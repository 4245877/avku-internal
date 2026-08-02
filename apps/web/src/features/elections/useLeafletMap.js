/**
 * Owns the Leaflet map instance behind the "Вибори" page.
 *
 * Leaflet is driven imperatively rather than through a React binding on
 * purpose: the map carries a few thousand building polygons, and letting React
 * reconcile them would turn every filter change into a full re-render of the
 * district. The hook exposes exactly the handful of values the UI needs
 * (`zoom`, `canZoomIn`, …) and keeps everything else inside Leaflet.
 *
 * The working area is the polygon the workspace store holds: the initial view
 * is fitted to it, its outline is drawn on top of the tiles, and everything
 * outside it is *hidden* — not dimmed. Only the ground inside the boundary is
 * ever shown, so the veil that covers the rest is opaque, is cut from a ring
 * that spans the world, and lives in a pane above every layer the map draws.
 * While the boundary is being re-traced (`isAreaEditing`) both overlays and the
 * pan limits step aside, so the new outline can be drawn beyond the old one —
 * and when a re-traced boundary is saved, the overlays, the pan limits and the
 * home view all follow it.
 *
 * Switching «Карта» ⇄ «Супутник» replaces the base layer set and nothing else.
 * The map instance, the view, the pan limits, the traced boundary, the mask,
 * the house polygons, the selection and the editor all belong to other effects
 * and are never torn down by a mode change — which is why the switch keeps the
 * zoom, the position and the work in progress exactly where they were.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';

import { AREA_CENTER } from './geo.js';
import { toLeafletLatLngs } from './workspaceArea.js';
import { useWorkspaceArea } from './useWorkspaceArea.js';
import { LABELS_PANE, MAP_MAX_ZOOM, getMapMode, layersOf } from './basemaps.js';

/** Padding around the working area when the whole district is fitted. */
const FIT_PADDING_PIXELS = 24;
/** How far outside the working area panning is still allowed. */
const PAN_MARGIN_RATIO = 0.3;
/** How far the fog reaches past the working area, as a share of it. */
const MASK_PAD_RATIO = PAN_MARGIN_RATIO * 2;
/**
 * How far below the fitted view zooming out may still go, in zoom levels.
 *
 * Zero would pin the widest view to the district exactly; half a step keeps a
 * band of fog around it, which is what makes the district read as cut out of
 * something rather than as the whole map.
 */
const MIN_ZOOM_SLACK = 0.5;
/**
 * The pane the working-area overlays live in.
 *
 * They cannot share the overlay pane with the building polygons, which is where
 * Leaflet puts paths by default. The house canvas is added to that pane *after*
 * the veil — its effect runs later — so it painted straight over it, and the
 * house-number markers sit in the marker pane, which is above the overlay pane
 * at every moment. Both showed on ground the veil is supposed to hide.
 */
const AREA_PANE = 'elections-area';
/** Above the marker pane (600), below Leaflet's own tooltips (650). */
const AREA_PANE_Z_INDEX = 620;
/** How far past the viewport the working area's overlays are drawn. */
const AREA_RENDERER_PADDING = 0.5;
/** Closest zoom a single-house focus is allowed to reach. */
const FOCUS_MAX_ZOOM = 19;
/**
 * Failed tiles in one batch before the map calls the tile service broken. A
 * viewport is a dozen-odd tiles, so this distinguishes "the host is blocked or
 * out of quota" from "one tile fell outside coverage".
 */
export const TILE_ERROR_THRESHOLD = 4;

/**
 * One verdict from the per-layer tile counters.
 *
 * Exported because the rule it encodes is easy to get subtly wrong and worth
 * pinning down: Leaflet fires `load` at the end of a batch whether the tiles
 * arrived or failed, so "nothing pending" must never be read as "ready" while a
 * layer's failures stand. Errors therefore outrank both other states.
 */
export function foldTileStatus(health, threshold = TILE_ERROR_THRESHOLD) {
  if (health.some((layer) => layer.failed >= threshold)) {
    return 'error';
  }

  return health.some((layer) => layer.pending > 0) ? 'loading' : 'ready';
}

/**
 * Leaflet needs a real element size to compute the fitted zoom, which is not
 * available on the first paint inside a flex layout.
 */
function whenSized(container, callback) {
  if (container.clientWidth > 0 && container.clientHeight > 0) {
    callback();
    return () => {};
  }

  const observer = new ResizeObserver(() => {
    if (container.clientWidth > 0 && container.clientHeight > 0) {
      observer.disconnect();
      callback();
    }
  });

  observer.observe(container);

  return () => observer.disconnect();
}

/**
 * An SVG renderer that keeps up with a movement instead of waiting it out.
 *
 * A renderer draws a band of ground a little wider than the viewport and then
 * holds still until Leaflet tells it to redraw — which for panning is `moveend`,
 * the *end* of the gesture. Tiles do not work that way: `GridLayer` loads on
 * `move`, which is why a flick brings fresh cartography in as it travels. So
 * the veil was the one thing on the map standing still while everything under
 * it moved, and a flick — a drag is followed by inertia that carries the map
 * thousands of pixels further — slid whole neighbourhoods out from under it and
 * left them on screen, uncovered, until the map came to rest.
 *
 * No padding fixes that; the distance is unbounded. Redrawing on `move` is what
 * fixes it, and it costs a viewBox and three simple paths per frame. Zoom is
 * left alone: `L.SVG` refuses to redraw mid-zoom on purpose, because the
 * animation is a transform on the whole container and a redraw would fight it.
 */
const AreaRenderer = L.SVG.extend({
  getEvents() {
    return { ...L.SVG.prototype.getEvents.call(this), move: this._update };
  },
});

/** Where Mercator runs out — Leaflet projects nothing past this latitude. */
const MAX_LATITUDE = 85.0511287798;

/**
 * The whole projectable world, as one ring.
 *
 * The veil used to be cut from the pan limit instead, on the grounds that the
 * map cannot be moved past it. That was wrong in the one direction nobody
 * checks: the limit is a *box around the district*, and a district that is
 * taller than it is wide leaves the viewport wider than the box at every zoom
 * that fits it — so the city went on being drawn down both sides of the map.
 * A ring this size cannot be reached past at any zoom or pan, and it costs
 * nothing to draw: Leaflet clips a polygon's rings to its renderer's bounds
 * before building the path, so what reaches the SVG is viewport-sized however
 * large the ring it was cut from.
 */
const WORLD_RING = [
  [-MAX_LATITUDE, -180],
  [-MAX_LATITUDE, 180],
  [MAX_LATITUDE, 180],
  [MAX_LATITUDE, -180],
];

/**
 * The veil: one polygon covering everything outside the working area, which is
 * punched out of it as a hole (Leaflet fills paths with the even-odd rule).
 *
 * Exported for the property the whole feature rests on — that there is no view
 * of the map in which some corner of the ground escapes it.
 */
export function veilRings(rings) {
  return [WORLD_RING, ...toLeafletLatLngs(rings)];
}

/**
 * The fog: the same hole, cut from a box a little larger than the district.
 *
 * It is painted over the veil rather than over the map, so it tints the veil
 * near the border and gives out into the veil's own tone further off. That is
 * the whole of its job — the veil below it is opaque everywhere, so nothing the
 * fog does can uncover ground.
 */
function fogRings(bounds, rings) {
  const outside = bounds.pad(MASK_PAD_RATIO);
  const north = outside.getNorth();
  const south = outside.getSouth();
  const east = outside.getEast();
  const west = outside.getWest();

  return [
    [
      [south, west],
      [south, east],
      [north, east],
      [north, west],
    ],
    ...toLeafletLatLngs(rings),
  ];
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
/** Ties the mask's `fill` to the gradient below. Document-wide, as SVG ids are. */
const FOG_GRADIENT_ID = 'elections-area-fog';
/** Stops across the fade. Six is past the point where the ramp shows steps. */
const FOG_FADE_STEPS = 5;

/**
 * How the fog gives out into the veil below it.
 *
 * The fog is one tone laid over the veil, so a stop's opacity is how much of
 * that tone survives at that distance — never how much of the *map* does. It
 * has an outer edge nobody drew — the box it is cut from — and a flat edge
 * there would read as a hard-cornered square around the district, so it is
 * painted with a radial gradient and has run out entirely by the time it
 * arrives at its own boundary.
 *
 * The gradient is mapped onto the path's own bounding box, which is what makes
 * this hold at every zoom and for any shape of territory: it stretches with the
 * box and needs no recomputing when the map moves. Offsets are fractions of the
 * gradient's radius, and that radius is half the box — so `1` lands on the
 * middle of the box's edge, and the corners lie beyond it, left to the veil by
 * the final stop.
 *
 * Exported for the one thing here that is easy to get quietly wrong: the fade
 * must not start until past everything the working area can reach, or the
 * ground immediately outside the border would be tinted unevenly around it.
 * The polygon is inscribed in `bounds`, whose furthest point from the centre is
 * a corner — so that corner's radius is the earliest the fade may begin.
 */
export function fogGradientStops(padRatio = MASK_PAD_RATIO, steps = FOG_FADE_STEPS) {
  // The mask's box is `bounds` grown by `padRatio` of its full size on each
  // side, so `bounds` reaches `1 / span` of the way across it — and its corner,
  // `√2` further out along the diagonal, `√2 / span` of the way to the edge.
  const span = 1 + 2 * padRatio;
  const solid = Math.SQRT2 / span;

  return Array.from({ length: steps + 1 }, (_, index) => {
    const progress = index / steps;

    return {
      offset: solid + progress * (1 - solid),
      // Raised cosine: flat at both ends, so neither where the fog starts nor
      // where it runs out leaves an edge for the eye to catch.
      opacity: (1 + Math.cos(Math.PI * progress)) / 2,
    };
  });
}

/**
 * Puts the gradient in the document so the mask's `fill` can name it.
 *
 * It goes in the map container rather than the page: it belongs to this map,
 * dies with it, and inherits the theme's palette from the same place the rest
 * of the map does — the stops take their colour from CSS, this only describes
 * the shape of the falloff. The host `<svg>` carries no size and paints
 * nothing; `<defs>` is only ever referenced.
 */
function addFogGradient(container) {
  const host = document.createElementNS(SVG_NAMESPACE, 'svg');

  host.setAttribute('width', '0');
  host.setAttribute('height', '0');
  host.setAttribute('aria-hidden', 'true');
  host.setAttribute('focusable', 'false');
  host.setAttribute('class', 'elections-area-fog-defs');

  const defs = document.createElementNS(SVG_NAMESPACE, 'defs');
  const gradient = document.createElementNS(SVG_NAMESPACE, 'radialGradient');

  gradient.setAttribute('id', FOG_GRADIENT_ID);

  for (const stop of fogGradientStops()) {
    const node = document.createElementNS(SVG_NAMESPACE, 'stop');

    node.setAttribute('offset', stop.offset.toFixed(4));
    node.setAttribute('stop-opacity', stop.opacity.toFixed(4));
    gradient.append(node);
  }

  defs.append(gradient);
  host.append(defs);
  container.append(host);

  return () => host.remove();
}

export function useLeafletMap({ center = AREA_CENTER, mapModeId, isAreaEditing = false } = {}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const baseLayersRef = useRef([]);
  const homeBoundsRef = useRef(null);

  const area = useWorkspaceArea();
  // The map is created once; the territory it opens on is whatever is in force
  // at that moment, and later changes are handled by the effect below rather
  // than by rebuilding the map.
  const areaRef = useRef(area);

  areaRef.current = area;

  const [map, setMap] = useState(null);
  const [zoom, setZoom] = useState(null);
  const [zoomRange, setZoomRange] = useState({ min: 0, max: MAP_MAX_ZOOM });
  /**
   * How the cartography itself is doing — separate from the house dataset, and
   * the only thing that can report a blocked, throttled or unreachable tile
   * service. `error` survives until tiles load again, because a half-drawn map
   * that silently stopped fetching is exactly what looks like a broken feature.
   */
  const [tileStatus, setTileStatus] = useState('loading');
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return undefined;
    }

    let instance = null;

    const stopWaiting = whenSized(container, () => {
      instance = L.map(container, {
        center: [center.lat, center.lon],
        zoom: 15,
        zoomControl: false,
        attributionControl: true,
        // Wheel zoom in whole steps: half-steps make building outlines swim
        // while the tiles catch up.
        zoomSnap: 0.5,
        wheelPxPerZoomLevel: 90,
        preferCanvas: true,
        // Owned by the map, not by the layer set: every mode reaches the same
        // depth, so switching to imagery can never clamp the current zoom.
        maxZoom: MAP_MAX_ZOOM,
        // The pan limit is a wall, not a rubber band. Left at Leaflet's default
        // a drag can carry the map right off the district and only spring back
        // once it is let go — and for the whole of that flight the map is
        // showing ground the working area does not cover.
        maxBoundsViscosity: 1,
      });

      // Hybrid labels ride between the imagery and the buildings: above the
      // photo they annotate, below the polygons a canvasser clicks.
      instance.createPane(LABELS_PANE).style.zIndex = 250;
      instance.getPane(LABELS_PANE).style.pointerEvents = 'none';

      // The working area's own pane, above every layer the map draws — tiles,
      // hybrid labels, building polygons and house-number markers alike. Deaf
      // to the pointer, because it covers the whole viewport: a veil that took
      // clicks would take panning and every building underneath it with it.
      instance.createPane(AREA_PANE).style.zIndex = AREA_PANE_Z_INDEX;
      instance.getPane(AREA_PANE).style.pointerEvents = 'none';

      // The starting view is whatever fits the traced boundary — the polygon is
      // the only thing that decides how far out the district opens.
      const areaBounds = L.latLngBounds(areaRef.current.bounds);

      instance.fitBounds(areaBounds, { padding: [FIT_PADDING_PIXELS, FIT_PADDING_PIXELS] });

      homeBoundsRef.current = areaBounds;

      // Bottom-right, stacked above the attribution: bottom-left belongs to the
      // completeness legend.
      L.control
        .scale({ metric: true, imperial: false, position: 'bottomright', maxWidth: 130 })
        .addTo(instance);

      const syncZoom = () => {
        setZoom(instance.getZoom());
        setZoomRange({ min: instance.getMinZoom(), max: instance.getMaxZoom() });
      };

      // `zoomlevelschange` matters too: the pan-limit effect raises the minimum
      // zoom once the fitted level is known, which decides "can zoom out".
      instance.on('zoomend zoomlevelschange', syncZoom);
      syncZoom();

      mapRef.current = instance;
      setMap(instance);
    });

    return () => {
      stopWaiting();
      instance?.remove();
      mapRef.current = null;
      baseLayersRef.current = [];
      setMap(null);
    };
  }, [center]);

  /*
   * The base layer set.
   *
   * The old layers are removed only after the new ones are added, so the map
   * never flashes empty mid-switch, and the swap touches nothing but the tile
   * pane: view, limits, boundary, houses and selection all stay as they were.
   *
   * Tile events are the map's own health report. `loading`/`load` drive the
   * quiet progress chip; `tileerror` is what a blocked host, an exhausted quota
   * or a bad key look like from inside the browser, and it is only believed
   * after a whole batch fails — a single missing tile at the edge of coverage
   * is normal and must not raise an alarm.
   *
   * Health is tracked per layer and folded together afterwards, for two reasons
   * a shared counter got wrong: Leaflet fires `load` at the end of a batch even
   * when every tile in it failed, so "finished" is not "succeeded"; and in the
   * hybrid mode the imagery and the labels are separate services that can fail
   * independently.
   */
  useEffect(() => {
    if (!map) {
      return undefined;
    }

    const mode = getMapMode(mapModeId);
    const previous = baseLayersRef.current;
    const specs = layersOf(mode);
    const health = specs.map(() => ({ pending: 0, failed: 0 }));

    let isCurrent = true;

    const sync = () => {
      if (isCurrent) {
        setTileStatus(foldTileStatus(health));
      }
    };

    const layers = specs.map((spec, index) => {
      const layer = L.tileLayer(spec.url, {
        attribution: spec.attribution,
        subdomains: spec.subdomains ?? 'abc',
        maxZoom: MAP_MAX_ZOOM,
        maxNativeZoom: spec.maxNativeZoom,
        tileSize: spec.tileSize ?? 256,
        zoomOffset: spec.zoomOffset ?? 0,
        detectRetina: spec.detectRetina ?? false,
        className: spec.className,
        ...(spec.pane ? { pane: spec.pane } : {}),
      });

      const state = health[index];

      // A fresh batch starts the failure count over: whatever went wrong last
      // time, this is the map asking the service again.
      layer.on('loading', () => {
        state.pending += 1;
        state.failed = 0;
        sync();
      });

      layer.on('load', () => {
        state.pending = Math.max(0, state.pending - 1);
        sync();
      });

      layer.on('tileerror', () => {
        state.failed += 1;
        sync();
      });

      return layer.addTo(map);
    });

    baseLayersRef.current = layers;
    setTileStatus('loading');

    for (const layer of previous) {
      layer.remove();
    }

    return () => {
      isCurrent = false;
    };
  }, [mapModeId, map, retryToken]);

  /* A newly saved boundary becomes the district: it is what "show the whole
   * territory" means from now on, and the view moves to it once. The guard is
   * what keeps that to an actual change of territory — re-fitting on every
   * render would yank the map back from wherever the user had panned to. */
  const fittedAreaRef = useRef(null);

  useEffect(() => {
    if (!map) {
      return undefined;
    }

    homeBoundsRef.current = L.latLngBounds(area.bounds);

    const isFirstArea = fittedAreaRef.current === null;

    fittedAreaRef.current = area;

    if (!isFirstArea && !isAreaEditing) {
      // Not animated: the pan and zoom limits are recomputed in the very next
      // effect, and clamping a moving map mid-flight leaves it short of the
      // territory it was asked to show.
      map.fitBounds(homeBoundsRef.current, {
        padding: [FIT_PADDING_PIXELS, FIT_PADDING_PIXELS],
        animate: false,
      });
    }

    return undefined;
  }, [area, isAreaEditing, map]);

  /*
   * Container resize.
   *
   * Leaflet only watches the *window*, so every resize that leaves the window
   * alone — a responsive column that re-proportions itself, a panel opening,
   * the layout switching between the wide and stacked workspace grids — leaves
   * the map drawing at its old pixel size: tiles stop short of the new edge and
   * clicks land on the wrong building. A ResizeObserver on the container is the
   * only thing that sees those.
   *
   * Measurement is deferred to the next frame because the observer fires inside
   * layout, and `invalidateSize` reads back geometry.
   */
  useEffect(() => {
    const container = containerRef.current;

    if (!map || !container) {
      return undefined;
    }

    let frame = 0;

    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // `pan: false` keeps the centre put: a wider column should reveal more
        // map, not slide the district sideways.
        map.invalidateSize({ animate: false, pan: false });
      });
    });

    observer.observe(container);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [map]);

  /* Pan and zoom limits — lifted while a new boundary is being traced.
   * Re-applied on `resize` as well: the minimum zoom is "whatever fits the
   * territory", which is a function of the container's pixel size. */
  useEffect(() => {
    if (!map) {
      return undefined;
    }

    const applyLimits = () => {
      const bounds = homeBoundsRef.current;

      if (!bounds) {
        return;
      }

      if (isAreaEditing) {
        map.setMaxBounds(null);
        map.setMinZoom(0);

        return;
      }

      const fitted = map.getBoundsZoom(bounds, false, [FIT_PADDING_PIXELS, FIT_PADDING_PIXELS]);

      map.setMinZoom(fitted - MIN_ZOOM_SLACK);
      map.setMaxBounds(bounds.pad(PAN_MARGIN_RATIO));
    };

    applyLimits();
    map.on('resize', applyLimits);

    return () => {
      map.off('resize', applyLimits);
    };
  }, [area, isAreaEditing, map]);

  /* The gradient the mask fades out with. Tied to the map's own lifetime: the
   * mask below is rebuilt on every change of territory, and re-creating a
   * definition that never varies along with it would be pure churn. */
  useEffect(() => (map ? addFogGradient(map.getContainer()) : undefined), [map]);

  /* The working area: hidden surroundings, outlined border, campaign anchor.
   *
   * Three paths through one renderer, and the order they are added in is the
   * order they are painted in: the veil hides the ground, the fog tints it, the
   * border draws the line between that and the district. */
  useEffect(() => {
    if (!map || isAreaEditing) {
      return undefined;
    }

    const renderer = new AreaRenderer({
      padding: AREA_RENDERER_PADDING,
      pane: AREA_PANE,
    });

    // What actually hides everything outside the district. Opaque, and cut from
    // a ring no view can reach past — see `veilRings`.
    const veil = L.polygon(veilRings(area.rings), {
      interactive: false,
      className: 'elections-area-veil',
      renderer,
    }).addTo(map);

    // The fill is named here rather than in CSS so the reference resolves
    // against the document: a fragment url in a stylesheet is resolved against
    // the stylesheet's own address, which in a built bundle is not this page.
    //
    // `noClip` because the gradient is mapped onto this path's bounding box:
    // let Leaflet trim the path to the viewport, as it does every other one,
    // and the box the fog is measured against would be trimmed with it, so the
    // fog would slide about with every pan and zoom. The path is a rectangle
    // and a ring, and it is the veil below that has to cover the viewport.
    const fog = L.polygon(fogRings(L.latLngBounds(area.bounds), area.rings), {
      interactive: false,
      className: 'elections-area-fog',
      fillColor: `url(#${FOG_GRADIENT_ID})`,
      noClip: true,
      renderer,
    }).addTo(map);

    const border = L.polygon(toLeafletLatLngs(area.rings), {
      interactive: false,
      className: 'elections-area-ring',
      renderer,
    }).addTo(map);

    const anchor = L.marker([center.lat, center.lon], {
      interactive: false,
      keyboard: false,
      zIndexOffset: 1000,
      icon: L.divIcon({
        className: 'elections-anchor-icon',
        html: '<span></span>',
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      }),
    }).addTo(map);

    return () => {
      veil.remove();
      fog.remove();
      border.remove();
      anchor.remove();
    };
  }, [area, center, isAreaEditing, map]);

  const zoomIn = useCallback(() => mapRef.current?.zoomIn(), []);
  const zoomOut = useCallback(() => mapRef.current?.zoomOut(), []);

  const resetView = useCallback(() => {
    if (mapRef.current && homeBoundsRef.current) {
      mapRef.current.fitBounds(homeBoundsRef.current, {
        padding: [FIT_PADDING_PIXELS, FIT_PADDING_PIXELS],
      });
    }
  }, []);

  /** Brings one building into view without diving all the way to max zoom. */
  const focusOnBounds = useCallback((bounds) => {
    mapRef.current?.flyToBounds(bounds, {
      maxZoom: FOCUS_MAX_ZOOM,
      padding: [80, 80],
      duration: 0.6,
    });
  }, []);

  /** Rebuilds the layer set — the one honest answer to a tile host that failed. */
  const retryTiles = useCallback(() => setRetryToken((current) => current + 1), []);

  return {
    containerRef,
    map,
    zoom,
    canZoomIn: zoom !== null && zoom < zoomRange.max,
    canZoomOut: zoom !== null && zoom > zoomRange.min,
    zoomIn,
    zoomOut,
    resetView,
    focusOnBounds,
    tileStatus,
    retryTiles,
  };
}
