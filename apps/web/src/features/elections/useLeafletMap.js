/**
 * Owns the Leaflet map instance behind the "Вибори" page.
 *
 * Leaflet is driven imperatively rather than through a React binding on
 * purpose: the map carries a few thousand building polygons, and letting React
 * reconcile them would turn every filter change into a full re-render of the
 * district. The hook exposes exactly the handful of values the UI needs
 * (`zoom`, `canZoomIn`, …) and keeps everything else inside Leaflet.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';

import { AREA_CENTER, AREA_RADIUS_METERS } from './geo.js';
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

export function useLeafletMap({
  center = AREA_CENTER,
  radiusMeters = AREA_RADIUS_METERS,
  basemapId,
} = {}) {
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

      const areaBounds = L.latLng(center.lat, center.lon).toBounds(radiusMeters * 2);

      instance.fitBounds(areaBounds, { padding: [FIT_PADDING_PIXELS, FIT_PADDING_PIXELS] });

      homeBoundsRef.current = areaBounds;
      instance.setMinZoom(instance.getZoom() - 1);
      instance.setMaxBounds(areaBounds.pad(PAN_MARGIN_RATIO));

      // Bottom-right, stacked above the attribution: bottom-left belongs to the
      // completeness legend.
      L.control
        .scale({ metric: true, imperial: false, position: 'bottomright', maxWidth: 130 })
        .addTo(instance);

      const syncZoom = () => {
        setZoom(instance.getZoom());
        setZoomRange({ min: instance.getMinZoom(), max: instance.getMaxZoom() });
      };

      instance.on('zoomend', syncZoom);
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
  }, [center, radiusMeters]);

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

  /* The 3 km working area and the campaign anchor. */
  useEffect(() => {
    if (!map) {
      return undefined;
    }

    const ring = L.circle([center.lat, center.lon], {
      radius: radiusMeters,
      interactive: false,
      className: 'elections-area-ring',
      renderer: L.svg({ padding: 1 }),
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
      ring.remove();
      anchor.remove();
    };
  }, [center, map, radiusMeters]);

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
