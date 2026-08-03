/**
 * Domain vocabulary for the "Вибори" module.
 *
 * Every label, badge and option the UI renders comes from here, and every list
 * mirrors one the API validates against (`apps/api/src/modules/elections/
 * elections.types.ts`). The server never trusts these values — it re-checks
 * them — but keeping the two in step is what lets a form show exactly the
 * options a save will accept.
 *
 * **Removed deliberately.** Earlier versions of this file carried
 * `SUPPORT_STANCES` and `AGE_GROUPS`, and the resident record held a `stance`
 * and an `ageGroup`. That was per-person political profiling — a special
 * category of personal data — kept in plain `localStorage` on a device that
 * walks around the district. It is gone from the model, the forms, the
 * aggregates and the database, and the importer drops it rather than carrying
 * it across. A person is recorded only as a contact with a working role.
 *
 * @typedef {object} HouseGeoPoint
 * @property {number} lat
 * @property {number} lon
 *
 * @typedef {object} HouseEstimate
 *   Derived from the OSM footprint, never stored. A field is `null` when the
 *   geometry cannot support a guess — most often because OpenStreetMap has no
 *   `building:levels` for that house.
 * @property {number|null} entrances
 * @property {number|null} apartments
 * @property {number|null} residents
 *
 * @typedef {object} PersonContact
 * @property {string} id
 * @property {string} type   One of {@link CONTACT_TYPES}.
 * @property {string} value
 * @property {string} label
 * @property {boolean} isMasked  True when the viewer may not see the real value.
 *
 * @typedef {object} Person
 *   A contact person for a building. Name, working role, how to reach them.
 * @property {string} id
 * @property {string} fullName
 * @property {string} role   One of {@link PERSON_ROLES}.
 * @property {string} note
 * @property {PersonContact[]} contacts
 *
 * @typedef {object} HouseCampaignState
 *   What has been done about this house in the active campaign. Lives beside
 *   the house rather than inside it, so a second campaign adds a record instead
 *   of overwriting the first one's results.
 * @property {string} stage      One of {@link WORK_STAGES}.
 * @property {string} priority   One of {@link PRIORITIES}.
 * @property {string} priorityReason
 * @property {string} summary
 * @property {string} nextStep     What is planned here next, in words.
 * @property {string|null} nextActionAt
 * @property {string|null} lastActionAt
 * @property {number} openIssuesCount
 * @property {number} overdueTasksCount
 * @property {{email: string, role: string}[]} assignees
 *
 * @typedef {object} House
 *   One real building. `id` is the module's own identifier; `osmType`/`osmId`
 *   are matching attributes, so regenerating the OSM snapshot updates a house
 *   instead of orphaning everything recorded against it.
 * @property {string} id
 * @property {'way'|'relation'|null} osmType
 * @property {number|null} osmId
 * @property {string} street
 * @property {string} streetShort
 * @property {string} number
 * @property {string} address
 * @property {string} fullAddress
 * @property {string|null} name
 * @property {string} type          One of {@link HOUSE_TYPES}.
 * @property {number|null} floors
 * @property {HouseGeoPoint} location
 * @property {HouseGeoPoint[]} footprint
 * @property {number} distanceMeters
 * @property {boolean} isHeadquarters
 * @property {HouseEstimate} estimate
 * @property {HouseCampaignState} campaign
 * @property {string[]} quality     Data-quality findings, never auto-corrected.
 */

/**
 * Building categories, derived from the OSM `building=*` tag rather than from
 * anything we assume about the district. `other` covers `building=yes`, which is
 * how roughly half of Kyiv is mapped — it means "OSM does not say", not "mixed".
 */
export const HOUSE_TYPES = [
  { id: 'apartments', label: 'Багатоквартирний', short: 'Багатокв.' },
  { id: 'private', label: 'Приватний будинок', short: 'Приватний' },
  { id: 'dormitory', label: 'Гуртожиток', short: 'Гуртожиток' },
  { id: 'public', label: 'Громадський обʼєкт', short: 'Громадський' },
  { id: 'commercial', label: 'Комерційний обʼєкт', short: 'Комерція' },
  { id: 'other', label: 'Тип не вказано', short: 'Без типу' },
];

/**
 * Where a house stands in the active campaign — and the **only** thing the
 * colour of a building on the map encodes.
 *
 * Urgency, missing owners and stale data are shown as separate overlays (see
 * `useHouseLayer.js`), because one colour that means four things at once cannot
 * answer "where have we not been yet".
 */
export const WORK_STAGES = [
  { id: 'not_started', label: 'Не розпочато', short: 'Не почато', tone: 'neutral' },
  { id: 'contact_setup', label: 'Встановлення контакту', short: 'Контакт', tone: 'info' },
  { id: 'in_progress', label: 'У роботі', short: 'У роботі', tone: 'warning' },
  {
    id: 'revisit_needed',
    label: 'Потрібен повторний вихід',
    short: 'Повторно',
    tone: 'accent',
  },
  { id: 'done', label: 'Завершено', short: 'Завершено', tone: 'success' },
  { id: 'blocked', label: 'Заблоковано або відмова', short: 'Відмова', tone: 'danger' },
  { id: 'not_applicable', label: 'Не застосовується', short: 'Не застос.', tone: 'muted' },
];

export const PRIORITIES = [
  { id: 'high', label: 'Високий', tone: 'danger' },
  { id: 'medium', label: 'Середній', tone: 'warning' },
  { id: 'low', label: 'Низький', tone: 'neutral' },
];

export const ACTION_TYPES = [
  { id: 'call', label: 'Дзвінок', icon: 'phone' },
  { id: 'visit', label: 'Візит', icon: 'door' },
  { id: 'meeting', label: 'Зустріч', icon: 'users' },
  { id: 'material', label: 'Видача матеріалів', icon: 'layers' },
  { id: 'comment', label: 'Коментар', icon: 'note' },
  { id: 'other', label: 'Інше', icon: 'list' },
];

export const ACTION_RESULTS = [
  { id: 'contacted', label: 'Поговорили', tone: 'success' },
  { id: 'no_answer', label: 'Не відчинили / не відповіли', tone: 'neutral' },
  { id: 'refused', label: 'Відмова від розмови', tone: 'danger' },
  { id: 'scheduled', label: 'Домовились на інший час', tone: 'info' },
  { id: 'materials_left', label: 'Залишили матеріали', tone: 'info' },
  { id: 'info_only', label: 'Лише зафіксовано', tone: 'muted' },
];

export const ISSUE_CATEGORIES = [
  { id: 'utilities', label: 'Комунальні послуги' },
  { id: 'yard', label: 'Двір і благоустрій' },
  { id: 'lighting', label: 'Освітлення' },
  { id: 'roof', label: 'Дах і фасад' },
  { id: 'elevator', label: 'Ліфт' },
  { id: 'waste', label: 'Сміття' },
  { id: 'road', label: 'Дорога і тротуари' },
  { id: 'safety', label: 'Безпека' },
  { id: 'social', label: 'Соціальні питання' },
  { id: 'other', label: 'Інше' },
];

export const ISSUE_STATUSES = [
  { id: 'open', label: 'Відкрите', tone: 'danger', isOpen: true },
  { id: 'in_progress', label: 'У роботі', tone: 'warning', isOpen: true },
  { id: 'waiting', label: 'Очікує', tone: 'info', isOpen: true },
  { id: 'resolved', label: 'Вирішено', tone: 'success', isOpen: false },
  { id: 'rejected', label: 'Відхилено', tone: 'neutral', isOpen: false },
];

export const TASK_STATUSES = [
  { id: 'todo', label: 'До виконання', tone: 'neutral', isOpen: true },
  { id: 'in_progress', label: 'У роботі', tone: 'warning', isOpen: true },
  { id: 'done', label: 'Виконано', tone: 'success', isOpen: false },
  { id: 'cancelled', label: 'Скасовано', tone: 'muted', isOpen: false },
];

/**
 * A contact's function in the building. Every value describes something the
 * person actually does, which is the only reason the module holds a name.
 */
export const PERSON_ROLES = [
  { id: 'osbb_head', label: 'Голова ОСББ' },
  { id: 'building_elder', label: 'Старший по будинку' },
  { id: 'entrance_elder', label: 'Старший по підʼїзду' },
  { id: 'concierge', label: 'Консьєрж' },
  { id: 'activist', label: 'Активіст' },
  { id: 'coordinator', label: 'Координатор' },
  { id: 'manager_org', label: 'Керуюча організація' },
  { id: 'other', label: 'Інше' },
];

export const CONTACT_TYPES = [
  { id: 'phone', label: 'Телефон', icon: 'phone', inputType: 'tel' },
  { id: 'email', label: 'Email', icon: 'mail', inputType: 'email' },
  { id: 'telegram', label: 'Telegram', icon: 'message', inputType: 'text' },
  { id: 'viber', label: 'Viber', icon: 'message', inputType: 'text' },
  { id: 'other', label: 'Інше', icon: 'link', inputType: 'text' },
];

export const EVENT_TYPES = [
  { id: 'meeting', label: 'Зустріч', icon: 'users' },
  { id: 'cleanup', label: 'Суботник', icon: 'layers' },
  { id: 'tent', label: 'Намет', icon: 'pin' },
  { id: 'temporary_point', label: 'Тимчасова точка', icon: 'pin' },
  { id: 'other', label: 'Інше', icon: 'list' },
];

export const ASSIGNMENT_ROLES = [
  { id: 'agitator', label: 'Агітатор' },
  { id: 'coordinator', label: 'Координатор' },
  { id: 'observer', label: 'Спостерігач' },
];

/** Roles the API recognises, in ascending order of authority. */
export const ELECTIONS_ROLES = [
  { id: 'agitator', label: 'Агітатор' },
  { id: 'coordinator', label: 'Координатор' },
  { id: 'manager', label: 'Менеджер' },
  { id: 'admin', label: 'Адміністратор' },
];

/**
 * Data-quality findings the API reports per house.
 *
 * They are shown, filtered on and never fixed automatically — a doubtful value
 * needs somebody who can check it, not a rule that quietly rewrites it.
 */
export const QUALITY_FLAGS = [
  { id: 'missingCoordinates', label: 'Немає координат', tone: 'danger' },
  { id: 'incompleteAddress', label: 'Неповна адреса', tone: 'danger' },
  { id: 'missingSource', label: 'Не вказано джерело', tone: 'warning' },
  { id: 'neverVerified', label: 'Дані не перевірялися', tone: 'warning' },
  { id: 'staleVerification', label: 'Дані застаріли', tone: 'warning' },
  { id: 'duplicateAddress', label: 'Можливий дубль адреси', tone: 'warning' },
  { id: 'missingInOsm', label: 'Зник з OpenStreetMap', tone: 'info' },
  { id: 'noAssignee', label: 'Немає відповідального', tone: 'accent' },
  { id: 'overdueTasks', label: 'Є прострочені задачі', tone: 'danger' },
];

const byId = (items) =>
  items.reduce((accumulator, item) => {
    accumulator[item.id] = item;
    return accumulator;
  }, {});

export const houseTypesById = byId(HOUSE_TYPES);
export const workStagesById = byId(WORK_STAGES);
export const prioritiesById = byId(PRIORITIES);
export const actionTypesById = byId(ACTION_TYPES);
export const actionResultsById = byId(ACTION_RESULTS);
export const issueCategoriesById = byId(ISSUE_CATEGORIES);
export const issueStatusesById = byId(ISSUE_STATUSES);
export const taskStatusesById = byId(TASK_STATUSES);
export const personRolesById = byId(PERSON_ROLES);
export const contactTypesById = byId(CONTACT_TYPES);
export const eventTypesById = byId(EVENT_TYPES);
export const qualityFlagsById = byId(QUALITY_FLAGS);

/** Stable-enough client id for rows that only exist in local form state. */
export function createLocalId(prefix) {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}

export function createEmptyContact() {
  return {
    id: createLocalId('contact'),
    type: 'phone',
    value: '',
    label: '',
  };
}

/** A blank contact person, for the "Люди" tab's add form. */
export function createEmptyPerson() {
  return {
    id: createLocalId('person'),
    fullName: '',
    role: 'building_elder',
    entrance: '',
    apartment: '',
    note: '',
    contacts: [createEmptyContact()],
  };
}

/**
 * The campaign state a house carries before anybody has touched it. The API
 * omits the row entirely in that case, which reads as exactly this.
 */
export function createEmptyCampaignState() {
  return {
    stage: 'not_started',
    priority: 'medium',
    priorityReason: '',
    summary: '',
    nextStep: '',
    nextActionAt: null,
    updatedAt: null,
    updatedBy: null,
    lastActionAt: null,
    lastActionId: null,
    lastActionType: null,
    lastActionResult: null,
    openIssuesCount: 0,
    overdueTasksCount: 0,
    todayTasksCount: 0,
    openTasksCount: 0,
    assignees: [],
  };
}
