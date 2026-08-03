/**
 * The seven views of one house: Огляд, Люди, Дії, Звернення, Задачі, Файли,
 * Історія.
 *
 * Each tab loads its own records the first time it is opened, so the card is
 * usable the moment it appears — the overview needs nothing but the house
 * itself, and that is the tab a canvasser opens ninety percent of the time.
 *
 * The "Люди" tab shows contact people and how to reach them. It has no list of
 * political positions, no age bands, no supporter/opponent tally and no hidden
 * score, because none of those exist any more — see `electionsTypes.js`.
 */

import { useState } from 'react';

import {
  actionResultsById,
  actionTypesById,
  contactTypesById,
  issueCategoriesById,
  issueStatusesById,
  taskStatusesById,
} from '../../../features/elections/electionsTypes.js';
import {
  campaignStateOf,
  formatAssignee,
  formatApartments,
  formatDate,
  formatEntrances,
  formatFloors,
  formatNumber,
  formatPrecincts,
  formatUpdatedAt,
  getHouseTypeLabel,
  getPersonRoleLabel,
  getPriority,
  getQualityFindings,
  getStage,
  resolveApartments,
  resolveEntrances,
  resolveResidents,
} from '../../../features/elections/houseUtils.js';
import { useHouseRelated } from '../../../features/elections/useHouseRelated.js';
import { useTablistKeys } from '../../../features/elections/useTablistKeys.js';
import { formatDistance } from '../../../features/elections/geo.js';
import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import styles from '../ElectionsPage.module.css';

const TABS = [
  { id: 'overview', label: 'Огляд', icon: 'building', collection: null },
  { id: 'people', label: 'Люди', icon: 'contacts', collection: 'people' },
  { id: 'actions', label: 'Дії', icon: 'list', collection: 'actions' },
  { id: 'issues', label: 'Звернення', icon: 'warning', collection: 'issues' },
  { id: 'tasks', label: 'Задачі', icon: 'check', collection: 'tasks' },
  { id: 'files', label: 'Файли', icon: 'layers', collection: 'files' },
  { id: 'history', label: 'Історія', icon: 'refresh', collection: 'history' },
];

const TAB_IDS = TABS.map((tab) => tab.id);

const toneClassNames = {
  success: styles.badgeSuccess,
  warning: styles.badgeWarning,
  danger: styles.badgeDanger,
  info: styles.badgeInfo,
  accent: styles.badgeAccent,
  neutral: styles.badgeNeutral,
  muted: styles.badgeNeutral,
};

function Badge({ tone, children }) {
  return (
    <span className={`${styles.badge} ${toneClassNames[tone] ?? styles.badgeNeutral}`}>
      {children}
    </span>
  );
}

function CollectionState({ state, emptyText }) {
  if (state.isLoading) {
    return (
      <p className={styles.summaryEmpty} role="status">
        Завантаження…
      </p>
    );
  }

  if (state.status === 'error') {
    return (
      <p className={styles.tabError} role="alert">
        <ElectionsIcon name="warning" size={15} />
        {state.error}
      </p>
    );
  }

  if (state.items.length === 0) {
    return <p className={styles.summaryEmpty}>{emptyText}</p>;
  }

  return null;
}

/** Turns a contact into something clickable where the channel allows it. */
function contactHref(contact) {
  const value = String(contact.value ?? '').trim();

  if (!value || contact.isMasked) {
    return null;
  }

  if (contact.type === 'phone') {
    return `tel:${value.replace(/[^\d+]/g, '')}`;
  }

  if (contact.type === 'viber') {
    return `viber://chat?number=${encodeURIComponent(value.replace(/[^\d+]/g, ''))}`;
  }

  if (contact.type === 'email') {
    return `mailto:${value}`;
  }

  if (contact.type === 'telegram') {
    return `https://t.me/${value.replace(/^@/, '')}`;
  }

  return null;
}

function Metric({ icon, label, value, hint, isEstimate }) {
  return (
    <div className={styles.metric}>
      <span aria-hidden="true" className={styles.metricIcon}>
        <ElectionsIcon name={icon} size={16} />
      </span>

      <strong className={styles.metricValue}>{value}</strong>
      <span className={styles.metricLabel}>{label}</span>

      {(hint || isEstimate) && (
        <small className={isEstimate ? styles.metricEstimate : styles.metricHint}>
          {isEstimate ? 'оціночно, за геометрією' : hint}
        </small>
      )}
    </div>
  );
}

/**
 * A metric that has neither a confirmed value nor a geometry estimate says so,
 * rather than showing a zero somebody could mistake for data.
 */
function metricHint(resolved) {
  return resolved.isKnown ? undefined : 'даних немає — заповніть картку';
}

function OverviewTab({ house }) {
  const state = campaignStateOf(house);
  const stage = getStage(house);
  const priority = getPriority(house);
  const entrances = resolveEntrances(house);
  const apartments = resolveApartments(house);
  const residents = resolveResidents(house);
  const findings = getQualityFindings(house);

  return (
    <div className={styles.summary}>
      <div className={styles.metricGrid}>
        <Metric
          hint={metricHint(entrances)}
          icon="door"
          isEstimate={entrances.isEstimate}
          label="Підʼїзди"
          value={formatNumber(entrances.value)}
        />
        <Metric
          hint={metricHint(apartments)}
          icon="home"
          isEstimate={apartments.isEstimate}
          label="Квартири"
          value={formatNumber(apartments.value)}
        />
        <Metric
          hint={metricHint(residents)}
          icon="users"
          isEstimate={residents.isEstimate}
          label="Мешканці"
          value={formatNumber(residents.value)}
        />
        <Metric
          hint={
            house.builtYear
              ? `${house.builtYear} рік`
              : `забудова ${formatNumber(house.footprintAreaSqm)} м²`
          }
          icon="building"
          label={getHouseTypeLabel(house)}
          value={
            Number.isFinite(house.floors) ? formatFloors(house.floors) : 'Поверхи невідомі'
          }
        />
      </div>

      <dl className={styles.factList}>
        <div>
          <dt>Повна адреса</dt>
          <dd>{house.fullAddress || house.address}</dd>
        </div>

        <div>
          <dt>Виборча дільниця</dt>
          <dd>{formatPrecincts(house)}</dd>
        </div>

        <div>
          <dt>Етап і пріоритет</dt>
          <dd>
            <Badge tone={stage.tone}>{stage.label}</Badge>
            <Badge tone={priority.tone}>Пріоритет: {priority.label.toLowerCase()}</Badge>
          </dd>
        </div>

        <div>
          <dt>Відповідальні</dt>
          <dd>
            {state.assignees.length === 0
              ? 'не призначено'
              : state.assignees.map((assignee) => formatAssignee(assignee.email)).join(', ')}
          </dd>
        </div>

        <div>
          <dt>Остання дія</dt>
          <dd>
            {state.lastActionAt
              ? `${actionTypesById[state.lastActionType]?.label ?? 'Дія'} · ${
                  formatDate(state.lastActionAt)
                }`
              : 'дій ще не було'}
          </dd>
        </div>

        <div>
          <dt>Наступна дія</dt>
          <dd>{state.nextActionAt ? formatDate(state.nextActionAt) : 'не запланована'}</dd>
        </div>

        {/* Who checked the data and when — the field the old card could not
            answer honestly, because the author was free text in a form. */}
        <div>
          <dt>Перевірка даних</dt>
          <dd>
            {house.verifiedAt
              ? `${formatDate(house.verifiedAt)}${
                  house.verifiedBy ? ` · ${formatAssignee(house.verifiedBy)}` : ''
                }`
              : 'дані не перевірялися'}
          </dd>
        </div>

        <div>
          <dt>Джерело даних</dt>
          <dd>{house.source || '—'}</dd>
        </div>

        <div>
          <dt>Відстань від штабу</dt>
          <dd>{formatDistance(house.distanceMeters)}</dd>
        </div>

        {house.osmType && house.osmId && (
          /* The outline and the address are somebody's OSM edit — link to it,
             so a wrong house number can be checked and fixed at the source. */
          <div>
            <dt>Обʼєкт на карті</dt>
            <dd>
              <a
                className={styles.factLink}
                href={`https://www.openstreetmap.org/${house.osmType}/${house.osmId}`}
                rel="noreferrer noopener"
                target="_blank"
              >
                OpenStreetMap · building={house.building}
                <ElectionsIcon name="link" size={13} />
              </a>
            </dd>
          </div>
        )}

        {house.accessNote && (
          <div>
            <dt>Доступ</dt>
            <dd>{house.accessNote}</dd>
          </div>
        )}

        {house.managingOrg && (
          <div>
            <dt>Керуюча організація</dt>
            <dd>{house.managingOrg}</dd>
          </div>
        )}
      </dl>

      {state.summary && (
        <section className={styles.summarySection}>
          <h3 className={styles.summarySectionTitle}>
            <ElectionsIcon name="note" size={16} />
            Коротке резюме
          </h3>
          <p className={styles.notesBody}>{state.summary}</p>
        </section>
      )}

      {findings.length > 0 && (
        <section className={styles.summarySection}>
          <h3 className={styles.summarySectionTitle}>
            <ElectionsIcon name="warning" size={16} />
            Якість даних
          </h3>

          {/* Reported, never corrected automatically: each of these needs
              somebody who can go and check, not a rule that rewrites it. */}
          <ul className={styles.qualityList}>
            {findings.map((finding) => (
              <li key={finding.id}>
                <Badge tone={finding.tone}>{finding.label}</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* «Редагувати» lives in the card header, where it is visible from every
          tab rather than only from this one. Here we just say how fresh the
          record is. */}
      <footer className={styles.summaryFooter}>
        <small>Оновлено: {formatUpdatedAt(house.updatedAt)}</small>
      </footer>
    </div>
  );
}

function PeopleTab({ state, canSeeContacts }) {
  const placeholder = (
    <CollectionState
      emptyText="Контактних осіб ще немає. Телефон старости чи голови ОСББ суттєво спрощує наступний обхід."
      state={state}
    />
  );

  return (
    <div className={styles.tabBody}>
      {!canSeeContacts && (
        <p className={styles.tabNotice}>
          <ElectionsIcon name="info" size={15} />
          Контакти цього будинку приховані — вони видимі відповідальному за нього.
        </p>
      )}

      {placeholder}

      <ul className={styles.personList}>
        {state.items.map((person) => (
          <li className={styles.personCard} key={person.id}>
            <div className={styles.personTop}>
              <strong>{person.fullName}</strong>
              <Badge tone="info">{getPersonRoleLabel(person.role)}</Badge>
            </div>

            {person.links?.length > 0 && (
              <p className={styles.personMeta}>
                {person.links
                  .map((link) =>
                    [
                      link.entrance ? `підʼїзд ${link.entrance}` : '',
                      link.apartment ? `кв. ${link.apartment}` : '',
                    ]
                      .filter(Boolean)
                      .join(', '),
                  )
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            )}

            <ul className={styles.contactList}>
              {(person.contacts ?? []).map((contact) => {
                const href = contactHref(contact);
                const typeMeta = contactTypesById[contact.type];

                return (
                  <li className={styles.contactRow} key={contact.id}>
                    <span aria-hidden="true" className={styles.contactIcon}>
                      <ElectionsIcon name={typeMeta?.icon ?? 'link'} size={16} />
                    </span>

                    <span className={styles.contactBody}>
                      {href ? (
                        <a className={styles.contactValue} href={href}>
                          {contact.value}
                        </a>
                      ) : (
                        <span className={styles.contactValue}>{contact.value}</span>
                      )}

                      <small>{contact.label || typeMeta?.label}</small>
                    </span>
                  </li>
                );
              })}
            </ul>

            {person.note && <p className={styles.personNote}>{person.note}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ActionsTab({ state }) {
  return (
    <div className={styles.tabBody}>
      <CollectionState
        emptyText="Дій ще не записано. Скористайтеся швидкими діями вгорі картки."
        state={state}
      />

      <ol className={styles.timeline}>
        {state.items.map((action) => (
          <li className={styles.timelineRow} key={action.id}>
            <span aria-hidden="true" className={styles.timelineIcon}>
              <ElectionsIcon name={actionTypesById[action.type]?.icon ?? 'list'} size={15} />
            </span>

            <div className={styles.timelineBody}>
              <div className={styles.timelineTop}>
                <strong>{actionTypesById[action.type]?.label ?? action.type}</strong>
                <Badge tone={actionResultsById[action.result]?.tone ?? 'neutral'}>
                  {actionResultsById[action.result]?.label ?? action.result}
                </Badge>
              </div>

              <small className={styles.timelineMeta}>
                {formatDate(action.happenedAt)} · {formatAssignee(action.authorEmail)}
              </small>

              {action.comment && <p className={styles.timelineText}>{action.comment}</p>}
              {action.nextStep && (
                <p className={styles.timelineNext}>Наступний крок: {action.nextStep}</p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function IssuesTab({ state, onResolve, canWrite }) {
  return (
    <div className={styles.tabBody}>
      <CollectionState emptyText="Звернень від мешканців цього будинку немає." state={state} />

      <ul className={styles.recordList}>
        {state.items.map((issue) => (
          <li className={styles.recordRow} key={issue.id}>
            <div className={styles.recordTop}>
              <strong>{issue.title}</strong>
              <Badge tone={issueStatusesById[issue.status]?.tone ?? 'neutral'}>
                {issueStatusesById[issue.status]?.label ?? issue.status}
              </Badge>
            </div>

            <small className={styles.recordMeta}>
              {issueCategoriesById[issue.category]?.label ?? issue.category}
              {issue.entrance ? ` · підʼїзд ${issue.entrance}` : ''}
              {' · відкрито '}
              {formatDate(issue.openedAt)}
              {issue.dueAt ? ` · термін ${formatDate(issue.dueAt)}` : ''}
            </small>

            {issue.description && <p className={styles.recordText}>{issue.description}</p>}

            {canWrite && issue.isOpen && (
              <button
                className={styles.linkButton}
                onClick={() => onResolve(issue.id)}
                type="button"
              >
                Позначити вирішеним
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TasksTab({ state, onComplete, canWrite }) {
  return (
    <div className={styles.tabBody}>
      <CollectionState emptyText="Задач за цим будинком немає." state={state} />

      <ul className={styles.recordList}>
        {state.items.map((task) => (
          <li
            className={[styles.recordRow, task.isOverdue ? styles.recordRowOverdue : '']
              .filter(Boolean)
              .join(' ')}
            key={task.id}
          >
            <div className={styles.recordTop}>
              <strong>{task.title}</strong>
              <Badge tone={taskStatusesById[task.status]?.tone ?? 'neutral'}>
                {taskStatusesById[task.status]?.label ?? task.status}
              </Badge>
            </div>

            <small className={styles.recordMeta}>
              {task.dueAt ? `Термін ${formatDate(task.dueAt)}` : 'без терміну'}
              {task.isOverdue ? ' · прострочено' : ''}
              {task.assigneeEmail
                ? ` · ${formatAssignee(task.assigneeEmail)}`
                : ' · без виконавця'}
            </small>

            {task.description && <p className={styles.recordText}>{task.description}</p>}

            {canWrite && task.status !== 'done' && (
              <button
                className={styles.linkButton}
                onClick={() => onComplete(task.id)}
                type="button"
              >
                Позначити виконаною
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FilesTab({ state }) {
  return (
    <div className={styles.tabBody}>
      <CollectionState
        emptyText="Файлів немає. Додайте фото підʼїзду або дошки оголошень кнопкою «Фото»."
        state={state}
      />

      <ul className={styles.fileList}>
        {state.items.map((file) => (
          <li className={styles.fileRow} key={file.id}>
            <a href={file.url} rel="noreferrer noopener" target="_blank">
              <ElectionsIcon name={file.kind === 'photo' ? 'building' : 'note'} size={16} />
              {file.fileName}
            </a>

            <small>
              {formatDate(file.createdAt)} · {formatAssignee(file.uploadedBy)} ·{' '}
              {Math.round(file.byteSize / 1024)} КБ
            </small>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HistoryTab({ state }) {
  return (
    <div className={styles.tabBody}>
      <CollectionState emptyText="Змін за цим будинком ще не було." state={state} />

      <ol className={styles.timeline}>
        {state.items.map((entry) => (
          <li className={styles.timelineRow} key={entry.id}>
            <span aria-hidden="true" className={styles.timelineIcon}>
              <ElectionsIcon name="refresh" size={15} />
            </span>

            <div className={styles.timelineBody}>
              <div className={styles.timelineTop}>
                <strong>
                  {entry.field ? `Поле «${entry.field}»` : entry.operation}
                </strong>
              </div>

              <small className={styles.timelineMeta}>
                {/* The author is the identity the server resolved, which is the
                    whole reason this log is worth keeping. */}
                {formatUpdatedAt(entry.changedAt)} · {entry.changedBy}
                {entry.origin !== 'api' ? ` · ${entry.origin}` : ''}
              </small>

              {entry.field && (
                <p className={styles.timelineText}>
                  <span className={styles.historyOld}>{entry.oldValue || '—'}</span>
                  {' → '}
                  <span className={styles.historyNew}>{entry.newValue || '—'}</span>
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function HouseTabs({
  house,
  campaignId,
  refreshToken,
  canWrite,
  onCompleteTask,
  onResolveIssue,
}) {
  const [activeTab, setActiveTab] = useState('overview');
  const collection = TABS.find((tab) => tab.id === activeTab)?.collection;

  const related = useHouseRelated(house.id, collection ?? 'people', {
    campaignId,
    enabled: Boolean(collection),
    refreshToken,
  });

  const state = campaignStateOf(house);
  const counts = {
    issues: state.openIssuesCount || null,
    tasks: state.openTasksCount || null,
    people: house.contactsCount || null,
  };
  const { listRef, onKeyDown, tabProps } = useTablistKeys(
    TAB_IDS,
    activeTab,
    setActiveTab,
  );

  return (
    <div className={styles.houseTabs}>
      <div
        aria-label="Розділи картки будинку"
        className={styles.houseTabList}
        onKeyDown={onKeyDown}
        ref={listRef}
        role="tablist"
      >
        {TABS.map((tab) => (
          <button
            {...tabProps(tab.id)}
            aria-controls={`house-tabpanel-${tab.id}`}
            className={[
              styles.houseTab,
              activeTab === tab.id ? styles.houseTabActive : '',
            ]
              .filter(Boolean)
              .join(' ')}
            id={`house-tab-${tab.id}`}
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
          >
            <ElectionsIcon name={tab.icon} size={15} />
            <span>{tab.label}</span>
            {counts[tab.id] ? (
              <span className={styles.houseTabCount}>{counts[tab.id]}</span>
            ) : null}
          </button>
        ))}
      </div>

      <div
        aria-labelledby={`house-tab-${activeTab}`}
        className={styles.houseTabPanel}
        id={`house-tabpanel-${activeTab}`}
        role="tabpanel"
        tabIndex={0}
      >
        {activeTab === 'overview' && (
          <OverviewTab house={house} />
        )}
        {activeTab === 'people' && (
          <PeopleTab canSeeContacts={house.canSeeContacts} state={related} />
        )}
        {activeTab === 'actions' && <ActionsTab state={related} />}
        {activeTab === 'issues' && (
          <IssuesTab canWrite={canWrite} onResolve={onResolveIssue} state={related} />
        )}
        {activeTab === 'tasks' && (
          <TasksTab canWrite={canWrite} onComplete={onCompleteTask} state={related} />
        )}
        {activeTab === 'files' && <FilesTab state={related} />}
        {activeTab === 'history' && <HistoryTab state={related} />}
      </div>
    </div>
  );
}

export default HouseTabs;
