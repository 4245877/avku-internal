/**
 * The interactive district map.
 *
 * Base cartography comes from a real map service (OpenStreetMap and Esri by
 * default, see `features/elections/basemaps.js`), so streets, yards, house
 * numbers and building outlines are the actual ones on the ground, in both
 * «Карта» and «Супутник». On top of it every surveyed building from the OSM
 * dataset is its own clickable polygon.
 *
 * The mode is state here rather than inside the map hook because it is a user
 * preference, not a property of the map: it is restored from the last visit and
 * written back on every change, while the map instance below it never restarts.
 *
 * Keyboard users reach individual houses through the results list, which is the
 * accessible equivalent of clicking a shape; the map surface itself keeps
 * Leaflet's arrow-key panning and +/- zoom.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import 'leaflet/dist/leaflet.css';

import {
  DEFAULT_MAP_MODE_ID,
  getMapMode,
  readStoredMapMode,
  writeStoredMapMode,
} from '../../../features/elections/basemaps.js';
import { useCoverageNotice } from '../../../features/elections/coverageNotice.js';
import { useHouseLayer } from '../../../features/elections/useHouseLayer.js';
import { useLeafletMap } from '../../../features/elections/useLeafletMap.js';
import { useWorkspaceArea } from '../../../features/elections/useWorkspaceArea.js';
import { useWorkspaceEditor } from '../../../features/elections/useWorkspaceEditor.js';
import { AREA_CENTER } from '../../../features/elections/geo.js';
import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import HouseTooltip from './HouseTooltip.jsx';
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
  MapTilesErrorState,
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
  stageFilter,
  onStageChange,
  onResetFilters,
  hasEmptyResult,
  coverage,
  hasMissingCoverage,
  isAreaEmpty,
  osmRefresh,
  onRefreshFromOsm,
  onCancelRefreshFromOsm,
  onDismissOsmRefresh,
  isAreaEditing,
  onEnterAreaEditing,
  onExitAreaEditing,
  campaign,
  canEditArea,
}) {
  /* Read once, before the first paint: the map must open on the mode the user
   * left it in, not switch under them a frame later. */
  const [mapModeId, setMapModeId] = useState(() => readStoredMapMode() ?? DEFAULT_MAP_MODE_ID);
  const [hoveredHouseId, setHoveredHouseId] = useState(null);
  const [tooltipPosition, setTooltipPosition] = useState(null);
  /** The house a long press asked about — the touch equivalent of hovering. */
  const [previewHouseId, setPreviewHouseId] = useState(null);
  const [areaNotice, setAreaNotice] = useState(null);
  /* Whether the map has ever finished a load — the full-surface skeleton is
   * only honest before there is any cartography underneath it. */
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  const area = useWorkspaceArea();

  /* Closed by hand, and closed for one particular gap: a remount, a reload or
   * a rebuild does not reopen it, a re-traced boundary or a new dataset does. */
  const coverageNotice = useCoverageNotice(coverage);

  useEffect(() => {
    if (status === 'ready') {
      setHasLoadedOnce(true);
    }
  }, [status]);

  const mapMode = getMapMode(mapModeId);

  const {
    containerRef,
    map,
    canZoomIn,
    canZoomOut,
    zoomIn,
    zoomOut,
    resetView,
    focusOnBounds,
    tileStatus,
    retryTiles,
  } = useLeafletMap({ mapModeId, isAreaEditing });

  /* Switching the base layer changes nothing but the tiles — the view, the
   * selected house, the traced boundary and the editor all outlive it. All that
   * is left to do is remember the choice for the next visit. */
  const handleModeChange = useCallback((id) => {
    setMapModeId(id);
    writeStoredMapMode(id);
  }, []);

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

  /*
   * A finished download closes its own banner — the houses are on the map by
   * then, so the confirmation is a receipt, not a state to sit in.
   */
  useEffect(() => {
    if (osmRefresh.status !== 'success') {
      return undefined;
    }

    const timeoutId = setTimeout(onDismissOsmRefresh, AREA_NOTICE_TIMEOUT_MS);

    return () => clearTimeout(timeoutId);
  }, [onDismissOsmRefresh, osmRefresh.status]);

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
    isImageryBasemap: mapMode.isImagery,
    isSelectionEnabled: !isAreaEditing,
    onSelectHouse: handleSelectHouse,
    onHoverHouse: handleHoverHouse,
    onLongPressHouse: setPreviewHouseId,
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
  const previewHouse = previewHouseId ? (housesById.get(previewHouseId) ?? null) : null;

  const isTooltipBelow =
    tooltipPosition !== null && tooltipPosition.y < TOOLTIP_FLIP_THRESHOLD_PIXELS;

  return (
    <div className={styles.mapFrame}>
      <div className={styles.mapSurface}>
        <div
          aria-describedby="elections-map-hint"
          aria-label={`Карта будинків у межах території «${area.name}»`}
          className={styles.mapCanvas}
          /* The photo underneath decides how the app's own labels are drawn. */
          data-map-mode={mapModeId}
          ref={containerRef}
          role="application"
        />

        <p className="sr-only" id="elections-map-hint">
          Карта показує реальні будинки з OpenStreetMap у межах робочої
          території — окресленого полігона навколо адреси {AREA_CENTER.address}.
          Територія поза межами прихована, будинки на ній недоступні.
          Перетягуйте карту стрілками, змінюйте масштаб клавішами плюс і мінус.
          Перемикач «Карта» / «Супутник» ліворуч угорі змінює підкладку:
          схему вулиць або супутникові знімки з дорогами та номерами будинків.
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
            <HouseTooltip house={hoveredHouse} />
          </div>
        )}

        {/* Touch devices never fire `mouseover`, so before this a phone had no
            preview at all — a tap went straight to the full card. A long press
            shows the same five lines as a sheet, and a tap on it opens the card,
            so the gesture adds a step rather than replacing one. */}
        {previewHouse && (
          <div className={styles.mapPreviewSheet} role="dialog" aria-label="Довідка про будинок">
            <button
              className={styles.mapPreviewBody}
              onClick={() => {
                onSelectHouse(previewHouse.id);
                setPreviewHouseId(null);
              }}
              type="button"
            >
              <HouseTooltip house={previewHouse} />
            </button>

            <button
              aria-label="Закрити довідку"
              className={styles.mapPreviewClose}
              onClick={() => setPreviewHouseId(null)}
              type="button"
            >
              <ElectionsIcon name="close" size={16} />
            </button>
          </div>
        )}

        <MapControls
          canZoomIn={canZoomIn}
          canZoomOut={canZoomOut}
          onReset={resetView}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
        />

        <MapBasemapSwitcher
          activeId={mapModeId}
          onChange={handleModeChange}
          tileStatus={tileStatus}
        />

        {isAreaEditing && (
          <WorkspaceAreaEditor
            editor={areaEditor}
            onExit={onExitAreaEditing}
            onSave={handleSaveArea}
          />
        )}

        {/* One notice slot, and a freshly downloaded dataset is the newer news
            of the two — a saved boundary is what caused the download. */}
        {!areaNotice && osmRefresh.status === 'success' && (
          <p className={styles.mapNotice} data-map-overlay="" role="status">
            <ElectionsIcon name="check" size={16} />
            {osmRefresh.houseCount > 0
              ? `Дані оновлено з OpenStreetMap — ${osmRefresh.houseCount} буд. у межах території.`
              : 'Дані оновлено з OpenStreetMap — у межах цієї території будинків немає.'}
          </p>
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
            activeStage={stageFilter}
            headquartersLabel={campaign?.hqAddress || AREA_CENTER.address}
            onStageChange={onStageChange}
            summary={summary}
          />
        )}

        {/* Only the very first load hides the map: from then on the tiles, the
            streets and the traced border stay visible under a banner, whatever
            the dataset is doing. */}
        {status === 'loading' && !hasLoadedOnce && <MapLoadingState />}

        {status === 'loading' && hasLoadedOnce && <MapBusyState />}

        {status === 'error' && <MapErrorState message={error} onRetry={onRetry} />}

        {/* A dead tile service is the second-most urgent thing the map can
            say, and unlike the states below it, it is true in every mode and
            at every stage of the dataset's life. */}
        {status !== 'error' && tileStatus === 'error' && (
          <MapTilesErrorState mode={mapMode} onRetry={retryTiles} />
        )}

        {status === 'ready' &&
          tileStatus !== 'error' &&
          !isAreaEditing &&
          hasMissingCoverage &&
          !coverageNotice.isDismissed && (
            <MapCoverageState
              coverage={coverage}
              onCancel={onCancelRefreshFromOsm}
              onDismiss={coverageNotice.dismiss}
              onRefresh={onRefreshFromOsm}
              refresh={osmRefresh}
            />
          )}

        {status === 'ready' && tileStatus !== 'error' && !isAreaEditing && isAreaEmpty && (
          <MapEmptyAreaState onEditArea={canEditArea ? onEnterAreaEditing : undefined} />
        )}

        {/* One banner owns the top-left corner at a time, and a missing dataset
            or missing cartography is the more urgent thing to say than an
            over-narrow filter. */}
        {status === 'ready' &&
          tileStatus !== 'error' &&
          hasEmptyResult &&
          !hasMissingCoverage && <MapEmptyResultState onResetFilters={onResetFilters} />}
      </div>
    </div>
  );
}

export default HouseMap;
