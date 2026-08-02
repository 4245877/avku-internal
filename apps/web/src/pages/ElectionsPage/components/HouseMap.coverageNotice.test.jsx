/**
 * The life of the "OSM does not cover this territory" warning once it is right.
 *
 * The banner reports a real gap, so the fix is not to suppress it — it is to let
 * somebody who has read it put it away, and then to keep it away. Everything
 * below is one of the ways it used to come back: a re-render, a reload of the
 * same dataset, a remounted map, a rebuilt bundle. None of those is news about
 * the territory, and none of them may reopen it.
 *
 * The other half is the opposite guarantee: a boundary that moves, a dataset
 * that changes or a gap of a different size *is* news, and the warning has to
 * return by itself.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* Leaflet, its layers and the boundary editor are not what is under test here
 * and cannot run over a jsdom surface with no size. */
vi.mock('../../../features/elections/useLeafletMap.js', () => ({
  useLeafletMap: () => ({
    containerRef: { current: null },
    map: null,
    canZoomIn: true,
    canZoomOut: true,
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    resetView: vi.fn(),
    focusOnBounds: vi.fn(),
    tileStatus: 'ready',
    retryTiles: vi.fn(),
  }),
}));

vi.mock('../../../features/elections/useHouseLayer.js', () => ({
  useHouseLayer: () => ({ getHouseBounds: () => null }),
}));

vi.mock('../../../features/elections/useWorkspaceEditor.js', async (importOriginal) => ({
  ...(await importOriginal()),
  useWorkspaceEditor: () => ({ save: vi.fn() }),
}));

import { COVERAGE_NOTICE_STORAGE_KEY } from '../../../features/elections/coverageNotice.js';
import HouseMap from './HouseMap.jsx';

const WARNING = /покривають територію не повністю/;
const DISMISS_LABEL = 'Закрити попередження про неповне покриття OSM';

/** The reported state: 1441 houses loaded, ~7% of the territory with no data. */
function coverageState(overrides = {}) {
  return {
    areaBox: { minLat: 50.4, minLon: 30.5, maxLat: 50.42, maxLon: 30.54 },
    datasetBox: { minLat: 50.4, minLon: 30.5, maxLat: 50.418, maxLon: 30.54 },
    source: 'snapshot',
    houseCount: 1441,
    isCovered: false,
    coveredShare: 0.93,
    missingAreaSqm: 220_000,
    gapMeters: 739,
    marginMeters: 300,
    command: 'npm run data:houses',
    ...overrides,
  };
}

const IDLE_REFRESH = { status: 'idle', error: null, houseCount: 0, progress: null };

const handlers = {
  onRefreshFromOsm: vi.fn(),
  onCancelRefreshFromOsm: vi.fn(),
  onDismissOsmRefresh: vi.fn(),
  onRetry: vi.fn(),
  onSelectHouse: vi.fn(),
  onResetFilters: vi.fn(),
  onFillStatusChange: vi.fn(),
  onEnterAreaEditing: vi.fn(),
  onExitAreaEditing: vi.fn(),
};

function mapProps(overrides = {}) {
  const { coverage = coverageState(), ...rest } = overrides;

  return {
    houses: [],
    matchedIds: new Set(),
    summary: { total: 0, byStatus: {} },
    selectedHouse: null,
    focusRequest: null,
    status: 'ready',
    error: null,
    fillStatusFilter: 'all',
    hasEmptyResult: false,
    coverage,
    hasMissingCoverage: coverage?.isCovered === false,
    isAreaEmpty: false,
    osmRefresh: IDLE_REFRESH,
    isAreaEditing: false,
    ...handlers,
    ...rest,
  };
}

const renderMap = (overrides) => render(<HouseMap {...mapProps(overrides)} />);

beforeEach(() => window.localStorage.clear());

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe('coverage warning', () => {
  it('is shown with a way out of it', () => {
    renderMap();

    expect(screen.getByText(WARNING)).toBeTruthy();
    expect(screen.getByRole('button', { name: DISMISS_LABEL })).toBeTruthy();
  });

  it('closes on click and stays closed through a re-render', () => {
    const view = renderMap();

    fireEvent.click(screen.getByRole('button', { name: DISMISS_LABEL }));

    expect(screen.queryByText(WARNING)).toBeNull();

    // A re-render is not new information about the territory.
    view.rerender(<HouseMap {...mapProps()} />);

    expect(screen.queryByText(WARNING)).toBeNull();
  });

  /* Closing says "I have read this", not "fetch it again": the gap is real and
   * the map underneath the banner is exactly the one the user wants to keep. */
  it('starts no request and moves no data', () => {
    renderMap();

    fireEvent.click(screen.getByRole('button', { name: DISMISS_LABEL }));

    expect(handlers.onRefreshFromOsm).not.toHaveBeenCalled();
    expect(handlers.onCancelRefreshFromOsm).not.toHaveBeenCalled();
    expect(handlers.onRetry).not.toHaveBeenCalled();
    expect(handlers.onEnterAreaEditing).not.toHaveBeenCalled();
    expect(handlers.onSelectHouse).not.toHaveBeenCalled();
  });

  it('survives a reload of the same dataset', () => {
    const view = renderMap();

    fireEvent.click(screen.getByRole('button', { name: DISMISS_LABEL }));

    // A reload rebuilds the coverage object from scratch: new identity, same
    // territory, same data — and the same answer as far as the user is
    // concerned, down to float noise in the recomputed geometry.
    view.rerender(
      <HouseMap
        {...mapProps({
          coverage: coverageState({
            coveredShare: 0.93 + 1e-12,
            missingAreaSqm: 220_000.3,
          }),
        })}
      />,
    );

    expect(screen.queryByText(WARNING)).toBeNull();
  });

  /* The rebuild case from the report: a new bundle remounts every component,
   * and the state has to outlive the React tree that recorded it. */
  it('survives a remount of the map and a reload of the page', () => {
    renderMap();

    fireEvent.click(screen.getByRole('button', { name: DISMISS_LABEL }));

    expect(window.localStorage.getItem(COVERAGE_NOTICE_STORAGE_KEY)).toBeTruthy();

    cleanup();
    renderMap();

    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it('comes back when the boundary is re-traced', () => {
    const view = renderMap();

    fireEvent.click(screen.getByRole('button', { name: DISMISS_LABEL }));

    view.rerender(
      <HouseMap
        {...mapProps({
          coverage: coverageState({
            areaBox: { minLat: 50.4, minLon: 30.5, maxLat: 50.46, maxLon: 30.54 },
            coveredShare: 0.71,
            missingAreaSqm: 900_000,
            gapMeters: 4200,
          }),
        })}
      />,
    );

    expect(screen.getByText(WARNING)).toBeTruthy();
  });

  it('comes back when the OSM dataset changes under the same boundary', () => {
    const view = renderMap();

    fireEvent.click(screen.getByRole('button', { name: DISMISS_LABEL }));

    view.rerender(
      <HouseMap
        {...mapProps({
          coverage: coverageState({
            datasetBox: { minLat: 50.4, minLon: 30.5, maxLat: 50.4195, maxLon: 30.54 },
            houseCount: 1502,
            source: 'overpass',
            coveredShare: 0.975,
            missingAreaSqm: 78_000,
            gapMeters: 150,
          }),
        })}
      />,
    );

    expect(screen.getByText(WARNING)).toBeTruthy();
  });

  it('closes itself when a download finally covers the territory', () => {
    const view = renderMap();

    // No dismissal at all: a covered territory has nothing left to warn about.
    view.rerender(
      <HouseMap
        {...mapProps({
          coverage: coverageState({
            isCovered: true,
            coveredShare: 1,
            missingAreaSqm: 0,
            gapMeters: 0,
            source: 'overpass',
          }),
          osmRefresh: { status: 'success', error: null, houseCount: 1502, progress: null },
        })}
      />,
    );

    expect(screen.queryByText(WARNING)).toBeNull();
  });
});

describe('coverage warning while a download runs', () => {
  it('can still be closed mid-download, without cancelling it', () => {
    renderMap({
      osmRefresh: { status: 'loading', error: null, houseCount: 0, progress: { round: 1, attempts: 2 } },
    });

    expect(screen.getByText(/Запитуємо OpenStreetMap/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: DISMISS_LABEL }));

    expect(screen.queryByText(WARNING)).toBeNull();
    // Closing the notice is not abandoning the request that is answering it.
    expect(handlers.onCancelRefreshFromOsm).not.toHaveBeenCalled();
  });

  it('can still be closed after the download fails', () => {
    renderMap({
      osmRefresh: {
        status: 'error',
        error: 'Overpass API недоступний після 2 спроб',
        houseCount: 0,
        progress: null,
      },
    });

    expect(screen.getByText(/Не вдалося звʼязатися з OpenStreetMap/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: DISMISS_LABEL }));

    expect(screen.queryByText(WARNING)).toBeNull();
    expect(handlers.onRefreshFromOsm).not.toHaveBeenCalled();
  });
});

describe('the close button itself', () => {
  it('is a real button in the tab order with a name that says what it closes', () => {
    renderMap();

    const dismiss = screen.getByRole('button', { name: DISMISS_LABEL });

    // Native, enabled and never pulled out of the tab order — which is all a
    // keyboard user needs for Enter and Space to work.
    expect(dismiss.tagName).toBe('BUTTON');
    expect(dismiss.getAttribute('type')).toBe('button');
    expect(dismiss.hasAttribute('disabled')).toBe(false);
    expect(dismiss.getAttribute('tabindex')).toBeNull();

    dismiss.focus();

    expect(document.activeElement).toBe(dismiss);
  });

  /* The banner's own message must be read before the control that silences it,
   * so the button comes last inside the card. */
  it('comes after the message and the download it offers', () => {
    renderMap();

    const dismiss = screen.getByRole('button', { name: DISMISS_LABEL });
    const download = screen.getByRole('button', { name: /Завантажити з OSM/ });

    expect(download.compareDocumentPosition(dismiss)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});
