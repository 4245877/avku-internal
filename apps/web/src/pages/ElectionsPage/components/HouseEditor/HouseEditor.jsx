/**
 * The full-screen house editor.
 *
 * The side card answers "what is going on here" in one glance and is the right
 * shape for that. It is the wrong shape for *filling the record in*: forty
 * fields, ten collections and six kinds of sub-form do not go into a 380px
 * column beside a map, and trying made every one of them a compromise. So the
 * card keeps its job and hands over to this — a surface that takes the whole
 * page, opened by «Редагувати» and closed back onto the same map, with the same
 * house still selected, at the same zoom, under the same filters.
 *
 * Three decisions shape everything below.
 *
 * **The map is never unmounted.** The editor is an overlay over a live page,
 * not a route. That is what makes "close and you are exactly where you were"
 * true by construction rather than by restoring a saved camera position.
 *
 * **Sections are lazy and cached.** Only «Основне» is needed to open; every
 * other collection is fetched when its section is first shown and then kept, so
 * moving between them is instant and a house nobody opens the files of never
 * downloads them. Switching house cancels whatever is in flight.
 *
 * **Nothing is lost silently.** Ordinary fields accumulate in a draft, so a
 * half-filled form survives a trip to another section; and every exit — the
 * close button, Escape, the browser's back gesture, switching to the next house
 * — goes through the same guard, which asks before it discards.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  campaignStateOf,
  formatAssignee,
  formatPrecincts,
  formatUpdatedAt,
  getPriority,
  getStage,
} from '../../../../features/elections/houseUtils.js';
import { useEditorCollections } from '../../../../features/elections/useEditorCollections.js';
import { useHouseEditor } from '../../../../features/elections/useHouseEditor.js';
import { fetchHouse } from '../../../../features/elections/electionsApi.js';
import { useTablistKeys } from '../../../../features/elections/useTablistKeys.js';
import ElectionsIcon from '../../../../features/elections/ElectionsIcon.jsx';
import ActionsSection from './ActionsSection.jsx';
import AssigneesSection from './AssigneesSection.jsx';
import BuildingSection from './BuildingSection.jsx';
import EventsSection from './EventsSection.jsx';
import FilesSection from './FilesSection.jsx';
import HistorySection from './HistorySection.jsx';
import IssuesSection from './IssuesSection.jsx';
import MainSection from './MainSection.jsx';
import PeopleSection from './PeopleSection.jsx';
import TasksSection from './TasksSection.jsx';
import { Button } from './editorFields.jsx';
import styles from './HouseEditor.module.css';

/**
 * The ten sections, in the order somebody works through them.
 *
 * `collection` names the lazily loaded records the section needs — `null` for
 * the two that are already on screen the moment the editor opens.
 */
export const EDITOR_SECTIONS = [
  { id: 'main', label: 'Основне', icon: 'list', collection: null },
  { id: 'building', label: 'Характеристики', icon: 'building', collection: null },
  { id: 'people', label: 'Контактні особи', icon: 'contacts', collection: 'people' },
  { id: 'assignees', label: 'Відповідальні', icon: 'users', collection: null },
  { id: 'actions', label: 'Дії', icon: 'phone', collection: 'actions' },
  { id: 'issues', label: 'Звернення', icon: 'warning', collection: 'issues' },
  { id: 'tasks', label: 'Завдання', icon: 'check', collection: 'tasks' },
  { id: 'events', label: 'Події', icon: 'map', collection: 'events' },
  { id: 'files', label: 'Файли', icon: 'layers', collection: 'files' },
  { id: 'history', label: 'Історія', icon: 'refresh', collection: 'history' },
];

const SECTION_IDS = EDITOR_SECTIONS.map((section) => section.id);

const toneClassNames = {
  success: styles.toneSuccess,
  warning: styles.toneWarning,
  danger: styles.toneDanger,
  info: styles.toneInfo,
  accent: styles.toneAccent,
  neutral: styles.toneNeutral,
  muted: styles.toneMuted,
};

/**
 * The one place an exit can be refused.
 *
 * Every way out of the editor routes through `guard`, so there is exactly one
 * rule about unsaved work rather than one per button — and a new exit added
 * later cannot forget it.
 */
function useUnsavedGuard(isDirty) {
  const [pendingExit, setPendingExit] = useState(null);

  const guard = useCallback(
    (proceed) => {
      if (!isDirty) {
        proceed();

        return;
      }

      setPendingExit(() => proceed);
    },
    [isDirty],
  );

  const confirmExit = useCallback(() => {
    setPendingExit((current) => {
      current?.();

      return null;
    });
  }, []);

  const cancelExit = useCallback(() => setPendingExit(null), []);

  /* The browser's own dialog for a reload or a closed tab — the one case a
   * React confirmation cannot reach. */
  useEffect(() => {
    if (!isDirty) {
      return undefined;
    }

    const onBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', onBeforeUnload);

    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);

  return { guard, pendingExit: Boolean(pendingExit), confirmExit, cancelExit };
}

function HouseEditor({
  house,
  campaign,
  campaignId,
  viewer,
  precincts,
  knownAssignees,
  isDetailsLoading,
  detailsError,
  neighbours,
  onClose,
  onSelectHouse,
  onSaved,
}) {
  const [activeSection, setActiveSection] = useState('main');
  const bodyRef = useRef(null);
  const surfaceRef = useRef(null);

  const role = viewer?.role ?? null;
  const isArchived = campaign?.status === 'archived';
  const canWrite = Boolean(role) && !isArchived;
  const canEditHouse =
    (role === 'coordinator' || role === 'manager' || role === 'admin') && !isArchived;
  const canManage = (role === 'manager' || role === 'admin') && !isArchived;

  const editor = useHouseEditor(house, {
    campaignId,
    canEditHouse,
    canEditState: canWrite,
    onSaved,
  });

  const collections = useEditorCollections(house?.id ?? null, { campaignId });
  const { guard, pendingExit, confirmExit, cancelExit } = useUnsavedGuard(editor.isDirty);

  const section = EDITOR_SECTIONS.find((one) => one.id === activeSection);

  /* Lazy loading: the collection behind the open section, and nothing else. */
  useEffect(() => {
    if (section?.collection) {
      collections.open(section.collection);
    }
  }, [collections, section]);

  /*
   * «Завдання» offers to link a task to an issue or an event of this house, so
   * it needs both lists — but only once somebody is actually on that section.
   */
  useEffect(() => {
    if (activeSection === 'tasks') {
      collections.open('issues');
      collections.open('events');
    }
  }, [activeSection, collections]);

  /* A different house is a different record: back to the top, back to «Основне». */
  useEffect(() => {
    setActiveSection('main');
  }, [house?.id]);

  useEffect(() => {
    bodyRef.current?.scrollTo?.({ top: 0 });
  }, [activeSection, house?.id]);

  /* The editor takes over the page, so the page behind it must not scroll. */
  useEffect(() => {
    const previous = document.body.style.overflow;

    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    surfaceRef.current?.focus?.();
  }, []);

  const requestClose = useCallback(() => guard(onClose), [guard, onClose]);

  /*
   * The back gesture is how a phone closes anything, so it has to close this —
   * and it has to be refusable. A history entry is pushed on open; `popstate`
   * puts it back and asks whenever there is unsaved work, so the answer to
   * "back" is a question rather than a lost form.
   */
  useEffect(() => {
    window.history.pushState({ electionsEditor: true }, '');

    const onPopState = () => {
      guard(() => onClose());

      // Re-armed unconditionally: if the exit was refused this restores the
      // entry the browser just consumed, and if it was allowed the effect's
      // cleanup takes it away again on unmount.
      window.history.pushState({ electionsEditor: true }, '');
    };

    window.addEventListener('popstate', onPopState);

    return () => {
      window.removeEventListener('popstate', onPopState);

      if (window.history.state?.electionsEditor) {
        window.history.back();
      }
    };
    // Bound once per open. `guard` changes with the dirty flag and re-binding
    // on every keystroke would push a history entry per character.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        requestClose();
      }
    };

    window.addEventListener('keydown', onKeyDown);

    return () => window.removeEventListener('keydown', onKeyDown);
  }, [requestClose]);

  const tabs = useTablistKeys(SECTION_IDS, activeSection, setActiveSection);

  /** A write inside a section: refresh the record and the lists it touched. */
  const afterWrite = useCallback(
    (...names) => {
      collections.invalidate(...names, 'history');
      onSaved?.(null);
    },
    [collections, onSaved],
  );

  /** The conflict banner's «Оновити дані» — re-read and re-baseline. */
  const reloadFromServer = useCallback(async () => {
    try {
      const fresh = await fetchHouse(house.id, { campaignId });

      editor.adopt(fresh);
      onSaved?.(fresh);
    } catch {
      // The banner stays up; the user can still choose to force the save.
    }
  }, [campaignId, editor, house?.id, onSaved]);

  const state = campaignStateOf(house);
  const stage = getStage(house);
  const priority = getPriority(house);

  const neighbourIndex = useMemo(
    () => neighbours.findIndex((one) => one === house?.id),
    [house?.id, neighbours],
  );

  const goToNeighbour = (delta) => {
    const next = neighbours[neighbourIndex + delta];

    if (next) {
      guard(() => onSelectHouse(next));
    }
  };

  if (!house) {
    return null;
  }

  const readOnlyReason = isArchived
    ? 'Кампанію заархівовано — дані доступні лише для читання.'
    : !role
      ? 'Для редагування потрібна роль у розділі «Вибори».'
      : null;

  /*
   * Rendered into `document.body`, not in place.
   *
   * `.page` finishes its reveal animation with `fill-mode: both`, so it keeps a
   * `transform` forever — and a transformed ancestor becomes the containing
   * block for `position: fixed`. In place, "full screen" therefore meant "as
   * big as the page element", which on a phone measured 4 199px tall against an
   * 844px viewport: the overlay scrolled with the page instead of covering it.
   * A portal escapes the transform, and the fixed overlay means the viewport
   * again.
   */
  return createPortal(
    <div
      aria-label={`Редагування будинку ${house.address}`}
      aria-modal="true"
      className={styles.overlay}
      role="dialog"
    >
      <div className={styles.surface} ref={surfaceRef} tabIndex={-1}>
        <header className={styles.header}>
          <div className={styles.headerMain}>
            <div className={styles.headerTitleRow}>
              <button
                aria-label="Попередній будинок"
                className={styles.navArrow}
                disabled={neighbourIndex <= 0}
                onClick={() => goToNeighbour(-1)}
                type="button"
              >
                <ElectionsIcon name="chevronRight" size={18} />
              </button>

              <div className={styles.headerTitleBlock}>
                <h2 className={styles.headerTitle}>{house.address}</h2>

                <p className={styles.headerSubtitle}>
                  {isDetailsLoading ? 'дільниця — завантаження…' : formatPrecincts(house)}
                  {campaign && <> · {campaign.name}</>}
                </p>
              </div>

              <button
                aria-label="Наступний будинок"
                className={`${styles.navArrow} ${styles.navArrowNext}`}
                disabled={neighbourIndex < 0 || neighbourIndex >= neighbours.length - 1}
                onClick={() => goToNeighbour(1)}
                type="button"
              >
                <ElectionsIcon name="chevronRight" size={18} />
              </button>
            </div>

            <dl className={styles.headerFacts}>
              <div>
                <dt>Етап</dt>
                <dd>
                  <span className={`${styles.pill} ${toneClassNames[stage.tone]}`}>
                    {stage.label}
                  </span>
                </dd>
              </div>

              <div>
                <dt>Пріоритет</dt>
                <dd>
                  <span className={`${styles.pill} ${toneClassNames[priority.tone]}`}>
                    {priority.label}
                  </span>
                </dd>
              </div>

              <div>
                <dt>Відповідальні</dt>
                <dd>
                  {state.assignees.length === 0
                    ? 'не призначено'
                    : state.assignees
                      .map((one) => formatAssignee(one.email))
                      .join(', ')}
                </dd>
              </div>

              <div>
                <dt>Останні зміни</dt>
                <dd>{formatUpdatedAt(state.updatedAt ?? house.updatedAt)}</dd>
              </div>
            </dl>
          </div>

          <div className={styles.headerActions}>
            {editor.isDirty && (
              <span className={styles.dirtyMark}>Є незбережені зміни</span>
            )}

            <Button
              disabled={!editor.isDirty || editor.isSaving}
              onClick={editor.reset}
              variant="ghost"
            >
              Скасувати
            </Button>

            <Button
              disabled={!editor.isDirty || Boolean(readOnlyReason)}
              icon="check"
              isBusy={editor.isSaving}
              onClick={() => editor.save()}
              variant="primary"
            >
              {editor.isSaving ? 'Зберігаємо…' : 'Зберегти'}
            </Button>

            <button
              aria-label="Закрити редактор"
              className={styles.closeButton}
              onClick={requestClose}
              type="button"
            >
              <ElectionsIcon name="close" size={20} />
            </button>
          </div>
        </header>

        {readOnlyReason && (
          <p className={styles.readOnlyBanner} role="status">
            <ElectionsIcon name="info" size={16} />
            {readOnlyReason}
          </p>
        )}

        {detailsError && (
          <p className={styles.errorBanner} role="alert">
            <ElectionsIcon name="warning" size={16} />
            {detailsError}
          </p>
        )}

        {editor.conflict && (
          <div className={styles.conflictBanner} role="alert">
            <div>
              <strong>
                <ElectionsIcon name="warning" size={16} />
                Запис змінив інший користувач
              </strong>
              <p>{editor.conflict.message}</p>
            </div>

            <div className={styles.conflictActions}>
              <Button onClick={reloadFromServer} variant="ghost">
                Оновити дані
              </Button>

              <Button
                isBusy={editor.isSaving}
                onClick={() => editor.save({ force: true })}
                variant="primary"
              >
                Зберегти мою версію
              </Button>
            </div>
          </div>
        )}

        {editor.error && !editor.conflict && (
          <p className={styles.errorBanner} role="alert">
            <ElectionsIcon name="warning" size={16} />
            {editor.error}
          </p>
        )}

        {editor.isSaved && !editor.isDirty && (
          <p className={styles.successBanner} role="status">
            <ElectionsIcon name="check" size={16} />
            Зміни збережено.
          </p>
        )}

        <div className={styles.layout}>
          <nav
            aria-label="Розділи редактора"
            className={styles.sectionNav}
            onKeyDown={tabs.onKeyDown}
            ref={tabs.listRef}
            role="tablist"
          >
            {EDITOR_SECTIONS.map((one) => (
              <button
                {...tabs.tabProps(one.id)}
                aria-controls={`editor-panel-${one.id}`}
                className={[
                  styles.sectionTab,
                  activeSection === one.id ? styles.sectionTabActive : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                id={`editor-tab-${one.id}`}
                key={one.id}
                onClick={() => setActiveSection(one.id)}
                /* A description, not part of the name: an `aria-label` on the
                   dot below would rename the tab itself to "Основне незбережені
                   зміни", so "go to Основне" would stop matching it. */
                title={
                  (one.id === 'main' && editor.isStateDirty) ||
                    (one.id === 'building' && editor.isHouseDirty)
                    ? 'Є незбережені зміни'
                    : undefined
                }
              >
                <ElectionsIcon name={one.icon} size={16} />
                <span>{one.label}</span>

                {/* The two sections that hold a draft say so, so a person who
                    navigated away knows where their unsaved typing is. */}
                {((one.id === 'main' && editor.isStateDirty) ||
                  (one.id === 'building' && editor.isHouseDirty)) && (
                  <span aria-hidden="true" className={styles.tabDot} />
                )}
              </button>
            ))}
          </nav>

          <div
            aria-labelledby={`editor-tab-${activeSection}`}
            className={styles.body}
            id={`editor-panel-${activeSection}`}
            ref={bodyRef}
            role="tabpanel"
            tabIndex={0}
          >
            {activeSection === 'main' && (
              <MainSection
                campaign={campaign}
                draft={editor.stateDraft}
                house={house}
                isReadOnly={!canWrite}
                onChange={editor.updateState}
              />
            )}

            {activeSection === 'building' && (
              <BuildingSection
                campaignId={campaignId}
                draft={editor.houseDraft}
                errors={editor.errors}
                house={house}
                isReadOnly={!canEditHouse}
                onChange={editor.updateHouse}
                onPrecinctsChanged={() => afterWrite()}
                precincts={precincts}
                showErrors={editor.showErrors}
              />
            )}

            {activeSection === 'people' && (
              <PeopleSection
                campaignId={campaignId}
                canDeletePeople={canManage}
                canEditPeople={canEditHouse}
                canWrite={canWrite}
                house={house}
                isReadOnly={!canWrite}
                onChanged={() => afterWrite('people')}
                state={collections.get('people')}
              />
            )}

            {activeSection === 'assignees' && (
              <AssigneesSection
                campaignId={campaignId}
                canAssign={canEditHouse}
                house={house}
                isReadOnly={!canWrite}
                knownAssignees={knownAssignees}
                onChanged={() => afterWrite()}
              />
            )}

            {activeSection === 'actions' && (
              <ActionsSection
                campaignId={campaignId}
                canDelete={canEditHouse}
                canWrite={canWrite}
                house={house}
                isReadOnly={!canWrite}
                onChanged={() => afterWrite('actions')}
                state={collections.get('actions')}
              />
            )}

            {activeSection === 'issues' && (
              <IssuesSection
                campaignId={campaignId}
                canWrite={canWrite}
                house={house}
                isReadOnly={!canWrite}
                knownAssignees={knownAssignees}
                onChanged={() => afterWrite('issues')}
                state={collections.get('issues')}
              />
            )}

            {activeSection === 'tasks' && (
              <TasksSection
                campaignId={campaignId}
                canWrite={canWrite}
                eventsState={collections.get('events')}
                house={house}
                isReadOnly={!canWrite}
                issuesState={collections.get('issues')}
                knownAssignees={knownAssignees}
                onChanged={() => afterWrite('tasks')}
                state={collections.get('tasks')}
              />
            )}

            {activeSection === 'events' && (
              <EventsSection
                campaignId={campaignId}
                canManageEvents={canEditHouse}
                house={house}
                isReadOnly={!canWrite}
                onChanged={() => afterWrite('events')}
                state={collections.get('events')}
              />
            )}

            {activeSection === 'files' && (
              <FilesSection
                campaignId={campaignId}
                canWrite={canWrite}
                house={house}
                isReadOnly={!canWrite}
                onChanged={() => afterWrite('files')}
                state={collections.get('files')}
              />
            )}

            {activeSection === 'history' && (
              <HistorySection state={collections.get('history')} />
            )}
          </div>
        </div>

        {/* On a phone the header scrolls away; saving must not. */}
        <footer className={styles.mobileBar}>
          <Button onClick={requestClose} variant="ghost">
            Закрити
          </Button>

          <Button
            disabled={!editor.isDirty || Boolean(readOnlyReason)}
            icon="check"
            isBusy={editor.isSaving}
            onClick={() => editor.save()}
            variant="primary"
          >
            {editor.isSaving ? 'Зберігаємо…' : 'Зберегти'}
          </Button>
        </footer>
      </div>

      {pendingExit && (
        <div className={styles.confirmOverlay} role="alertdialog" aria-modal="true">
          <div className={styles.confirmDialog}>
            <h3>
              <ElectionsIcon name="warning" size={18} />
              Є незбережені зміни
            </h3>

            <p>
              Зміни в розділах «Основне» та «Характеристики» ще не збережені.
              Якщо вийти зараз, їх буде втрачено.
            </p>

            <div className={styles.confirmActions}>
              <Button onClick={cancelExit} variant="ghost">
                Повернутись до редагування
              </Button>

              <Button
                isBusy={editor.isSaving}
                onClick={async () => {
                  const saved = await editor.save();

                  if (saved) {
                    confirmExit();
                  }
                }}
                variant="primary"
              >
                Зберегти й вийти
              </Button>

              <Button onClick={confirmExit} variant="danger">
                Вийти без збереження
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

export default HouseEditor;
