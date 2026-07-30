import { describe, expect, it } from 'vitest';

import { AREA_CENTER, unprojectFromMeters } from './geo.js';
import {
  HEADQUARTERS_OSM_ID,
  buildOverpassQuery,
  listStreetNames,
  normalizeOsmBuildings,
} from './osmBuildings.js';

/** A closed OSM way ring, given local-grid offsets in metres from the centre. */
function wayGeometry(origin, points) {
  const ring = points.map((point) =>
    unprojectFromMeters({ x: origin.x + point.x, y: origin.y + point.y }),
  );

  // Overpass repeats the first vertex to close the way.
  return [...ring, ring[0]];
}

function apartmentBlock({ id = 1, at = { x: 0, y: 0 }, tags = {} } = {}) {
  return {
    type: 'way',
    id,
    tags: {
      building: 'apartments',
      'addr:street': 'вулиця Якуба Коласа',
      'addr:housenumber': '6',
      'building:levels': '9',
      ...tags,
    },
    geometry: wayGeometry(at, [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 14 },
      { x: 0, y: 14 },
    ]),
  };
}

describe('buildOverpassQuery', () => {
  it('asks for ways and relations around the campaign address', () => {
    const query = buildOverpassQuery({ center: AREA_CENTER, radiusMeters: 3000 });

    expect(query).toContain(`around:3000,${AREA_CENTER.lat},${AREA_CENTER.lon}`);
    expect(query).toContain('way(');
    expect(query).toContain('relation(');
    expect(query).toContain('["addr:housenumber"]');
    // `tags` verbosity would silently drop relation members.
    expect(query).toContain('out body geom;');
  });

  it('drops the address filter when unaddressed buildings are wanted', () => {
    expect(buildOverpassQuery({ requireAddress: false })).not.toContain(
      '["addr:housenumber"]',
    );
  });
});

describe('normalizeOsmBuildings', () => {
  it('turns an OSM way into a house record with its real address', () => {
    const [house] = normalizeOsmBuildings([apartmentBlock()]);

    expect(house).toMatchObject({
      id: 'way/1',
      osmType: 'way',
      osmId: 1,
      street: 'вулиця Якуба Коласа',
      streetShort: 'вул. Якуба Коласа',
      number: '6',
      address: 'вул. Якуба Коласа, 6',
      type: 'apartments',
      building: 'apartments',
      floors: 9,
    });
  });

  it('keeps the footprint open, so the ring has no duplicate closing vertex', () => {
    const [house] = normalizeOsmBuildings([apartmentBlock()]);

    expect(house.footprint).toHaveLength(4);
    expect(house.footprint[0]).not.toEqual(house.footprint.at(-1));
  });

  it('measures footprint area and distance from the real geometry', () => {
    const [house] = normalizeOsmBuildings([apartmentBlock({ at: { x: 500, y: 0 } })]);

    expect(house.footprintAreaSqm).toBeCloseTo(840, -1);
    expect(house.distanceMeters).toBeGreaterThan(490);
    expect(house.distanceMeters).toBeLessThan(560);
  });

  it('estimates flats from footprint and levels, and residents from flats', () => {
    const [house] = normalizeOsmBuildings([apartmentBlock()]);

    // 60 × 14 m × 9 levels, 82% usable, 62 m² per flat.
    expect(house.estimate.apartments).toBe(100);
    expect(house.estimate.residents).toBe(230);
    expect(house.estimate.entrances).toBe(4);
  });

  it('refuses to guess flats when OSM has no building:levels', () => {
    const [house] = normalizeOsmBuildings([
      apartmentBlock({ tags: { 'building:levels': undefined } }),
    ]);

    expect(house.floors).toBeNull();
    expect(house.estimate.apartments).toBeNull();
    expect(house.estimate.residents).toBeNull();
    // The street frontage is still real, so entrances can be estimated.
    expect(house.estimate.entrances).toBe(4);
  });

  it('leaves non-residential buildings without resident estimates', () => {
    const [house] = normalizeOsmBuildings([
      apartmentBlock({ tags: { building: 'school' } }),
    ]);

    expect(house.type).toBe('public');
    expect(house.estimate).toEqual({ entrances: null, apartments: null, residents: null });
  });

  it('classifies building=yes as "type not stated" rather than guessing', () => {
    const [house] = normalizeOsmBuildings([apartmentBlock({ tags: { building: 'yes' } })]);

    expect(house.type).toBe('other');
  });

  it('skips garages, sheds and other structures nobody canvasses', () => {
    const houses = normalizeOsmBuildings([
      apartmentBlock({ id: 1, tags: { building: 'garages' } }),
      apartmentBlock({ id: 2, tags: { building: 'shed' } }),
      apartmentBlock({ id: 3 }),
    ]);

    expect(houses.map((house) => house.id)).toEqual(['way/3']);
  });

  it('skips buildings with no address when one is required', () => {
    const houses = normalizeOsmBuildings([
      apartmentBlock({ id: 1, tags: { 'addr:housenumber': undefined } }),
      apartmentBlock({ id: 2 }),
    ]);

    expect(houses.map((house) => house.id)).toEqual(['way/2']);
  });

  it('drops buildings whose centroid falls outside the working radius', () => {
    const houses = normalizeOsmBuildings(
      [
        apartmentBlock({ id: 1, at: { x: 2000, y: 0 } }),
        apartmentBlock({ id: 2, at: { x: 4000, y: 0 } }),
      ],
      { radiusMeters: 3000 },
    );

    expect(houses.map((house) => house.id)).toEqual(['way/1']);
  });

  it('stitches a multipolygon relation into one outline', () => {
    const corners = wayGeometry({ x: 0, y: 0 }, [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 30 },
      { x: 0, y: 30 },
    ]);

    const [house] = normalizeOsmBuildings([
      {
        type: 'relation',
        id: 77,
        tags: {
          type: 'multipolygon',
          building: 'school',
          'addr:street': 'Жмеринська вулиця',
          'addr:housenumber': '20',
        },
        members: [
          { type: 'way', role: 'outer', geometry: corners.slice(0, 3) },
          { type: 'way', role: 'outer', geometry: corners.slice(2) },
        ],
      },
    ]);

    expect(house.id).toBe('relation/77');
    expect(house.streetShort).toBe('Жмеринська вул.');
    expect(house.footprint).toHaveLength(4);
    expect(house.footprintAreaSqm).toBeCloseTo(900, -1);
  });

  it('collapses an element returned by more than one sub-query', () => {
    expect(normalizeOsmBuildings([apartmentBlock(), apartmentBlock()])).toHaveLength(1);
  });

  it('orders houses by distance from the campaign address', () => {
    const houses = normalizeOsmBuildings([
      apartmentBlock({ id: 1, at: { x: 1200, y: 0 } }),
      apartmentBlock({ id: 2, at: { x: 100, y: 0 } }),
      apartmentBlock({ id: 3, at: { x: 600, y: 0 } }),
    ]);

    expect(houses.map((house) => house.id)).toEqual(['way/2', 'way/3', 'way/1']);
  });

  it('flags the campaign office itself', () => {
    const [, osmId] = HEADQUARTERS_OSM_ID.split('/');
    const [house] = normalizeOsmBuildings([apartmentBlock({ id: Number(osmId) })]);

    expect(house.isHeadquarters).toBe(true);
    expect(normalizeOsmBuildings([apartmentBlock()])[0].isHeadquarters).toBe(false);
  });

  it('starts every house with empty survey details', () => {
    const [house] = normalizeOsmBuildings([apartmentBlock()]);

    expect(house.details).toMatchObject({ residents: [], contacts: [], updatedAt: null });
  });
});

describe('listStreetNames', () => {
  it('returns each street once', () => {
    const houses = normalizeOsmBuildings([
      apartmentBlock({ id: 1 }),
      apartmentBlock({ id: 2, at: { x: 80, y: 0 } }),
      apartmentBlock({
        id: 3,
        at: { x: 160, y: 0 },
        tags: { 'addr:street': 'Жмеринська вулиця' },
      }),
    ]);

    expect(listStreetNames(houses)).toEqual([
      'вулиця Якуба Коласа',
      'Жмеринська вулиця',
    ]);
  });
});
