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

import { DEFAULT_BASEMAP_ID, getBasemap } from '../../../features/elections/basemaps.js';
import { useHouseLayer } from '../../../features/elections/useHouseLayer.js';
import { useLeafletMap } from '../../../features/elections/useLeafletMap.js';
import { useWorkspaceArea } from '../../../features/elections/useWorkspaceArea.js';
import { useWorkspaceEditor } from '../../../features/elections/useWorkspaceEditor.js';
import {
  formatApartments,
  getFillStatus,
  resolveApartments,
} from '../../../features/elections/houseUtils.js';
import { fillStatusesById } from '../../../features/elections/electionsTypes.js';
import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import MapBasemapSwitcher from './MapBasemapSwitcher.jsx';
import MapControls from './MapControls.jsx';
import MapLegend from './MapLegend.jsx';
import WorkspaceAreaEditor from './WorkspaceAreaEditor.jsx';
import {
  MapBusyState,
  MapCoverageState,
  MapEmptyAreaState,
  MapEmptyResultState,
  MapErrorState,
  MapLoadingState,
} from './MapStates.jsx';
import styles from '../ElectionsPage.module.css';

/** Below this distance from the top edge the tooltip flips under the cursor. */
const TOOLTIP_FLIP_THRESHOLD_PIXELS = 76;

/** How long the confirmation of a saved boundary stays on the map. */
const AREA_NOTICE_TIMEOUT_MS = 6000;

/**
 * How durable a save turned out to be. The three outcomes are genuinely
 * different promises to the user, and a boundary that only lives in one browser
 * must never read as one that everybody now shares.
 */
const SAVE_OUTCOMES = {
  server: {
    text: 'Нову межу збережено на сервері — карта, список і дані будинків уже за нею.',
    isWarning: false,
  },
  local: {
    text:
      'Межу застосовано і збережено в цьому браузері, але сервер недоступний — ' +
      'для інших користувачів територія поки не змінилася.',
    isWarning: true,
  },
  memory: {
    text:
      'Межу застосовано, але зберегти її не вдалося — вона діятиме лише до ' +
      'перезавантаження сторінки.',
    isWarning: true,
  },
};

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
  coverage,
  hasMissingCoverage,
  isAreaEmpty,
  isRefreshingFromOsm,
  onRefreshFromOsm,
  isAreaEditing,
  onEnterAreaEditing,
  onExitAreaEditing,
}) {
  const [basemapId, setBasemapId] = useState(DEFAULT_BASEMAP_ID);
  const [hoveredHouseId, setHoveredHouseId] = useState(null);
  const [tooltipPosition, setTooltipPosition] = useState(null);
  const [areaNotice, setAreaNotice] = useState(null);
  /* Whether the map has ever finished a load — the full-surface skeleton is
   * only honest before there is any cartography underneath it. */
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  const area = useWorkspaceArea();

  useEffect(() => {
    if (status === 'ready') {
      setHasLoadedOnce(true);
    }
  }, [status]);

  const {
    containerRef,
    map,
    canZoomIn,
    canZoomOut,
    zoomIn,
    zoomOut,
    resetView,
    focusOnBounds,
  } = useLeafletMap({ basemapId, isAreaEditing });

  const areaEditor = useWorkspaceEditor({ map, isActive: isAreaEditing });

  /*
   * Saving closes the editor on purpose: the new border, the dimmed
   * surroundings and the re-cut set of houses are only visible once the drawing
   * surface is out of the way, and seeing them is the confirmation that the
   * boundary took effect. The banner covers what a redrawn map cannot say.
   */
  const handleSaveArea = useCallback(async () => {
    const result = await areaEditor.save();

    if (result.isSaved) {
      onExitAreaEditing();
      setAreaNotice(SAVE_OUTCOMES[result.storage] ?? SAVE_OUTCOMES.memory);
    }

    return result;
  }, [areaEditor, onExitAreaEditing]);

  useEffect(() => {
    if (!areaNotice) {
      return undefined;
    }

    const timeoutId = setTimeout(() => setAreaNotice(null), AREA_NOTICE_TIMEOUT_MS);

    return () => clearTimeout(timeoutId);
  }, [areaNotice]);

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
    isSelectionEnabled: !isAreaEditing,
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
          aria-label={`Карта будинків у межах території «${area.name}»`}
          className={styles.mapCanvas}
          ref={containerRef}
          role="application"
        />

        <p className="sr-only" id="elections-map-hint">
          Карта показує реальні будинки з OpenStreetMap у межах робочої
          території — окресленого полігона навколо адреси вулиця Якуба Коласа, 6.
          Територія поза межами затемнена, будинки на ній недоступні.
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

        {isAreaEditing && (
          <WorkspaceAreaEditor
            editor={areaEditor}
            onExit={onExitAreaEditing}
            onSave={handleSaveArea}
          />
        )}

        {areaNotice && (
          <p
            className={[styles.mapNotice, areaNotice.isWarning ? styles.mapNoticeWarning : '']
              .filter(Boolean)
              .join(' ')}
            data-map-overlay=""
            role="status"
          >
            <ElectionsIcon name={areaNotice.isWarning ? 'warning' : 'check'} size={16} />
            {areaNotice.text}
          </p>
        )}

        {/* The legend reads survey progress — not a question while the border
            is being traced, and the editor needs the corner it sits in. */}
        {!isAreaEditing && (
          <MapLegend
            activeStatus={fillStatusFilter}
            onStatusChange={onFillStatusChange}
            summary={summary}
          />
        )}

        {/* Only the very first load hides the map: from then on the tiles, the
            streets and the traced border stay visible under a banner, whatever
            the dataset is doing. */}
        {status === 'loading' && !hasLoadedOnce && <MapLoadingState />}

        {status === 'loading' && hasLoadedOnce && <MapBusyState />}

        {status === 'error' && <MapErrorState message={error} onRetry={onRetry} />}

        {status === 'ready' && !isAreaEditing && hasMissingCoverage && (
          <MapCoverageState
            coverage={coverage}
            isRefreshing={isRefreshingFromOsm}
            onRefresh={onRefreshFromOsm}
          />
        )}

        {status === 'ready' && !isAreaEditing && isAreaEmpty && (
          <MapEmptyAreaState onEditArea={onEnterAreaEditing} />
        )}

        {/* One banner owns the top-left corner at a time, and a missing dataset
            is the more urgent thing to say than an over-narrow filter. */}
        {status === 'ready' && hasEmptyResult && !hasMissingCoverage && (
          <MapEmptyResultState onResetFilters={onResetFilters} />
        )}
      </div>
    </div>
  );
}

export default HouseMap;
