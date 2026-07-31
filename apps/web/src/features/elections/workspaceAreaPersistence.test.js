/**
 * The bug this file exists for.
 *
 * A canvasser traced a new working area, pressed «Зберегти», reloaded the page
 * — and the new territory came back empty: no houses, no streets, no counters.
 * Three separate things had to be true for that to happen, and each of them is
 * pinned down here:
 *
 *   1. saving has to reach a permanent store, not just this browser profile;
 *   2. a reload has to come back on the *saved* polygon, not the shipped circle;
 *   3. the house download has to follow the new polygon's bounding box, rather
 *      than staying a 3 km circle around a fixed address.
 *
 * Plus the state that made it invisible: a dataset that does not reach the new
 * boundary has to say so, instead of presenting itself as an empty district.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AREA_CENTER, distanceMeters, unprojectFromMeters } from './geo.js';
import { AREA_STORAGE_KEY } from './workspaceAreaStorage.js';
import {
  AREA_DOWNLOAD_MARGIN_METERS,
  SHIPPED_WORKSPACE_AREA,
  filterHousesToWorkspace,
  getWorkspaceArea,
  hydrateWorkspaceArea,
  resetWorkspaceAreaToShipped,
  restoreShippedWorkspaceArea,
  ringsAreEqual,
  saveWorkspaceArea,
  toWorkspaceFeature,
  workspaceBoundingBox,
} from './workspaceArea.js';

/** A square district, given as metre offsets from the campaign address. */
function district({ east = 0, north = 0, half = 400 }) {
  return [
    { x: east - half, y: -(north - half) },
    { x: east + half, y: -(north - half) },
    { x: east + half, y: -(north + half) },
    { x: east - half, y: -(north + half) },
  ].map((point) => unprojectFromMeters(point));
}

function footprintAt({ x, y }, size = 15) {
  return [
    { x: x - size, y: y - size },
    { x: x + size, y: y - size },
    { x: x + size, y: y + size },
    { x: x - size, y: y + size },
  ].map((point) => unprojectFromMeters(point));
}

/**
 * A stand-in for `/api/elections/area` that behaves like the real one: it holds
 * at most one boundary and answers 404 while it holds none.
 */
function createFakeApi({ isReachable = true } = {}) {
  const state = { document: null, requests: [] };

  const handler = vi.fn(async (url, options = {}) => {
    const method = options.method ?? 'GET';

    state.requests.push(method);

    if (!isReachable) {
      throw new TypeError('Failed to fetch');
    }

    if (method === 'GET') {
      return state.document
        ? new Response(JSON.stringify({ area: state.document }), { status: 200 })
        : new Response(JSON.stringify({ error: 'немає' }), { status: 404 });
    }

    if (method === 'PUT') {
      state.document = JSON.parse(options.body).area;

      return new Response(JSON.stringify({ area: state.document }), { status: 200 });
    }

    state.document = null;

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  return { state, handler };
}

let api;

beforeEach(() => {
  api = createFakeApi();
  vi.stubGlobal('fetch', api.handler);
  window.localStorage.clear();
  resetWorkspaceAreaToShipped();
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  resetWorkspaceAreaToShipped();
});

describe('«Зберегти межу» writes to a permanent store', () => {
  it('sends the traced polygon to the API, not only to this browser', async () => {
    const result = await saveWorkspaceArea(toWorkspaceFeature(district({ east: 800 })));

    expect(result.storage).toBe('server');
    expect(result.isPersisted).toBe(true);
    expect(api.state.requests).toContain('PUT');
    expect(api.state.document.geometry.type).toBe('Polygon');
  });

  it('reports a browser-only save when the API cannot be reached', async () => {
    const offline = createFakeApi({ isReachable: false });
    vi.stubGlobal('fetch', offline.handler);

    const result = await saveWorkspaceArea(toWorkspaceFeature(district({ east: 800 })));

    // The distinction matters: the boundary works here and survives a reload
    // here, but nobody else has it — and the banner has to say so.
    expect(result.storage).toBe('local');
    expect(result.isPersisted).toBe(true);
    expect(getWorkspaceArea().isCustom).toBe(true);
    expect(window.localStorage.getItem(AREA_STORAGE_KEY)).not.toBeNull();
  });

  it('applies the boundary before the round trip finishes', async () => {
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await pending;

        return new Response('{}', { status: 200 });
      }),
    );

    const ring = district({ east: 800 });
    const saving = saveWorkspaceArea(toWorkspaceFeature(ring));

    // The map must answer the click immediately rather than after the network.
    expect(ringsAreEqual(getWorkspaceArea().outerRing, ring)).toBe(true);

    release();
    await saving;
  });

  it('rejects a self-intersecting outline instead of storing it', async () => {
    // Deliberately lopsided: a symmetric bow tie has zero signed area and would
    // be caught by the "encloses nothing" rule before the crossing test runs.
    const bowtie = [
      { lat: 50.430, lon: 30.370 },
      { lat: 50.446, lon: 30.382 },
      { lat: 50.430, lon: 30.382 },
      { lat: 50.440, lon: 30.370 },
    ];

    await expect(saveWorkspaceArea(toWorkspaceFeature(bowtie))).rejects.toThrow(
      /перетинає сам себе/,
    );
    expect(getWorkspaceArea()).toBe(SHIPPED_WORKSPACE_AREA);
    expect(api.state.document).toBeNull();
  });

  it('rejects an outline that encloses no ground', async () => {
    const collapsed = [
      { lat: 50.43, lon: 30.37 },
      { lat: 50.44, lon: 30.37 },
      { lat: 50.45, lon: 30.37 },
    ];

    await expect(saveWorkspaceArea(toWorkspaceFeature(collapsed))).rejects.toThrow(
      /не охоплює жодної площі/,
    );
  });

  it('rejects coordinates outside the legal lon/lat ranges', async () => {
    const broken = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [30.37, 95.0],
            [30.38, 95.0],
            [30.38, 96.0],
            [30.37, 95.0],
          ],
        ],
      },
    };

    await expect(saveWorkspaceArea(broken)).rejects.toThrow(/широта/);
    expect(api.state.document).toBeNull();
  });

  it('rejects a geometry that is not a polygon at all', async () => {
    await expect(
      saveWorkspaceArea({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] } }),
    ).rejects.toThrow(/Polygon/);
  });
});

describe('reloading the page', () => {
  it('comes back on the saved boundary, not the shipped circle', async () => {
    const ring = district({ east: 800, north: 600 });

    await saveWorkspaceArea(toWorkspaceFeature(ring, { name: 'Новий квартал' }));

    // A reload: the store starts over from the cache, then reconciles with the
    // API — exactly what `useHousesData` does on mount.
    resetWorkspaceAreaToShipped();
    expect(getWorkspaceArea()).toBe(SHIPPED_WORKSPACE_AREA);

    const { area, source } = await hydrateWorkspaceArea();

    expect(source).toBe('server');
    expect(area.isCustom).toBe(true);
    expect(area.name).toBe('Новий квартал');
    expect(ringsAreEqual(area.outerRing, ring)).toBe(true);
  });

  it('keeps the last known boundary when the API is down', async () => {
    const ring = district({ east: 800 });

    await saveWorkspaceArea(toWorkspaceFeature(ring));

    const offline = createFakeApi({ isReachable: false });
    vi.stubGlobal('fetch', offline.handler);

    const { area, source } = await hydrateWorkspaceArea();

    expect(source).toBe('cache');
    expect(ringsAreEqual(area.outerRing, ring)).toBe(true);
  });

  it('drops a stale local override once the API says there is none', async () => {
    await saveWorkspaceArea(toWorkspaceFeature(district({ east: 800 })));
    await restoreShippedWorkspaceArea();

    // Another browser cleared the boundary; this one still has it cached.
    window.localStorage.setItem(
      AREA_STORAGE_KEY,
      JSON.stringify(toWorkspaceFeature(district({ east: 1500 }))),
    );

    const { area, source } = await hydrateWorkspaceArea();

    expect(source).toBe('shipped');
    expect(area).toBe(SHIPPED_WORKSPACE_AREA);
    expect(window.localStorage.getItem(AREA_STORAGE_KEY)).toBeNull();
  });

  it('survives a cache entry that is not readable GeoJSON', async () => {
    const offline = createFakeApi({ isReachable: false });
    vi.stubGlobal('fetch', offline.handler);
    window.localStorage.setItem(AREA_STORAGE_KEY, '{"type":"Feature"');

    const { area } = await hydrateWorkspaceArea();

    expect(area).toBe(SHIPPED_WORKSPACE_AREA);
  });

  it('notifies subscribers when the server boundary differs from the cache', async () => {
    api.state.document = toWorkspaceFeature(district({ east: 1200 }));

    const seen = [];
    const { subscribeToWorkspaceArea } = await import('./workspaceArea.js');
    const unsubscribe = subscribeToWorkspaceArea((area) => seen.push(area.isCustom));

    await hydrateWorkspaceArea();
    unsubscribe();

    // One notification is what reloads the house dataset for the new polygon.
    expect(seen).toEqual([true]);
  });

  it('does not churn the store when the server matches what is already in force', async () => {
    const ring = district({ east: 800 });

    await saveWorkspaceArea(toWorkspaceFeature(ring));

    const before = getWorkspaceArea();
    const seen = [];
    const { subscribeToWorkspaceArea } = await import('./workspaceArea.js');
    const unsubscribe = subscribeToWorkspaceArea(() => seen.push(1));

    await hydrateWorkspaceArea();
    unsubscribe();

    // A pointless notification would re-download the whole dataset on every load.
    expect(seen).toEqual([]);
    expect(getWorkspaceArea()).toBe(before);
  });
});

describe('the acquisition box follows the boundary', () => {
  it('is the polygon bounding box plus a margin, not a 3 km circle', async () => {
    const ring = district({ east: 800, north: 600, half: 300 });

    await saveWorkspaceArea(toWorkspaceFeature(ring));

    const box = workspaceBoundingBox();
    const area = getWorkspaceArea();

    expect(box.minLat).toBeLessThan(area.box.minLat);
    expect(box.maxLat).toBeGreaterThan(area.box.maxLat);
    expect(box.minLon).toBeLessThan(area.box.minLon);
    expect(box.maxLon).toBeGreaterThan(area.box.maxLon);

    // The margin is measured on the ground, so it is the same number of metres
    // north–south as east–west despite being far more degrees of longitude.
    const northMargin = distanceMeters(
      { lat: area.box.maxLat, lon: area.box.maxLon },
      { lat: box.maxLat, lon: area.box.maxLon },
    );
    const eastMargin = distanceMeters(
      { lat: area.box.maxLat, lon: area.box.maxLon },
      { lat: area.box.maxLat, lon: box.maxLon },
    );

    expect(northMargin).toBeCloseTo(AREA_DOWNLOAD_MARGIN_METERS, -1);
    expect(eastMargin).toBeCloseTo(AREA_DOWNLOAD_MARGIN_METERS, -1);
  });

  it('moves with the boundary instead of staying centred on the office', async () => {
    const before = workspaceBoundingBox();

    await saveWorkspaceArea(toWorkspaceFeature(district({ east: 4000, half: 300 })));

    const after = workspaceBoundingBox();

    // The old model kept the campaign address at the centre and simply grew the
    // radius; the box has to leave the office behind entirely.
    expect(after.minLon).toBeGreaterThan(before.maxLon - 0.001);
    expect(after.minLon).toBeGreaterThan(AREA_CENTER.lon);

    const widthDegrees = after.maxLon - after.minLon;

    expect(widthDegrees).toBeLessThan(before.maxLon - before.minLon);
  });

  it('shrinks when the boundary shrinks', async () => {
    await saveWorkspaceArea(toWorkspaceFeature(district({ half: 200 })));

    const small = workspaceBoundingBox();

    await saveWorkspaceArea(toWorkspaceFeature(district({ half: 2000 })));

    const large = workspaceBoundingBox();

    expect(large.maxLat - large.minLat).toBeGreaterThan(small.maxLat - small.minLat);
  });
});

describe('re-cutting the dataset after a boundary change', () => {
  it('keeps only what the new polygon covers', async () => {
    const houses = [
      { id: 'near-office', footprint: footprintAt({ x: 0, y: 0 }) },
      { id: 'east', footprint: footprintAt({ x: 3800, y: 0 }) },
    ];

    expect(filterHousesToWorkspace(houses).map((house) => house.id)).toEqual([
      'near-office',
    ]);

    await saveWorkspaceArea(toWorkspaceFeature(district({ east: 3800, half: 300 })));

    expect(filterHousesToWorkspace(houses).map((house) => house.id)).toEqual(['east']);
  });

  it('keeps a building that straddles the new border', async () => {
    await saveWorkspaceArea(toWorkspaceFeature(district({ half: 400 })));

    // Sat exactly on the eastern edge: half in, half out.
    const straddling = [{ id: 'edge', footprint: footprintAt({ x: 400, y: 0 }, 20) }];

    expect(filterHousesToWorkspace(straddling)).toHaveLength(1);
  });
});
