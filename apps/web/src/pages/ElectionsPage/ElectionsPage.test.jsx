/**
 * The page that wires the map, the card and the full-screen editor together.
 *
 * This file exists because of a bug it would have caught. The editor rewrite
 * left one stale prop behind — `isEditing={isEditing}` against a state variable
 * that no longer existed — and nothing failed: JSX does not resolve identifiers
 * at build time, so `vite build` was green, and every unit test targeted a
 * child component rather than the page. The whole «Вибори» section rendered a
 * blank white screen, and only a real browser said so.
 *
 * So the assertions here are deliberately shallow and deliberately about the
 * *seams*: the page renders at all, the card's «Редагувати» opens the editor,
 * closing it puts the card back with the same house still selected, and a save
 * inside the editor reaches the list the map draws from.
 *
 * The map itself is stubbed. It needs Leaflet, a canvas and a real layout, none
 * of which say anything about the wiring under test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { createEmptyCampaignState } from '../../features/elections/electionsTypes.js';

const house = {
  id: 'house-1',
  street: 'вулиця Зодчих',
  streetShort: 'вул. Зодчих',
  number: '58',
  block: '',
  address: 'вул. Зодчих, 58',
  fullAddress: 'вулиця Зодчих, 58, Київ',
  city: 'Київ',
  postalCode: '03170',
  type: 'apartments',
  building: 'apartments',
  floors: 9,
  builtYear: 1978,
  entrances: 4,
  apartments: 128,
  households: null,
  residentsCount: null,
  managingOrg: '',
  accessNote: '',
  source: 'osm',
  name: null,
  location: { lat: 50.43, lon: 30.36 },
  footprint: [],
  footprintAreaSqm: 1200,
  estimate: { entrances: 4, apartments: 128, residents: 294 },
  distanceMeters: 120,
  isHeadquarters: false,
  verifiedAt: null,
  verifiedBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  precincts: [],
  quality: [],
  canSeeContacts: true,
  contactsCount: 0,
  campaign: { ...createEmptyCampaignState(), updatedAt: '2026-06-01T00:00:00.000Z' },
};

const replaceHouse = vi.fn();
const refreshHouse = vi.fn();

vi.mock('../../features/elections/useHousesData.js', () => ({
  useHousesData: () => ({
    status: 'ready',
    houses: [house],
    streets: ['вул. Зодчих'],
    // The real shape from `getWorkspaceMeta()` — the page header reads
    // `area.center.address` directly.
    area: {
      name: 'Тестова територія',
      center: {
        lat: 50.4307636,
        lon: 30.3640481,
        address: 'вулиця Зодчих, 58А',
        city: 'Київ',
        postalCode: '03170',
        district: 'Святошинський район',
      },
      bounds: null,
      box: null,
      areaSqm: 13_870_000,
      vertexCount: 25,
      isCustom: true,
      label: 'вулиця Зодчих, 58А, Київ, 03170',
    },
    coverage: { isCovered: true },
    campaign: { id: 'campaign-1', name: 'Кампанія 2026', status: 'active' },
    campaigns: [{ id: 'campaign-1', name: 'Кампанія 2026', status: 'active' }],
    viewer: { email: 'coordinator@avku.org', role: 'coordinator' },
    error: null,
    source: 'backend',
    isBackend: true,
    isLoading: false,
    isReady: true,
    hasError: false,
    hasMissingCoverage: false,
    isAreaEmpty: false,
    osmRefresh: { status: 'idle', error: null, houseCount: 0, progress: null },
    isRefreshingFromOsm: false,
    savingHouseId: null,
    saveError: null,
    campaignId: 'campaign-1',
    reload: vi.fn(),
    selectCampaign: vi.fn(),
    refreshFromOsm: vi.fn(),
    cancelRefreshFromOsm: vi.fn(),
    dismissOsmRefresh: vi.fn(),
    refreshHouse,
    replaceHouse,
    saveAttributes: vi.fn(async () => true),
    saveState: vi.fn(async () => true),
    addAction: vi.fn(async () => true),
    addIssue: vi.fn(async () => true),
    addTask: vi.fn(async () => true),
    addPerson: vi.fn(async () => true),
    addAttachment: vi.fn(async () => true),
    dismissSaveError: vi.fn(),
  }),
}));

vi.mock('../../features/elections/useHouseDetails.js', () => ({
  useHouseDetails: (houseId) => ({
    status: houseId ? 'ready' : 'idle',
    house: houseId ? house : null,
    error: null,
    isLoading: false,
    isReady: Boolean(houseId),
    replace: vi.fn(),
  }),
}));

/* Leaflet, a canvas and a real layout say nothing about the wiring. */
vi.mock('./components/HouseMap.jsx', () => ({
  default: ({ onSelectHouse }) => (
    <div data-testid="map-stub">
      <button onClick={() => onSelectHouse('house-1')} type="button">
        map: вул. Зодчих, 58
      </button>
    </div>
  ),
}));

vi.mock('../../features/elections/electionsApi.js', async () => {
  const actual = await vi.importActual('../../features/elections/electionsApi.js');

  return {
    ...actual,
    fetchPrecincts: vi.fn(async () => []),
    createImportBatch: vi.fn(async () => ({})),
    updateIssue: vi.fn(async () => ({ ok: true })),
    updateTask: vi.fn(async () => ({ ok: true })),
    fetchHouse: vi.fn(async () => house),
    fetchHousePeople: vi.fn(async () => []),
    fetchHouseActions: vi.fn(async () => []),
    fetchHouseIssues: vi.fn(async () => []),
    fetchHouseTasks: vi.fn(async () => []),
    fetchHouseEvents: vi.fn(async () => []),
    fetchHouseAttachments: vi.fn(async () => []),
    fetchHouseHistory: vi.fn(async () => []),
    fetchAssignments: vi.fn(async () => []),
    saveHouseAttributes: vi.fn(async () => house),
    saveHouseState: vi.fn(async (id, patch) => ({
      ...house,
      campaign: { ...house.campaign, ...patch },
    })),
  };
});

import ElectionsPage from './ElectionsPage.jsx';
import * as api from '../../features/elections/electionsApi.js';

beforeEach(() => {
  vi.clearAllMocks();

  // jsdom has no `matchMedia`, and the search field asks for one on mount.
  // Everything reports "no match", which is the desktop branch.
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(cleanup);

/** Selects the house through the stubbed map and opens the editor. */
function openEditor() {
  fireEvent.click(screen.getByRole('button', { name: /map: вул\. Зодчих/ }));

  const card = screen.getByRole('tabpanel', { name: /Картка будинку/ });

  fireEvent.click(within(card).getByRole('button', { name: /^Редагувати$/ }));

  return screen.getByRole('dialog', { name: /Редагування будинку/ });
}

describe('the elections page renders', () => {
  /* The regression guard: this failed with a blank screen, not an error. */
  it('mounts without throwing and shows the module', () => {
    render(<ElectionsPage />);

    expect(screen.getAllByText(/Вибори/).length).toBeGreaterThan(0);
    expect(screen.getByTestId('map-stub')).toBeTruthy();
  });

  it('shows the empty card until a house is chosen', () => {
    render(<ElectionsPage />);

    expect(screen.getByText('Будинок не вибрано')).toBeTruthy();
  });
});

describe('card → editor → card', () => {
  it('opens the full-screen editor from the card', () => {
    render(<ElectionsPage />);

    const editor = openEditor();

    expect(within(editor).getByText('вул. Зодчих, 58')).toBeTruthy();
    expect(
      within(editor).getByRole('tablist', { name: 'Розділи редактора' }),
    ).toBeTruthy();
  });

  it('closes back onto the card with the same house still selected', () => {
    render(<ElectionsPage />);

    const editor = openEditor();

    fireEvent.click(within(editor).getByRole('button', { name: 'Закрити редактор' }));

    expect(screen.queryByRole('dialog', { name: /Редагування будинку/ })).toBeNull();

    // The card is back, and it is still this house's card.
    const card = screen.getByRole('tabpanel', { name: /Картка будинку/ });

    expect(within(card).getAllByText('вул. Зодчих, 58').length).toBeGreaterThan(0);
  });

  /**
   * The map and the card read from the same list, so a save inside the editor
   * has to reach it — otherwise the change is on screen in one place and stale
   * in the other until a full reload.
   */
  it('feeds a save back into the list the map draws from', async () => {
    render(<ElectionsPage />);

    const editor = openEditor();

    fireEvent.change(within(editor).getByLabelText(/Коротке резюме/), {
      target: { value: 'Записано з редактора' },
    });
    fireEvent.click(within(editor).getAllByRole('button', { name: /Зберегти/ })[0]);

    await waitFor(() => expect(api.saveHouseState).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(replaceHouse).toHaveBeenCalled());

    expect(replaceHouse.mock.calls.at(-1)[0].campaign.summary).toBe(
      'Записано з редактора',
    );
  });
});
