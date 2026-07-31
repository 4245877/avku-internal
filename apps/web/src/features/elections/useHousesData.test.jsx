/**
 * What the page ends up holding after a boundary change and after a reload.
 *
 * The store-level tests next door prove the polygon is saved and restored; this
 * one proves the page reacts to it — that a saved boundary re-cuts the dataset
 * without a manual refresh, that a reload comes back on the saved territory,
 * and that a dataset which does not reach the new territory produces a reported
 * state rather than a thrown error.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { unprojectFromMeters } from './geo.js';
import { useHousesData } from './useHousesData.js';
import { AREA_STORAGE_KEY } from './workspaceAreaStorage.js';
import {
  resetWorkspaceAreaToShipped,
  saveWorkspaceArea,
  toWorkspaceFeature,
  workspaceBoundingBox,
} from './workspaceArea.js';

function district({ east = 0, north = 0, half = 400 }) {
  return [
    { x: east - half, y: -(north - half) },
    { x: east + half, y: -(north - half) },
    { x: east + half, y: -(north + half) },
    { x: east - half, y: -(north + half) },
  ].map((point) => unprojectFromMeters(point));
}

function houseAt({ x, y }, id, size = 15) {
  return {
    id: `way/${id}`,
    street: 'вулиця Якуба Коласа',
    streetShort: 'вул. Якуба Коласа',
    number: String(id),
    address: `вул. Якуба Коласа, ${id}`,
    type: 'apartments',
    location: unprojectFromMeters({ x, y }),
    footprint: [
      { x: x - size, y: y - size },
      { x: x + size, y: y - size },
      { x: x + size, y: y + size },
      { x: x - size, y: y + size },
    ].map((point) => unprojectFromMeters(point)),
    isHeadquarters: false,
  };
}

/** The whole shipped dataset: two blocks by the office, one 2 km east. */
const HOUSES = [
  houseAt({ x: 0, y: 0 }, 1),
  houseAt({ x: 120, y: 0 }, 2),
  houseAt({ x: 2000, y: 0 }, 3),
];

/** A stand-in for both endpoints the page talks to on load. */
function createServer({ savedArea = null } = {}) {
  const state = { savedArea, coverageBox: null };

  resetWorkspaceAreaToShipped();
  state.coverageBox = workspaceBoundingBox();

  const handler = vi.fn(async (url, options = {}) => {
    const href = String(url);

    if (href.includes('/elections/area')) {
      if ((options.method ?? 'GET') !== 'GET') {
        state.savedArea = options.body ? JSON.parse(options.body).area : null;

        return new Response('{}', { status: 200 });
      }

      return state.savedArea
        ? new Response(JSON.stringify({ area: state.savedArea }), { status: 200 })
        : new Response('{}', { status: 404 });
    }

    return new Response(
      JSON.stringify({
        version: 2,
        coverage: { box: state.coverageBox },
        houses: HOUSES,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });

  return { state, handler };
}

let server;

beforeEach(() => {
  window.localStorage.clear();
  resetWorkspaceAreaToShipped();
  server = createServer();
  vi.stubGlobal('fetch', server.handler);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  resetWorkspaceAreaToShipped();
});

describe('useHousesData', () => {
  it('loads the district the shipped boundary covers', async () => {
    const { result } = renderHook(() => useHousesData());

    await waitFor(() => expect(result.current.isReady).toBe(true));

    expect(result.current.houses).toHaveLength(3);
    expect(result.current.streets).toEqual(['вулиця Якуба Коласа']);
    expect(result.current.hasMissingCoverage).toBe(false);
    expect(result.current.isAreaEmpty).toBe(false);
  });

  it('re-cuts the dataset the moment a new boundary is saved', async () => {
    const { result } = renderHook(() => useHousesData());

    await waitFor(() => expect(result.current.isReady).toBe(true));

    // A tight district around the office: the block 2 km east drops out.
    await act(async () => {
      await saveWorkspaceArea(toWorkspaceFeature(district({ half: 300 })));
    });

    await waitFor(() => expect(result.current.houses).toHaveLength(2));

    expect(result.current.houses.map((house) => house.id)).toEqual([
      'way/1',
      'way/2',
    ]);
    expect(result.current.area.isCustom).toBe(true);
    expect(result.current.area.vertexCount).toBe(4);
  });

  it('comes back on the saved boundary after a reload', async () => {
    // The first session saves a boundary…
    await act(async () => {
      await saveWorkspaceArea(toWorkspaceFeature(district({ half: 300 })));
    });

    expect(server.state.savedArea).not.toBeNull();

    // …and the reload starts from nothing but what the API holds.
    resetWorkspaceAreaToShipped();
    window.localStorage.clear();

    const { result } = renderHook(() => useHousesData());

    await waitFor(() => expect(result.current.isReady).toBe(true));
    await waitFor(() => expect(result.current.area.isCustom).toBe(true));

    expect(result.current.houses.map((house) => house.id)).toEqual([
      'way/1',
      'way/2',
    ]);
    expect(result.current.hasMissingCoverage).toBe(false);
  });

  it('reports missing coverage instead of failing when the boundary moves away', async () => {
    const { result } = renderHook(() => useHousesData());

    await waitFor(() => expect(result.current.isReady).toBe(true));

    await act(async () => {
      await saveWorkspaceArea(toWorkspaceFeature(district({ east: 12000, half: 300 })));
    });

    await waitFor(() => expect(result.current.hasMissingCoverage).toBe(true));

    // The status stays `ready`: the map, its tiles and the new border are all
    // fine, and only the buildings are missing.
    expect(result.current.status).toBe('ready');
    expect(result.current.hasError).toBe(false);
    expect(result.current.houses).toEqual([]);
    expect(result.current.coverage.command).toMatch(/data:houses/);
  });

  it('distinguishes an empty territory from an uncovered one', async () => {
    const { result } = renderHook(() => useHousesData());

    await waitFor(() => expect(result.current.isReady).toBe(true));

    // Inside the downloaded box, but on ground with no addressed buildings.
    await act(async () => {
      await saveWorkspaceArea(toWorkspaceFeature(district({ north: 1000, half: 120 })));
    });

    await waitFor(() => expect(result.current.houses).toHaveLength(0));

    expect(result.current.hasMissingCoverage).toBe(false);
    expect(result.current.isAreaEmpty).toBe(true);
  });

  it('falls back to the cached boundary when the API is unreachable', async () => {
    await act(async () => {
      await saveWorkspaceArea(toWorkspaceFeature(district({ half: 300 })));
    });

    const cached = window.localStorage.getItem(AREA_STORAGE_KEY);

    expect(cached).not.toBeNull();

    resetWorkspaceAreaToShipped();
    window.localStorage.setItem(AREA_STORAGE_KEY, cached);

    // Only the snapshot answers now; the boundary endpoint is dead.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        if (String(url).includes('/elections/area')) {
          throw new TypeError('Failed to fetch');
        }

        return new Response(
          JSON.stringify({
            version: 2,
            coverage: { box: server.state.coverageBox },
            houses: HOUSES,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    const { result } = renderHook(() => useHousesData());

    await waitFor(() => expect(result.current.isReady).toBe(true));

    expect(result.current.area.isCustom).toBe(true);
    expect(result.current.houses).toHaveLength(2);
  });

  it('surfaces a failed dataset request as an error the page can retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) =>
        String(url).includes('/elections/area')
          ? new Response('{}', { status: 404 })
          : new Response('boom', { status: 503, statusText: 'Unavailable' }),
      ),
    );

    const { result } = renderHook(() => useHousesData());

    await waitFor(() => expect(result.current.hasError).toBe(true));

    expect(result.current.error).toMatch(/503/);
  });
});
