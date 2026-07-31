/**
 * "Вибори" — interactive map of residential buildings around the campaign
 * address, with an editable survey card per house.
 *
 * This file is the orchestrator only: it owns selection, filters and edit mode,
 * and wires them to the map, the results list and the details panel. All data
 * access lives in `features/elections`, all rendering in `./components`.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { useHousesData } from '../../features/elections/useHousesData.js';
import { useAreaEditMode } from '../../features/elections/useWorkspaceEditor.js';
import {
  DEFAULT_HOUSE_FILTERS,
  filterHouses,
  formatHouses,
  hasActiveFilters as checkActiveFilters,
  summarizeHouses,
} from '../../features/elections/houseUtils.js';
import ElectionsIcon from '../../features/elections/ElectionsIcon.jsx';
import ElectionsHeader from './components/ElectionsHeader.jsx';
import ElectionsToolbar from './components/ElectionsToolbar.jsx';
import HouseDetailsPanel from './components/HouseDetailsPanel.jsx';
import HouseMap from './components/HouseMap.jsx';
import HouseResultsList from './components/HouseResultsList.jsx';
import styles from './ElectionsPage.module.css';

/** How long the "saved" confirmation stays visible. */
const SAVE_NOTICE_TIMEOUT_MS = 4000;

const PANEL_TABS = [
  { id: 'house', label: 'Картка будинку', icon: 'building' },
  { id: 'list', label: 'Список', icon: 'list' },
];

function ElectionsPage() {
  const data = useHousesData();

  /* Redrawing the boundary decides which houses exist at all, so the mode is
   * owned here — the button that opens it belongs in the page header, next to
   * the territory it describes, not hidden inside the map. */
  const areaEdit = useAreaEditMode();
  const workspaceRef = useRef(null);

  const [filters, setFilters] = useState(DEFAULT_HOUSE_FILTERS);
  const [selectedHouseId, setSelectedHouseId] = useState(null);
  const [isEditing, setIsEditing] = useState(false);
  const [activeTab, setActiveTab] = useState('house');
  const [saveNotice, setSaveNotice] = useState('');
  /** Bumped whenever the map should move to a house it did not select itself. */
  const [focusRequest, setFocusRequest] = useState(null);

  const summary = useMemo(() => summarizeHouses(data.houses), [data.houses]);

  const filteredHouses = useMemo(
    () => filterHouses(data.houses, filters),
    [data.houses, filters],
  );

  const matchedIds = useMemo(
    () => new Set(filteredHouses.map((house) => house.id)),
    [filteredHouses],
  );

  const selectedHouse = useMemo(
    () => data.houses.find((house) => house.id === selectedHouseId) ?? null,
    [data.houses, selectedHouseId],
  );

  const hasActiveFilters = checkActiveFilters(filters);

  useEffect(() => {
    if (!saveNotice) {
      return undefined;
    }

    const timeoutId = setTimeout(() => setSaveNotice(''), SAVE_NOTICE_TIMEOUT_MS);

    return () => clearTimeout(timeoutId);
  }, [saveNotice]);

  /** Opens the editor and brings the map — the drawing surface — into view. */
  function enterAreaEditing() {
    areaEdit.enter();
    setIsEditing(false);
    workspaceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function toggleAreaEditing() {
    if (areaEdit.isActive) {
      areaEdit.exit();
      return;
    }

    enterAreaEditing();
  }

  function updateFilters(patch) {
    setFilters((current) => ({ ...current, ...patch }));
  }

  function resetFilters() {
    setFilters(DEFAULT_HOUSE_FILTERS);
  }

  /** Selection from the map: no camera move, the user is already looking there. */
  function selectHouse(houseId) {
    setSelectedHouseId(houseId);
    setIsEditing(false);
    setSaveNotice('');
    data.dismissSaveError();

    if (houseId) {
      setActiveTab('house');
    }
  }

  /** Selection from the list or search: bring the house into view. */
  function selectAndFocusHouse(houseId) {
    selectHouse(houseId);

    if (houseId) {
      // A monotonic token lets the map tell "focus again" from a re-render,
      // even when the same house is picked twice in a row.
      setFocusRequest((current) => ({ houseId, token: (current?.token ?? 0) + 1 }));
    }
  }

  async function handleSave(details) {
    const wasSaved = await data.saveDetails(selectedHouseId, details);

    if (wasSaved) {
      setIsEditing(false);
      setSaveNotice('Дані будинку збережено.');
    }
  }

  const isMapEmpty =
    data.isReady && data.houses.length > 0 && filteredHouses.length === 0;

  return (
    <main className={styles.page}>
      <ElectionsHeader
        area={data.area}
        isAreaEditing={areaEdit.isActive}
        isLoading={data.isLoading}
        onResetDemoData={data.resetDemoData}
        onToggleAreaEditing={toggleAreaEditing}
        summary={summary}
      />

      <ElectionsToolbar
        filters={filters}
        hasActiveFilters={hasActiveFilters}
        houses={data.houses}
        isDisabled={!data.isReady}
        onFiltersChange={updateFilters}
        onResetFilters={resetFilters}
        onSelectHouse={(house) => selectAndFocusHouse(house.id)}
        resultCount={filteredHouses.length}
        streets={data.streets}
        summary={summary}
      />

      <div className={styles.workspace} ref={workspaceRef}>
        <HouseMap
          coverage={data.coverage}
          error={data.error}
          fillStatusFilter={filters.fillStatus}
          focusRequest={focusRequest}
          hasEmptyResult={isMapEmpty}
          hasMissingCoverage={data.hasMissingCoverage}
          houses={data.houses}
          isAreaEditing={areaEdit.isActive}
          isAreaEmpty={data.isAreaEmpty}
          isRefreshingFromOsm={data.isRefreshingFromOsm}
          matchedIds={matchedIds}
          onEnterAreaEditing={enterAreaEditing}
          onExitAreaEditing={areaEdit.exit}
          onFillStatusChange={(fillStatus) => updateFilters({ fillStatus })}
          onRefreshFromOsm={data.refreshFromOsm}
          onResetFilters={resetFilters}
          onRetry={data.reload}
          onSelectHouse={selectHouse}
          selectedHouse={selectedHouse}
          status={data.status}
          summary={summary}
        />

        <aside className={styles.sideColumn}>
          <div aria-label="Панель будинків" className={styles.tabs} role="tablist">
            {PANEL_TABS.map((tab) => (
              <button
                aria-controls={`elections-panel-${tab.id}`}
                aria-selected={activeTab === tab.id}
                className={[styles.tab, activeTab === tab.id ? styles.tabActive : '']
                  .filter(Boolean)
                  .join(' ')}
                id={`elections-tab-${tab.id}`}
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                role="tab"
                type="button"
              >
                <ElectionsIcon name={tab.icon} size={16} />
                {tab.label}
                {tab.id === 'list' && (
                  <span className={styles.tabCount}>{filteredHouses.length}</span>
                )}
              </button>
            ))}
          </div>

          <div
            aria-labelledby="elections-tab-house"
            className={styles.tabPanel}
            hidden={activeTab !== 'house'}
            id="elections-panel-house"
            role="tabpanel"
          >
            <HouseDetailsPanel
              hasError={data.hasError}
              house={selectedHouse}
              isEditing={isEditing}
              isLoading={data.isLoading}
              isSaving={
                Boolean(selectedHouseId) && data.savingHouseId === selectedHouseId
              }
              onCancelEditing={() => {
                setIsEditing(false);
                data.dismissSaveError();
              }}
              onClose={() => selectHouse(null)}
              onSave={handleSave}
              onStartEditing={() => {
                setIsEditing(true);
                setSaveNotice('');
              }}
              saveError={data.saveError}
              saveNotice={saveNotice}
            />
          </div>

          <div
            aria-labelledby="elections-tab-list"
            className={styles.tabPanel}
            hidden={activeTab !== 'list'}
            id="elections-panel-list"
            role="tabpanel"
          >
            <section className={styles.listPanel}>
              <header className={styles.listPanelHeader}>
                <strong>{formatHouses(filteredHouses.length)}</strong>
                <small>
                  {hasActiveFilters ? 'за поточними фільтрами' : 'на всій території'}
                </small>
              </header>

              <HouseResultsList
                hasActiveFilters={hasActiveFilters}
                houses={filteredHouses}
                isLoading={data.isLoading}
                onResetFilters={resetFilters}
                onSelectHouse={selectAndFocusHouse}
                selectedHouseId={selectedHouseId}
              />
            </section>
          </div>
        </aside>
      </div>
    </main>
  );
}

export default ElectionsPage;
