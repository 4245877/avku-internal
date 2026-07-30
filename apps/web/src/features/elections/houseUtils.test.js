import { describe, expect, it } from 'vitest';

import {
  createEmptyContact,
  createEmptyDetails,
  createEmptyResident,
} from './electionsTypes.js';
import {
  DEFAULT_HOUSE_FILTERS,
  filterHouses,
  formatApartments,
  formatFloors,
  getCompletedFields,
  getCompletionRatio,
  getFillStatus,
  getMissingFieldLabels,
  getStanceBreakdown,
  hasActiveFilters,
  matchesQuery,
  normalizeText,
  pluralize,
  resolveApartments,
  resolveEntrances,
  resolveResidents,
  scoreHouseMatch,
  searchHouses,
  summarizeHouses,
  tokenizeQuery,
} from './houseUtils.js';

function createHouse(overrides = {}) {
  return {
    id: 'house-1',
    street: 'вулиця Якуба Коласа',
    streetShort: 'вул. Якуба Коласа',
    number: '6',
    address: 'вул. Якуба Коласа, 6',
    fullAddress: 'вул. Якуба Коласа, 6, Київ, 03146',
    type: 'apartments',
    floors: 9,
    builtYear: 1976,
    location: { lat: 50.4569, lon: 30.3618 },
    footprint: [],
    distanceMeters: 40,
    estimate: { entrances: 4, apartments: 144, residents: 274 },
    details: createEmptyDetails(),
    isHeadquarters: false,
    ...overrides,
  };
}

function createCompleteDetails(overrides = {}) {
  return {
    ...createEmptyDetails(),
    entrances: 4,
    apartments: 144,
    residents: [{ ...createEmptyResident(), name: 'Коваленко Олена', stance: 'support' }],
    contacts: [{ ...createEmptyContact(), value: '+380 67 123 45 67' }],
    notes: 'Активний ОСББ.',
    ...overrides,
  };
}

describe('getFillStatus', () => {
  it('reports an untouched house as empty', () => {
    expect(getFillStatus(createHouse())).toBe('empty');
    expect(getCompletedFields(createHouse().details)).toEqual([]);
  });

  it('reports a fully surveyed house as complete', () => {
    const house = createHouse({ details: createCompleteDetails() });

    expect(getFillStatus(house)).toBe('complete');
    expect(getCompletionRatio(house)).toBe(1);
    expect(getMissingFieldLabels(house)).toEqual([]);
  });

  it('reports a house as partial when any block is missing', () => {
    const house = createHouse({
      details: createCompleteDetails({ notes: '', contacts: [] }),
    });

    expect(getFillStatus(house)).toBe('partial');
    expect(getCompletionRatio(house)).toBeCloseTo(0.6);
    expect(getMissingFieldLabels(house)).toEqual(['Контактні дані', 'Нотатки']);
  });

  it('ignores contacts that only exist as empty rows', () => {
    const house = createHouse({
      details: createCompleteDetails({ contacts: [createEmptyContact()] }),
    });

    expect(getCompletedFields(house.details)).not.toContain('contacts');
  });

  it('counts an aggregate resident number as resident data', () => {
    const house = createHouse({
      details: { ...createEmptyDetails(), residentsCount: 240 },
    });

    expect(getCompletedFields(house.details)).toEqual(['residents']);
  });
});

describe('estimate fallbacks', () => {
  it('falls back to the geometry estimate and flags it', () => {
    const house = createHouse();

    expect(resolveEntrances(house)).toEqual({ value: 4, isEstimate: true, isKnown: true });
    expect(resolveApartments(house)).toEqual({
      value: 144,
      isEstimate: true,
      isKnown: true,
    });
    expect(resolveResidents(house)).toEqual({
      value: 274,
      isEstimate: true,
      isKnown: true,
    });
  });

  it('prefers surveyed values over the estimate', () => {
    const house = createHouse({
      details: { ...createEmptyDetails(), entrances: 6, apartments: 210, residentsCount: 400 },
    });

    expect(resolveEntrances(house)).toEqual({ value: 6, isEstimate: false, isKnown: true });
    expect(resolveApartments(house)).toEqual({
      value: 210,
      isEstimate: false,
      isKnown: true,
    });
    expect(resolveResidents(house)).toEqual({
      value: 400,
      isEstimate: false,
      isKnown: true,
    });
  });

  it('treats a surveyed zero as a real answer, not a missing one', () => {
    const house = createHouse({
      details: { ...createEmptyDetails(), residentsCount: 0 },
    });

    expect(resolveResidents(house)).toEqual({ value: 0, isEstimate: false, isKnown: true });
  });

  /*
   * OpenStreetMap knows the outline of every house but the storey count of only
   * about half of them, so "no answer from either source" is a normal state the
   * UI has to be able to render.
   */
  it('reports nothing known when OSM supports no estimate either', () => {
    const house = createHouse({
      floors: null,
      estimate: { entrances: null, apartments: null, residents: null },
    });

    expect(resolveApartments(house)).toEqual({
      value: null,
      isEstimate: false,
      isKnown: false,
    });
    expect(formatApartments(resolveApartments(house).value)).toBe(
      'кількість квартир невідома',
    );
    expect(formatFloors(house.floors)).toBe('поверхи невідомі');
  });

  it('keeps totals finite when part of the district has no estimate', () => {
    const summary = summarizeHouses([
      createHouse(),
      createHouse({
        id: 'house-2',
        estimate: { entrances: null, apartments: null, residents: null },
      }),
    ]);

    expect(summary.apartments).toBe(144);
    expect(summary.residents).toBe(274);
  });
});

describe('search', () => {
  it('normalises case and apostrophe variants', () => {
    expect(normalizeText('  Підʼїзд   Один ')).toBe('підїзд один');
    expect(normalizeText("Прикордон'ників")).toBe('прикордонників');
    expect(tokenizeQuery('Коласа, 6')).toEqual(['коласа', '6']);
  });

  it('requires every token to match', () => {
    const house = createHouse();

    expect(matchesQuery(house, tokenizeQuery('коласа 6'))).toBe(true);
    expect(matchesQuery(house, tokenizeQuery('коласа 6 зодчих'))).toBe(false);
    expect(scoreHouseMatch(house, tokenizeQuery('зодчих'))).toBe(-1);
  });

  it('matches everything when the query is empty', () => {
    expect(matchesQuery(createHouse(), tokenizeQuery('   '))).toBe(true);
  });

  it('ranks an exact house number above a partial one', () => {
    const exact = createHouse({ id: 'exact', number: '6', address: 'вул. Якуба Коласа, 6' });
    const partial = createHouse({ id: 'partial', number: '16', address: 'вул. Якуба Коласа, 16' });

    const tokens = tokenizeQuery('коласа 6');

    expect(scoreHouseMatch(exact, tokens)).toBeGreaterThan(scoreHouseMatch(partial, tokens));
  });

  it('returns the closest house first among equally scored matches', () => {
    const near = createHouse({ id: 'near', distanceMeters: 40 });
    const far = createHouse({ id: 'far', distanceMeters: 900 });

    expect(searchHouses([far, near], 'коласа 6').map((house) => house.id)).toEqual([
      'near',
      'far',
    ]);
  });

  it('returns nothing for a blank query', () => {
    expect(searchHouses([createHouse()], '  ')).toEqual([]);
  });

  it('respects the suggestion limit', () => {
    const houses = Array.from({ length: 12 }, (_, index) =>
      createHouse({ id: `house-${index}`, number: String(index + 1) }),
    );

    expect(searchHouses(houses, 'коласа', 5)).toHaveLength(5);
  });
});

describe('filterHouses', () => {
  const houses = [
    createHouse({
      id: 'complete-far',
      number: '10',
      address: 'вул. Якуба Коласа, 10',
      distanceMeters: 800,
      details: createCompleteDetails(),
    }),
    createHouse({
      id: 'empty-near',
      number: '12',
      address: 'вул. Якуба Коласа, 12',
      distanceMeters: 100,
    }),
    createHouse({
      id: 'private-other-street',
      street: 'вулиця Зодчих',
      streetShort: 'вул. Зодчих',
      number: '3',
      address: 'вул. Зодчих, 3',
      type: 'private',
      distanceMeters: 450,
    }),
  ];

  it('returns everything and sorts by distance by default', () => {
    expect(filterHouses(houses, DEFAULT_HOUSE_FILTERS).map((house) => house.id)).toEqual([
      'empty-near',
      'private-other-street',
      'complete-far',
    ]);
  });

  it('filters by completeness', () => {
    const filtered = filterHouses(houses, {
      ...DEFAULT_HOUSE_FILTERS,
      fillStatus: 'complete',
    });

    expect(filtered.map((house) => house.id)).toEqual(['complete-far']);
  });

  it('filters by street and building type', () => {
    expect(
      filterHouses(houses, { ...DEFAULT_HOUSE_FILTERS, street: 'вулиця Зодчих' }),
    ).toHaveLength(1);

    expect(
      filterHouses(houses, { ...DEFAULT_HOUSE_FILTERS, houseType: 'private' }),
    ).toHaveLength(1);
  });

  it('combines the query with the other filters', () => {
    const filtered = filterHouses(houses, {
      ...DEFAULT_HOUSE_FILTERS,
      query: 'коласа',
      fillStatus: 'empty',
    });

    expect(filtered.map((house) => house.id)).toEqual(['empty-near']);
  });

  it('sorts unfilled houses first for the completion order', () => {
    const filtered = filterHouses(houses, {
      ...DEFAULT_HOUSE_FILTERS,
      sortBy: 'completion',
    });

    expect(filtered[filtered.length - 1].id).toBe('complete-far');
  });

  it('sorts by address alphabetically and numerically', () => {
    const filtered = filterHouses(houses, { ...DEFAULT_HOUSE_FILTERS, sortBy: 'address' });

    expect(filtered.map((house) => house.address)).toEqual([
      'вул. Зодчих, 3',
      'вул. Якуба Коласа, 10',
      'вул. Якуба Коласа, 12',
    ]);
  });

  it('does not mutate the source array', () => {
    const order = houses.map((house) => house.id);

    filterHouses(houses, { ...DEFAULT_HOUSE_FILTERS, sortBy: 'address' });

    expect(houses.map((house) => house.id)).toEqual(order);
  });

  it('detects active filters', () => {
    expect(hasActiveFilters(DEFAULT_HOUSE_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_HOUSE_FILTERS, query: ' ' })).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_HOUSE_FILTERS, query: 'коласа' })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_HOUSE_FILTERS, fillStatus: 'empty' })).toBe(true);
    // Sorting is not a filter — it must not light up the reset button.
    expect(hasActiveFilters({ ...DEFAULT_HOUSE_FILTERS, sortBy: 'address' })).toBe(false);
  });
});

describe('summarizeHouses', () => {
  it('aggregates completeness and estimated volumes', () => {
    const summary = summarizeHouses([
      createHouse({ id: 'a', details: createCompleteDetails() }),
      createHouse({ id: 'b', details: createCompleteDetails({ notes: '' }) }),
      createHouse({ id: 'c' }),
    ]);

    expect(summary).toMatchObject({
      total: 3,
      complete: 1,
      partial: 1,
      empty: 1,
      knownContacts: 2,
    });
    // Two surveyed houses report 144 apartments, the untouched one is estimated.
    expect(summary.apartments).toBe(144 * 3);
  });

  it('handles an empty dataset', () => {
    expect(summarizeHouses([])).toMatchObject({ total: 0, complete: 0, apartments: 0 });
  });
});

describe('getStanceBreakdown', () => {
  it('counts residents per stance in display order', () => {
    const house = createHouse({
      details: createCompleteDetails({
        residents: [
          { ...createEmptyResident(), name: 'A', stance: 'support' },
          { ...createEmptyResident(), name: 'B', stance: 'support' },
          { ...createEmptyResident(), name: 'C', stance: 'against' },
          { ...createEmptyResident(), name: 'D', stance: 'нісенітниця' },
        ],
      }),
    });

    const breakdown = getStanceBreakdown(house);

    expect(breakdown.map((stance) => stance.id)).toEqual([
      'support',
      'neutral',
      'against',
      'unknown',
    ]);
    expect(breakdown.map((stance) => stance.count)).toEqual([2, 0, 1, 1]);
  });
});

describe('pluralize', () => {
  it('applies Ukrainian plural rules', () => {
    const forms = ['поверх', 'поверхи', 'поверхів'];

    expect(pluralize(1, forms)).toBe('поверх');
    expect(pluralize(2, forms)).toBe('поверхи');
    expect(pluralize(5, forms)).toBe('поверхів');
    expect(pluralize(11, forms)).toBe('поверхів');
    expect(pluralize(21, forms)).toBe('поверх');
    expect(pluralize(0, forms)).toBe('поверхів');
    expect(formatFloors(9)).toBe('9 поверхів');
  });
});
