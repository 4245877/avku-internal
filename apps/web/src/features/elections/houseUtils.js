/**
 * Derived, pure helpers for house records: completeness, search, filtering and
 * display formatting. Everything here is UI-agnostic and unit-tested, so the
 * map, the list and the details panel always agree on what a house "is".
 */

import {
  AGE_GROUPS,
  COMPLETION_FIELDS,
  SUPPORT_STANCES,
  ageGroupsById,
  canvassStatusesById,
  contactTypesById,
  createEmptyDetails,
  houseTypesById,
  prioritiesById,
  supportStancesById,
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

/** Which completeness fields a details record satisfies. */
export function getCompletedFields(details = createEmptyDetails()) {
  const completed = [];

  if (hasValue(details.entrances)) {
    completed.push('entrances');
  }

  if (hasValue(details.apartments)) {
    completed.push('apartments');
  }

  if (details.residents?.length > 0 || hasValue(details.residentsCount)) {
    completed.push('residents');
  }

  if (details.contacts?.some((contact) => contact.value?.trim())) {
    completed.push('contacts');
  }

  if (details.notes?.trim()) {
    completed.push('notes');
  }

  return completed;
}

/** `complete` when every completeness field is filled, `empty` when none is. */
export function getFillStatus(house) {
  const completed = getCompletedFields(house.details);

  if (completed.length === 0) {
    return 'empty';
  }

  return completed.length === COMPLETION_FIELDS.length ? 'complete' : 'partial';
}

/** 0…1 share of completeness fields filled — drives the progress bar. */
export function getCompletionRatio(house) {
  return getCompletedFields(house.details).length / COMPLETION_FIELDS.length;
}

/** Completeness fields still waiting for data, as labels for the UI. */
export function getMissingFieldLabels(house) {
  const completed = new Set(getCompletedFields(house.details));

  return COMPLETION_FIELDS.filter((field) => !completed.has(field.id)).map(
    (field) => field.label,
  );
}

/**
 * Confirmed value if a canvasser entered one, otherwise the geometry estimate.
 * `isEstimate` lets the UI show "оціночно" instead of pretending to know.
 */
export function resolveEntrances(house) {
  return hasValue(house.details?.entrances)
    ? { value: house.details.entrances, isEstimate: false }
    : { value: house.estimate.entrances, isEstimate: true };
}

export function resolveApartments(house) {
  return hasValue(house.details?.apartments)
    ? { value: house.details.apartments, isEstimate: false }
    : { value: house.estimate.apartments, isEstimate: true };
}

export function resolveResidents(house) {
  return hasValue(house.details?.residentsCount)
    ? { value: house.details.residentsCount, isEstimate: false }
    : { value: house.estimate.residents, isEstimate: true };
}

/** Counts known residents per political stance, in a stable display order. */
export function getStanceBreakdown(house) {
  const counts = new Map(SUPPORT_STANCES.map((stance) => [stance.id, 0]));

  for (const resident of house.details?.residents ?? []) {
    const key = counts.has(resident.stance) ? resident.stance : 'unknown';
    counts.set(key, counts.get(key) + 1);
  }

  return SUPPORT_STANCES.map((stance) => ({
    ...stance,
    count: counts.get(stance.id),
  }));
}

export function getHouseTypeLabel(house) {
  return houseTypesById[house.type]?.label ?? 'Не визначено';
}

export function getCanvassStatus(house) {
  return canvassStatusesById[house.details?.canvassStatus] ?? canvassStatusesById.planned;
}

export function getPriority(house) {
  return prioritiesById[house.details?.priority] ?? prioritiesById.medium;
}

export function getStanceLabel(stanceId) {
  return supportStancesById[stanceId]?.label ?? 'Невідомо';
}

export function getAgeGroupLabel(ageGroupId) {
  return ageGroupsById[ageGroupId]?.label ?? AGE_GROUPS[0].label;
}

export function getContactTypeLabel(typeId) {
  return contactTypesById[typeId]?.label ?? 'Контакт';
}

/*
 * Search text is cached against the house object: the map may re-render often,
 * but a house only changes when it is edited.
 */
const searchTextCache = new WeakMap();

function getSearchText(house) {
  const cached = searchTextCache.get(house);

  if (cached) {
    return cached;
  }

  const text = normalizeText(
    `${house.street} ${house.streetShort} ${house.number} ${house.address}`,
  );

  searchTextCache.set(house, text);

  return text;
}

/**
 * Relevance score for an address query, or `-1` when the house does not match.
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
    if (!searchText.includes(token)) {
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

/** Ranked address suggestions for the search field. */
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
  { id: 'completion', label: 'Спочатку незаповнені' },
  { id: 'apartments', label: 'За кількістю квартир' },
];

function compareHouses(first, second, sortBy) {
  if (sortBy === 'address') {
    return (
      first.street.localeCompare(second.street, 'uk') ||
      first.number.localeCompare(second.number, 'uk', { numeric: true })
    );
  }

  if (sortBy === 'completion') {
    return (
      getCompletionRatio(first) - getCompletionRatio(second) ||
      first.distanceMeters - second.distanceMeters
    );
  }

  if (sortBy === 'apartments') {
    return resolveApartments(second).value - resolveApartments(first).value;
  }

  return first.distanceMeters - second.distanceMeters;
}

export const DEFAULT_HOUSE_FILTERS = {
  query: '',
  fillStatus: 'all',
  houseType: 'all',
  street: 'all',
  sortBy: 'distance',
};

/** Applies the toolbar filters and sorting to the full dataset. */
export function filterHouses(houses, filters = DEFAULT_HOUSE_FILTERS) {
  const tokens = tokenizeQuery(filters.query);

  const filtered = houses.filter((house) => {
    if (filters.fillStatus !== 'all' && getFillStatus(house) !== filters.fillStatus) {
      return false;
    }

    if (filters.houseType !== 'all' && house.type !== filters.houseType) {
      return false;
    }

    if (filters.street !== 'all' && house.street !== filters.street) {
      return false;
    }

    return matchesQuery(house, tokens);
  });

  return filtered.sort((first, second) => compareHouses(first, second, filters.sortBy));
}

export function hasActiveFilters(filters) {
  return (
    Boolean(filters.query.trim()) ||
    filters.fillStatus !== 'all' ||
    filters.houseType !== 'all' ||
    filters.street !== 'all'
  );
}

/** Aggregate numbers for the page header and the legend. */
export function summarizeHouses(houses) {
  const summary = {
    total: houses.length,
    complete: 0,
    partial: 0,
    empty: 0,
    apartments: 0,
    residents: 0,
    knownContacts: 0,
  };

  for (const house of houses) {
    summary[getFillStatus(house)] += 1;
    summary.apartments += resolveApartments(house).value;
    summary.residents += resolveResidents(house).value;
    summary.knownContacts += house.details?.contacts?.length ?? 0;
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

export function formatSurveyDate(dateValue) {
  if (!dateValue) {
    return 'Обхід не проводився';
  }

  return new Intl.DateTimeFormat('uk-UA', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${dateValue}T12:00:00`));
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

export function formatFloors(floors) {
  return `${floors} ${pluralize(floors, ['поверх', 'поверхи', 'поверхів'])}`;
}

export function formatEntrances(count) {
  return `${count} ${pluralize(count, ['підʼїзд', 'підʼїзди', 'підʼїздів'])}`;
}

export function formatApartments(count) {
  return `${formatNumber(count)} ${pluralize(count, ['квартира', 'квартири', 'квартир'])}`;
}

export function formatHouses(count) {
  return `${formatNumber(count)} ${pluralize(count, ['будинок', 'будинки', 'будинків'])}`;
}
