/**
 * OpenStreetMap → house records.
 *
 * Every building on the "Вибори" map is a real OSM object: its outline is the
 * mapped footprint, its address is `addr:street` + `addr:housenumber`, its
 * height is `building:levels`. Nothing here invents geometry or attributes — a
 * value that OSM does not carry stays `null` and the UI renders it as "—".
 *
 * The module is deliberately environment-free (no DOM, no `fetch`, no `fs`) so
 * the same code normalizes data in three places: the snapshot script that ships
 * the dataset, the browser when it refreshes straight from Overpass, and the
 * API once houses move to the backend.
 *
 * @see https://wiki.openstreetmap.org/wiki/Key:building
 */

import {
  AREA_CENTER,
  AREA_RADIUS_METERS,
  boxFromCircle,
  distanceMeters,
  formatBoxForOverpass,
  isPointInBox,
  ringAreaSquareMeters,
  ringCentroid,
  ringDimensions,
} from './geo.js';
import { createEmptyDetails } from './electionsTypes.js';
import { abbreviateStreet } from './streetNames.js';

/** The campaign office itself — OSM way for вулиця Зодчих, 58А. */
export const HEADQUARTERS_OSM_ID = 'way/180170140';

/**
 * `building=*` → the house type shown in the card and the filter. Values that
 * are missing from this table (including the very common `building=yes`) fall
 * back to `other`, which reads as "тип не вказано" rather than a guess.
 */
const HOUSE_TYPE_BY_BUILDING_VALUE = {
  apartments: 'apartments',
  residential: 'apartments',
  flats: 'apartments',
  dormitory: 'dormitory',
  house: 'private',
  detached: 'private',
  semidetached_house: 'private',
  terrace: 'private',
  bungalow: 'private',
  farm: 'private',
  school: 'public',
  kindergarten: 'public',
  university: 'public',
  college: 'public',
  hospital: 'public',
  clinic: 'public',
  civic: 'public',
  public: 'public',
  government: 'public',
  administrative: 'public',
  fire_station: 'public',
  train_station: 'public',
  transportation: 'public',
  church: 'public',
  chapel: 'public',
  temple: 'public',
  mosque: 'public',
  synagogue: 'public',
  sports_hall: 'public',
  stadium: 'public',
  commercial: 'commercial',
  retail: 'commercial',
  supermarket: 'commercial',
  office: 'commercial',
  industrial: 'commercial',
  warehouse: 'commercial',
  manufacture: 'commercial',
  hotel: 'commercial',
  kiosk: 'commercial',
  service: 'commercial',
  hangar: 'commercial',
};

/** House types whose apartment/resident estimates make sense at all. */
const RESIDENTIAL_HOUSE_TYPES = new Set(['apartments', 'private', 'dormitory']);

/**
 * Structures nobody canvasses. Some of them do carry an address in OSM, so they
 * have to be dropped explicitly rather than by "has an address" alone.
 */
const IGNORED_BUILDING_VALUES = new Set([
  'garage',
  'garages',
  'carport',
  'parking',
  'shed',
  'hut',
  'roof',
  'construction',
  'ruins',
  'greenhouse',
  'container',
  'transformer_tower',
  'water_tower',
  'bunker',
  'silo',
  'storage_tank',
  'digester',
  'toilets',
  'guardhouse',
  'boathouse',
  'tent',
  'no',
]);

/*
 * Estimate constants. These produce the "оціночно, за геометрією" numbers a
 * canvasser sees before the first survey; every one of them is overwritten by
 * real data as soon as somebody fills the card in.
 */

/** Share of a floor plate that is actually flats rather than stairs and walls. */
const USABLE_FLOOR_SHARE = 0.82;
/** Average flat area in a Kyiv apartment block, in square metres. */
const AVERAGE_FLAT_AREA_SQM = 62;
/** A stairwell serves roughly this much street frontage in a Soviet-era block. */
const METERS_PER_ENTRANCE = 15;
/** Average household size in Kyiv (State Statistics Service, 2020 census round). */
const RESIDENTS_PER_FLAT = 2.3;
/** Below this footprint a "building" is an outbuilding, not a house. */
const MIN_FOOTPRINT_SQM = 12;

function readInteger(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);

  return Number.isFinite(parsed) ? parsed : null;
}

/** `start_date` is free-form in OSM; only a plain year is trustworthy enough. */
function readBuiltYear(tags) {
  const match = /^\s*(1[6-9]\d{2}|20\d{2})/.exec(tags['start_date'] ?? '');

  return match ? Number.parseInt(match[1], 10) : null;
}

function classifyHouse(tags) {
  return HOUSE_TYPE_BY_BUILDING_VALUE[tags.building] ?? 'other';
}

/**
 * Geometry estimates for a house that has never been surveyed. Anything the
 * footprint cannot support — most often because OSM has no `building:levels` —
 * stays `null` instead of being filled with a plausible-looking number.
 */
function estimateFromGeometry({ areaSqm, dimensions, levels, houseType }) {
  if (!RESIDENTIAL_HOUSE_TYPES.has(houseType)) {
    return { entrances: null, apartments: null, residents: null };
  }

  if (houseType === 'private') {
    return { entrances: 1, apartments: 1, residents: Math.round(RESIDENTS_PER_FLAT) };
  }

  const entrances = Math.max(1, Math.round(dimensions.length / METERS_PER_ENTRANCE));

  if (!levels) {
    return { entrances, apartments: null, residents: null };
  }

  const apartments = Math.max(
    1,
    Math.round((areaSqm * levels * USABLE_FLOOR_SHARE) / AVERAGE_FLAT_AREA_SQM),
  );

  return {
    entrances,
    apartments,
    residents: Math.round(apartments * RESIDENTS_PER_FLAT),
  };
}

/**
 * Overpass returns closed ways with the first vertex repeated at the end, which
 * Leaflet would draw as a zero-length edge.
 */
function openRing(ring) {
  if (ring.length < 2) {
    return ring;
  }

  const first = ring[0];
  const last = ring[ring.length - 1];

  return first.lat === last.lat && first.lon === last.lon ? ring.slice(0, -1) : ring;
}

function toRing(geometry) {
  return openRing(
    (geometry ?? [])
      .filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lon))
      .map((point) => ({ lat: point.lat, lon: point.lon })),
  );
}

const ringKey = (point) => `${point.lat.toFixed(7)},${point.lon.toFixed(7)}`;

/**
 * Stitches the `outer` members of a multipolygon relation into closed rings —
 * a large building is often mapped as several ways that only form an outline
 * once joined end to end. Returns the largest ring, which is the building
 * itself; courtyards and annexes are not worth a separate card.
 */
function stitchOuterRing(members) {
  const segments = (members ?? [])
    .filter((member) => member.type === 'way' && (member.role ?? 'outer') === 'outer')
    .map((member) => toRing(member.geometry))
    .filter((points) => points.length >= 2);

  const rings = [];

  while (segments.length > 0) {
    let ring = segments.shift();

    let joined = true;
    while (joined) {
      joined = false;

      for (let index = 0; index < segments.length; index += 1) {
        const candidate = segments[index];
        const ringEnd = ringKey(ring[ring.length - 1]);

        if (ringKey(candidate[0]) === ringEnd) {
          ring = ring.concat(candidate.slice(1));
        } else if (ringKey(candidate[candidate.length - 1]) === ringEnd) {
          ring = ring.concat(candidate.slice(0, -1).reverse());
        } else {
          continue;
        }

        segments.splice(index, 1);
        joined = true;
        break;
      }
    }

    rings.push(openRing(ring));
  }

  return rings
    .filter((points) => points.length >= 3)
    .sort((first, second) => ringAreaSquareMeters(second) - ringAreaSquareMeters(first))[0];
}

function footprintOf(element) {
  if (element.type === 'relation') {
    return stitchOuterRing(element.members);
  }

  return toRing(element.geometry);
}

/**
 * Normalizes the two ways an acquisition area can be described into the one the
 * query and the filter both use.
 *
 * A bounding box is the current model — it follows the traced polygon wherever
 * it is drawn. The `center` + `radiusMeters` circle is what the module was
 * built on and what an older snapshot records, so it is still accepted and
 * converted rather than being a second code path.
 */
export function resolveAcquisitionBox({
  box,
  center = AREA_CENTER,
  radiusMeters = AREA_RADIUS_METERS,
} = {}) {
  return box ?? boxFromCircle(center, radiusMeters);
}

/**
 * The Overpass QL for the covered territory. Kept next to the normalizer so the
 * query and the parser can never drift apart.
 *
 * Overpass keeps any way with *a node* inside the box, so the result includes a
 * thin fringe of buildings hanging over the edge; {@link normalizeOsmBuildings}
 * re-checks every centroid against the same box and drops them.
 */
export function buildOverpassQuery({
  box,
  center = AREA_CENTER,
  radiusMeters = AREA_RADIUS_METERS,
  timeoutSeconds = 300,
  requireAddress = true,
} = {}) {
  const bounds = formatBoxForOverpass(resolveAcquisitionBox({ box, center, radiusMeters }));
  const addressFilter = requireAddress ? '["addr:housenumber"]' : '';

  // `body geom` rather than `tags geom`: the `tags` verbosity omits relation
  // members, which would silently drop every multipolygon building.
  return `[out:json][timeout:${timeoutSeconds}];
(
  way(${bounds})["building"]${addressFilter};
  relation(${bounds})["building"]${addressFilter};
);
out body geom;`;
}

/** One Overpass element → a house record, or `null` if it is not a house. */
function normalizeElement(element, { center, box, requireAddress }) {
  const tags = element.tags ?? {};

  if (!tags.building || IGNORED_BUILDING_VALUES.has(tags.building)) {
    return null;
  }

  const number = String(tags['addr:housenumber'] ?? '').trim();
  const street = String(tags['addr:street'] ?? '').trim();

  if (requireAddress && (!number || !street)) {
    return null;
  }

  const footprint = footprintOf(element);

  if (!footprint || footprint.length < 3) {
    return null;
  }

  const areaSqm = ringAreaSquareMeters(footprint);

  if (areaSqm < MIN_FOOTPRINT_SQM) {
    return null;
  }

  const location = ringCentroid(footprint);

  if (!isPointInBox(location, box)) {
    return null;
  }

  // Distance from the campaign address is what the results list sorts by; it
  // has nothing to do with membership of the territory any more.
  const distance = distanceMeters(center, location);

  const id = `${element.type}/${element.id}`;
  const houseType = classifyHouse(tags);
  const levels = readInteger(tags['building:levels']);
  const streetShort = abbreviateStreet(street);
  const city = String(tags['addr:city'] ?? '').trim() || null;
  const postalCode = String(tags['addr:postcode'] ?? '').trim() || null;
  const address = street ? `${streetShort}, ${number}` : (tags.name ?? id);

  return {
    id,
    osmType: element.type,
    osmId: element.id,
    street,
    streetShort,
    number,
    address,
    fullAddress: [street ? `${street}, ${number}` : address, city, postalCode]
      .filter(Boolean)
      .join(', '),
    name: String(tags.name ?? '').trim() || null,
    type: houseType,
    building: tags.building,
    floors: levels,
    builtYear: readBuiltYear(tags),
    footprintAreaSqm: Math.round(areaSqm),
    location,
    footprint,
    distanceMeters: Math.round(distance),
    estimate: estimateFromGeometry({
      areaSqm,
      dimensions: ringDimensions(footprint),
      levels,
      houseType,
    }),
    isHeadquarters: id === HEADQUARTERS_OSM_ID,
    details: createEmptyDetails(),
  };
}

/**
 * Overpass response elements → house records, ordered by distance from the
 * campaign address. Duplicate OSM ids (a way returned by two sub-queries) are
 * collapsed, so every real building stays exactly one interactive object.
 */
export function normalizeOsmBuildings(
  elements,
  {
    box,
    center = AREA_CENTER,
    radiusMeters = AREA_RADIUS_METERS,
    requireAddress = true,
  } = {},
) {
  const bounds = resolveAcquisitionBox({ box, center, radiusMeters });
  const housesById = new Map();

  for (const element of elements ?? []) {
    const house = normalizeElement(element, { center, box: bounds, requireAddress });

    if (house && !housesById.has(house.id)) {
      housesById.set(house.id, house);
    }
  }

  return [...housesById.values()].sort(
    (first, second) => first.distanceMeters - second.distanceMeters,
  );
}

/** Distinct street names present in a dataset, for the toolbar filter. */
export function listStreetNames(houses) {
  return [...new Set(houses.map((house) => house.street).filter(Boolean))];
}
