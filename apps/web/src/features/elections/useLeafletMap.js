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
 * outside is covered by a dimming mask that dissolves into fog well before its
 * own edge, so the widest view never shows the rectangle it is cut from. While
 * the boundary is being re-traced (`isAreaEditing`) both overlays and the pan
 * limits step aside, so the new outline can be drawn beyond the old one — and
 * when a re-traced boundary is saved, the overlays, the pan limits and the home
 * view all follow it.
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
/** How far the dimming mask reaches past the working area, as a share of it. */
const MASK_PAD_RATIO = PAN_MARGIN_RATIO * 2;
/**
 * How far below the fitted view zooming out may still go, in zoom levels.
 *
 * Zero would pin the widest view to the district exactly. A whole level — what
 * this used to be — pulls back to four times the district's area, far enough
 * that the mask stops covering the viewport and the ground beyond it reads as a
 * plain rectangle of dimming. Half a step keeps a band of surrounding city for
 * orientation and stays inside the fog.
 */
const MIN_ZOOM_SLACK = 0.5;
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
 * The dimming mask is one polygon with the working area punched out of it as a
 * hole (Leaflet fills paths with the even-odd rule). Its outer ring is the pan
 * limit rather than the whole world: the map cannot be moved past that anyway,
 * and a world-sized SVG path turns into millions of pixels at street zoom.
 */
function maskRings(bounds, rings) {
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
 * The fog: how the dimming outside the working area gives out.
 *
 * The mask has an outer edge nobody drew — the rectangle it is cut from — and
 * at the widest zoom that edge used to sit in plain view as a hard-cornered
 * dark square around the district. So the mask is painted with a radial
 * gradient rather than a flat colour, and simply stops existing before it
 * reaches its own boundary.
 *
 * The gradient is mapped onto the mask's own bounding box, which is what makes
 * this hold at every zoom and for any shape of territory: it stretches with the
 * box and needs no recomputing when the map moves. Offsets are fractions of the
 * gradient's radius, and that radius is half the box — so `1` lands on the
 * middle of the box's edge, and the corners lie beyond it, left transparent by
 * the final stop.
 *
 * Exported for the one thing here that is easy to get quietly wrong: the fade
 * must not start until past everything the working area can reach, or houses
 * just inside the border would sit in half-lit ground and read as excluded.
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
  host.setAttribute('class', 'elections-area-fog');

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
      });

      // Hybrid labels ride between the imagery and the buildings: above the
      // photo they annotate, below the polygons a canvasser clicks.
      instance.createPane(LABELS_PANE).style.zIndex = 250;
      instance.getPane(LABELS_PANE).style.pointerEvents = 'none';

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

  /* The working area: dimmed surroundings, outlined border, campaign anchor. */
  useEffect(() => {
    if (!map || isAreaEditing) {
      return undefined;
    }

    const renderer = L.svg({ padding: 1 });

    // Non-interactive on purpose: the mask covers the whole viewport, and a
    // path that swallowed clicks would also swallow panning. Nothing outside
    // the polygon is clickable anyway — those houses are never added to the map.
    //
    // The fill is named here rather than in CSS so the reference resolves
    // against the document: a fragment url in a stylesheet is resolved against
    // the stylesheet's own address, which in a built bundle is not this page.
    const mask = L.polygon(maskRings(L.latLngBounds(area.bounds), area.rings), {
      interactive: false,
      className: 'elections-area-mask',
      fillColor: `url(#${FOG_GRADIENT_ID})`,
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
      mask.remove();
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
