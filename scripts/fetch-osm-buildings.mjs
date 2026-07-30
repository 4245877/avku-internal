#!/usr/bin/env node
/**
 * Builds the "Вибори" house dataset from OpenStreetMap.
 *
 * Downloads every mapped building around the campaign address through the
 * Overpass API, normalizes it with the same module the app uses, and writes the
 * snapshot the web bundle ships with. Re-run it whenever the district should
 * pick up new OSM edits — the map has no other source of buildings.
 *
 * Overpass filters by radius, the app by the working-area polygon, so the
 * default radius is whatever it takes to cover `workspaceArea.geo.json` from
 * the campaign address, plus a margin for buildings hanging over the border.
 * Re-run it after re-tracing the boundary: a wider polygon needs a wider
 * download.
 *
 *   node scripts/fetch-osm-buildings.mjs
 *   node scripts/fetch-osm-buildings.mjs --radius 4000 --out apps/web/public/data/elections/houses.json
 *   node scripts/fetch-osm-buildings.mjs --include-unaddressed
 *
 * Data © OpenStreetMap contributors, ODbL 1.0 — https://osm.org/copyright
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AREA_CENTER } from '../apps/web/src/features/elections/geo.js';
import { listStreetNames } from '../apps/web/src/features/elections/osmBuildings.js';
import { fetchHousesFromOverpass } from '../apps/web/src/features/elections/overpassClient.js';
import {
  WORKSPACE_AREA_NAME,
  filterHousesToWorkspace,
  workspaceCoverRadiusMeters,
} from '../apps/web/src/features/elections/workspaceArea.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT = 'apps/web/public/data/elections/houses.json';
/** Slack around the polygon, so a building straddling the border is complete. */
const COVER_MARGIN_METERS = 250;

/** Narrowest circle that still contains the traced boundary, plus the margin. */
function defaultRadiusMeters() {
  return workspaceCoverRadiusMeters() + COVER_MARGIN_METERS;
}

function parseArguments(argv) {
  const options = {
    radiusMeters: defaultRadiusMeters(),
    outputPath: DEFAULT_OUTPUT,
    requireAddress: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--radius') {
      options.radiusMeters = Number(argv[++index]);
    } else if (argument === '--out') {
      options.outputPath = argv[++index];
    } else if (argument === '--include-unaddressed') {
      options.requireAddress = false;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new Error(`Невідомий аргумент: ${argument}`);
    }
  }

  if (!Number.isFinite(options.radiusMeters) || options.radiusMeters <= 0) {
    throw new Error('--radius має бути додатним числом метрів.');
  }

  return options;
}

/** Coordinates are trimmed to ~1 cm — more digits only inflate the payload. */
function roundCoordinate(value) {
  return Number(value.toFixed(7));
}

/**
 * The shipped record drops everything the UI can recompute (`details` starts
 * empty on every load, and it is the local overlay that fills it in).
 */
function toSnapshotRecord(house) {
  const { details, ...rest } = house;

  return {
    ...rest,
    location: {
      lat: roundCoordinate(house.location.lat),
      lon: roundCoordinate(house.location.lon),
    },
    footprint: house.footprint.map((point) => ({
      lat: roundCoordinate(point.lat),
      lon: roundCoordinate(point.lon),
    })),
  };
}

function summarize(houses) {
  const byType = {};
  let withLevels = 0;

  for (const house of houses) {
    byType[house.type] = (byType[house.type] ?? 0) + 1;

    if (house.floors) {
      withLevels += 1;
    }
  }

  return { byType, withLevels };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));

  if (options.help) {
    console.log(
      [
        'Оновлює датасет будинків «Вибори» з OpenStreetMap.',
        '',
        `  --radius <м>            радіус завантаження (типово ${defaultRadiusMeters()}, ` +
          'щоб покрити полігон робочої території)',
        `  --out <шлях>            куди писати (типово ${DEFAULT_OUTPUT})`,
        '  --include-unaddressed   додати будівлі без addr:housenumber',
      ].join('\n'),
    );
    return;
  }

  console.log(
    `Завантаження будівель OSM: ${AREA_CENTER.address}, радіус ${options.radiusMeters} м…`,
  );

  const { houses, generatedAt } = await fetchHousesFromOverpass({
    center: AREA_CENTER,
    radiusMeters: options.radiusMeters,
    requireAddress: options.requireAddress,
    onProgress: ({ endpoint, round, attempts }) =>
      console.log(`  спроба ${round}/${attempts} → ${endpoint}`),
  });

  if (houses.length === 0) {
    throw new Error('Overpass повернув порожній набір — датасет не перезаписано.');
  }

  // The snapshot keeps the whole download: the polygon is applied when the app
  // loads it, so re-tracing a border does not mean re-downloading the district.
  const covered = filterHousesToWorkspace(houses);
  const streets = listStreetNames(houses);
  const snapshot = {
    version: 1,
    source: 'OpenStreetMap via Overpass API',
    license: 'ODbL 1.0 — https://www.openstreetmap.org/copyright',
    osmTimestamp: generatedAt,
    fetchedAt: new Date().toISOString(),
    area: {
      center: AREA_CENTER,
      downloadRadiusMeters: options.radiusMeters,
      workspace: WORKSPACE_AREA_NAME,
      label: `${AREA_CENTER.address}, ${AREA_CENTER.city}, ${AREA_CENTER.postalCode}`,
    },
    streets,
    houses: houses.map(toSnapshotRecord),
  };

  const outputPath = resolve(REPO_ROOT, options.outputPath);
  const serialized = `${JSON.stringify(snapshot)}\n`;

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized, 'utf8');

  const { byType, withLevels } = summarize(houses);

  console.log(`\nЗаписано ${outputPath}`);
  console.log(`  будинків:        ${houses.length}`);
  console.log(`  у межах зони:    ${covered.length} (${WORKSPACE_AREA_NAME})`);
  console.log(`  вулиць:          ${streets.length}`);
  console.log(`  з поверховістю:  ${withLevels}`);
  console.log(`  за типом:        ${JSON.stringify(byType)}`);
  console.log(`  розмір:          ${(serialized.length / 1024 / 1024).toFixed(2)} МБ`);
  console.log(`  зріз OSM:        ${generatedAt ?? 'невідомо'}`);
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
