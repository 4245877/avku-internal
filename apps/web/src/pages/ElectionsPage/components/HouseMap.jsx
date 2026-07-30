/**
 * The interactive district map.
 *
 * Base cartography comes from a real map service (OpenStreetMap by default,
 * see `features/elections/basemaps.js`), so streets, yards, house numbers and
 * building outlines are the actual ones on the ground. On top of it every
 * surveyed building from the OSM dataset is its own clickable polygon.
 *
 * Keyboard users reach individual houses through the results list, which is the
 * accessible equivalent of clicking a shape; the map surface itself keeps
 * Leaflet's arrow-key panning and +/- zoom.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import 'leaflet/dist/leaflet.css';

import { AREA_RADIUS_METERS } from '../../../features/elections/geo.js';
import { DEFAULT_BASEMAP_ID, getBasemap } from '../../../features/elections/basemaps.js';
import { useHouseLayer } from '../../../features/elections/useHouseLayer.js';
import { useLeafletMap } from '../../../features/elections/useLeafletMap.js';
import {
  formatApartments,
  getFillStatus,
  resolveApartments,
} from '../../../features/elections/houseUtils.js';
import { fillStatusesById } from '../../../features/elections/electionsTypes.js';
import MapBasemapSwitcher from './MapBasemapSwitcher.jsx';
import MapControls from './MapControls.jsx';
import MapLegend from './MapLegend.jsx';
import { MapEmptyResultState, MapErrorState, MapLoadingState } from './MapStates.jsx';
import styles from '../ElectionsPage.module.css';

/** Below this distance from the top edge the tooltip flips under the cursor. */
const TOOLTIP_FLIP_THRESHOLD_PIXELS = 76;

function HouseMap({
  houses,
  matchedIds,
  summary,
  selectedHouse,
  onSelectHouse,
  focusRequest,
  status,
  error,
  onRetry,
  fillStatusFilter,
  onFillStatusChange,
  onResetFilters,
  hasEmptyResult,
}) {
  const [basemapId, setBasemapId] = useState(DEFAULT_BASEMAP_ID);
  const [hoveredHouseId, setHoveredHouseId] = useState(null);
  const [tooltipPosition, setTooltipPosition] = useState(null);

  const {
    containerRef,
    map,
    canZoomIn,
    canZoomOut,
    zoomIn,
    zoomOut,
    resetView,
    focusOnBounds,
  } = useLeafletMap({ basemapId });

  const handleSelectHouse = useCallback(
    (houseId) => onSelectHouse(houseId ?? null),
    [onSelectHouse],
  );

  const handleHoverHouse = useCallback((houseId, containerPoint) => {
    setHoveredHouseId(houseId);
    setTooltipPosition(houseId ? (containerPoint ?? null) : null);
  }, []);

  const { getHouseBounds } = useHouseLayer({
    map,
    houses,
    matchedIds,
    selectedHouseId: selectedHouse?.id ?? null,
    hoveredHouseId,
    isImageryBasemap: Boolean(getBasemap(basemapId).isImagery),
    onSelectHouse: handleSelectHouse,
    onHoverHouse: handleHoverHouse,
  });

  /* While a building is hovered the tooltip follows the cursor across it; its
   * first position comes from the `mouseover` event itself. */
  useEffect(() => {
    if (!map || !hoveredHouseId) {
      return undefined;
    }

    const track = (event) => setTooltipPosition(event.containerPoint);

    map.on('mousemove', track);

    return () => {
      map.off('mousemove', track);
    };
  }, [hoveredHouseId, map]);

  // Selecting from the list or the search field asks the map to move; clicking
  // a building on the map deliberately does not, so the view stays stable.
  const handledFocusTokenRef = useRef(0);

  useEffect(() => {
    if (!focusRequest || focusRequest.token === handledFocusTokenRef.current) {
      return;
    }

    const bounds = getHouseBounds(focusRequest.houseId);

    if (!bounds) {
      return;
    }

    handledFocusTokenRef.current = focusRequest.token;
    focusOnBounds(bounds);
  }, [focusOnBounds, focusRequest, getHouseBounds]);

  /* Every pointer move over a building re-renders this component, so the
   * hovered house is looked up by key rather than scanned for. */
  const housesById = useMemo(
    () => new Map(houses.map((house) => [house.id, house])),
    [houses],
  );

  const hoveredHouse = hoveredHouseId ? (housesById.get(hoveredHouseId) ?? null) : null;

  const isTooltipBelow =
    tooltipPosition !== null && tooltipPosition.y < TOOLTIP_FLIP_THRESHOLD_PIXELS;

  return (
    <div className={styles.mapFrame}>
      <div className={styles.mapSurface}>
        <div
          aria-describedby="elections-map-hint"
          aria-label="Карта будинків у радіусі 3 км від штабу"
          className={styles.mapCanvas}
          ref={containerRef}
          role="application"
        />

        <p className="sr-only" id="elections-map-hint">
          Карта показує реальні будинки з OpenStreetMap у радіусі{' '}
          {AREA_RADIUS_METERS / 1000} км від адреси вулиця Якуба Коласа, 6.
          Перетягуйте карту стрілками, змінюйте масштаб клавішами плюс і мінус.
          Щоб вибрати будинок за допомогою клавіатури, скористайтеся списком
          будинків поруч із картою.
        </p>

        {hoveredHouse && tooltipPosition && (
          <div
            className={[styles.mapTooltip, isTooltipBelow ? styles.mapTooltipBelow : '']
              .filter(Boolean)
              .join(' ')}
            style={{ left: `${tooltipPosition.x}px`, top: `${tooltipPosition.y}px` }}
          >
            <strong>{hoveredHouse.address}</strong>
            <span>{formatApartments(resolveApartments(hoveredHouse).value)}</span>
            <span className={styles.mapTooltipStatus}>
              {fillStatusesById[getFillStatus(hoveredHouse)].label}
            </span>
          </div>
        )}

        <MapControls
          canZoomIn={canZoomIn}
          canZoomOut={canZoomOut}
          onReset={resetView}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
        />

        <MapBasemapSwitcher activeId={basemapId} onChange={setBasemapId} />

        <MapLegend
          activeStatus={fillStatusFilter}
          onStatusChange={onFillStatusChange}
          summary={summary}
        />

        {status === 'loading' && <MapLoadingState />}

        {status === 'error' && <MapErrorState message={error} onRetry={onRetry} />}

        {status === 'ready' && hasEmptyResult && (
          <MapEmptyResultState onResetFilters={onResetFilters} />
        )}
      </div>
    </div>
  );
}

export default HouseMap;
