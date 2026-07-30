/**
 * Deterministic mock dataset for the "Вибори" map.
 *
 * The real module will read houses from the API. Until then the district is
 * generated from a hand-authored street network: buildings are walked along
 * each street, footprints are oriented to the road, and a share of them is
 * pre-filled with survey data so the "заповнено / частково / немає даних"
 * states are all visible on first load.
 *
 * Street geometry is authored in the local metre grid (see `geo.js`) because it
 * is far easier to read than raw coordinates, then converted to WGS84 so the
 * shape of the data matches what an API would return.
 */

import {
  AREA_CENTER,
  AREA_RADIUS_METERS,
  distanceMeters,
  polygonCentroid,
  unprojectFromMeters,
} from './geo.js';
import { createEmptyDetails } from './electionsTypes.js';

const DATASET_SEED = 20260730;

/** Road classes — `width` is the real carriageway width in metres. */
const ROAD_CLASSES = {
  avenue: { width: 26, setback: 20, label: true },
  street: { width: 15, setback: 13, label: true },
  lane: { width: 9, setback: 8, label: false },
};

/**
 * Building archetypes. `length` runs along the street, `depth` across it.
 * Ranges are `[min, max]` in metres / floors.
 */
const BUILDING_ARCHETYPES = {
  slab: {
    type: 'panel',
    length: [58, 96],
    depth: [13, 16],
    floors: [5, 9],
    shape: 'bar',
    builtYear: [1968, 1988],
  },
  tower: {
    type: 'newBuild',
    length: [26, 38],
    depth: [22, 30],
    floors: [16, 25],
    shape: 'bar',
    builtYear: [2006, 2023],
  },
  brick: {
    type: 'brick',
    length: [34, 56],
    depth: [14, 18],
    floors: [4, 5],
    shape: 'ell',
    builtYear: [1957, 1974],
  },
  cottage: {
    type: 'private',
    length: [11, 17],
    depth: [9, 13],
    floors: [1, 2],
    shape: 'bar',
    builtYear: [1961, 2014],
  },
};

/** Archetype mix per road class, as cumulative weights. */
const ARCHETYPE_MIX = {
  avenue: [
    ['slab', 0.45],
    ['tower', 0.8],
    ['brick', 1],
  ],
  street: [
    ['slab', 0.4],
    ['brick', 0.72],
    ['tower', 0.84],
    ['cottage', 1],
  ],
  lane: [
    ['cottage', 0.82],
    ['brick', 1],
  ],
};

/**
 * The district network. Coordinates are `[east, south]` metres from the
 * campaign address; `sides` limits which kerb receives buildings (`-1` gives
 * odd numbers, `1` even ones).
 */
const STREET_BLUEPRINTS = [
  {
    name: 'проспект Перемоги',
    short: 'просп. Перемоги',
    kind: 'avenue',
    sides: [1],
    nodes: [
      [-2600, -1220],
      [-1400, -1180],
      [-200, -1150],
      [1100, -1130],
      [2500, -1160],
    ],
  },
  {
    name: 'вулиця Львівська',
    short: 'вул. Львівська',
    kind: 'avenue',
    sides: [-1, 1],
    nodes: [
      [-2200, 1040],
      [-900, 1000],
      [400, 970],
      [1600, 990],
      [2400, 1030],
    ],
  },
  {
    name: 'Кільцева дорога',
    short: 'Кільцева дор.',
    kind: 'avenue',
    sides: [1],
    nodes: [
      [-2150, -2400],
      [-2120, -1200],
      [-2100, 0],
      [-2130, 1200],
      [-2160, 2300],
    ],
  },
  {
    name: 'проспект Леся Курбаса',
    short: 'просп. Л. Курбаса',
    kind: 'avenue',
    sides: [-1, 1],
    nodes: [
      [1880, -2200],
      [1900, -1000],
      [1910, 200],
      [1890, 1400],
      [1870, 2300],
    ],
  },
  {
    name: 'вулиця Якуба Коласа',
    short: 'вул. Якуба Коласа',
    kind: 'street',
    sides: [-1, 1],
    nodes: [
      [-1250, 40],
      [-500, 10],
      [0, 0],
      [600, -10],
      [1350, -30],
    ],
  },
  {
    name: 'вулиця Гната Юри',
    short: 'вул. Гната Юри',
    kind: 'street',
    sides: [-1, 1],
    nodes: [
      [-1200, -560],
      [-300, -530],
      [600, -510],
      [1400, -540],
    ],
  },
  {
    name: 'вулиця Тулузи',
    short: 'вул. Тулузи',
    kind: 'street',
    sides: [-1, 1],
    nodes: [
      [-950, 500],
      [-200, 470],
      [500, 460],
      [1100, 490],
    ],
  },
  {
    name: 'вулиця Чорнобильська',
    short: 'вул. Чорнобильська',
    kind: 'street',
    sides: [1],
    nodes: [
      [-2100, -1600],
      [-1000, -1570],
      [100, -1540],
      [1000, -1560],
      [1900, -1590],
    ],
  },
  {
    name: 'вулиця Зодчих',
    short: 'вул. Зодчих',
    kind: 'street',
    sides: [-1, 1],
    nodes: [
      [-800, -1650],
      [-790, -700],
      [-780, 200],
      [-770, 1100],
      [-760, 1900],
    ],
  },
  {
    name: 'вулиця Верховинна',
    short: 'вул. Верховинна',
    kind: 'street',
    sides: [-1, 1],
    nodes: [
      [-180, -2050],
      [-170, -1100],
      [-160, -200],
      [-150, 700],
      [-140, 1600],
    ],
  },
  {
    name: 'вулиця Симиренка',
    short: 'вул. Симиренка',
    kind: 'street',
    sides: [-1, 1],
    nodes: [
      [600, -1750],
      [610, -800],
      [620, 100],
      [630, 1000],
      [640, 1800],
    ],
  },
  {
    name: 'вулиця Академіка Булаховського',
    short: 'вул. Ак. Булаховського',
    kind: 'street',
    sides: [1],
    nodes: [
      [1230, -1500],
      [1240, -600],
      [1250, 300],
      [1260, 1200],
    ],
  },
  {
    name: 'вулиця Жмеринська',
    short: 'вул. Жмеринська',
    kind: 'street',
    sides: [-1],
    nodes: [
      [-1480, -1900],
      [-1460, -800],
      [-1450, 300],
      [-1470, 1400],
      [-1490, 2200],
    ],
  },
  {
    name: 'бульвар Ромена Роллана',
    short: 'бул. Р. Роллана',
    kind: 'street',
    sides: [-1, 1],
    nodes: [
      [-2100, 700],
      [-1500, 420],
      [-900, 190],
      [-300, -40],
      [300, -250],
    ],
  },
  {
    name: 'вулиця Прикордонників',
    short: 'вул. Прикордонників',
    kind: 'street',
    sides: [1],
    nodes: [
      [-1900, -2100],
      [-800, -2060],
      [300, -2030],
      [1200, -2060],
    ],
  },
  {
    name: 'вулиця Пшенична',
    short: 'вул. Пшенична',
    kind: 'lane',
    sides: [-1, 1],
    nodes: [
      [-1700, 1600],
      [-600, 1570],
      [500, 1550],
      [1500, 1580],
    ],
  },
  {
    name: 'вулиця Наумова',
    short: 'вул. Наумова',
    kind: 'lane',
    sides: [-1, 1],
    nodes: [
      [620, 700],
      [1000, 860],
      [1400, 1080],
      [1700, 1330],
    ],
  },
  {
    name: 'вулиця Картвелішвілі',
    short: 'вул. Картвелішвілі',
    kind: 'lane',
    sides: [-1, 1],
    nodes: [
      [-1450, 1750],
      [-1000, 1720],
      [-560, 1700],
      [-120, 1690],
    ],
  },
  {
    name: 'вулиця Депутатська',
    short: 'вул. Депутатська',
    kind: 'lane',
    sides: [-1, 1],
    nodes: [
      [-1200, 2140],
      [-200, 2110],
      [800, 2130],
    ],
  },
  {
    name: 'вулиця Ушакова',
    short: 'вул. Ушакова',
    kind: 'lane',
    sides: [-1, 1],
    nodes: [
      [700, -2200],
      [1100, -2230],
      [1500, -2210],
    ],
  },
];

/** Non-buildable map texture: parks, water and metro entrances. */
const LANDMARK_BLUEPRINTS = [
  {
    id: 'park-svyatoshyn',
    name: 'Святошинський лісопарк',
    kind: 'forest',
    ring: [
      [-2600, -2500],
      [-1450, -2450],
      [-1300, -1900],
      [-1600, -1450],
      [-2350, -1350],
      [-2650, -1800],
    ],
  },
  {
    id: 'park-nyvky',
    name: 'Парк «Нивки»',
    kind: 'park',
    ring: [
      [1350, -1050],
      [2400, -1030],
      [2450, -350],
      [1900, -180],
      [1320, -420],
    ],
  },
  {
    id: 'square-zodchykh',
    name: 'Сквер на Зодчих',
    kind: 'park',
    ring: [
      [-700, 560],
      [-260, 545],
      [-250, 900],
      [-690, 915],
    ],
  },
  {
    id: 'park-kurbasa',
    name: 'Сквер Леся Курбаса',
    kind: 'park',
    ring: [
      [660, 1120],
      [1150, 1105],
      [1160, 1480],
      [670, 1495],
    ],
  },
  {
    id: 'water-svyatoshyn',
    name: 'Святошинські озера',
    kind: 'water',
    ring: [
      [-2050, -1900],
      [-1700, -1980],
      [-1520, -1780],
      [-1650, -1560],
      [-1980, -1590],
    ],
  },
  {
    id: 'metro-svyatoshyn',
    name: 'Метро «Святошин»',
    kind: 'metro',
    point: [1180, -1090],
  },
  {
    id: 'metro-zhytomyrska',
    name: 'Метро «Житомирська»',
    kind: 'metro',
    point: [-2030, -1180],
  },
  {
    id: 'school-256',
    name: 'Школа № 256',
    kind: 'civic',
    ring: [
      [180, 180],
      [470, 175],
      [475, 380],
      [185, 385],
    ],
  },
  {
    id: 'clinic-svyatoshyn',
    name: 'Поліклініка № 2',
    kind: 'civic',
    ring: [
      [-620, -330],
      [-380, -335],
      [-375, -170],
      [-615, -165],
    ],
  },
];

const FIRST_NAMES = [
  'Олена',
  'Марія',
  'Ірина',
  'Наталія',
  'Тетяна',
  'Людмила',
  'Оксана',
  'Софія',
  'Андрій',
  'Сергій',
  'Володимир',
  'Микола',
  'Тарас',
  'Богдан',
  'Дмитро',
  'Олександр',
  'Павло',
  'Юрій',
];

const LAST_NAMES = [
  'Коваленко',
  'Шевченко',
  'Бондаренко',
  'Ткаченко',
  'Кравчук',
  'Мельник',
  'Савчук',
  'Данилюк',
  'Гриценко',
  'Лисенко',
  'Марченко',
  'Поліщук',
  'Романюк',
  'Сидоренко',
  'Гуменюк',
  'Левченко',
];

const CANVASSERS = [
  'Оксана Гриценко',
  'Марко Бойко',
  'Ірина Савчук',
  'Андрій Левченко',
  'Ольга Ткаченко',
];

const ACCESS_NOTES = [
  'Кодовий замок, код надає староста будинку.',
  'Домофон працює, консьєржа немає.',
  'Двір закритий, вʼїзд з боку подвірʼя.',
  'Консьєрж на першому підʼїзді, потрібно попередити.',
  'Вільний доступ до підʼїздів.',
];

const HOUSE_NOTES = [
  'Активний ОСББ, голова охоче спілкується. Найкращий час для обходу — субота до обіду.',
  'Багато людей похилого віку, потрібні друковані матеріали великим шрифтом.',
  'Мешканці скаржаться на освітлення у дворі — тема для розмови.',
  'Молоді родини, більшість контактів через Telegram.',
  'Частина квартир здається в оренду, реєстрація не збігається з проживанням.',
  'Двір нещодавно відремонтовано, настрій позитивний.',
  'Потрібен повторний обхід — минулого разу вдома майже нікого не було.',
];

const RESIDENT_NOTES = [
  'Голова ОСББ, готова допомогти з обходом.',
  'Просила зателефонувати ввечері.',
  'Староста підʼїзду.',
  'Цікавиться темою прибудинкової території.',
  'Просив більше не турбувати.',
  '',
  '',
];

/** Mulberry32 — small, fast, and stable across runs. */
function createRandom(seed) {
  let state = seed >>> 0;

  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;

    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (random, [min, max]) => min + random() * (max - min);
const intBetween = (random, range) => Math.round(between(random, range));
const pick = (random, items) => items[Math.floor(random() * items.length) % items.length];

function pickArchetype(random, kind) {
  const roll = random();
  const mix = ARCHETYPE_MIX[kind];

  for (const [name, threshold] of mix) {
    if (roll <= threshold) {
      return BUILDING_ARCHETYPES[name];
    }
  }

  return BUILDING_ARCHETYPES[mix[mix.length - 1][0]];
}

/** Pre-computes segment lengths so the walker can work in arc-length space. */
function measurePolyline(nodes) {
  const segments = [];
  let total = 0;

  for (let index = 0; index < nodes.length - 1; index += 1) {
    const [fromX, fromY] = nodes[index];
    const [toX, toY] = nodes[index + 1];
    const deltaX = toX - fromX;
    const deltaY = toY - fromY;
    const length = Math.hypot(deltaX, deltaY);

    segments.push({
      fromX,
      fromY,
      length,
      start: total,
      dirX: deltaX / length,
      dirY: deltaY / length,
    });

    total += length;
  }

  return { segments, total };
}

function pointAtDistance(measured, distance) {
  const clamped = Math.min(Math.max(distance, 0), measured.total);
  const segment =
    measured.segments.find((item) => clamped <= item.start + item.length) ??
    measured.segments[measured.segments.length - 1];
  const offset = clamped - segment.start;

  return {
    x: segment.fromX + segment.dirX * offset,
    y: segment.fromY + segment.dirY * offset,
    dirX: segment.dirX,
    dirY: segment.dirY,
  };
}

/**
 * Builds a footprint in street-local space (`along` × `across`) and rotates it
 * onto the grid. `side` flips the shape so wings always face the courtyard.
 */
function buildFootprint(anchor, length, depth, shape, side) {
  const halfLength = length / 2;
  const halfDepth = depth / 2;

  const localPoints =
    shape === 'ell'
      ? [
          [-halfLength, -halfDepth],
          [halfLength, -halfDepth],
          [halfLength, halfDepth + depth * 0.85],
          [halfLength - depth * 1.2, halfDepth + depth * 0.85],
          [halfLength - depth * 1.2, halfDepth],
          [-halfLength, halfDepth],
        ]
      : [
          [-halfLength, -halfDepth],
          [halfLength, -halfDepth],
          [halfLength, halfDepth],
          [-halfLength, halfDepth],
        ];

  const normalX = -anchor.dirY;
  const normalY = anchor.dirX;

  return localPoints.map(([along, across]) => ({
    x: anchor.x + anchor.dirX * along + normalX * across * side,
    y: anchor.y + anchor.dirY * along + normalY * across * side,
  }));
}

function buildHouseNumber(random, sequence, side) {
  const base = (sequence - 1) * 2 + (side < 0 ? 1 : 2);
  const roll = random();

  if (roll > 0.9) {
    return `${base}${pick(random, ['А', 'Б', 'В'])}`;
  }

  if (roll > 0.84) {
    return `${base}/${intBetween(random, [1, 3])}`;
  }

  return String(base);
}

function estimateFromGeometry(archetype, length, floors) {
  if (archetype.type === 'private') {
    return { entrances: 1, apartments: 1, residents: 4 };
  }

  const entrances = Math.min(9, Math.max(1, Math.round(length / 17)));
  const apartmentsPerLanding = archetype.type === 'newBuild' ? 5 : 4;
  const apartments = entrances * floors * apartmentsPerLanding;

  return {
    entrances,
    apartments,
    residents: Math.round(apartments * 1.9),
  };
}

function createResident(random, apartmentCount) {
  return {
    id: `resident-${Math.floor(random() * 1e9).toString(36)}`,
    name: `${pick(random, LAST_NAMES)} ${pick(random, FIRST_NAMES)}`,
    apartment: String(Math.max(1, Math.round(random() * apartmentCount))),
    stance: pick(random, ['support', 'support', 'neutral', 'neutral', 'against', 'unknown']),
    ageGroup: pick(random, ['18-35', '36-55', '56-70', '70+', 'unknown']),
    note: pick(random, RESIDENT_NOTES),
  };
}

function createContact(random, residentName) {
  const type = pick(random, ['phone', 'phone', 'phone', 'telegram', 'email', 'viber']);
  const operator = pick(random, ['67', '95', '99', '63', '73']);
  const phone = `+380 ${operator} ${intBetween(random, [100, 999])} ${intBetween(random, [10, 99])} ${intBetween(random, [10, 99])}`;
  const translit = `resident${Math.floor(random() * 900 + 100)}`;

  const values = {
    phone,
    viber: phone,
    telegram: `@${translit}`,
    email: `${translit}@ukr.net`,
    other: phone,
  };

  return {
    id: `contact-${Math.floor(random() * 1e9).toString(36)}`,
    type,
    value: values[type],
    label: residentName,
  };
}

/**
 * Fills a share of the houses with survey data. `completeness` decides whether
 * the record reads as fully filled or only partially, which is what the map
 * legend is built around.
 */
function createSurveyedDetails(random, house, completeness) {
  const details = createEmptyDetails();
  const { estimate } = house;

  details.entrances = estimate.entrances;
  // Jitter the estimate, but never below one apartment per entrance — the edit
  // form rejects that combination, so seeded data must not contain it either.
  details.apartments = Math.max(
    estimate.entrances,
    estimate.apartments + intBetween(random, [-6, 6]),
  );
  details.updatedBy = pick(random, CANVASSERS);
  details.updatedAt = new Date(
    Date.UTC(2026, 5, intBetween(random, [1, 28]), intBetween(random, [8, 19]), 0, 0),
  ).toISOString();
  details.surveyedAt = details.updatedAt.slice(0, 10);
  details.priority = pick(random, ['high', 'medium', 'medium', 'low']);

  const residentCount =
    completeness === 'complete' ? intBetween(random, [2, 5]) : intBetween(random, [1, 2]);

  details.residents = Array.from({ length: residentCount }, () =>
    createResident(random, Math.max(1, details.apartments)),
  );

  if (completeness === 'complete') {
    details.residentsCount = Math.round(estimate.residents * between(random, [0.8, 1.1]));
    details.householdsCount = Math.round(details.apartments * between(random, [0.75, 0.95]));
    details.canvassStatus = pick(random, ['done', 'done', 'inProgress']);
    details.accessNote = pick(random, ACCESS_NOTES);
    details.notes = pick(random, HOUSE_NOTES);
    details.contacts = details.residents
      .slice(0, intBetween(random, [1, 3]))
      .map((resident) => createContact(random, resident.name));

    return details;
  }

  // Partially filled: at most one of contacts/notes, so the record can never
  // accidentally satisfy every completeness field.
  details.canvassStatus = pick(random, ['inProgress', 'planned', 'refused']);

  const missingBlock = random();

  if (missingBlock < 0.4) {
    details.contacts = [createContact(random, details.residents[0].name)];
  } else if (missingBlock < 0.75) {
    details.notes = pick(random, HOUSE_NOTES);
  }

  if (random() > 0.6) {
    details.residentsCount = Math.round(estimate.residents * between(random, [0.7, 1.05]));
  }

  return details;
}

function walkStreet(street, random, collected) {
  const measured = measurePolyline(street.nodes);
  const roadClass = ROAD_CLASSES[street.kind];

  for (const side of street.sides) {
    let travelled = between(random, [30, 140]);
    let sequence = 0;

    while (travelled < measured.total - 40) {
      const runLength = intBetween(random, [2, 4]);

      for (let indexInRun = 0; indexInRun < runLength; indexInRun += 1) {
        const archetype = pickArchetype(random, street.kind);
        const length = between(random, archetype.length);
        const depth = between(random, archetype.depth);
        const floors = intBetween(random, archetype.floors);

        if (travelled + length > measured.total - 20) {
          travelled = measured.total;
          break;
        }

        const anchor = pointAtDistance(measured, travelled + length / 2);
        const normalX = -anchor.dirY;
        const normalY = anchor.dirX;
        const offset = roadClass.width / 2 + roadClass.setback + depth / 2;

        const center = {
          x: anchor.x + normalX * offset * side,
          y: anchor.y + normalY * offset * side,
        };
        const location = unprojectFromMeters(center);
        const distance = distanceMeters(AREA_CENTER, location);

        sequence += 1;
        travelled += length + between(random, [12, 30]);

        if (distance > AREA_RADIUS_METERS) {
          continue;
        }

        const footprintLocal = buildFootprint(
          { ...center, dirX: anchor.dirX, dirY: anchor.dirY },
          length,
          depth,
          archetype.shape,
          side,
        );
        const number = buildHouseNumber(random, sequence, side);

        collected.push({
          id: `house-${collected.length + 1}`,
          street: street.name,
          streetShort: street.short,
          number,
          address: `${street.short}, ${number}`,
          fullAddress: `${street.short}, ${number}, ${AREA_CENTER.city}, ${AREA_CENTER.postalCode}`,
          type: archetype.type,
          floors,
          builtYear: intBetween(random, archetype.builtYear),
          location,
          footprint: footprintLocal.map((point) => unprojectFromMeters(point)),
          distanceMeters: Math.round(distance),
          estimate: estimateFromGeometry(archetype, length, floors),
          details: createEmptyDetails(),
          isHeadquarters: false,
        });
      }

      travelled += between(random, [170, 430]);
    }
  }
}

/**
 * The campaign address itself must exist as a real house, so the building
 * closest to the anchor on вулиця Якуба Коласа is renumbered to 6.
 */
function markHeadquarters(houses) {
  const candidates = houses.filter((house) => house.street === 'вулиця Якуба Коласа');

  if (candidates.length === 0) {
    return;
  }

  const anchor = candidates.reduce((closest, house) =>
    house.distanceMeters < closest.distanceMeters ? house : closest,
  );

  // Renumbering can collide with the building that already held number 6.
  for (const house of candidates) {
    if (house !== anchor && house.number === '6') {
      house.number = '6А';
      house.address = `${house.streetShort}, 6А`;
      house.fullAddress = `${house.streetShort}, 6А, ${AREA_CENTER.city}, ${AREA_CENTER.postalCode}`;
    }
  }

  anchor.number = '6';
  anchor.address = `${anchor.streetShort}, 6`;
  anchor.fullAddress = `${anchor.streetShort}, 6, ${AREA_CENTER.city}, ${AREA_CENTER.postalCode}`;
  anchor.isHeadquarters = true;
}

/** Builds the full mock district. Same seed ⇒ same output. */
export function createMockHouses(seed = DATASET_SEED) {
  const random = createRandom(seed);
  const houses = [];

  for (const street of STREET_BLUEPRINTS) {
    walkStreet(street, random, houses);
  }

  markHeadquarters(houses);

  // ~30% fully surveyed, ~22% partially — the rest stay empty on purpose.
  for (const house of houses) {
    const roll = random();

    if (roll < 0.3) {
      house.details = createSurveyedDetails(random, house, 'complete');
    } else if (roll < 0.52) {
      house.details = createSurveyedDetails(random, house, 'partial');
    }
  }

  houses.sort(
    (first, second) =>
      first.street.localeCompare(second.street, 'uk') ||
      first.number.localeCompare(second.number, 'uk', { numeric: true }),
  );

  return houses;
}

/** Street network for the map base layer, projected into the local grid. */
export function createMapStreets() {
  return STREET_BLUEPRINTS.map((street) => ({
    id: street.name,
    name: street.name,
    short: street.short,
    kind: street.kind,
    width: ROAD_CLASSES[street.kind].width,
    showLabel: ROAD_CLASSES[street.kind].label,
    points: street.nodes.map(([x, y]) => ({ x, y })),
  }));
}

/** Parks, water, civic buildings and metro pins for the map base layer. */
export function createMapLandmarks() {
  return LANDMARK_BLUEPRINTS.map((landmark) => {
    if (landmark.point) {
      return {
        id: landmark.id,
        name: landmark.name,
        kind: landmark.kind,
        point: { x: landmark.point[0], y: landmark.point[1] },
      };
    }

    const ring = landmark.ring.map(([x, y]) => ({ x, y }));

    return {
      id: landmark.id,
      name: landmark.name,
      kind: landmark.kind,
      ring,
      labelAt: polygonCentroid(ring),
    };
  });
}

/** Distinct street names, for the filter control. */
export function listStreetNames() {
  return STREET_BLUEPRINTS.map((street) => street.name).sort((first, second) =>
    first.localeCompare(second, 'uk'),
  );
}
