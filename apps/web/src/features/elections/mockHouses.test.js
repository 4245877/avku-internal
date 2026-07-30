import { describe, expect, it } from 'vitest';

import { AREA_CENTER, AREA_RADIUS_METERS, distanceMeters } from './geo.js';
import { getFillStatus } from './houseUtils.js';
import {
  createMapLandmarks,
  createMapStreets,
  createMockHouses,
  listStreetNames,
} from './mockHouses.js';

const houses = createMockHouses();

describe('createMockHouses', () => {
  it('is deterministic for a given seed', () => {
    const other = createMockHouses();

    expect(other).toHaveLength(houses.length);
    expect(other.map((house) => house.address)).toEqual(houses.map((house) => house.address));
    expect(createMockHouses(1).length).not.toBe(0);
  });

  it('generates a district of a workable size', () => {
    expect(houses.length).toBeGreaterThan(200);
    expect(houses.length).toBeLessThan(1200);
  });

  it('keeps every house inside the covered radius', () => {
    for (const house of houses) {
      expect(distanceMeters(AREA_CENTER, house.location)).toBeLessThanOrEqual(
        AREA_RADIUS_METERS,
      );
      expect(house.distanceMeters).toBeLessThanOrEqual(AREA_RADIUS_METERS);
    }
  });

  it('gives every house a unique id and address', () => {
    expect(new Set(houses.map((house) => house.id)).size).toBe(houses.length);
    expect(new Set(houses.map((house) => house.address)).size).toBe(houses.length);
  });

  it('marks the campaign address as the single headquarters', () => {
    const headquarters = houses.filter((house) => house.isHeadquarters);

    expect(headquarters).toHaveLength(1);
    expect(headquarters[0].street).toBe('вулиця Якуба Коласа');
    expect(headquarters[0].number).toBe('6');
    expect(headquarters[0].fullAddress).toBe('вул. Якуба Коласа, 6, Київ, 03146');
  });

  it('produces a closed footprint and a plausible estimate for every house', () => {
    for (const house of houses) {
      expect(house.footprint.length).toBeGreaterThanOrEqual(4);

      for (const point of house.footprint) {
        expect(Number.isFinite(point.lat)).toBe(true);
        expect(Number.isFinite(point.lon)).toBe(true);
      }

      expect(house.estimate.entrances).toBeGreaterThan(0);
      expect(house.estimate.apartments).toBeGreaterThanOrEqual(house.estimate.entrances);
      expect(house.estimate.residents).toBeGreaterThan(0);
      expect(house.floors).toBeGreaterThan(0);
    }
  });

  it('only uses street names that the filter offers', () => {
    const knownStreets = new Set(listStreetNames());

    for (const house of houses) {
      expect(knownStreets.has(house.street)).toBe(true);
    }
  });

  it('seeds only survey data that the edit form would accept', () => {
    for (const house of houses) {
      const { details } = house;

      for (const field of ['entrances', 'apartments', 'residentsCount', 'householdsCount']) {
        if (details[field] !== null) {
          expect(details[field]).toBeGreaterThanOrEqual(0);
        }
      }

      if (details.entrances !== null && details.apartments !== null) {
        expect(details.apartments).toBeGreaterThanOrEqual(details.entrances);
      }

      for (const contact of details.contacts) {
        expect(contact.value.trim()).not.toBe('');
      }

      for (const resident of details.residents) {
        expect(resident.name.trim()).not.toBe('');
      }
    }
  });

  it('covers all three completeness states so the legend is meaningful', () => {
    const counts = { complete: 0, partial: 0, empty: 0 };

    for (const house of houses) {
      counts[getFillStatus(house)] += 1;
    }

    expect(counts.complete).toBeGreaterThan(0);
    expect(counts.partial).toBeGreaterThan(0);
    expect(counts.empty).toBeGreaterThan(0);
    expect(counts.complete + counts.partial + counts.empty).toBe(houses.length);
  });

  it('sorts by street then by house number', () => {
    const addresses = houses.map((house) => `${house.street}|${house.number}`);
    const sorted = [...addresses].sort((first, second) => {
      const [firstStreet, firstNumber] = first.split('|');
      const [secondStreet, secondNumber] = second.split('|');

      return (
        firstStreet.localeCompare(secondStreet, 'uk') ||
        firstNumber.localeCompare(secondNumber, 'uk', { numeric: true })
      );
    });

    expect(addresses).toEqual(sorted);
  });
});

describe('map base layer data', () => {
  it('exposes every street as a polyline with a real width', () => {
    const streets = createMapStreets();

    expect(streets).toHaveLength(listStreetNames().length);

    for (const street of streets) {
      expect(street.points.length).toBeGreaterThanOrEqual(2);
      expect(street.width).toBeGreaterThan(0);
      expect(typeof street.short).toBe('string');
    }
  });

  it('exposes landmarks as either a ring with a label anchor or a point', () => {
    const landmarks = createMapLandmarks();

    expect(landmarks.length).toBeGreaterThan(0);

    for (const landmark of landmarks) {
      if (landmark.kind === 'metro') {
        expect(landmark.point).toEqual(
          expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
        );
      } else {
        expect(landmark.ring.length).toBeGreaterThanOrEqual(3);
        expect(Number.isFinite(landmark.labelAt.x)).toBe(true);
        expect(Number.isFinite(landmark.labelAt.y)).toBe(true);
      }
    }
  });
});
