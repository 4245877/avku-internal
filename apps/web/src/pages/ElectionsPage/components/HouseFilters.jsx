/**
 * The filter row.
 *
 * Every filter here answers a question somebody actually asks in the field:
 * "where have we not been", "what is overdue", "which houses have nobody on
 * them", "what is on for today". The component is stateless — the page owns the
 * filter object — and each control is independent, so they compose.
 */

import {
  HOUSE_TYPES,
  PRIORITIES,
  QUALITY_FLAGS,
  WORK_STAGES,
} from '../../../features/elections/electionsTypes.js';
import {
  HOUSE_SORT_OPTIONS,
  formatAssignee,
  formatNumber,
} from '../../../features/elections/houseUtils.js';
import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import styles from '../ElectionsPage.module.css';

const stageToneClassNames = {
  success: styles.chipSuccess,
  warning: styles.chipWarning,
  danger: styles.chipDanger,
  info: styles.chipInfo,
  accent: styles.chipAccent,
  neutral: styles.chipNeutral,
  muted: styles.chipNeutral,
};

/**
 * The one-tap answers to "what should I look at right now". They are toggles
 * rather than a single select because they are independent facts about a house.
 */
function QuickFilters({ filters, summary, onChange, disabled }) {
  const toggles = [
    {
      id: 'unassigned',
      label: 'Без відповідального',
      count: summary.withoutAssignee,
      isActive: filters.assignment === 'none',
      apply: () => onChange({ assignment: filters.assignment === 'none' ? 'all' : 'none' }),
    },
    {
      id: 'overdue',
      label: 'Прострочені задачі',
      count: summary.overdueTasks,
      isActive: filters.tasks === 'overdue',
      apply: () => onChange({ tasks: filters.tasks === 'overdue' ? 'all' : 'overdue' }),
    },
    {
      id: 'today',
      label: 'Задачі на сьогодні',
      count: summary.todayTasks,
      isActive: filters.tasks === 'today',
      apply: () => onChange({ tasks: filters.tasks === 'today' ? 'all' : 'today' }),
    },
    {
      id: 'issues',
      label: 'Відкриті звернення',
      count: summary.openIssues,
      isActive: filters.issues === 'open',
      apply: () => onChange({ issues: filters.issues === 'open' ? 'all' : 'open' }),
    },
    {
      id: 'stale',
      label: 'Застарілі дані',
      count: summary.stale,
      isActive: filters.verification === 'stale',
      apply: () =>
        onChange({ verification: filters.verification === 'stale' ? 'all' : 'stale' }),
    },
    {
      id: 'contacts',
      label: 'Є контакт',
      count: summary.knownContacts,
      isActive: filters.contacts === 'with',
      apply: () => onChange({ contacts: filters.contacts === 'with' ? 'all' : 'with' }),
    },
  ];

  return (
    <div aria-label="Швидкі фільтри" className={styles.chipGroup} role="group">
      {toggles.map((toggle) => (
        <button
          aria-pressed={toggle.isActive}
          className={[styles.chip, toggle.isActive ? styles.chipActive : '']
            .filter(Boolean)
            .join(' ')}
          disabled={disabled}
          key={toggle.id}
          onClick={toggle.apply}
          type="button"
        >
          {toggle.label}
          <span className={styles.chipCount}>{formatNumber(toggle.count)}</span>
        </button>
      ))}
    </div>
  );
}

function HouseFilters({
  filters,
  summary,
  streets,
  precincts,
  assignees,
  onChange,
  onReset,
  hasActive,
  disabled,
}) {
  const districts = [
    ...new Set(precincts.map((precinct) => precinct.district).filter(Boolean)),
  ];

  return (
    <div className={styles.filters}>
      <div aria-label="Фільтр за етапом" className={styles.chipGroup} role="group">
        <button
          aria-pressed={filters.stage === 'all'}
          className={[styles.chip, filters.stage === 'all' ? styles.chipActive : '']
            .filter(Boolean)
            .join(' ')}
          disabled={disabled}
          onClick={() => onChange({ stage: 'all' })}
          type="button"
        >
          Усі етапи
          <span className={styles.chipCount}>{formatNumber(summary.total)}</span>
        </button>

        {WORK_STAGES.map((stage) => {
          const isActive = filters.stage === stage.id;
          const count = summary.byStage[stage.id] ?? 0;

          return (
            <button
              aria-pressed={isActive}
              className={[
                styles.chip,
                stageToneClassNames[stage.tone],
                isActive ? styles.chipActive : '',
              ]
                .filter(Boolean)
                .join(' ')}
              disabled={disabled}
              key={stage.id}
              onClick={() => onChange({ stage: isActive ? 'all' : stage.id })}
              type="button"
            >
              {stage.short}
              <span className={styles.chipCount}>{formatNumber(count)}</span>
            </button>
          );
        })}
      </div>

      <QuickFilters
        disabled={disabled}
        filters={filters}
        onChange={onChange}
        summary={summary}
      />

      <div className={styles.selectGroup}>
        <label className={styles.selectField}>
          <span className="sr-only">Пріоритет</span>
          <select
            disabled={disabled}
            onChange={(event) => onChange({ priority: event.target.value })}
            value={filters.priority}
          >
            <option value="all">Будь-який пріоритет</option>
            {PRIORITIES.map((priority) => (
              <option key={priority.id} value={priority.id}>
                Пріоритет: {priority.label.toLowerCase()}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.selectField}>
          <span className="sr-only">Відповідальний</span>
          <select
            disabled={disabled}
            onChange={(event) => onChange({ assignee: event.target.value })}
            value={filters.assignee}
          >
            <option value="all">Будь-який відповідальний</option>
            {assignees.map((email) => (
              <option key={email} value={email}>
                {formatAssignee(email)}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.selectField}>
          <span className="sr-only">Дільниця</span>
          <select
            disabled={disabled}
            onChange={(event) => onChange({ precinct: event.target.value })}
            value={filters.precinct}
          >
            <option value="all">Усі дільниці</option>
            {precincts.map((precinct) => (
              <option key={precinct.id} value={precinct.id}>
                Дільниця №{precinct.number}
              </option>
            ))}
          </select>
        </label>

        {districts.length > 0 && (
          <label className={styles.selectField}>
            <span className="sr-only">Округ</span>
            <select
              disabled={disabled}
              onChange={(event) => onChange({ district: event.target.value })}
              value={filters.district}
            >
              <option value="all">Усі округи</option>
              {districts.map((district) => (
                <option key={district} value={district}>
                  {district}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className={styles.selectField}>
          <span className="sr-only">Вулиця</span>
          <select
            disabled={disabled}
            onChange={(event) => onChange({ street: event.target.value })}
            value={filters.street}
          >
            <option value="all">Усі вулиці</option>
            {streets.map((street) => (
              <option key={street} value={street}>
                {street}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.selectField}>
          <span className="sr-only">Тип будинку</span>
          <select
            disabled={disabled}
            onChange={(event) => onChange({ houseType: event.target.value })}
            value={filters.houseType}
          >
            <option value="all">Будь-який тип</option>
            {HOUSE_TYPES.map((type) => (
              <option key={type.id} value={type.id}>
                {type.label}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.selectField}>
          <span className="sr-only">Остання дія</span>
          <select
            disabled={disabled}
            onChange={(event) => onChange({ lastActionWithin: event.target.value })}
            value={filters.lastActionWithin}
          >
            <option value="all">Будь-коли остання дія</option>
            <option value="7">Дія за останній тиждень</option>
            <option value="30">Дія за останній місяць</option>
            <option value="90">Дія за три місяці</option>
          </select>
        </label>

        <label className={styles.selectField}>
          <span className="sr-only">Наступна дія</span>
          <select
            disabled={disabled}
            onChange={(event) => onChange({ nextActionWithin: event.target.value })}
            value={filters.nextActionWithin}
          >
            <option value="all">Будь-коли наступна дія</option>
            <option value="1">Наступна дія сьогодні–завтра</option>
            <option value="7">Наступна дія цього тижня</option>
          </select>
        </label>

        <label className={styles.selectField}>
          <span className="sr-only">Джерело даних</span>
          <select
            disabled={disabled}
            onChange={(event) => onChange({ source: event.target.value })}
            value={filters.source}
          >
            <option value="all">Будь-яке джерело</option>
            <option value="osm">OpenStreetMap</option>
            <option value="import:">Імпорт</option>
            <option value="manual">Ручне введення</option>
          </select>
        </label>

        <label className={styles.selectField}>
          <span className="sr-only">Помилки якості даних</span>
          <select
            disabled={disabled}
            onChange={(event) => onChange({ quality: event.target.value })}
            value={filters.quality}
          >
            <option value="all">Будь-яка якість даних</option>
            {QUALITY_FLAGS.map((flag) => (
              <option key={flag.id} value={flag.id}>
                {flag.label}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.selectField}>
          <span className="sr-only">Сортування</span>
          <select
            disabled={disabled}
            onChange={(event) => onChange({ sortBy: event.target.value })}
            value={filters.sortBy}
          >
            {HOUSE_SORT_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {hasActive && (
          <button className={styles.resetFiltersButton} onClick={onReset} type="button">
            <ElectionsIcon name="close" size={15} />
            Скинути
          </button>
        )}
      </div>
    </div>
  );
}

export default HouseFilters;
