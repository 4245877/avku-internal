/**
 * Owns the Leaflet map instance behind the "Вибори" page.
 *
 * Leaflet is driven imperatively rather than through a React binding on
 * purpose: the map carries a few thousand building polygons, and letting React
 * reconcile them would turn every filter change into a full re-render of the
 * district. The hook exposes exactly the handful of values the UI needs
 * (`zoom`, `canZoomIn`, …) and keeps everything else inside Leaflet.
 *
 * The working area is the GeoJSON polygon from `workspaceArea.geo.json`: the
 * initial view is fitted to it, its outline is drawn on top of the tiles, and
 * everything outside is covered by a dimming mask. While the boundary is being
 * re-traced (`isAreaEditing`) both overlays and the pan limits step aside, so
 * the new outline can be drawn beyond the old one.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';

import { AREA_CENTER } from './geo.js';
import { WORKSPACE_BOUNDS, toLeafletLatLngs } from './workspaceArea.js';
import { getBasemap } from './basemaps.js';

/** Padding around the working area when the whole district is fitted. */
const FIT_PADDING_PIXELS = 24;
/** How far outside the working area panning is still allowed. */
const PAN_MARGIN_RATIO = 0.3;
/** Closest zoom a single-house focus is allowed to reach. */
const FOCUS_MAX_ZOOM = 19;

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
function maskRings(bounds) {
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
    ...toLeafletLatLngs(),
  ];
}

export function useLeafletMap({ center = AREA_CENTER, basemapId, isAreaEditing = false } = {}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const tileLayerRef = useRef(null);
  const homeBoundsRef = useRef(null);

  const [map, setMap] = useState(null);
  const [zoom, setZoom] = useState(null);
  const [zoomRange, setZoomRange] = useState({ min: 0, max: 19 });

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
      });

      // The starting view is whatever fits the traced boundary — the polygon is
      // the only thing that decides how far out the district opens.
      const areaBounds = L.latLngBounds(WORKSPACE_BOUNDS);

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
      tileLayerRef.current = null;
      setMap(null);
    };
  }, [center]);

  /* Base layer, swapped in place so overlays keep their stacking order. */
  useEffect(() => {
    if (!map) {
      return undefined;
    }

    const basemap = getBasemap(basemapId);
    const layer = L.tileLayer(basemap.url, {
      attribution: basemap.attribution,
      subdomains: basemap.subdomains ?? 'abc',
      maxZoom: basemap.maxZoom,
      maxNativeZoom: basemap.maxNativeZoom,
      tileSize: basemap.tileSize ?? 256,
      zoomOffset: basemap.zoomOffset ?? 0,
      detectRetina: true,
      className: 'elections-basemap-tiles',
    });

    layer.addTo(map);
    map.setMaxZoom(basemap.maxZoom);
    tileLayerRef.current?.remove();
    tileLayerRef.current = layer;

    return undefined;
  }, [basemapId, map]);

  /* Pan and zoom limits — lifted while a new boundary is being traced. */
  useEffect(() => {
    const bounds = homeBoundsRef.current;

    if (!map || !bounds) {
      return undefined;
    }

    if (isAreaEditing) {
      map.setMaxBounds(null);
      map.setMinZoom(0);

      return undefined;
    }

    const fitted = map.getBoundsZoom(bounds, false, [FIT_PADDING_PIXELS, FIT_PADDING_PIXELS]);

    map.setMinZoom(fitted - 1);
    map.setMaxBounds(bounds.pad(PAN_MARGIN_RATIO));

    return undefined;
  }, [isAreaEditing, map]);

  /* The working area: dimmed surroundings, outlined border, campaign anchor. */
  useEffect(() => {
    if (!map || isAreaEditing) {
      return undefined;
    }

    const renderer = L.svg({ padding: 1 });

    // Non-interactive on purpose: the mask covers the whole viewport, and a
    // path that swallowed clicks would also swallow panning. Nothing outside
    // the polygon is clickable anyway — those houses are never added to the map.
    const mask = L.polygon(maskRings(L.latLngBounds(WORKSPACE_BOUNDS)), {
      interactive: false,
      className: 'elections-area-mask',
      renderer,
    }).addTo(map);

    const border = L.polygon(toLeafletLatLngs(), {
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
  }, [center, isAreaEditing, map]);

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
  };
}
