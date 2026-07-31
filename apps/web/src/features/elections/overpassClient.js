/**
 * Thin client for the Overpass API — the query endpoint of OpenStreetMap.
 *
 * Overpass is a shared free service: instances go busy, rate-limit, or answer
 * with an HTML error page instead of JSON. The client therefore walks a list of
 * mirrors and retries, which is the difference between "the map is empty today"
 * and a dataset that refreshes reliably.
 *
 * Used by `scripts/fetch-osm-buildings.mjs` to build the shipped snapshot, and
 * by the browser only when someone explicitly asks for a live refresh.
 *
 * @see https://wiki.openstreetmap.org/wiki/Overpass_API
 */

import { AREA_CENTER, AREA_RADIUS_METERS } from './geo.js';
import { buildOverpassQuery, normalizeOsmBuildings } from './osmBuildings.js';

/** Public Overpass instances, tried in order. */
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
];

const RETRY_BASE_DELAY_MS = 15000;

/**
 * Overpass answers `406 Not Acceptable` to clients that do not identify
 * themselves, and its usage policy asks for a contact anyway. Browsers ignore
 * the header (it is on fetch's forbidden list), which is fine — there it is the
 * page's own origin that identifies the caller.
 */
const USER_AGENT = 'avku-internal/1.0 (elections district map; +https://internal.avku.org)';

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Запит скасовано', 'AbortError'));
      return;
    }

    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);

    function onAbort() {
      clearTimeout(timeoutId);
      reject(new DOMException('Запит скасовано', 'AbortError'));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A busy Overpass instance answers `200 text/html` with the error inside the
 * body, so the status code alone cannot be trusted.
 */
function extractOverpassError(body) {
  const match = /<strong[^>]*>Error<\/strong>:?(.*?)<\/p>/s.exec(body);

  return match ? match[1].replace(/<[^>]+>/g, '').trim() : null;
}

async function requestOnce(endpoint, query, signal) {
  const response = await fetch(endpoint, {
    method: 'POST',
    // The raw query as the body is the form Overpass documents, and `text/plain`
    // keeps it a CORS-simple request so the browser needs no preflight.
    headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'User-Agent': USER_AGENT },
    body: query,
    signal,
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `${endpoint} відповів ${response.status}: ${extractOverpassError(body) ?? response.statusText}`,
    );
  }

  const overpassError = extractOverpassError(body);

  if (overpassError) {
    throw new Error(`${endpoint}: ${overpassError}`);
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${endpoint} повернув відповідь, що не є JSON.`);
  }
}

/**
 * Runs an Overpass query, walking the mirror list and backing off between
 * rounds. `onProgress` reports every attempt so the snapshot script can log it.
 */
export async function runOverpassQuery(
  query,
  { endpoints = OVERPASS_ENDPOINTS, attempts = 3, signal, onProgress } = {},
) {
  const failures = [];

  for (let round = 0; round < attempts; round += 1) {
    for (const endpoint of endpoints) {
      try {
        onProgress?.({ endpoint, round: round + 1, attempts });

        return await requestOnce(endpoint, query, signal);
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw error;
        }

        failures.push(error.message);
      }
    }

    if (round < attempts - 1) {
      await wait(RETRY_BASE_DELAY_MS * 2 ** round, signal);
    }
  }

  throw new Error(
    `Overpass API недоступний після ${attempts} спроб:\n${failures.slice(-4).join('\n')}`,
  );
}

/**
 * Live house dataset straight from OpenStreetMap.
 *
 * `box` is the working area's bounding box plus its margin — the acquisition
 * area. `center` / `radiusMeters` remain as the legacy circular form; either
 * way the same resolved box filters the response.
 */
export async function fetchHousesFromOverpass({
  box,
  center = AREA_CENTER,
  radiusMeters = AREA_RADIUS_METERS,
  requireAddress = true,
  signal,
  onProgress,
  ...options
} = {}) {
  const query = buildOverpassQuery({ box, center, radiusMeters, requireAddress });
  const payload = await runOverpassQuery(query, { signal, onProgress, ...options });

  return {
    houses: normalizeOsmBuildings(payload.elements, {
      box,
      center,
      radiusMeters,
      requireAddress,
    }),
    generatedAt: payload.osm3s?.timestamp_osm_base ?? null,
  };
}
