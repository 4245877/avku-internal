/**
 * The interactive district map.
 *
 * Rendering strategy: one `<svg>` whose contents live in the local metre grid,
 * moved by a single transform from `useMapViewport`. Pointer interaction is
 * delegated from the houses group — with several hundred footprints on screen,
 * per-shape React handlers are the main source of jank.
 *
 * Keyboard users reach individual houses through the results list, which is the
 * accessible equivalent of clicking a shape; the map itself supports arrow-key
 * panning and +/-/0 for zoom.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  AREA_RADIUS_METERS,
  polygonBounds,
  polygonCentroid,
  polygonToPath,
  projectFootprint,
} from '../../../features/elections/geo.js';
import { createMapLandmarks, createMapStreets } from '../../../features/elections/mockHouses.js';
import { useMapViewport } from '../../../features/elections/useMapViewport.js';
import {
  formatApartments,
  getFillStatus,
  resolveApartments,
} from '../../../features/elections/houseUtils.js';
import { fillStatusesById } from '../../../features/elections/electionsTypes.js';
import MapBaseLayer from './MapBaseLayer.jsx';
import MapControls from './MapControls.jsx';
import MapHouseShape from './MapHouseShape.jsx';
import MapLegend from './MapLegend.jsx';
import { MapEmptyResultState, MapErrorState, MapLoadingState } from './MapStates.jsx';
import styles from '../ElectionsPage.module.css';

/**
 * Zoom ratio (relative to the fitted view) at which house numbers appear —
 * roughly the point where a panel block is wide enough to hold a label.
 */
const HOUSE_NUMBER_ZOOM = 10;

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
  const streets = useMemo(() => createMapStreets(), []);
  const landmarks = useMemo(() => createMapLandmarks(), []);
  const [hoveredHouseId, setHoveredHouseId] = useState(null);

  const {
    containerRef,
    size,
    viewport,
    transform,
    isPanning,
    zoomRatio,
    canZoomIn,
    canZoomOut,
    zoomIn,
    zoomOut,
    resetView,
    focusOnBounds,
    hasPanned,
    toScreen,
    handlers,
  } = useMapViewport({ worldRadius: AREA_RADIUS_METERS });

  /**
   * Projected geometry per house. `projectFootprint` caches on the footprint
   * array, which edits never replace, so saving a house does not re-project the
   * whole district.
   */
  const shapes = useMemo(
    () =>
      houses.map((house) => {
        const points = projectFootprint(house.footprint);

        return {
          id: house.id,
          path: polygonToPath(points),
          centroid: polygonCentroid(points),
          bounds: polygonBounds(points),
          status: getFillStatus(house),
          number: house.number,
          isHeadquarters: house.isHeadquarters,
        };
      }),
    [houses],
  );

  const shapesById = useMemo(
    () => new Map(shapes.map((shape) => [shape.id, shape])),
    [shapes],
  );

  const housesById = useMemo(
    () => new Map(houses.map((house) => [house.id, house])),
    [houses],
  );

  // Selecting from the list or the search field asks the map to move; clicking
  // a shape on the map deliberately does not, so the view stays stable.
  const handledFocusTokenRef = useRef(0);

  useEffect(() => {
    if (!focusRequest || focusRequest.token === handledFocusTokenRef.current) {
      return;
    }

    const shape = shapesById.get(focusRequest.houseId);

    if (!shape) {
      return;
    }

    handledFocusTokenRef.current = focusRequest.token;
    focusOnBounds(shape.bounds);
  }, [focusOnBounds, focusRequest, shapesById]);

  /**
   * One delegated click for the whole canvas: a hit on a footprint selects it,
   * a hit on anything else (road, park, empty ground) clears the selection.
   * Suppressed after a pan so dragging the map never changes the selection.
   */
  const handleCanvasClick = useCallback(
    (event) => {
      if (hasPanned()) {
        return;
      }

      onSelectHouse(event.target?.getAttribute?.('data-house-id') ?? null);
    },
    [hasPanned, onSelectHouse],
  );

  const handlePointerMove = useCallback((event) => {
    const houseId = event.target?.getAttribute?.('data-house-id') ?? null;

    setHoveredHouseId((current) => (current === houseId ? current : houseId));
  }, []);

  const handlePointerLeave = useCallback(() => setHoveredHouseId(null), []);

  /** Overlay controls must not start a map pan. */
  function handleSurfacePointerDown(event) {
    if (event.target?.closest?.('[data-map-overlay]')) {
      return;
    }

    handlers.onPointerDown(event);
  }

  const visibleWorldRect = useMemo(() => {
    if (!viewport.zoom || !size.width || !size.height) {
      return null;
    }

    const halfWidth = size.width / 2 / viewport.zoom;
    const halfHeight = size.height / 2 / viewport.zoom;

    return {
      minX: viewport.x - halfWidth,
      maxX: viewport.x + halfWidth,
      minY: viewport.y - halfHeight,
      maxY: viewport.y + halfHeight,
    };
  }, [size.height, size.width, viewport.x, viewport.y, viewport.zoom]);

  const numberedShapes = useMemo(() => {
    if (zoomRatio < HOUSE_NUMBER_ZOOM || !visibleWorldRect) {
      return [];
    }

    return shapes.filter(
      (shape) =>
        shape.centroid.x >= visibleWorldRect.minX &&
        shape.centroid.x <= visibleWorldRect.maxX &&
        shape.centroid.y >= visibleWorldRect.minY &&
        shape.centroid.y <= visibleWorldRect.maxY,
    );
  }, [shapes, visibleWorldRect, zoomRatio]);

  const selectedShape = selectedHouse ? shapesById.get(selectedHouse.id) : null;
  const hoveredHouse =
    hoveredHouseId && !isPanning ? (housesById.get(hoveredHouseId) ?? null) : null;
  const hoveredShape = hoveredHouse ? shapesById.get(hoveredHouse.id) : null;

  const tooltipPosition =
    hoveredShape && viewport.zoom ? toScreen(hoveredShape.centroid) : null;
  const isTooltipBelow =
    tooltipPosition !== null && tooltipPosition.y < TOOLTIP_FLIP_THRESHOLD_PIXELS;

  return (
    <div className={styles.mapFrame}>
      <div
        aria-describedby="elections-map-hint"
        aria-label="Карта будинків у радіусі 3 км від штабу"
        className={[styles.mapSurface, isPanning ? styles.mapSurfacePanning : '']
          .filter(Boolean)
          .join(' ')}
        onKeyDown={handlers.onKeyDown}
        onPointerDown={handleSurfacePointerDown}
        onPointerLeave={handlePointerLeave}
        onPointerMove={handlePointerMove}
        ref={containerRef}
        role="group"
        tabIndex={0}
      >
        <svg
          aria-hidden="true"
          className={styles.mapCanvas}
          height="100%"
          onClick={handleCanvasClick}
          width="100%"
        >
          {transform && (
            <g transform={transform}>
              <MapBaseLayer
                landmarks={landmarks}
                streets={streets}
                zoom={viewport.zoom}
                zoomRatio={zoomRatio}
              />

              <g>
                {shapes.map((shape) => (
                  <MapHouseShape
                    houseId={shape.id}
                    isHeadquarters={shape.isHeadquarters}
                    isMuted={!matchedIds.has(shape.id)}
                    key={shape.id}
                    path={shape.path}
                    status={shape.status}
                  />
                ))}
              </g>

              {selectedShape && (
                <path
                  className={styles.houseSelected}
                  d={selectedShape.path}
                  vectorEffect="non-scaling-stroke"
                />
              )}

              {numberedShapes.length > 0 && (
                <g className={styles.houseNumbers}>
                  {numberedShapes.map((shape) => (
                    <text
                      fontSize={11 / viewport.zoom}
                      key={shape.id}
                      strokeWidth={2.5 / viewport.zoom}
                      x={shape.centroid.x}
                      y={shape.centroid.y + 4 / viewport.zoom}
                    >
                      {shape.number}
                    </text>
                  ))}
                </g>
              )}
            </g>
          )}
        </svg>

        <p className="sr-only" id="elections-map-hint">
          Карта показує територію в радіусі {AREA_RADIUS_METERS / 1000} км від адреси
          вулиця Якуба Коласа, 6. Перетягуйте карту стрілками, змінюйте масштаб
          клавішами плюс і мінус, повертайтеся до загального вигляду клавішею нуль.
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
          zoom={viewport.zoom}
        />

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
