/**
 * Data access for the "Вибори" module.
 *
 * This is the only file that knows the data is mocked. It already has the shape
 * the real client will have — async, abortable, one function per endpoint — so
 * swapping the mock generator for `fetch(...)` calls does not touch the hook,
 * the page or any component.
 *
 * Edits are persisted to localStorage as a details overlay keyed by house id,
 * which mirrors the `PATCH /houses/:id/details` the API will expose.
 */

import { AREA_CENTER, AREA_RADIUS_METERS } from './geo.js';
import { createEmptyDetails } from './electionsTypes.js';
import { createMockHouses, listStreetNames } from './mockHouses.js';

const OVERRIDES_STORAGE_KEY = 'avku-elections-details-v1';

/** Fake network latency, so loading and saving states are actually visible. */
const LOAD_LATENCY_MS = 700;
const SAVE_LATENCY_MS = 420;

/**
 * Append `?electionsMockError=1` to the URL to exercise the load-failure state
 * without touching any code.
 */
const MOCK_ERROR_PARAM = 'electionsMockError';

function delay(milliseconds, signal) {
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

function isMockErrorRequested() {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return new URLSearchParams(window.location.search).get(MOCK_ERROR_PARAM) === '1';
  } catch {
    return false;
  }
}

function readOverrides() {
  try {
    const stored = window.localStorage.getItem(OVERRIDES_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : null;

    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Private mode or a corrupted entry — fall back to the generated dataset.
    return {};
  }
}

function writeOverrides(overrides) {
  try {
    window.localStorage.setItem(OVERRIDES_STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Saving is best-effort in the demo; the in-memory state stays correct.
  }
}

/** Details are plain JSON, so a round-trip is the cheapest safe deep copy. */
function cloneDetails(details) {
  return JSON.parse(JSON.stringify(details));
}

function normalizeDetails(details) {
  return {
    ...createEmptyDetails(),
    ...cloneDetails(details ?? {}),
  };
}

/** Static metadata about the covered territory. */
export function getAreaMeta() {
  return {
    center: AREA_CENTER,
    radiusMeters: AREA_RADIUS_METERS,
    label: `${AREA_CENTER.address}, ${AREA_CENTER.city}, ${AREA_CENTER.postalCode}`,
  };
}

/**
 * `GET /elections/houses` — every house within the covered radius, with any
 * locally saved survey data already merged in.
 */
export async function fetchHouses({ signal } = {}) {
  await delay(LOAD_LATENCY_MS, signal);

  if (isMockErrorRequested()) {
    throw new Error('Не вдалося завантажити дані будинків із сервера.');
  }

  const overrides = readOverrides();
  const houses = createMockHouses().map((house) =>
    overrides[house.id]
      ? { ...house, details: normalizeDetails(overrides[house.id]) }
      : house,
  );

  return {
    houses,
    streets: listStreetNames(),
    area: getAreaMeta(),
  };
}

/** `PATCH /elections/houses/:id/details` — persists one house's survey data. */
export async function saveHouseDetails(houseId, details, { signal } = {}) {
  await delay(SAVE_LATENCY_MS, signal);

  const saved = {
    ...normalizeDetails(details),
    updatedAt: new Date().toISOString(),
  };

  const overrides = readOverrides();
  overrides[houseId] = saved;
  writeOverrides(overrides);

  return { houseId, details: saved };
}

/** Drops every locally saved edit and restores the generated demo dataset. */
export async function resetHouseDetails() {
  try {
    window.localStorage.removeItem(OVERRIDES_STORAGE_KEY);
  } catch {
    // Nothing to clean up when storage is unavailable.
  }

  return { cleared: true };
}
