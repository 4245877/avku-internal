/**
 * "Вибори" — the field-work module: an interactive map of the campaign's
 * buildings, with a working card behind each one.
 *
 * This file is the orchestrator only: it owns selection, filters, edit mode and
 * the two overlay panels (import, bulk assignment), and wires them to the map,
 * the results list and the details panel. All data access lives in
 * `features/elections`, all rendering in `./components`.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { useHousesData } from '../../features/elections/useHousesData.js';
import { useAreaEditMode } from '../../features/elections/useWorkspaceEditor.js';
import {
  DEFAULT_HOUSE_FILTERS,
  campaignStateOf,
  filterHouses,
  formatHouses,
  hasActiveFilters as checkActiveFilters,
  summarizeHouses,
} from '../../features/elections/houseUtils.js';
import {
  createImportBatch,
  fetchPrecincts,
  updateIssue,
  updateTask,
} from '../../features/elections/electionsApi.js';
import ElectionsIcon from '../../features/elections/ElectionsIcon.jsx';
import BulkAssignDialog from './components/BulkAssignDialog.jsx';
import ElectionsHeader from './components/ElectionsHeader.jsx';
import ElectionsToolbar from './components/ElectionsToolbar.jsx';
import HouseDetailsPanel from './components/HouseDetailsPanel.jsx';
import HouseMap from './components/HouseMap.jsx';
import HouseResultsList from './components/HouseResultsList.jsx';
import ImportPanel from './components/ImportPanel.jsx';
import LegacyDataNotice from './components/LegacyDataNotice.jsx';
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
  const [overlay, setOverlay] = useState(null);
  const [precincts, setPrecincts] = useState([]);
  /** Bumped after any write, so the open card tab reloads its records. */
  const [refreshToken, setRefreshToken] = useState(0);
  /** Bumped whenever the map should move to a house it did not select itself. */
  const [focusRequest, setFocusRequest] = useState(null);

  const role = data.viewer?.role ?? null;
  const canManage = role === 'manager' || role === 'admin';

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

  /** Everybody who is responsible for at least one visible house. */
  const assignees = useMemo(() => {
    const emails = new Set();

    for (const house of data.houses) {
      for (const assignee of campaignStateOf(house).assignees) {
        emails.add(assignee.email);
      }
    }

    return [...emails].sort();
  }, [data.houses]);

  const hasActiveFilters = checkActiveFilters(filters);

  useEffect(() => {
    if (!data.isBackend) {
      return undefined;
    }

    const controller = new AbortController();

    fetchPrecincts({ signal: controller.signal })
      .then(setPrecincts)
      .catch(() => {
        // No precinct directory yet is a normal early state, not an error: the
        // filter simply has nothing to offer until one is created.
      });

    return () => controller.abort();
  }, [data.isBackend]);

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

  /** Runs a write and, when it lands, refreshes the open tab's records. */
  async function afterWrite(saved, notice) {
    if (saved) {
      setRefreshToken((current) => current + 1);
      setSaveNotice(notice);
    }

    return saved;
  }

  async function handleSaveAttributes(patch) {
    const saved = await data.saveAttributes(selectedHouseId, patch);

    if (saved) {
      setIsEditing(false);
    }

    return afterWrite(saved, 'Характеристики будинку збережено.');
  }

  async function handleSaveState(patch) {
    const saved = await data.saveState(selectedHouseId, patch);

    if (saved) {
      setIsEditing(false);
    }

    return afterWrite(saved, 'Стан у кампанії збережено.');
  }

  async function handleCompleteTask(taskId) {
    try {
      await updateTask(taskId, { status: 'done' }, { campaignId: data.campaignId });
      await data.refreshHouse(selectedHouseId);

      return afterWrite(true, 'Задачу позначено виконаною.');
    } catch {
      return false;
    }
  }

  async function handleResolveIssue(issueId) {
    try {
      await updateIssue(issueId, { status: 'resolved' }, { campaignId: data.campaignId });
      await data.refreshHouse(selectedHouseId);

      return afterWrite(true, 'Звернення позначено вирішеним.');
    } catch {
      return false;
    }
  }

  const isMapEmpty =
    data.isReady && data.houses.length > 0 && filteredHouses.length === 0;

  return (
    <main className={styles.page}>
      <ElectionsHeader
        area={data.area}
        campaign={data.campaign}
        campaigns={data.campaigns}
        isAreaEditing={areaEdit.isActive}
        isLoading={data.isLoading}
        onOpenBulkAssign={() => setOverlay('bulk')}
        onOpenImport={() => setOverlay('import')}
        onSelectCampaign={data.selectCampaign}
        onToggleAreaEditing={toggleAreaEditing}
        summary={summary}
        viewer={data.viewer}
      />

      {/* Work that only exists in this browser has to be rescued before
          anything else — the banner stays until it has been dealt with. */}
      <LegacyDataNotice
        canImport={role === 'admin'}
        onUpload={(document) =>
          createImportBatch(
            {
              kind: 'legacy_local',
              fileName: 'avku-elections-details-v1.json',
              document,
            },
            { campaignId: data.campaignId },
          )
        }
      />

      {overlay === 'import' && (
        <ImportPanel campaignId={data.campaignId} onClose={() => setOverlay(null)} />
      )}

      {overlay === 'bulk' && canManage && (
        <BulkAssignDialog
          campaignId={data.campaignId}
          houses={filteredHouses}
          knownAssignees={assignees}
          onApplied={data.reload}
          onClose={() => setOverlay(null)}
        />
      )}

      <ElectionsToolbar
        assignees={assignees}
        filters={filters}
        hasActiveFilters={hasActiveFilters}
        houses={data.houses}
        isDisabled={!data.isReady}
        onFiltersChange={updateFilters}
        onResetFilters={resetFilters}
        onSelectHouse={(house) => selectAndFocusHouse(house.id)}
        precincts={precincts}
        resultCount={filteredHouses.length}
        streets={data.streets}
        summary={summary}
      />

      <div className={styles.workspace} ref={workspaceRef}>
        <HouseMap
          campaign={data.campaign}
          canEditArea={role === 'admin'}
          coverage={data.coverage}
          error={data.error}
          focusRequest={focusRequest}
          hasEmptyResult={isMapEmpty}
          hasMissingCoverage={data.hasMissingCoverage}
          houses={data.houses}
          isAreaEditing={areaEdit.isActive}
          isAreaEmpty={data.isAreaEmpty}
          matchedIds={matchedIds}
          onCancelRefreshFromOsm={data.cancelRefreshFromOsm}
          onDismissOsmRefresh={data.dismissOsmRefresh}
          onEnterAreaEditing={enterAreaEditing}
          onExitAreaEditing={areaEdit.exit}
          onRefreshFromOsm={data.refreshFromOsm}
          onResetFilters={resetFilters}
          onRetry={data.reload}
          onSelectHouse={selectHouse}
          onStageChange={(stage) => updateFilters({ stage })}
          osmRefresh={data.osmRefresh}
          selectedHouse={selectedHouse}
          stageFilter={filters.stage}
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
              campaignId={data.campaignId}
              hasError={data.hasError}
              house={selectedHouse}
              isEditing={isEditing}
              isLoading={data.isLoading}
              isSaving={
                Boolean(selectedHouseId) && data.savingHouseId === selectedHouseId
              }
              onAddAction={(payload) =>
                data
                  .addAction(selectedHouseId, payload)
                  .then((saved) => afterWrite(saved, 'Дію записано.'))
              }
              onAddIssue={(payload) =>
                data
                  .addIssue(selectedHouseId, payload)
                  .then((saved) => afterWrite(saved, 'Звернення створено.'))
              }
              onAddPerson={(payload) =>
                data
                  .addPerson(selectedHouseId, payload)
                  .then((saved) => afterWrite(saved, 'Контактну особу додано.'))
              }
              onAddPhoto={(file) =>
                data
                  .addAttachment(selectedHouseId, file)
                  .then((saved) => afterWrite(saved, 'Фото завантажено.'))
              }
              onAddTask={(payload) =>
                data
                  .addTask(selectedHouseId, payload)
                  .then((saved) => afterWrite(saved, 'Задачу створено.'))
              }
              onCancelEditing={() => {
                setIsEditing(false);
                data.dismissSaveError();
              }}
              onClose={() => selectHouse(null)}
              onCompleteTask={handleCompleteTask}
              onResolveIssue={handleResolveIssue}
              onSaveAttributes={handleSaveAttributes}
              onSaveState={handleSaveState}
              onStartEditing={() => {
                setIsEditing(true);
                setSaveNotice('');
              }}
              refreshToken={refreshToken}
              saveError={data.saveError}
              saveNotice={saveNotice}
              viewer={data.viewer}
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
