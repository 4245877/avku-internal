/**
 * «Історія» — every change ever made to this building, and who made it.
 *
 * Read-only by construction. The author is the identity the server resolved on
 * each write — never a name somebody typed into a form — and that is the whole
 * reason the journal is worth keeping.
 */

import { useMemo, useState } from 'react';

import { formatUpdatedAt } from '../../../../features/elections/houseUtils.js';
import ElectionsIcon from '../../../../features/elections/ElectionsIcon.jsx';
import {
  Card,
  CollectionState,
  ListToolbar,
  ToolbarSelect,
} from './editorFields.jsx';
import styles from './HouseEditor.module.css';

/** The field names the journal stores, in the words the form uses. */
const FIELD_LABELS = {
  street: 'Вулиця',
  number: 'Номер',
  block: 'Корпус / літера',
  streetShort: 'Коротка назва вулиці',
  address: 'Адреса',
  fullAddress: 'Повна адреса',
  city: 'Населений пункт',
  postalCode: 'Поштовий індекс',
  lat: 'Широта',
  lon: 'Довгота',
  type: 'Тип будівлі',
  building: 'Тег building',
  floors: 'Поверхів',
  builtYear: 'Рік побудови',
  entrances: 'Підʼїздів',
  apartments: 'Квартир',
  households: 'Заселених квартир',
  residentsCount: 'Мешканців',
  managingOrg: 'Керуюча організація',
  accessNote: 'Доступ у будинок',
  source: 'Джерело даних',
  name: 'Назва обʼєкта',
  stage: 'Етап роботи',
  priority: 'Пріоритет',
  priorityReason: 'Причина пріоритету',
  summary: 'Коротке резюме',
  nextStep: 'Наступна задача',
  nextActionAt: 'Термін наступної дії',
  title: 'Назва',
  description: 'Опис',
  status: 'Статус',
  assigneeEmail: 'Відповідальний',
  dueAt: 'Термін',
  resolution: 'Результат',
  entrance: 'Підʼїзд',
  apartment: 'Квартира',
  roleInHouse: 'Роль у будинку',
  fullName: 'Імʼя',
  role: 'Роль',
  note: 'Примітка',
};

const OPERATION_LABELS = {
  create: 'Створено',
  update: 'Змінено',
  delete: 'Видалено',
  verify: 'Дані перевірено',
  merge: 'Обʼєднано',
  merged_into: 'Обʼєднано з іншим записом',
  end: 'Завершено',
  contacts_replaced: 'Оновлено контакти',
};

const ENTITY_LABELS = {
  house: 'Будинок',
  houseCampaignState: 'Стан у кампанії',
  person: 'Контактна особа',
  housePerson: 'Звʼязок з особою',
  housePrecinct: 'Дільниця',
  action: 'Дія',
  issue: 'Звернення',
  task: 'Задача',
  event: 'Подія',
  assignment: 'Призначення',
  attachment: 'Файл',
};

const SCOPE_OPTIONS = [
  { id: 'all', label: 'Усе' },
  { id: 'house', label: 'Будинок' },
  { id: 'houseCampaignState', label: 'Стан у кампанії' },
  { id: 'person', label: 'Контакти' },
];

function HistorySection({ state }) {
  const [scope, setScope] = useState('all');

  const visible = useMemo(() => {
    if (scope === 'all') {
      return state.items;
    }

    if (scope === 'person') {
      return state.items.filter(
        (entry) => entry.entity === 'person' || entry.entity === 'housePerson',
      );
    }

    return state.items.filter((entry) => entry.entity === scope);
  }, [scope, state.items]);

  return (
    <Card
      hint="Автор кожного запису — перевірена особистість, а не введене вручну імʼя."
      icon="refresh"
      title="Історія змін"
    >
      {state.items.length > 1 && (
        <ListToolbar>
          <ToolbarSelect
            label="Показати"
            onChange={setScope}
            options={SCOPE_OPTIONS}
            value={scope}
          />
        </ListToolbar>
      )}

      <CollectionState
        emptyIcon="refresh"
        emptyText="Щойно хтось змінить дані будинку, зміна зʼявиться тут із автором і часом."
        emptyTitle="Змін за цим будинком ще не було"
        state={state}
      />

      {visible.length === 0 && state.items.length > 0 && (
        <p className={styles.mutedLine}>За цим фільтром змін немає.</p>
      )}

      <ol className={styles.timeline}>
        {visible.map((entry) => (
          <li className={styles.timelineRow} key={entry.id}>
            <span aria-hidden="true" className={styles.timelineIcon}>
              <ElectionsIcon name="refresh" size={15} />
            </span>

            <div className={styles.timelineBody}>
              <div className={styles.recordTop}>
                <strong>
                  {entry.field
                    ? (FIELD_LABELS[entry.field] ?? entry.field)
                    : (OPERATION_LABELS[entry.operation] ?? entry.operation)}
                </strong>

                {entry.entity && ENTITY_LABELS[entry.entity] && (
                  <small className={styles.historyEntity}>
                    {ENTITY_LABELS[entry.entity]}
                  </small>
                )}
              </div>

              <small className={styles.recordMeta}>
                {formatUpdatedAt(entry.changedAt)} · {entry.changedBy}
                {entry.origin && entry.origin !== 'api' ? ` · ${entry.origin}` : ''}
              </small>

              {entry.field && (
                <p className={styles.recordText}>
                  <span className={styles.historyOld}>{entry.oldValue || '—'}</span>
                  {' → '}
                  <span className={styles.historyNew}>{entry.newValue || '—'}</span>
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export default HistorySection;
