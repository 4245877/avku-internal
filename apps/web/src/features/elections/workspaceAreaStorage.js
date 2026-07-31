/**
 * Where a traced working-area boundary is kept.
 *
 * A browser cannot write `workspaceArea.geo.json` — it is a file in the
 * repository — so "Зберегти" used to mean nothing more durable than a
 * `localStorage` entry in one browser profile. That is the difference between a
 * boundary and a note to self: the snapshot script could not see it, a second
 * canvasser could not see it, and a cleared profile lost it.
 *
 * So there are two tiers, and they are not the same thing:
 *
 *   server (`/api/elections/area`) — the permanent source. One boundary for the
 *     whole team, readable by `scripts/fetch-osm-buildings.mjs`, survives any
 *     browser. This is what «Зберегти межу» writes.
 *   local  (`localStorage`)        — a cache and an offline fallback. It lets
 *     the page open on the right territory before the server answers, and keeps
 *     a boundary usable when the API is down. Never the source of truth.
 *
 * `getWorkspaceArea()` is synchronous because the map, the mask and the filter
 * all need a territory on the very first render. So the cache is read
 * synchronously at import and the server is reconciled right after — see
 * `hydrateWorkspaceArea()` in `workspaceArea.js`.
 */

/** Where the cached copy of the boundary lives. */
export const AREA_STORAGE_KEY = 'avku-elections-area-v1';

/**
 * Resolved on demand rather than at import: this module is loaded by
 * `scripts/fetch-osm-buildings.mjs` under plain Node, where `import.meta.env`
 * does not exist at all. Vite substitutes the whole object at build time, so
 * reading it through a local binding keeps both environments working.
 */
export function areaEndpoint() {
  const env = import.meta.env;
  const base = (
    env?.VITE_ELECTIONS_API_URL ||
    env?.VITE_API_URL ||
    '/api'
  ).replace(/\/$/, '');

  return `${base}/elections/area`;
}

/** How long the boundary request may hang before the cache wins instead. */
const REQUEST_TIMEOUT_MS = 8000;

function hasStorage() {
  return typeof window !== 'undefined' && Boolean(window.localStorage);
}

/** The cached boundary document, or `null` when there is none or it is junk. */
export function readCachedArea() {
  if (!hasStorage()) {
    return null;
  }

  try {
    const stored = window.localStorage.getItem(AREA_STORAGE_KEY);

    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

export function writeCachedArea(document) {
  if (!hasStorage()) {
    return false;
  }

  try {
    window.localStorage.setItem(AREA_STORAGE_KEY, JSON.stringify(document));

    return true;
  } catch {
    // Private mode or quota: the boundary still applies for this session.
    return false;
  }
}

export function clearCachedArea() {
  if (!hasStorage()) {
    return;
  }

  try {
    window.localStorage.removeItem(AREA_STORAGE_KEY);
  } catch {
    // Nothing to clean up when storage is unavailable.
  }
}

/**
 * A request that gives up rather than leaving the page waiting on a hung API.
 * The caller always has the cache to fall back on, so a timeout is a normal
 * outcome here and not an error worth propagating.
 */
async function request(method, body, signal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();

  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    return await fetch(areaEndpoint(), {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function readError(response) {
  try {
    const payload = await response.json();

    return typeof payload?.error === 'string' ? payload.error : null;
  } catch {
    return null;
  }
}

/**
 * The boundary the whole team shares.
 *
 * `{ document: null }` means the server is reachable and holds no boundary —
 * which is a real answer: it says the shipped file is the current territory and
 * a stale local cache should be dropped. `{ isReachable: false }` means we
 * learned nothing and the cache must be left alone.
 */
export async function fetchRemoteArea({ signal } = {}) {
  try {
    const response = await request('GET', undefined, signal);

    if (response.status === 404) {
      return { isReachable: true, document: null };
    }

    if (!response.ok) {
      return { isReachable: false, document: null, error: await readError(response) };
    }

    const payload = await response.json();

    return { isReachable: true, document: payload?.area ?? null };
  } catch (error) {
    if (error?.name === 'AbortError' && signal?.aborted) {
      throw error;
    }

    return { isReachable: false, document: null, error: error?.message ?? null };
  }
}

/** Makes a traced boundary the permanent one. */
export async function saveRemoteArea(document, { signal } = {}) {
  try {
    const response = await request('PUT', { area: document }, signal);

    if (!response.ok) {
      return {
        isSaved: false,
        error: (await readError(response)) ?? `Сервер відповів ${response.status}.`,
      };
    }

    return { isSaved: true };
  } catch (error) {
    if (error?.name === 'AbortError' && signal?.aborted) {
      throw error;
    }

    return { isSaved: false, error: error?.message ?? 'Сервер недоступний.' };
  }
}

/** Drops the shared boundary, so the shipped file is the territory again. */
export async function deleteRemoteArea({ signal } = {}) {
  try {
    const response = await request('DELETE', undefined, signal);

    if (!response.ok && response.status !== 404) {
      return {
        isSaved: false,
        error: (await readError(response)) ?? `Сервер відповів ${response.status}.`,
      };
    }

    return { isSaved: true };
  } catch (error) {
    if (error?.name === 'AbortError' && signal?.aborted) {
      throw error;
    }

    return { isSaved: false, error: error?.message ?? 'Сервер недоступний.' };
  }
}
