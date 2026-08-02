/**
 * The house card as a field worker meets it.
 *
 * Four things are pinned down here, and each is an acceptance criterion of the
 * rebuild rather than a rendering detail:
 *
 *   • the seven tabs exist, and the header answers the coordinator's questions
 *     without navigating anywhere;
 *   • a visit result is three taps — open the card, «Візит», a result button —
 *     and it reaches the server with no author field for anyone to forge;
 *   • an agitator sees no contacts for a house that is not theirs, and the DOM
 *     holds no trace of the withheld values;
 *   • **nothing renders a political position or an age band.** Those fields
 *     were removed from the module, and this fails loudly if one ever comes
 *     back through a payload.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import HouseDetailsPanel from './HouseDetailsPanel.jsx';
import { createEmptyCampaignState } from '../../../features/elections/electionsTypes.js';

/*
 * Each tab loads its own collection. Stubbing the module boundary — rather than
 * `fetch` — keeps the test about the card and not about URL shapes.
 */
vi.mock('../../../features/elections/electionsApi.js', () => ({
  fetchHousePeople: vi.fn(async () => []),
  fetchHouseActions: vi.fn(async () => []),
  fetchHouseIssues: vi.fn(async () => []),
  fetchHouseTasks: vi.fn(async () => []),
  fetchHouseAttachments: vi.fn(async () => []),
  fetchHouseHistory: vi.fn(async () => []),
}));

import * as api from '../../../features/elections/electionsApi.js';

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
    building: 'apartments',
    floors: 9,
    footprintAreaSqm: 1200,
    location: { lat: 50.43, lon: 30.36 },
    footprint: [],
    distanceMeters: 120,
    isHeadquarters: false,
    entrances: 4,
    apartments: 128,
    households: null,
    residentsCount: null,
    managingOrg: '',
    accessNote: '',
    estimate: { entrances: 4, apartments: 128, residents: 294 },
    source: 'osm',
    verifiedAt: null,
    verifiedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    precincts: [
      { id: 'l1', precinctId: 'p1', precinctNumber: '123', district: 'Округ 5', entrance: '' },
    ],
    quality: [],
    canSeeContacts: true,
    contactsCount: 1,
    ...rest,
    campaign: { ...createEmptyCampaignState(), ...(campaign ?? {}) },
  };
}

function renderPanel(props = {}) {
  const handlers = {
    onAddAction: vi.fn(async () => true),
    onAddIssue: vi.fn(async () => true),
    onAddTask: vi.fn(async () => true),
    onAddPerson: vi.fn(async () => true),
    onAddPhoto: vi.fn(async () => true),
    onSaveAttributes: vi.fn(async () => true),
    onSaveState: vi.fn(async () => true),
    onCompleteTask: vi.fn(async () => true),
    onResolveIssue: vi.fn(async () => true),
    onStartEditing: vi.fn(),
    onCancelEditing: vi.fn(),
    onClose: vi.fn(),
  };

  const utils = render(
    <HouseDetailsPanel
      campaignId="campaign-1"
      house={createHouse()}
      isEditing={false}
      isSaving={false}
      refreshToken={0}
      viewer={{ email: 'coordinator@avku.org', role: 'coordinator' }}
      {...handlers}
      {...props}
    />,
  );

  return { ...utils, handlers };
}

/** Opens a tab and waits for its loader to settle. */
async function openTab(name) {
  fireEvent.click(screen.getByRole('tab', { name }));
}

/**
 * The card header only. Several of these facts appear twice on purpose — once
 * in the header, once in the Огляд tab — so the assertions have to say which
 * one they mean.
 */
function header() {
  return within(document.querySelector('header'));
}

beforeEach(() => {
  for (const loader of Object.values(api)) {
    loader.mockClear?.();
    loader.mockResolvedValue?.([]);
  }
});

afterEach(cleanup);

describe('the card header', () => {
  it('answers the coordinator questions without opening a tab', () => {
    renderPanel({
      house: createHouse({
        verifiedAt: '2026-07-12T09:00:00.000Z',
        verifiedBy: 'kovalenko@avku.org',
        campaign: {
          stage: 'in_progress',
          priority: 'high',
          lastActionAt: '2026-07-28T10:00:00.000Z',
          lastActionType: 'visit',
          nextActionAt: '2026-08-05T10:00:00.000Z',
          assignees: [{ id: 'a1', email: 'kovalenko@avku.org', role: 'agitator' }],
        },
      }),
    });

    expect(header().getByText('вул. Якуба Коласа, 6')).toBeTruthy();
    expect(header().getByText(/дільниця №123/)).toBeTruthy();
    expect(header().getByText('У роботі')).toBeTruthy();
    expect(header().getByText('Високий пріоритет')).toBeTruthy();
    expect(header().getAllByText(/kovalenko/).length).toBeGreaterThan(0);
    expect(header().getByText(/Візит 28\.07/)).toBeTruthy();
  });

  /*
   * Overdue work, an unowned house and stale data are separate statements. A
   * single "needs attention" badge would hide whichever came second.
   */
  it('lists each warning separately rather than collapsing them', () => {
    renderPanel({
      house: createHouse({
        quality: ['staleVerification', 'noAssignee', 'overdueTasks'],
        campaign: { overdueTasksCount: 2, openIssuesCount: 1, assignees: [] },
      }),
    });

    expect(header().getByText('Прострочених задач: 2')).toBeTruthy();
    expect(header().getByText('Відкритих звернень: 1')).toBeTruthy();
    expect(header().getByText('Немає відповідального')).toBeTruthy();
    expect(header().getByText('Дані давно не перевірялися')).toBeTruthy();
  });
});

describe('the seven tabs', () => {
  it('offers exactly the tabs the module is built around', () => {
    renderPanel();

    const tablist = screen.getByRole('tablist', { name: 'Розділи картки будинку' });
    const labels = within(tablist)
      .getAllByRole('tab')
      .map((tab) => tab.textContent.replace(/\d+$/, '').trim());

    expect(labels).toEqual([
      'Огляд',
      'Люди',
      'Дії',
      'Звернення',
      'Задачі',
      'Файли',
      'Історія',
    ]);
  });

  it('loads a tab only when it is opened', async () => {
    renderPanel();

    expect(api.fetchHouseActions).not.toHaveBeenCalled();

    await openTab(/Дії/);

    await waitFor(() =>
      expect(api.fetchHouseActions).toHaveBeenCalledWith(
        'house-1',
        expect.objectContaining({ campaignId: 'campaign-1' }),
      ),
    );
  });

  it('shows contact people with their working role and a way to call them', async () => {
    api.fetchHousePeople.mockResolvedValueOnce([
      {
        id: 'p1',
        fullName: 'Коваленко Олена Петрівна',
        role: 'osbb_head',
        note: '',
        isMasked: false,
        links: [{ id: 'l1', entrance: '2', apartment: '12' }],
        contacts: [
          { id: 'c1', type: 'phone', value: '+380671234567', label: '', isMasked: false },
        ],
      },
    ]);

    renderPanel();
    await openTab(/Люди/);

    expect(await screen.findByText('Коваленко Олена Петрівна')).toBeTruthy();
    expect(screen.getByText('Голова ОСББ')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: '+380671234567' }).getAttribute('href'),
    ).toBe('tel:+380671234567');
  });
});

/*
 * The regression guard for the feature this change removes. It reads the whole
 * rendered document, so it fails whether a position leaks through a payload, a
 * label, a select option or a stray data attribute.
 */
describe('personal political profiling is gone', () => {
  const FORBIDDEN = [
    'Підтримує',
    'Нейтрально',
    'Проти',
    'Позиція',
    'stance',
    'ageGroup',
    'age_group',
    '56-70',
    '18–35',
  ];

  it('renders none of it, even when a payload tries to smuggle it in', async () => {
    // A hostile or legacy payload: the fields must not reach the DOM even so.
    api.fetchHousePeople.mockResolvedValueOnce([
      {
        id: 'p1',
        fullName: 'Коваленко Олена',
        role: 'osbb_head',
        note: '',
        isMasked: false,
        stance: 'against',
        ageGroup: '56-70',
        links: [],
        contacts: [],
      },
    ]);

    renderPanel();
    await openTab(/Люди/);
    await screen.findByText('Коваленко Олена');

    const markup = document.body.innerHTML;

    for (const term of FORBIDDEN) {
      expect(markup).not.toContain(term);
    }
  });

  it('offers no such option in the contact form', async () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /Контакт/ }));

    const roleSelect = await screen.findByLabelText('Роль у будинку');
    const options = within(roleSelect).getAllByRole('option').map((o) => o.textContent);

    expect(options).toContain('Голова ОСББ');
    expect(options.join(' ')).not.toMatch(/Підтримує|Проти|Нейтрально/);
  });
});

describe('quick actions — the field path', () => {
  /**
   * The thirty-second target: open the card, press «Візит», press a result.
   * More than three interactions and the result gets written on paper instead,
   * which is where it stops being data.
   */
  it('records a visit result in three taps', async () => {
    const { handlers } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /Візит/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Не відчинили / не відповіли' }));

    await waitFor(() => expect(handlers.onAddAction).toHaveBeenCalledTimes(1));

    const payload = handlers.onAddAction.mock.calls[0][0];

    expect(payload).toMatchObject({ type: 'visit', result: 'no_answer' });
    expect(payload.happenedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The author is never in the payload — the server takes it from the
    // verified identity, and there is no field here to sign with a name.
    expect(payload).not.toHaveProperty('authorEmail');
    expect(payload).not.toHaveProperty('updatedBy');
  });

  it('closes the form once the action is saved', async () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /Дзвінок/ }));
    expect(screen.getByText('Дзвінок', { selector: 'strong' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Поговорили' }));

    await waitFor(() =>
      expect(screen.queryByText('Дзвінок', { selector: 'strong' })).toBeNull(),
    );
  });

  it('creates an issue with a category and a title', async () => {
    const { handlers } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /Звернення/ }));
    fireEvent.change(screen.getByLabelText('Суть звернення'), {
      target: { value: 'Не працює світло' },
    });
    fireEvent.change(screen.getByLabelText('Категорія'), { target: { value: 'lighting' } });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));

    await waitFor(() =>
      expect(handlers.onAddIssue).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Не працює світло', category: 'lighting' }),
      ),
    );
  });

  it('will not save an empty task', async () => {
    const { handlers } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /Задача/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));

    await waitFor(() => expect(handlers.onAddTask).not.toHaveBeenCalled());
  });

  it('hides every write affordance from somebody with no role', () => {
    renderPanel({ viewer: { email: 'guest@avku.org', role: null } });

    expect(screen.queryByRole('button', { name: /Візит/ })).toBeNull();
    expect(screen.getByText(/потрібна роль/i)).toBeTruthy();
  });
});

describe('contacts an agitator may not see', () => {
  it('says they are hidden and renders no value at all', async () => {
    renderPanel({
      house: createHouse({ canSeeContacts: false, contactsCount: 2 }),
      viewer: { email: 'other@avku.org', role: 'agitator' },
    });

    await openTab(/Люди/);

    expect(await screen.findByText(/Контакти цього будинку приховані/)).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('380');
  });
});
