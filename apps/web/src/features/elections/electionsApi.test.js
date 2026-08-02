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
  fetchHousesFromOsm,
  forgetOsmDataset,
} from './electionsApi.js';
import { ringBox } from './polygonGeometry.js';
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
 * One house as the map endpoint sends it: streets by index into a shared
 * dictionary, coordinates flat, and no outline — those come from
 * `/houses/geometry` under their own cache lifetime.
 */
function mapHouse({ x, y }, id) {
  const location = unprojectFromMeters({ x, y });

  return {
    id: String(id),
    street: 0,
    number: String(id),
    lat: location.lat,
    lon: location.lon,
    type: 'apartments',
  };
}

/**
 * Serves the map payload with a declared coverage box around the campaign
 * address — the shape of the real endpoint.
 *
 * `areaApplied: false` because these tests are about the client's own boundary
 * handling; a deployment with a saved boundary has the server cut the set and
 * `fetchHouses` then leaves it alone.
 */
function serveSnapshot({ houses, coverageBox }) {
  return vi.fn(async (url) => {
    if (String(url).includes('/elections/area')) {
      return new Response(JSON.stringify({ error: 'немає' }), { status: 404 });
    }

    if (String(url).includes('/houses/geometry')) {
      return new Response(JSON.stringify({ version: 'test', footprints: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({
        version: 2,
        license: 'ODbL 1.0',
        osmTimestamp: '2026-07-01T00:00:00Z',
        coverage: { box: coverageBox },
        areaApplied: false,
        streets: ['вулиця Якуба Коласа'],
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
  forgetOsmDataset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  resetWorkspaceAreaToShipped();
  forgetOsmDataset();
});

describe('fetchHouses coverage reporting', () => {
  it('reports full coverage for a boundary the snapshot was built for', async () => {
    const coverageBox = shippedCoverageBox();

    vi.stubGlobal(
      'fetch',
      serveSnapshot({ houses: [mapHouse({ x: 0, y: 0 }, 1)], coverageBox }),
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
      serveSnapshot({ houses: [mapHouse({ x: 0, y: 0 }, 1)], coverageBox }),
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
        houses: [mapHouse({ x: 0, y: 0 }, 1), mapHouse({ x: 500, y: 0 }, 2)],
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

    // The banner has to be able to say *how* partial: half a district missing
    // and a metre of it must not produce the same sentence.
    expect(payload.coverage.coveredShare).toBeGreaterThan(0);
    expect(payload.coverage.coveredShare).toBeLessThan(1);
    expect(payload.coverage.gapMeters).toBeGreaterThan(0);
  });

  /**
   * The bounding-box test is exact, which is precisely why it needs a floor: a
   * hand-traced outline that clips the downloaded box by a wedge of a few
   * square metres is not a district with missing houses, and a warning that
   * cannot tell the two apart is a warning nobody reads.
   */
  it('treats an overhang too small to hold a building as covered', async () => {
    // The dataset covers exactly the square district, with no margin at all.
    const coverageBox = ringBox(district({ half: 400 }));

    // The same square with one vertex nudged 40 m east on a narrow wedge.
    const spike = [
      { x: -400, y: -400 },
      { x: 400, y: -400 },
      { x: 400, y: -4 },
      { x: 440, y: 0 },
      { x: 400, y: 4 },
      { x: 400, y: 400 },
      { x: -400, y: 400 },
    ].map((point) => unprojectFromMeters(point));

    vi.stubGlobal(
      'fetch',
      serveSnapshot({ houses: [mapHouse({ x: 0, y: 0 }, 1)], coverageBox }),
    );

    await saveWorkspaceArea(toWorkspaceFeature(spike));

    const payload = await fetchHouses();

    expect(payload.coverage.isCovered).toBe(true);
    expect(payload.coverage.missingAreaSqm).toBeLessThan(400);
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
            houses: [mapHouse({ x: 0, y: 0 }, 1)],
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

    // With the backend as the source an empty result is a state, not a
    // failure — a campaign with no houses yet still has to render a map.
    const payload = await fetchHouses();

    expect(payload.houses).toEqual([]);
    expect(payload.coverage.houseCount).toBe(0);
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

/** One Overpass element, in the `out body geom` shape the normalizer reads. */
function overpassBuilding({ x, y }, id, size = 12) {
  return {
    type: 'way',
    id,
    tags: {
      building: 'apartments',
      'addr:street': 'вулиця Якуба Коласа',
      'addr:housenumber': String(id),
    },
    geometry: [
      { x: x - size, y: y - size },
      { x: x + size, y: y - size },
      { x: x + size, y: y + size },
      { x: x - size, y: y + size },
      { x: x - size, y: y - size },
    ].map((point) => unprojectFromMeters(point)),
  };
}

/**
 * The snapshot *and* the Overpass mirrors behind one handler. The coverage box
 * is taken as an argument rather than derived here, because deriving it would
 * reset the boundary in the middle of a request.
 */
function serveOverpass(elements, coverageBox) {
  return vi.fn(async (url) => {
    if (String(url).includes('/elections/area')) {
      return new Response('{}', { status: 404 });
    }

    if (String(url).includes('overpass')) {
      return new Response(
        JSON.stringify({
          osm3s: { timestamp_osm_base: '2026-08-01T00:00:00Z' },
          elements,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({
        version: 2,
        coverage: { box: coverageBox },
        houses: [mapHouse({ x: 0, y: 0 }, 1)],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
}

/**
 * The warning has to be answerable once. Before this, a live refresh lived only
 * in React state: the next reload — a retried request, a nudged boundary, a
 * reopened page — went back to the shipped snapshot and asked for exactly the
 * download that had just been made.
 */
describe('a live refresh answers the coverage warning for the session', () => {
  it('serves the downloaded buildings to later loads of the same territory', async () => {
    const coverageBox = shippedCoverageBox();

    vi.stubGlobal(
      'fetch',
      serveOverpass([overpassBuilding({ x: 12000, y: 0 }, 501)], coverageBox),
    );

    await saveWorkspaceArea(toWorkspaceFeature(district({ east: 12000, half: 300 })));

    // The shipped snapshot does not reach 12 km east.
    const before = await fetchHouses();

    expect(before.coverage.isCovered).toBe(false);

    const refreshed = await fetchHousesFromOsm();

    expect(refreshed.coverage.isCovered).toBe(true);
    expect(refreshed.houses).toHaveLength(1);

    // The reload the page does after any boundary change or retry.
    const after = await fetchHouses();

    expect(after.coverage.isCovered).toBe(true);
    expect(after.coverage.source).toBe('osm');
    expect(after.houses.map((house) => house.id)).toEqual(['way/501']);
  });

  it('goes back to the snapshot for a boundary the download never reached', async () => {
    const coverageBox = shippedCoverageBox();

    vi.stubGlobal(
      'fetch',
      serveOverpass([overpassBuilding({ x: 12000, y: 0 }, 501)], coverageBox),
    );

    await saveWorkspaceArea(toWorkspaceFeature(district({ east: 12000, half: 300 })));
    await fetchHousesFromOsm();

    // Somewhere else entirely — the session download says nothing about it.
    await saveWorkspaceArea(toWorkspaceFeature(district({ east: 40000, half: 300 })));

    const payload = await fetchHouses();

    expect(payload.coverage.isCovered).toBe(false);
    expect(payload.coverage.source).toBe('backend');
  });
});
