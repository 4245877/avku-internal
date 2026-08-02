/**
 * Derived, pure helpers for house records: search, filtering, formatting and
 * the small amount of interpretation the UI needs. Everything here is
 * UI-agnostic and unit-tested, so the map, the list and the card always agree
 * on what a house "is".
 *
 * `getStanceBreakdown` used to live here — a per-house tally of residents by
 * political position. It is gone along with the field it counted; see
 * `electionsTypes.js`.
 */

import {
  QUALITY_FLAGS,
  contactTypesById,
  createEmptyCampaignState,
  houseTypesById,
  personRolesById,
  prioritiesById,
  qualityFlagsById,
  workStagesById,
} from './electionsTypes.js';

/** Lowercases and strips the apostrophe variants Ukrainian input mixes freely. */
export function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[ʼ'’`ʹ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenizeQuery(query) {
  const normalized = normalizeText(query).replace(/[,.;]/g, ' ');

  return normalized.split(' ').filter(Boolean);
}

const hasValue = (value) => value !== null && value !== undefined && value !== '';

/**
 * Phone digits, for search. Mirrors `normalizePhone` on the API so a number
 * typed as `067…` finds a contact stored as `+380 67 …`.
 */
export function normalizePhoneDigits(value) {
  const digits = String(value ?? '').replace(/\D/g, '');

  if (digits.length === 10 && digits.startsWith('0')) {
    return `38${digits}`;
  }

  if (digits.length === 11 && digits.startsWith('80')) {
    return `3${digits}`;
  }

  return digits;
}

export const campaignStateOf = (house) => house.campaign ?? createEmptyCampaignState();

/**
 * Confirmed value if somebody entered one, otherwise the geometry estimate.
 * `isEstimate` lets the UI show "оціночно" instead of pretending to know, and a
 * `null` value means neither source has an answer — OSM does not describe every
 * building well enough to guess from.
 */
function resolve(surveyed, estimated) {
  if (hasValue(surveyed)) {
    return { value: surveyed, isEstimate: false, isKnown: true };
  }

  return {
    value: hasValue(estimated) ? estimated : null,
    isEstimate: hasValue(estimated),
    isKnown: hasValue(estimated),
  };
}

export function resolveEntrances(house) {
  return resolve(house.entrances, house.estimate?.entrances);
}

export function resolveApartments(house) {
  return resolve(house.apartments, house.estimate?.apartments);
}

export function resolveResidents(house) {
  return resolve(house.residentsCount, house.estimate?.residents);
}

export function getHouseTypeLabel(house) {
  return houseTypesById[house.type]?.label ?? 'Не визначено';
}

/** The stage of work in the active campaign — what the map colour encodes. */
export function getStage(house) {
  return workStagesById[campaignStateOf(house).stage] ?? workStagesById.not_started;
}

export function getPriority(house) {
  return prioritiesById[campaignStateOf(house).priority] ?? prioritiesById.medium;
}

export function getContactTypeLabel(typeId) {
  return contactTypesById[typeId]?.label ?? 'Контакт';
}

export function getPersonRoleLabel(roleId) {
  return personRolesById[roleId]?.label ?? 'Контактна особа';
}

/**
 * The signals shown *beside* the colour, never mixed into it.
 *
 * Each one answers a different question — "is this urgent", "has anybody got
 * it", "can I trust these numbers" — and a coordinator needs to see them at the
 * same time, which a single colour cannot do.
 */
export function getHouseFlags(house) {
  const state = campaignStateOf(house);
  const quality = house.quality ?? [];

  return {
    isUrgent: state.priority === 'high',
    hasOverdueTasks: state.overdueTasksCount > 0,
    hasOpenIssues: state.openIssuesCount > 0,
    hasNoAssignee: state.assignees.length === 0,
    isStale: quality.includes('staleVerification') || quality.includes('neverVerified'),
    hasDataProblem: quality.some((flag) =>
      ['missingCoordinates', 'incompleteAddress', 'missingSource', 'duplicateAddress'].includes(
        flag,
      ),
    ),
  };
}

/** Quality findings as labelled objects, in a stable display order. */
export function getQualityFindings(house) {
  const flags = new Set(house.quality ?? []);

  return QUALITY_FLAGS.filter((flag) => flags.has(flag.id));
}

export function getQualityLabel(flagId) {
  return qualityFlagsById[flagId]?.label ?? flagId;
}

/*
 * Search text is cached against the house object: the map may re-render often,
 * but a house record is replaced only when it is edited.
 */
const searchTextCache = new WeakMap();

/**
 * The haystack one house contributes to search.
 *
 * Beyond the address it now covers the responsible people, the precinct and any
 * contact the *server chose to send this viewer* — which is the whole trick
 * behind permission-aware search. A house whose contacts were withheld simply
 * has no phone number in its haystack, so a phone query cannot match it and
 * cannot reveal that it exists.
 */
export function getSearchText(house) {
  const cached = searchTextCache.get(house);

  if (cached) {
    return cached;
  }

  const state = campaignStateOf(house);
  const parts = [
    house.street,
    house.streetShort,
    house.number,
    house.address,
    house.fullAddress,
    ...(house.precincts ?? []).map((link) => `дільниця ${link.precinctNumber} ${link.district}`),
    ...state.assignees.map((assignee) => assignee.email),
    ...(house.people ?? []).flatMap((person) => [
      person.fullName,
      ...(person.contacts ?? []).filter((contact) => !contact.isMasked).map(
        (contact) => contact.value,
      ),
    ]),
  ];

  const text = normalizeText(parts.filter(Boolean).join(' '));
  const digits = (house.people ?? [])
    .flatMap((person) => person.contacts ?? [])
    .filter((contact) => !contact.isMasked)
    .map((contact) => normalizePhoneDigits(contact.value))
    .filter(Boolean)
    .join(' ');

  const combined = digits ? `${text} ${digits}` : text;

  searchTextCache.set(house, combined);

  return combined;
}

/**
 * Relevance score for a query, or `-1` when the house does not match.
 * Every token must be present; exact house-number and street-prefix hits rank
 * first so typing "коласа 6" lands on вул. Якуба Коласа, 6.
 */
export function scoreHouseMatch(house, tokens) {
  if (tokens.length === 0) {
    return 0;
  }

  const searchText = getSearchText(house);
  const normalizedNumber = normalizeText(house.number);
  const normalizedStreet = normalizeText(house.street);
  let score = 0;

  for (const token of tokens) {
    // A run of digits is probably a phone number, so it is also compared
    // against the normalised form — `0671234567` has to find `+380 67 …`.
    const phoneToken = /^\d{5,}$/.test(token) ? normalizePhoneDigits(token) : '';

    if (!searchText.includes(token) && !(phoneToken && searchText.includes(phoneToken))) {
      return -1;
    }

    if (normalizedNumber === token) {
      score += 60;
    } else if (normalizedNumber.startsWith(token)) {
      score += 25;
    }

    if (normalizedStreet.startsWith(token)) {
      score += 30;
    } else if (normalizedStreet.includes(` ${token}`)) {
      score += 20;
    }

    score += 5;
  }

  return score;
}

export function matchesQuery(house, tokens) {
  return scoreHouseMatch(house, tokens) >= 0;
}

/** Ranked suggestions for the search field. */
export function searchHouses(houses, query, limit = 8) {
  const tokens = tokenizeQuery(query);

  if (tokens.length === 0) {
    return [];
  }

  return houses
    .map((house) => ({ house, score: scoreHouseMatch(house, tokens) }))
    .filter((entry) => entry.score >= 0)
    .sort(
      (first, second) =>
        second.score - first.score ||
        first.house.distanceMeters - second.house.distanceMeters,
    )
    .slice(0, limit)
    .map((entry) => entry.house);
}

export const HOUSE_SORT_OPTIONS = [
  { id: 'distance', label: 'За відстанню від штабу' },
  { id: 'address', label: 'За адресою' },
  { id: 'stage', label: 'Спочатку не розпочаті' },
  { id: 'priority', label: 'Спочатку високий пріоритет' },
  { id: 'lastAction', label: 'Найдавніші дії спочатку' },
  { id: 'apartments', label: 'За кількістю квартир' },
];

/** Display order of stages, used for sorting "least advanced first". */
const STAGE_ORDER = [
  'not_started',
  'contact_setup',
  'in_progress',
  'revisit_needed',
  'blocked',
  'done',
  'not_applicable',
];

const PRIORITY_ORDER = ['high', 'medium', 'low'];

function compareHouses(first, second, sortBy) {
  if (sortBy === 'address') {
    return (
      first.street.localeCompare(second.street, 'uk') ||
      first.number.localeCompare(second.number, 'uk', { numeric: true })
    );
  }

  if (sortBy === 'stage') {
    return (
      STAGE_ORDER.indexOf(campaignStateOf(first).stage) -
        STAGE_ORDER.indexOf(campaignStateOf(second).stage) ||
      first.distanceMeters - second.distanceMeters
    );
  }

  if (sortBy === 'priority') {
    return (
      PRIORITY_ORDER.indexOf(campaignStateOf(first).priority) -
        PRIORITY_ORDER.indexOf(campaignStateOf(second).priority) ||
      first.distanceMeters - second.distanceMeters
    );
  }

  if (sortBy === 'lastAction') {
    // A house nobody has visited sorts first: "never" is older than any date.
    const left = campaignStateOf(first).lastActionAt ?? '';
    const right = campaignStateOf(second).lastActionAt ?? '';

    return left.localeCompare(right) || first.distanceMeters - second.distanceMeters;
  }

  if (sortBy === 'apartments') {
    // Houses with no usable estimate sort last rather than jumping to the top.
    return (resolveApartments(second).value ?? -1) - (resolveApartments(first).value ?? -1);
  }

  return first.distanceMeters - second.distanceMeters;
}

export const DEFAULT_HOUSE_FILTERS = {
  query: '',
  stage: 'all',
  priority: 'all',
  houseType: 'all',
  street: 'all',
  precinct: 'all',
  district: 'all',
  assignee: 'all',
  /** `all` | `none` | `any` — the "houses without an owner" filter. */
  assignment: 'all',
  contacts: 'all',
  issues: 'all',
  tasks: 'all',
  source: 'all',
  quality: 'all',
  verification: 'all',
  lastActionWithin: 'all',
  nextActionWithin: 'all',
  sortBy: 'distance',
};

function isWithinDays(isoValue, days) {
  if (!isoValue) {
    return false;
  }

  const parsed = Date.parse(isoValue);

  if (Number.isNaN(parsed)) {
    return false;
  }

  return Date.now() - parsed <= days * 86_400_000;
}

function isDueWithinDays(isoValue, days) {
  if (!isoValue) {
    return false;
  }

  const parsed = Date.parse(isoValue);

  if (Number.isNaN(parsed)) {
    return false;
  }

  return parsed - Date.now() <= days * 86_400_000;
}

/** Applies the toolbar filters and sorting to the full dataset. */
export function filterHouses(houses, filters = DEFAULT_HOUSE_FILTERS) {
  const merged = { ...DEFAULT_HOUSE_FILTERS, ...filters };
  const tokens = tokenizeQuery(merged.query);

  const filtered = houses.filter((house) => {
    const state = campaignStateOf(house);
    const flags = getHouseFlags(house);

    if (merged.stage !== 'all' && state.stage !== merged.stage) {
      return false;
    }

    if (merged.priority !== 'all' && state.priority !== merged.priority) {
      return false;
    }

    if (merged.houseType !== 'all' && house.type !== merged.houseType) {
      return false;
    }

    if (merged.street !== 'all' && house.street !== merged.street) {
      return false;
    }

    if (
      merged.precinct !== 'all' &&
      !(house.precincts ?? []).some((link) => link.precinctId === merged.precinct)
    ) {
      return false;
    }

    if (
      merged.district !== 'all' &&
      !(house.precincts ?? []).some((link) => link.district === merged.district)
    ) {
      return false;
    }

    if (
      merged.assignee !== 'all' &&
      !state.assignees.some((assignee) => assignee.email === merged.assignee)
    ) {
      return false;
    }

    if (merged.assignment === 'none' && !flags.hasNoAssignee) {
      return false;
    }

    if (merged.assignment === 'any' && flags.hasNoAssignee) {
      return false;
    }

    if (merged.contacts === 'with' && (house.contactsCount ?? 0) === 0) {
      return false;
    }

    if (merged.contacts === 'without' && (house.contactsCount ?? 0) > 0) {
      return false;
    }

    if (merged.issues === 'open' && !flags.hasOpenIssues) {
      return false;
    }

    if (merged.tasks === 'overdue' && !flags.hasOverdueTasks) {
      return false;
    }

    if (merged.tasks === 'today' && state.todayTasksCount === 0) {
      return false;
    }

    if (merged.tasks === 'open' && state.openTasksCount === 0) {
      return false;
    }

    if (merged.source !== 'all' && !String(house.source ?? '').startsWith(merged.source)) {
      return false;
    }

    if (merged.quality !== 'all' && !(house.quality ?? []).includes(merged.quality)) {
      return false;
    }

    if (merged.verification === 'stale' && !flags.isStale) {
      return false;
    }

    if (merged.verification === 'verified' && flags.isStale) {
      return false;
    }

    if (
      merged.lastActionWithin !== 'all' &&
      !isWithinDays(state.lastActionAt, Number(merged.lastActionWithin))
    ) {
      return false;
    }

    if (
      merged.nextActionWithin !== 'all' &&
      !isDueWithinDays(state.nextActionAt, Number(merged.nextActionWithin))
    ) {
      return false;
    }

    return matchesQuery(house, tokens);
  });

  return filtered.sort((first, second) => compareHouses(first, second, merged.sortBy));
}

export function hasActiveFilters(filters) {
  const merged = { ...DEFAULT_HOUSE_FILTERS, ...filters };

  return Object.entries(merged).some(([key, value]) => {
    if (key === 'sortBy') {
      return false;
    }

    if (key === 'query') {
      return Boolean(String(value).trim());
    }

    return value !== DEFAULT_HOUSE_FILTERS[key];
  });
}

/** Aggregate numbers for the page header, the legend and the filters. */
export function summarizeHouses(houses) {
  const summary = {
    total: houses.length,
    apartments: 0,
    residents: 0,
    knownContacts: 0,
    withoutAssignee: 0,
    openIssues: 0,
    overdueTasks: 0,
    todayTasks: 0,
    stale: 0,
    byStage: {},
    byPriority: {},
  };

  for (const house of houses) {
    const state = campaignStateOf(house);
    const flags = getHouseFlags(house);

    summary.byStage[state.stage] = (summary.byStage[state.stage] ?? 0) + 1;
    summary.byPriority[state.priority] = (summary.byPriority[state.priority] ?? 0) + 1;
    summary.apartments += resolveApartments(house).value ?? 0;
    summary.residents += resolveResidents(house).value ?? 0;
    // Counts houses that have at least one contact, not contact rows: a house
    // with three phones is still one house somebody can reach.
    summary.knownContacts += (house.contactsCount ?? 0) > 0 ? 1 : 0;
    summary.withoutAssignee += flags.hasNoAssignee ? 1 : 0;
    summary.openIssues += state.openIssuesCount;
    summary.overdueTasks += state.overdueTasksCount;
    summary.todayTasks += state.todayTasksCount;
    summary.stale += flags.isStale ? 1 : 0;
  }

  return summary;
}

/** `1 234` — thin spaces read better than the locale default in dense tables. */
export function formatNumber(value) {
  if (!Number.isFinite(value)) {
    return '—';
  }

  return new Intl.NumberFormat('uk-UA').format(value);
}

export function formatUpdatedAt(isoValue) {
  if (!isoValue) {
    return 'Ще не оновлювалося';
  }

  return new Intl.DateTimeFormat('uk-UA', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(isoValue));
}

export function formatDate(dateValue) {
  if (!dateValue) {
    return '—';
  }

  const parsed = new Date(
    dateValue.length === 10 ? `${dateValue}T12:00:00` : dateValue,
  );

  if (Number.isNaN(parsed.getTime())) {
    return '—';
  }

  return new Intl.DateTimeFormat('uk-UA', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(parsed);
}

/** `28.07` — the compact form the map tooltip and the card header use. */
export function formatShortDate(dateValue) {
  if (!dateValue) {
    return '—';
  }

  const parsed = new Date(
    dateValue.length === 10 ? `${dateValue}T12:00:00` : dateValue,
  );

  if (Number.isNaN(parsed.getTime())) {
    return '—';
  }

  return new Intl.DateTimeFormat('uk-UA', {
    day: '2-digit',
    month: '2-digit',
  }).format(parsed);
}

/** `9 поверхів` / `1 поверх` — Ukrainian plural rules for the few nouns we show. */
export function pluralize(count, forms) {
  const absolute = Math.abs(count) % 100;
  const lastDigit = absolute % 10;

  if (absolute > 10 && absolute < 20) {
    return forms[2];
  }

  if (lastDigit > 1 && lastDigit < 5) {
    return forms[1];
  }

  if (lastDigit === 1) {
    return forms[0];
  }

  return forms[2];
}

/**
 * OpenStreetMap has `building:levels` for roughly half the district, so "поверхи
 * невідомі" is a normal, frequent answer rather than an error state.
 */
export function formatFloors(floors) {
  if (!Number.isFinite(floors)) {
    return 'поверхи невідомі';
  }

  return `${floors} ${pluralize(floors, ['поверх', 'поверхи', 'поверхів'])}`;
}

export function formatEntrances(count) {
  if (!Number.isFinite(count)) {
    return '—';
  }

  return `${count} ${pluralize(count, ['підʼїзд', 'підʼїзди', 'підʼїздів'])}`;
}

export function formatApartments(count) {
  if (!Number.isFinite(count)) {
    return 'кількість квартир невідома';
  }

  return `${formatNumber(count)} ${pluralize(count, ['квартира', 'квартири', 'квартир'])}`;
}

export function formatHouses(count) {
  return `${formatNumber(count)} ${pluralize(count, ['будинок', 'будинки', 'будинків'])}`;
}

/** `коваленко@avku.org` → `коваленко` — enough to recognise a colleague. */
export function formatAssignee(email) {
  if (!email) {
    return '—';
  }

  return email.split('@')[0];
}

/** The precinct label for the tooltip and the card header. */
export function formatPrecincts(house) {
  const links = house.precincts ?? [];

  if (links.length === 0) {
    return 'дільниця не визначена';
  }

  if (links.length === 1) {
    return `дільниця №${links[0].precinctNumber}`;
  }

  return `дільниці ${links.map((link) => `№${link.precinctNumber}`).join(', ')}`;
}
