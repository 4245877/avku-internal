/**
 * Container for the selected-house card.
 *
 * The header answers the questions a coordinator asks before doing anything —
 * where, which precinct, what stage, how urgent, who owns it, when we were last
 * here, what is next, what is wrong — without opening a tab. Under it sit the
 * quick actions, and under those the seven tabs.
 *
 * The card **shows**; it no longer edits. Filling a record in means forty
 * fields, ten collections and half a dozen sub-forms, and none of that fits a
 * column beside a map — «Редагувати» opens the full-screen editor instead, and
 * closes back onto this card with the same house still selected.
 */

import {
  campaignStateOf,
  formatAssignee,
  formatDate,
  formatShortDate,
  formatPrecincts,
  getHouseFlags,
  getPriority,
  getStage,
} from '../../../features/elections/houseUtils.js';
import { actionTypesById } from '../../../features/elections/electionsTypes.js';
import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import HouseTabs from './HouseTabs.jsx';
import QuickActions from './QuickActions.jsx';
import styles from '../ElectionsPage.module.css';

const toneClassNames = {
  success: styles.badgeSuccess,
  warning: styles.badgeWarning,
  danger: styles.badgeDanger,
  info: styles.badgeInfo,
  accent: styles.badgeAccent,
  neutral: styles.badgeNeutral,
  muted: styles.badgeNeutral,
};

function PanelShell({ children, className }) {
  return (
    <section className={[styles.detailsPanel, className].filter(Boolean).join(' ')}>
      {children}
    </section>
  );
}

/**
 * The warnings worth a line in the header. Each is a separate statement — an
 * overdue task and stale data are different problems with different fixes, and
 * collapsing them into one badge would hide whichever came second.
 */
function headerWarnings(house) {
  const state = campaignStateOf(house);
  const flags = getHouseFlags(house);
  const warnings = [];

  if (flags.hasOverdueTasks) {
    warnings.push({
      id: 'overdue',
      tone: 'danger',
      text: `Прострочених задач: ${state.overdueTasksCount}`,
    });
  }

  if (flags.hasOpenIssues) {
    warnings.push({
      id: 'issues',
      tone: 'warning',
      text: `Відкритих звернень: ${state.openIssuesCount}`,
    });
  }

  if (flags.hasNoAssignee) {
    warnings.push({ id: 'assignee', tone: 'accent', text: 'Немає відповідального' });
  }

  if (flags.isStale) {
    warnings.push({ id: 'stale', tone: 'warning', text: 'Дані давно не перевірялися' });
  }

  if (flags.hasDataProblem) {
    warnings.push({ id: 'quality', tone: 'info', text: 'Є питання до якості даних' });
  }

  return warnings;
}

function HouseDetailsPanel({
  house,
  campaignId,
  isLoading,
  /**
   * The card's own record is still on its way.
   *
   * The address, the stage and the outline come from the map payload and are on
   * screen from the click; the precinct, the responsible people and what the
   * last action actually was are in the record being fetched. While that is in
   * flight those read as "loading" rather than as "none" — the difference
   * between the two is exactly what a canvasser is about to act on.
   */
  isDetailsLoading,
  detailsError,
  hasError,
  isSaving,
  saveError,
  saveNotice,
  refreshToken,
  viewer,
  onStartEditing,
  onAddAction,
  onAddIssue,
  onAddTask,
  onAddPerson,
  onAddPhoto,
  onCompleteTask,
  onResolveIssue,
  onClose,
}) {
  if (isLoading) {
    return (
      <PanelShell>
        <div className={styles.panelPlaceholder} role="status">
          <span className={styles.placeholderTitle} />
          <span className={styles.placeholderLine} />
          <span className={styles.placeholderLine} />
          <div className={styles.placeholderGrid}>
            <span />
            <span />
            <span />
            <span />
          </div>
          <span className="sr-only">Завантаження даних будинку</span>
        </div>
      </PanelShell>
    );
  }

  if (hasError) {
    return (
      <PanelShell>
        <div className={styles.panelEmpty}>
          <span aria-hidden="true" className={styles.panelEmptyIcon}>
            <ElectionsIcon name="warning" size={26} />
          </span>

          <h2>Дані недоступні</h2>
          <p>
            Картку будинку не показати, поки не завантажені дані території.
            Скористайтеся кнопкою повторної спроби на карті.
          </p>
        </div>
      </PanelShell>
    );
  }

  if (!house) {
    return (
      <PanelShell>
        <div className={styles.panelEmpty}>
          <span aria-hidden="true" className={styles.panelEmptyIcon}>
            <ElectionsIcon name="pin" size={26} />
          </span>

          <h2>Будинок не вибрано</h2>
          <p>
            Натисніть на будинок на карті або виберіть його зі списку, щоб
            побачити етап роботи, відповідальних, контактних осіб і журнал дій.
          </p>

          <ul className={styles.panelHints}>
            <li>
              <ElectionsIcon name="search" size={15} />
              Знайдіть адресу, телефон або відповідального через пошук
            </li>
            <li>
              <ElectionsIcon name="layers" size={15} />
              Колір будинку показує етап роботи, значки — терміновість і якість даних
            </li>
            <li>
              <ElectionsIcon name="target" size={15} />
              Довге натискання на будинок показує коротку довідку
            </li>
          </ul>
        </div>
      </PanelShell>
    );
  }

  const state = campaignStateOf(house);
  const stage = getStage(house);
  const priority = getPriority(house);
  const warnings = headerWarnings(house);
  const role = viewer?.role ?? null;
  const canWrite = Boolean(role);

  return (
    <PanelShell className={styles.detailsPanelFilled}>
      <header className={styles.panelHeader}>
        <div className={styles.panelHeaderTop}>
          <span className={`${styles.statusPill} ${toneClassNames[stage.tone]}`}>
            {stage.label}
          </span>

          {priority.id === 'high' && (
            <span className={`${styles.statusPill} ${styles.badgeDanger}`}>
              Високий пріоритет
            </span>
          )}

          {house.isHeadquarters && <span className={styles.hqPill}>Штаб кампанії</span>}

          <button
            aria-label="Закрити картку будинку"
            className={styles.panelClose}
            onClick={onClose}
            type="button"
          >
            <ElectionsIcon name="close" size={18} />
          </button>
        </div>

        <h2 className={styles.panelTitle}>{house.address}</h2>

        <p className={styles.panelSubtitle}>
          {isDetailsLoading ? 'дільниця — завантаження…' : formatPrecincts(house)}
        </p>

        {detailsError && (
          <p className={styles.panelNoticeError} role="status">
            {detailsError}
          </p>
        )}

        <dl className={styles.panelFacts}>
          <div>
            <dt>Відповідальні</dt>
            <dd>
              {isDetailsLoading
                ? '…'
                : state.assignees.length === 0
                  ? '—'
                  : state.assignees.map((assignee) => formatAssignee(assignee.email)).join(', ')}
            </dd>
          </div>

          <div>
            <dt>Остання дія</dt>
            <dd>
              {state.lastActionAt
                ? `${
                    isDetailsLoading
                      ? 'Дія'
                      : (actionTypesById[state.lastActionType]?.label ?? 'Дія')
                  } ${formatShortDate(state.lastActionAt)}`
                : '—'}
            </dd>
          </div>

          <div>
            <dt>Наступна</dt>
            <dd>{state.nextActionAt ? formatShortDate(state.nextActionAt) : '—'}</dd>
          </div>

          <div>
            <dt>Перевірено</dt>
            <dd>
              {house.verifiedAt
                ? `${formatDate(house.verifiedAt)}${
                    house.verifiedBy ? `, ${formatAssignee(house.verifiedBy)}` : ''
                  }`
                : '—'}
            </dd>
          </div>
        </dl>

        {warnings.length > 0 && (
          <ul className={styles.panelWarnings}>
            {warnings.map((warning) => (
              <li
                className={`${styles.badge} ${toneClassNames[warning.tone]}`}
                key={warning.id}
              >
                {warning.text}
              </li>
            ))}
          </ul>
        )}

        {/* The one way into the full record. Prominent rather than buried at
            the bottom of a tab: it is the button daily work starts with. */}
        <button
          className={`${styles.primaryButton} ${styles.panelEditButton}`}
          onClick={onStartEditing}
          type="button"
        >
          <ElectionsIcon name="edit" size={17} />
          Редагувати
        </button>
      </header>

      {saveNotice && (
        <p className={styles.panelNotice} role="status">
          <ElectionsIcon name="check" size={16} />
          {saveNotice}
        </p>
      )}

      {saveError && (
        <p className={styles.panelError} role="alert">
          <ElectionsIcon name="warning" size={16} />
          {saveError}
        </p>
      )}

      <div className={styles.panelBody}>
        <QuickActions
          canWrite={canWrite}
          house={house}
          isSaving={isSaving}
          onAction={onAddAction}
          onIssue={onAddIssue}
          onPerson={onAddPerson}
          onPhoto={onAddPhoto}
          onTask={onAddTask}
        />

        <HouseTabs
          campaignId={campaignId}
          canWrite={canWrite}
          house={house}
          onCompleteTask={onCompleteTask}
          onResolveIssue={onResolveIssue}
          refreshToken={refreshToken}
        />
      </div>
    </PanelShell>
  );
}

export default HouseDetailsPanel;
