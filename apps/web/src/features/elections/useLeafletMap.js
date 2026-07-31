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
 * outside is covered by a dimming mask. While the boundary is being re-traced
 * (`isAreaEditing`) both overlays and the pan limits step aside, so the new
 * outline can be drawn beyond the old one — and when a re-traced boundary is
 * saved, the overlays, the pan limits and the home view all follow it.
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
  const outside = bounds.pad(PAN_MARGIN_RATIO * 2);
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

      map.setMinZoom(fitted - 1);
      map.setMaxBounds(bounds.pad(PAN_MARGIN_RATIO));
    };

    applyLimits();
    map.on('resize', applyLimits);

    return () => {
      map.off('resize', applyLimits);
    };
  }, [area, isAreaEditing, map]);

  /* The working area: dimmed surroundings, outlined border, campaign anchor. */
  useEffect(() => {
    if (!map || isAreaEditing) {
      return undefined;
    }

    const renderer = L.svg({ padding: 1 });

    // Non-interactive on purpose: the mask covers the whole viewport, and a
    // path that swallowed clicks would also swallow panning. Nothing outside
    // the polygon is clickable anyway — those houses are never added to the map.
    const mask = L.polygon(maskRings(L.latLngBounds(area.bounds), area.rings), {
      interactive: false,
      className: 'elections-area-mask',
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
