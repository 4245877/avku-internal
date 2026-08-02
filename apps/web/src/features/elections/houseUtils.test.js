/**
 * The pure helpers behind the map, the list and the card.
 *
 * The cases below are the ones the rebuild turns on: the map colour must depend
 * on the work stage and nothing else, urgency and data quality must be separate
 * signals, search must find a house by a phone number the viewer is allowed to
 * see and must not reveal one they are not, and the filters the field actually
 * asks for ("no owner", "overdue", "today") must work.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HOUSE_FILTERS,
  campaignStateOf,
  filterHouses,
  formatApartments,
  formatAssignee,
  formatEntrances,
  formatFloors,
  formatHouses,
  formatNumber,
  formatPrecincts,
  getHouseFlags,
  getQualityFindings,
  getSearchText,
  getStage,
  hasActiveFilters,
  matchesQuery,
  normalizePhoneDigits,
  normalizeText,
  resolveApartments,
  resolveEntrances,
  resolveResidents,
  scoreHouseMatch,
  searchHouses,
  summarizeHouses,
  tokenizeQuery,
} from './houseUtils.js';
import { createEmptyCampaignState } from './electionsTypes.js';

const HOUR = 3_600_000;

function createHouse(overrides = {}) {
  const { campaign, ...rest } = overrides;

  return {
    id: 'house-1',
    osmType: 'way',
    osmId: 1001,
    street: 'вулиця Якуба Коласа',
    streetShort: 'вул. Якуба Коласа',
    number: '6',
    address: 'вул. Якуба Коласа, 6',
    fullAddress: 'вулиця Якуба Коласа, 6, Київ',
    type: 'apartments',
    floors: 9,
    footprintAreaSqm: 1200,
    location: { lat: 50.43, lon: 30.36 },
    footprint: [],
    distanceMeters: 40,
    isHeadquarters: false,
    entrances: null,
    apartments: null,
    residentsCount: null,
    estimate: { entrances: 4, apartments: 144, residents: 274 },
    source: 'osm',
    verifiedAt: null,
    precincts: [],
    people: [],
    contactsCount: 0,
    quality: [],
    ...rest,
    campaign: { ...createEmptyCampaignState(), ...(campaign ?? {}) },
  };
}

describe('normalizeText and tokenizeQuery', () => {
  it('folds the apostrophe variants Ukrainian input mixes', () => {
    expect(normalizeText('підʼїзд')).toBe(normalizeText("під'їзд"));
    expect(normalizeText('  Вулиця   Зодчих ')).toBe('вулиця зодчих');
  });

  it('splits a query on spaces and punctuation', () => {
    expect(tokenizeQuery('вул. Коласа, 6')).toEqual(['вул', 'коласа', '6']);
  });
});

describe('normalizePhoneDigits', () => {
  it('brings the ways a Ukrainian number is written to one form', () => {
    expect(normalizePhoneDigits('0671234567')).toBe('380671234567');
    expect(normalizePhoneDigits('+380 67 123 45 67')).toBe('380671234567');
    expect(normalizePhoneDigits('380671234567')).toBe('380671234567');
  });
});

describe('measured values and estimates', () => {
  it('prefers a confirmed count and marks a fallback as an estimate', () => {
    expect(resolveEntrances(createHouse({ entrances: 6 }))).toEqual({
      value: 6,
      isEstimate: false,
      isKnown: true,
    });
    expect(resolveEntrances(createHouse())).toEqual({
      value: 4,
      isEstimate: true,
      isKnown: true,
    });
  });

  it('says "unknown" rather than zero when neither source has an answer', () => {
    const house = createHouse({
      estimate: { entrances: null, apartments: null, residents: null },
    });

    expect(resolveApartments(house)).toEqual({
      value: null,
      isEstimate: false,
      isKnown: false,
    });
    expect(resolveResidents(house).isKnown).toBe(false);
  });

  it('treats a confirmed zero as data, not as missing', () => {
    expect(resolveResidents(createHouse({ residentsCount: 0 }))).toEqual({
      value: 0,
      isEstimate: false,
      isKnown: true,
    });
  });
});

describe('stage, priority and the separate signals', () => {
  it('reads the stage from the campaign state, defaulting to not started', () => {
    expect(getStage(createHouse()).id).toBe('not_started');
    expect(getStage(createHouse({ campaign: { stage: 'done' } })).id).toBe('done');
  });

  it('falls back to a known stage when the server sends something unexpected', () => {
    expect(getStage(createHouse({ campaign: { stage: 'вигадка' } })).id).toBe('not_started');
  });

  /*
   * The heart of the change: urgency, ownership, freshness and open work are
   * four independent facts. A finished house can still be unowned and still
   * carry an overdue task, and each has to be visible on its own.
   */
  it('reports urgency, ownership and freshness independently of the stage', () => {
    const house = createHouse({
      quality: ['staleVerification', 'noAssignee', 'overdueTasks'],
      campaign: {
        stage: 'done',
        priority: 'high',
        overdueTasksCount: 2,
        openIssuesCount: 1,
        assignees: [],
      },
    });

    expect(getStage(house).id).toBe('done');
    expect(getHouseFlags(house)).toMatchObject({
      isUrgent: true,
      hasOverdueTasks: true,
      hasOpenIssues: true,
      hasNoAssignee: true,
      isStale: true,
    });
  });

  it('does not call a house urgent just because it is unfinished', () => {
    const flags = getHouseFlags(createHouse({ campaign: { stage: 'in_progress' } }));

    expect(flags.isUrgent).toBe(false);
    expect(flags.hasOverdueTasks).toBe(false);
  });

  it('surfaces data-quality findings as labels without changing anything', () => {
    const findings = getQualityFindings(
      createHouse({ quality: ['duplicateAddress', 'missingCoordinates'] }),
    );

    expect(findings.map((finding) => finding.id)).toEqual([
      'missingCoordinates',
      'duplicateAddress',
    ]);
  });
});

describe('search', () => {
  it('ranks an exact house number above a street-only match', () => {
    const exact = createHouse({ id: 'exact', number: '6' });
    const other = createHouse({ id: 'other', number: '61' });

    expect(scoreHouseMatch(exact, tokenizeQuery('коласа 6'))).toBeGreaterThan(
      scoreHouseMatch(other, tokenizeQuery('коласа 6')),
    );
  });

  it('requires every token to be present', () => {
    expect(matchesQuery(createHouse(), tokenizeQuery('коласа 6'))).toBe(true);
    expect(matchesQuery(createHouse(), tokenizeQuery('коласа 6 зодчих'))).toBe(false);
  });

  it('finds a house by the phone number of a contact the viewer can see', () => {
    const house = createHouse({
      people: [
        {
          id: 'p1',
          fullName: 'Коваленко Олена',
          contacts: [
            { id: 'c1', type: 'phone', value: '+380 67 123 45 67', isMasked: false },
          ],
        },
      ],
    });

    expect(matchesQuery(house, tokenizeQuery('0671234567'))).toBe(true);
    expect(searchHouses([house], '0671234567')).toHaveLength(1);
  });

  it('finds a house by its responsible person', () => {
    const house = createHouse({
      campaign: {
        assignees: [{ id: 'a1', email: 'kovalenko@avku.org', role: 'agitator' }],
      },
    });

    expect(matchesQuery(house, tokenizeQuery('kovalenko'))).toBe(true);
  });

  /*
   * The server withholds contact values the viewer may not see and marks them
   * masked. A masked value must not enter the haystack, or a phone search would
   * confirm which building a number belongs to without ever showing it.
   */
  it('never matches a contact the server masked', () => {
    const house = createHouse({
      id: 'masked',
      people: [
        {
          id: 'p1',
          fullName: 'Коваленко О.',
          contacts: [{ id: 'c1', type: 'phone', value: '+380•••••67', isMasked: true }],
        },
      ],
    });

    expect(getSearchText(house)).not.toContain('380671234567');
    expect(matchesQuery(house, tokenizeQuery('0671234567'))).toBe(false);
  });

  it('finds a house by its precinct number', () => {
    const house = createHouse({
      precincts: [
        { id: 'pr1', precinctId: 'pr1', precinctNumber: '123', district: 'Округ 5' },
      ],
    });

    expect(matchesQuery(house, tokenizeQuery('дільниця 123'))).toBe(true);
  });
});

describe('filterHouses', () => {
  const overdue = createHouse({
    id: 'overdue',
    number: '10',
    contactsCount: 1,
    quality: ['overdueTasks'],
    campaign: {
      stage: 'in_progress',
      priority: 'high',
      overdueTasksCount: 1,
      openTasksCount: 1,
      assignees: [{ id: 'a1', email: 'ivan@avku.org', role: 'agitator' }],
    },
  });

  const unowned = createHouse({
    id: 'unowned',
    number: '12',
    quality: ['noAssignee', 'staleVerification'],
    campaign: { stage: 'not_started', assignees: [] },
  });

  const done = createHouse({
    id: 'done',
    number: '14',
    source: 'import:batch-1',
    precincts: [{ id: 'l1', precinctId: 'pr1', precinctNumber: '123', district: 'Округ 5' }],
    campaign: {
      stage: 'done',
      openIssuesCount: 2,
      todayTasksCount: 1,
      openTasksCount: 1,
      lastActionAt: new Date(Date.now() - 2 * HOUR).toISOString(),
      assignees: [{ id: 'a2', email: 'olena@avku.org', role: 'coordinator' }],
    },
  });

  const houses = [overdue, unowned, done];

  const ids = (filters) =>
    filterHouses(houses, { ...DEFAULT_HOUSE_FILTERS, ...filters }).map((house) => house.id);

  it('returns everything by default', () => {
    expect(ids({})).toHaveLength(3);
  });

  it('filters by stage', () => {
    expect(ids({ stage: 'done' })).toEqual(['done']);
    expect(ids({ stage: 'not_started' })).toEqual(['unowned']);
  });

  it('filters by priority', () => {
    expect(ids({ priority: 'high' })).toEqual(['overdue']);
  });

  it('finds the houses nobody is responsible for', () => {
    expect(ids({ assignment: 'none' })).toEqual(['unowned']);
    expect(ids({ assignment: 'any' }).sort()).toEqual(['done', 'overdue']);
  });

  it('filters by responsible person', () => {
    expect(ids({ assignee: 'olena@avku.org' })).toEqual(['done']);
  });

  it('filters overdue, today and open work separately', () => {
    expect(ids({ tasks: 'overdue' })).toEqual(['overdue']);
    expect(ids({ tasks: 'today' })).toEqual(['done']);
    expect(ids({ issues: 'open' })).toEqual(['done']);
  });

  it('filters by precinct and by district', () => {
    expect(ids({ precinct: 'pr1' })).toEqual(['done']);
    expect(ids({ district: 'Округ 5' })).toEqual(['done']);
  });

  it('filters by contact presence, source and data quality', () => {
    expect(ids({ contacts: 'with' })).toEqual(['overdue']);
    expect(ids({ source: 'import:' })).toEqual(['done']);
    expect(ids({ quality: 'noAssignee' })).toEqual(['unowned']);
    expect(ids({ verification: 'stale' })).toEqual(['unowned']);
  });

  it('filters by how recently something was done', () => {
    expect(ids({ lastActionWithin: '7' })).toEqual(['done']);
  });

  it('combines filters rather than replacing them', () => {
    expect(ids({ stage: 'in_progress', priority: 'high' })).toEqual(['overdue']);
    expect(ids({ stage: 'done', priority: 'high' })).toEqual([]);
  });

  it('sorts least-advanced first when asked', () => {
    expect(ids({ sortBy: 'stage' })).toEqual(['unowned', 'overdue', 'done']);
  });

  it('sorts by priority when asked', () => {
    expect(ids({ sortBy: 'priority' })[0]).toBe('overdue');
  });

  it('reports whether any filter is actually narrowing the set', () => {
    expect(hasActiveFilters(DEFAULT_HOUSE_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_HOUSE_FILTERS, sortBy: 'address' })).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_HOUSE_FILTERS, assignment: 'none' })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_HOUSE_FILTERS, query: ' зодчих ' })).toBe(true);
  });
});

describe('summarizeHouses', () => {
  it('counts by stage and totals the separate signals', () => {
    const summary = summarizeHouses([
      createHouse({
        id: 'a',
        contactsCount: 2,
        campaign: {
          stage: 'done',
          overdueTasksCount: 1,
          openIssuesCount: 2,
          assignees: [{ id: 'x', email: 'a@b.c', role: 'agitator' }],
        },
      }),
      createHouse({
        id: 'b',
        quality: ['neverVerified'],
        estimate: { entrances: null, apartments: null, residents: null },
        campaign: { stage: 'not_started', assignees: [] },
      }),
    ]);

    expect(summary.total).toBe(2);
    expect(summary.byStage).toEqual({ done: 1, not_started: 1 });
    expect(summary.withoutAssignee).toBe(1);
    expect(summary.overdueTasks).toBe(1);
    expect(summary.openIssues).toBe(2);
    expect(summary.stale).toBe(1);
    // One house has contacts, not two contact rows — the number the header
    // shows is "houses we can reach".
    expect(summary.knownContacts).toBe(1);
  });

  it('sums apartments from estimates without pretending they are measured', () => {
    const summary = summarizeHouses([createHouse()]);

    expect(summary.apartments).toBe(144);
    expect(summary.residents).toBe(274);
  });
});

describe('campaignStateOf', () => {
  it('answers with an empty state rather than throwing on a bare house', () => {
    expect(campaignStateOf({ id: 'x' })).toMatchObject({
      stage: 'not_started',
      assignees: [],
    });
  });
});

describe('formatting', () => {
  it('applies Ukrainian plural rules', () => {
    expect(formatEntrances(1)).toBe('1 підʼїзд');
    expect(formatEntrances(3)).toBe('3 підʼїзди');
    expect(formatEntrances(11)).toBe('11 підʼїздів');
    expect(formatFloors(9)).toBe('9 поверхів');
    expect(formatHouses(2)).toContain('будинки');
  });

  it('says so instead of showing a dash-shaped lie', () => {
    expect(formatNumber(Number.NaN)).toBe('—');
    expect(formatFloors(null)).toBe('поверхи невідомі');
    expect(formatApartments(null)).toBe('кількість квартир невідома');
  });

  it('shortens an assignee to something recognisable', () => {
    expect(formatAssignee('kovalenko@avku.org')).toBe('kovalenko');
    expect(formatAssignee(null)).toBe('—');
  });

  it('describes precincts, including a house split between two', () => {
    expect(formatPrecincts(createHouse())).toBe('дільниця не визначена');
    expect(
      formatPrecincts(
        createHouse({
          precincts: [
            { id: 'l1', precinctId: 'p1', precinctNumber: '123', district: '' },
            { id: 'l2', precinctId: 'p2', precinctNumber: '124', district: '' },
          ],
        }),
      ),
    ).toBe('дільниці №123, №124');
  });
});
