#!/usr/bin/env node
/**
 * Builds the "Вибори" house dataset from OpenStreetMap.
 *
 * Downloads every mapped building for the working territory through the
 * Overpass API, normalizes it with the same module the app uses, and writes the
 * snapshot the web bundle ships with. Re-run it whenever the district should
 * pick up new OSM edits — the map has no other source of buildings.
 *
 * **Which territory?** Whichever boundary is actually in force. In order:
 *
 *   1. `--area <file>`   — an exported `workspaceArea.geo.json`;
 *   2. the API           — the boundary saved from «Редагувати межу», which is
 *                          the one users are looking at (`--no-server` skips it,
 *                          `--api <url>` points elsewhere);
 *   3. the shipped file  — `workspaceArea.geo.json` in the repository.
 *
 * That order is the whole point: re-tracing the boundary in the browser used to
 * leave this script downloading the *old* district, so the new territory stayed
 * empty however often the dataset was refreshed.
 *
 * The download area is the polygon's bounding box plus a margin, not a circle
 * around a fixed address — a circle cannot follow a boundary drawn somewhere
 * else on the map without growing to many times the area it needs to cover.
 *
 *   node scripts/fetch-osm-buildings.mjs
 *   node scripts/fetch-osm-buildings.mjs --area ~/Downloads/workspaceArea.geo.json
 *   node scripts/fetch-osm-buildings.mjs --margin 400 --include-unaddressed
 *
 * Data © OpenStreetMap contributors, ODbL 1.0 — https://osm.org/copyright
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AREA_CENTER, formatBoxForOverpass } from '../apps/web/src/features/elections/geo.js';
import { listStreetNames } from '../apps/web/src/features/elections/osmBuildings.js';
import { fetchHousesFromOverpass } from '../apps/web/src/features/elections/overpassClient.js';
import {
  AREA_DOWNLOAD_MARGIN_METERS,
  SHIPPED_WORKSPACE_AREA,
  applyWorkspaceAreaDocument,
  filterHousesToWorkspace,
  getWorkspaceArea,
  workspaceBoundingBox,
} from '../apps/web/src/features/elections/workspaceArea.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT = 'apps/web/public/data/elections/houses.json';
const DEFAULT_API_URL = process.env.AVKU_API_URL ?? 'http://localhost:3001/api';

function parseArguments(argv) {
  const options = {
    marginMeters: AREA_DOWNLOAD_MARGIN_METERS,
    outputPath: DEFAULT_OUTPUT,
    requireAddress: true,
    areaPath: null,
    apiUrl: DEFAULT_API_URL,
    useServer: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--margin') {
      options.marginMeters = Number(argv[++index]);
    } else if (argument === '--out') {
      options.outputPath = argv[++index];
    } else if (argument === '--area') {
      options.areaPath = argv[++index];
    } else if (argument === '--api') {
      options.apiUrl = argv[++index];
    } else if (argument === '--no-server') {
      options.useServer = false;
    } else if (argument === '--include-unaddressed') {
      options.requireAddress = false;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new Error(`Невідомий аргумент: ${argument}`);
    }
  }

  if (!Number.isFinite(options.marginMeters) || options.marginMeters < 0) {
    throw new Error('--margin має бути невідʼємним числом метрів.');
  }

  return options;
}

/** The boundary saved from the editor, if the API is up and holds one. */
async function readServerArea(apiUrl) {
  const endpoint = `${apiUrl.replace(/\/$/, '')}/elections/area`;

  try {
    const response = await fetch(endpoint, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      console.warn(`  ! ${endpoint} відповів ${response.status} — беремо межу з репозиторію`);
      return null;
    }

    return (await response.json())?.area ?? null;
  } catch (error) {
    console.warn(`  ! ${endpoint} недоступний (${error.message}) — беремо межу з репозиторію`);
    return null;
  }
}

/**
 * Puts the boundary that is actually in force into the workspace store, so
 * every downstream helper — the bounding box, the filter, the reported name —
 * describes the same territory.
 */
async function resolveWorkspaceArea(options) {
  if (options.areaPath) {
    const document = JSON.parse(await readFile(resolve(REPO_ROOT, options.areaPath), 'utf8'));

    return { area: applyWorkspaceAreaDocument(document), source: options.areaPath };
  }

  if (options.useServer) {
    const document = await readServerArea(options.apiUrl);

    if (document) {
      return { area: applyWorkspaceAreaDocument(document), source: options.apiUrl };
    }
  }

  return { area: getWorkspaceArea(), source: 'workspaceArea.geo.json' };
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
        'Оновлює датасет будинків «Вибори» з OpenStreetMap за чинною межею території.',
        '',
        `  --margin <м>            запас навколо полігона (типово ${AREA_DOWNLOAD_MARGIN_METERS})`,
        `  --out <шлях>            куди писати (типово ${DEFAULT_OUTPUT})`,
        '  --area <файл>           узяти межу з експортованого GeoJSON',
        `  --api <url>             звідки читати збережену межу (типово ${DEFAULT_API_URL})`,
        '  --no-server             не питати API, узяти межу з репозиторію',
        '  --include-unaddressed   додати будівлі без addr:housenumber',
      ].join('\n'),
    );
    return;
  }

  const { area, source } = await resolveWorkspaceArea(options);
  const box = workspaceBoundingBox({ marginMeters: options.marginMeters });

  console.log(`Межа території: «${area.name}» (${source}), вершин: ${area.vertexCount}`);
  console.log(
    `Завантаження будівель OSM у межах ${formatBoxForOverpass(box)} ` +
      `(запас ${options.marginMeters} м)…`,
  );

  const { houses, generatedAt } = await fetchHousesFromOverpass({
    box,
    requireAddress: options.requireAddress,
    onProgress: ({ endpoint, round, attempts }) =>
      console.log(`  спроба ${round}/${attempts} → ${endpoint}`),
  });

  if (houses.length === 0) {
    throw new Error('Overpass повернув порожній набір — датасет не перезаписано.');
  }

  // The snapshot keeps the whole download: the polygon is applied when the app
  // loads it, so a small re-trace inside the covered box does not mean
  // re-downloading the district. `coverage.box` is what lets the app tell a
  // genuinely empty territory from one it has no data for at all.
  const covered = filterHousesToWorkspace(houses);
  const streets = listStreetNames(houses);
  const snapshot = {
    version: 2,
    source: 'OpenStreetMap via Overpass API',
    license: 'ODbL 1.0 — https://www.openstreetmap.org/copyright',
    osmTimestamp: generatedAt,
    fetchedAt: new Date().toISOString(),
    coverage: {
      box,
      marginMeters: options.marginMeters,
      requireAddress: options.requireAddress,
    },
    area: {
      center: AREA_CENTER,
      workspace: area.name,
      workspaceSource: source,
      isCustomWorkspace: area.isCustom,
      bounds: area.bounds,
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
  console.log(`  у межах зони:    ${covered.length} (${area.name})`);
  console.log(`  вулиць:          ${streets.length}`);
  console.log(`  з поверховістю:  ${withLevels}`);
  console.log(`  за типом:        ${JSON.stringify(byType)}`);
  console.log(`  розмір:          ${(serialized.length / 1024 / 1024).toFixed(2)} МБ`);
  console.log(`  зріз OSM:        ${generatedAt ?? 'невідомо'}`);

  if (covered.length === 0) {
    console.warn(
      '\n! Жоден завантажений будинок не потрапляє в межі території. ' +
        'Перевірте, що межа обведена там, де є адресні будівлі OSM.',
    );
  }

  if (area === SHIPPED_WORKSPACE_AREA && options.useServer && !options.areaPath) {
    console.log(
      '\nПідказка: межу взято з репозиторію. Якщо в браузері збережено іншу межу, ' +
        'запустіть API або передайте --area з експортованим GeoJSON.',
    );
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
