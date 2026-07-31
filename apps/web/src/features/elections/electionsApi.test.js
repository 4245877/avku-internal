/**
 * What the page is told when the dataset and the boundary disagree.
 *
 * The shipped snapshot covers one patch of ground; the boundary can be traced
 * onto any other. Before this, the mismatch surfaced as a thrown error and a
 * full-surface overlay — which is what "the new territory loads nothing, not
 * even streets" looked like from the outside. A dataset that does not reach the
 * territory is now a reported state, and the map underneath keeps working.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { unprojectFromMeters } from './geo.js';
import {
  REFRESH_DATASET_COMMAND,
  fetchHouses,
} from './electionsApi.js';
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
  const footprint = [
    { x: x - size, y: y - size },
    { x: x + size, y: y - size },
    { x: x + size, y: y + size },
    { x: x - size, y: y + size },
  ].map((point) => unprojectFromMeters(point));

  return {
    id,
    street: 'вулиця Якуба Коласа',
    streetShort: 'вул. Якуба Коласа',
    number: String(id),
    address: `вул. Якуба Коласа, ${id}`,
    type: 'apartments',
    location: unprojectFromMeters({ x, y }),
    footprint,
    isHeadquarters: false,
  };
}

/**
 * Serves a snapshot whose declared coverage is a box around the campaign
 * address — the shape of the real shipped file.
 */
function serveSnapshot({ houses, coverageBox }) {
  return vi.fn(async (url) => {
    if (String(url).includes('/elections/area')) {
      return new Response(JSON.stringify({ error: 'немає' }), { status: 404 });
    }

    return new Response(
      JSON.stringify({
        version: 2,
        license: 'ODbL 1.0',
        osmTimestamp: '2026-07-01T00:00:00Z',
        coverage: { box: coverageBox },
        houses,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
}

/** The box the shipped snapshot would have been downloaded for. */
function shippedCoverageBox() {
  resetWorkspaceAreaToShipped();

  return workspaceBoundingBox();
}

beforeEach(() => {
  window.localStorage.clear();
  resetWorkspaceAreaToShipped();
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  resetWorkspaceAreaToShipped();
});

describe('fetchHouses coverage reporting', () => {
  it('reports full coverage for a boundary the snapshot was built for', async () => {
    const coverageBox = shippedCoverageBox();

    vi.stubGlobal(
      'fetch',
      serveSnapshot({ houses: [houseAt({ x: 0, y: 0 }, 1)], coverageBox }),
    );

    const payload = await fetchHouses();

    expect(payload.coverage.isCovered).toBe(true);
    expect(payload.houses).toHaveLength(1);
    expect(payload.streets).toEqual(['вулиця Якуба Коласа']);
  });

  it('flags a boundary the snapshot never reached, instead of throwing', async () => {
    const coverageBox = shippedCoverageBox();

    vi.stubGlobal(
      'fetch',
      serveSnapshot({ houses: [houseAt({ x: 0, y: 0 }, 1)], coverageBox }),
    );

    // 12 km east — well outside the snapshot's box.
    await saveWorkspaceArea(toWorkspaceFeature(district({ east: 12000, half: 300 })));

    const payload = await fetchHouses();

    expect(payload.coverage.isCovered).toBe(false);
    expect(payload.coverage.houseCount).toBe(0);
    expect(payload.coverage.command).toBe(REFRESH_DATASET_COMMAND);
    // The whole point: an empty territory is data, not a failure. The map, its
    // tiles and the traced border still have to render.
    expect(payload.houses).toEqual([]);
    expect(payload.area.isCustom).toBe(true);
  });

  it('flags partial coverage when the boundary only half overlaps the dataset', async () => {
    const coverageBox = shippedCoverageBox();

    vi.stubGlobal(
      'fetch',
      serveSnapshot({
        houses: [houseAt({ x: 0, y: 0 }, 1), houseAt({ x: 500, y: 0 }, 2)],
        coverageBox,
      }),
    );

    // Straddles the eastern edge of the snapshot box.
    await saveWorkspaceArea(
      toWorkspaceFeature(district({ east: 3000, half: 3200 })),
    );

    const payload = await fetchHouses();

    expect(payload.coverage.isCovered).toBe(false);
    expect(payload.coverage.houseCount).toBeGreaterThan(0);
    expect(payload.houses.length).toBe(payload.coverage.houseCount);
  });

  it('derives coverage from a legacy snapshot that only records its radius', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        if (String(url).includes('/elections/area')) {
          return new Response('{}', { status: 404 });
        }

        return new Response(
          JSON.stringify({
            version: 1,
            area: {
              center: { lat: 50.4345086, lon: 30.3774787 },
              downloadRadiusMeters: 3000,
            },
            houses: [houseAt({ x: 0, y: 0 }, 1)],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    // The shipped boundary is a 3 km circle, so a 3 km download covers it.
    const payload = await fetchHouses();

    expect(payload.coverage.datasetBox).not.toBeNull();
    expect(payload.coverage.isCovered).toBe(true);
  });

  it('still fails loudly when the dataset itself is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) =>
        String(url).includes('/elections/area')
          ? new Response('{}', { status: 404 })
          : new Response(JSON.stringify({ houses: [] }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
      ),
    );

    await expect(fetchHouses()).rejects.toThrow(/порожній/);
  });

  it('surfaces an HTTP failure as an error rather than an empty district', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) =>
        String(url).includes('/elections/area')
          ? new Response('{}', { status: 404 })
          : new Response('nope', { status: 500, statusText: 'Server Error' }),
      ),
    );

    await expect(fetchHouses()).rejects.toThrow(/500/);
  });
});
