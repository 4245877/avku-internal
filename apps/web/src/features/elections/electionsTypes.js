/**
 * Domain vocabulary for the "Вибори" module.
 *
 * Everything the UI renders as a label, badge or option comes from here, so the
 * same lists can later be validated on the API side without duplicating copy.
 *
 * @typedef {object} HouseGeoPoint
 * @property {number} lat
 * @property {number} lon
 *
 * @typedef {object} HouseEstimate
 * @property {number} entrances    Derived from the footprint, before any survey.
 * @property {number} apartments
 * @property {number} residents
 *
 * @typedef {object} Resident
 * @property {string} id
 * @property {string} name
 * @property {string} apartment
 * @property {string} stance      One of {@link SUPPORT_STANCES}.
 * @property {string} ageGroup    One of {@link AGE_GROUPS}.
 * @property {string} note
 *
 * @typedef {object} HouseContact
 * @property {string} id
 * @property {string} type        One of {@link CONTACT_TYPES}.
 * @property {string} value
 * @property {string} label
 *
 * @typedef {object} HouseDetails
 * @property {number|null} entrances
 * @property {number|null} apartments
 * @property {number|null} residentsCount
 * @property {number|null} householdsCount
 * @property {Resident[]} residents
 * @property {HouseContact[]} contacts
 * @property {string} canvassStatus  One of {@link CANVASS_STATUSES}.
 * @property {string} priority       One of {@link PRIORITIES}.
 * @property {string} accessNote
 * @property {string} notes
 * @property {string} surveyedAt     ISO date (`YYYY-MM-DD`) or empty string.
 * @property {string} updatedBy
 * @property {string|null} updatedAt ISO timestamp of the last save.
 *
 * @typedef {object} House
 * @property {string} id
 * @property {string} street
 * @property {string} streetShort
 * @property {string} number
 * @property {string} address
 * @property {string} fullAddress
 * @property {string} type          One of {@link HOUSE_TYPES}.
 * @property {number} floors
 * @property {number} builtYear
 * @property {HouseGeoPoint} location
 * @property {HouseGeoPoint[]} footprint
 * @property {number} distanceMeters
 * @property {HouseEstimate} estimate
 * @property {HouseDetails} details
 */

export const HOUSE_TYPES = [
  { id: 'panel', label: 'Панельний', short: 'Панель' },
  { id: 'brick', label: 'Цегляний', short: 'Цегла' },
  { id: 'newBuild', label: 'Новобудова', short: 'Новобуд' },
  { id: 'private', label: 'Приватний', short: 'Приват' },
];

export const FILL_STATUSES = [
  {
    id: 'complete',
    label: 'Дані заповнені',
    shortLabel: 'Заповнено',
    tone: 'success',
  },
  {
    id: 'partial',
    label: 'Частково заповнено',
    shortLabel: 'Частково',
    tone: 'warning',
  },
  {
    id: 'empty',
    label: 'Даних немає',
    shortLabel: 'Немає даних',
    tone: 'neutral',
  },
];

export const SUPPORT_STANCES = [
  { id: 'support', label: 'Підтримує', tone: 'success' },
  { id: 'neutral', label: 'Нейтрально', tone: 'info' },
  { id: 'against', label: 'Проти', tone: 'danger' },
  { id: 'unknown', label: 'Невідомо', tone: 'neutral' },
];

export const CANVASS_STATUSES = [
  { id: 'planned', label: 'Заплановано', tone: 'neutral' },
  { id: 'inProgress', label: 'Опитування триває', tone: 'warning' },
  { id: 'done', label: 'Опитано', tone: 'success' },
  { id: 'refused', label: 'Відмова від контакту', tone: 'danger' },
];

export const PRIORITIES = [
  { id: 'high', label: 'Високий', tone: 'danger' },
  { id: 'medium', label: 'Середній', tone: 'warning' },
  { id: 'low', label: 'Низький', tone: 'neutral' },
];

export const CONTACT_TYPES = [
  { id: 'phone', label: 'Телефон', icon: 'phone', inputType: 'tel' },
  { id: 'email', label: 'Email', icon: 'mail', inputType: 'email' },
  { id: 'telegram', label: 'Telegram', icon: 'message', inputType: 'text' },
  { id: 'viber', label: 'Viber', icon: 'message', inputType: 'text' },
  { id: 'other', label: 'Інше', icon: 'link', inputType: 'text' },
];

export const AGE_GROUPS = [
  { id: 'unknown', label: 'Не вказано' },
  { id: '18-35', label: '18–35 років' },
  { id: '36-55', label: '36–55 років' },
  { id: '56-70', label: '56–70 років' },
  { id: '70+', label: '70+ років' },
];

/**
 * Fields that count toward the completeness indicator on the map. Keeping the
 * list in one place means the legend, the badge and the progress bar can never
 * drift apart.
 */
export const COMPLETION_FIELDS = [
  { id: 'entrances', label: 'Кількість підʼїздів' },
  { id: 'apartments', label: 'Кількість квартир' },
  { id: 'residents', label: 'Інформація про мешканців' },
  { id: 'contacts', label: 'Контактні дані' },
  { id: 'notes', label: 'Нотатки' },
];

const byId = (items) =>
  items.reduce((accumulator, item) => {
    accumulator[item.id] = item;
    return accumulator;
  }, {});

export const houseTypesById = byId(HOUSE_TYPES);
export const fillStatusesById = byId(FILL_STATUSES);
export const supportStancesById = byId(SUPPORT_STANCES);
export const canvassStatusesById = byId(CANVASS_STATUSES);
export const prioritiesById = byId(PRIORITIES);
export const contactTypesById = byId(CONTACT_TYPES);
export const ageGroupsById = byId(AGE_GROUPS);

/** Stable-enough client id for rows that only exist in local state. */
export function createLocalId(prefix) {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}

export function createEmptyResident() {
  return {
    id: createLocalId('resident'),
    name: '',
    apartment: '',
    stance: 'unknown',
    ageGroup: 'unknown',
    note: '',
  };
}

export function createEmptyContact() {
  return {
    id: createLocalId('contact'),
    type: 'phone',
    value: '',
    label: '',
  };
}

/**
 * A house always carries a details object — "даних немає" is expressed by empty
 * values rather than by `null`, which keeps every form binding trivial.
 */
export function createEmptyDetails() {
  return {
    entrances: null,
    apartments: null,
    residentsCount: null,
    householdsCount: null,
    residents: [],
    contacts: [],
    canvassStatus: 'planned',
    priority: 'medium',
    accessNote: '',
    notes: '',
    surveyedAt: '',
    updatedBy: '',
    updatedAt: null,
  };
}
