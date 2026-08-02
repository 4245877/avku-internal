/**
 * Data access for the "Вибори" module.
 *
 * **The backend is the source of truth.** Houses, campaign state, people,
 * actions, issues, tasks and files live in `apps/api` and are shared by
 * everybody. Clearing a browser's site data no longer destroys anybody's work,
 * and two people looking at the same building see the same card.
 *
 * Two other sources remain, and neither of them is a fallback that could hide a
 * broken backend — each is selected explicitly at build time:
 *
 *   backend   (default) — `VITE_ELECTIONS_API_URL`, normally `/api/elections`.
 *   snapshot            — the OSM dataset shipped in `public/data/elections`,
 *                         for working on the map with no API running.
 *   overpass            — a live OpenStreetMap query, for checking the district
 *                         against fresh edits without regenerating anything.
 *
 * Whatever the source, the result is cut to the working-area polygon before it
 * leaves this module, and every load reports **coverage**: whether the dataset
 * actually reaches the territory it is being filtered against. That is the
 * difference between "there are no houses here" and "we never downloaded here",
 * and it is unchanged by this rewrite.
 *
 * The old `localStorage` overlay (`avku-elections-details-v1`) is no longer read
 * or written. It is not deleted either — see `legacyLocalData.js`, which
 * exports it and hands it to the import endpoint.
 */

import {
  boxCoversBox,
  boxFromCircle,
  boxShortfallMeters,
  distanceMeters,
  expandBox,
  ringAreaSquareMeters,
} from './geo.js';
import { AREA_CENTER } from './geo.js';
import {
  AREA_DOWNLOAD_MARGIN_METERS,
  filterHousesToWorkspace,
  getWorkspaceArea,
  getWorkspaceMeta,
  workspaceBoundingBox,
} from './workspaceArea.js';
import { clipRingToBox } from './polygonGeometry.js';
import { createEmptyCampaignState } from './electionsTypes.js';
import {
  DEFAULT_HEADQUARTERS_OSM_ID,
  computeHouseEstimate,
  listStreetNames,
} from './osmBuildings.js';
import { fetchHousesFromOverpass } from './overpassClient.js';
import { compareStreetNames } from './streetNames.js';

/** Where the shipped OSM snapshot lives, relative to the app origin. */
const SNAPSHOT_URL = `${import.meta.env.BASE_URL ?? '/'}data/elections/houses.json`.replace(
  /\/{2,}/g,
  '/',
);

/** `backend` | `snapshot` | `overpass` — see the module comment. */
const SOURCE = import.meta.env.VITE_ELECTIONS_SOURCE ?? 'backend';
const BACKEND_URL = (import.meta.env.VITE_ELECTIONS_API_URL ?? '/api/elections').replace(
  /\/$/,
  '',
);

/**
 * Which campaign the user is looking at. A preference, not data: the campaigns
 * themselves and everything in them live on the server, and this only remembers
 * which one this browser had open.
 */
const ACTIVE_CAMPAIGN_KEY = 'avku-elections-campaign-v1';

export function readActiveCampaignId() {
  try {
    return window.localStorage.getItem(ACTIVE_CAMPAIGN_KEY) || null;
  } catch {
    return null;
  }
}

export function writeActiveCampaignId(campaignId) {
  try {
    if (campaignId) {
      window.localStorage.setItem(ACTIVE_CAMPAIGN_KEY, campaignId);
    } else {
      window.localStorage.removeItem(ACTIVE_CAMPAIGN_KEY);
    }
  } catch {
    // A browser that refuses storage still works; it just forgets the choice.
  }
}

/**
 * The geometry version this browser saw last time.
 *
 * Not a cache of the outlines — the browser's own HTTP cache holds those, under
 * the versioned URL. This is only the URL, remembered so the next visit can ask
 * for the outlines *at the same time* as the houses instead of waiting to be
 * told which version to ask for. When it is still the current one the request
 * never leaves the machine and the shapes are on the map in the same frame as
 * the list; when it is stale the houses response says so and the right version
 * is fetched instead.
 */
const GEOMETRY_VERSION_KEY = 'avku-elections-geometry-v1';

export function readCachedGeometryVersion() {
  try {
    return window.localStorage.getItem(GEOMETRY_VERSION_KEY) || null;
  } catch {
    return null;
  }
}

export function writeCachedGeometryVersion(version) {
  try {
    if (version) {
      window.localStorage.setItem(GEOMETRY_VERSION_KEY, version);
    } else {
      window.localStorage.removeItem(GEOMETRY_VERSION_KEY);
    }
  } catch {
    // Same as above: a browser without storage simply pays one round trip.
  }
}

/**
 * Append `?electionsMockError=1` to the URL to exercise the load-failure state
 * without touching any code.
 */
const MOCK_ERROR_PARAM = 'electionsMockError';

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

/** Static metadata about the covered territory — the traced GeoJSON polygon. */
export function getAreaMeta() {
  return getWorkspaceMeta();
}

async function fetchJson(url, signal) {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });

  if (!response.ok) {
    throw new Error(`${url} відповів ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * One request against the elections API.
 *
 * Errors carry the server's own message where there is one: a 403 has to read
 * as "you do not have the rights for this", not as a generic failure the user
 * will retry forever.
 */
async function request(path, { method = 'GET', body, signal, headers } = {}) {
  const response = await fetch(`${BACKEND_URL}${path}`, {
    method,
    signal,
    headers: {
      Accept: 'application/json',
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error(payload?.error ?? `Запит відхилено (${response.status}).`);

    error.status = response.status;
    throw error;
  }

  return payload;
}

/** `?campaignId=…`, when one is selected. */
function campaignQuery(campaignId, extra = '') {
  const parts = [];

  if (campaignId) {
    parts.push(`campaignId=${encodeURIComponent(campaignId)}`);
  }

  if (extra) {
    parts.push(extra);
  }

  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

/**
 * A raw record from any source → the one house shape the UI works with.
 *
 * Three fields are computed here rather than stored anywhere:
 *
 *  • `estimate` — from the footprint, so a guess can never age into something
 *    indistinguishable from a measurement;
 *  • `distanceMeters` — from the *campaign's* headquarters, which is why the
 *    office address is no longer a constant in the bundle;
 *  • `isHeadquarters` — likewise from the campaign.
 */
function hydrateHouse(house, context = {}) {
  const campaign = context.campaign ?? null;
  const origin =
    campaign && Number.isFinite(campaign.hqLat) && Number.isFinite(campaign.hqLon)
      ? { lat: campaign.hqLat, lon: campaign.hqLon }
      : AREA_CENTER;

  const isHeadquarters = campaign?.hqHouseId
    ? campaign.hqHouseId === house.id
    : (house.isHeadquarters ??
      (house.osmType && house.osmId
        ? `${house.osmType}/${house.osmId}` === DEFAULT_HEADQUARTERS_OSM_ID
        : false));

  const hydrated = {
    ...house,
    campaign: { ...createEmptyCampaignState(), ...(house.campaign ?? {}) },
    precincts: house.precincts ?? [],
    quality: house.quality ?? [],
    people: house.people ?? [],
    contactsCount: house.contactsCount ?? 0,
    canSeeContacts: house.canSeeContacts ?? false,
    source: house.source ?? 'osm',
    isHeadquarters,
  };

  hydrated.estimate = house.estimate ?? computeHouseEstimate(hydrated);
  hydrated.distanceMeters = Number.isFinite(house.distanceMeters)
    ? house.distanceMeters
    : Math.round(distanceMeters(origin, hydrated.location));

  return hydrated;
}

/**
 * The patch of ground a dataset actually contains buildings for.
 *
 * Recorded explicitly by the current snapshot script; a snapshot written before
 * the switch to bounding boxes only records the circle it was downloaded as, so
 * that is converted. When neither is present the extent of the houses
 * themselves is the honest answer — it under-reports an area whose edges happen
 * to be unmapped, which errs towards offering a refresh rather than hiding one.
 */
function readDatasetBox(snapshot) {
  if (snapshot?.coverage?.box) {
    return snapshot.coverage.box;
  }

  const { center, radiusMeters, downloadRadiusMeters } = snapshot?.area ?? {};
  const radius = downloadRadiusMeters ?? radiusMeters;

  if (center && Number.isFinite(radius)) {
    return boxFromCircle(center, radius);
  }

  const houses = snapshot?.houses ?? [];

  if (houses.length === 0) {
    return null;
  }

  // Either wire shape: the snapshot and Overpass sources nest the coordinates
  // under `location`, the map payload carries them flat.
  return houses.reduce(
    (box, house) => {
      const lat = house.location ? house.location.lat : house.lat;
      const lon = house.location ? house.location.lon : house.lon;

      return {
        minLat: Math.min(box.minLat, lat),
        maxLat: Math.max(box.maxLat, lat),
        minLon: Math.min(box.minLon, lon),
        maxLon: Math.max(box.maxLon, lon),
      };
    },
    {
      minLat: Infinity,
      maxLat: -Infinity,
      minLon: Infinity,
      maxLon: -Infinity,
    },
  );
}

/**
 * Buildings downloaded live during this session, and the box they were asked
 * for.
 *
 * Without it the live refresh only survives until the next load: re-tracing the
 * boundary, retrying a failed request or reopening the page all go back to the
 * shipped snapshot, and the coverage banner returns to ask for a refresh that
 * has already been done. Holding the answer for the session means the warning
 * is raised once and stays answered — the CLI is still what makes it permanent
 * for everybody else.
 */
let sessionOsmDataset = null;

/** Drops the live dataset, so the next load goes back to the shipped one. */
export function forgetOsmDataset() {
  sessionOsmDataset = null;
}

/**
 * The live dataset, when it reaches the territory currently in force. A
 * boundary re-traced *inside* the box that was downloaded is still covered by
 * it; one traced outside is not, and falls back to the snapshot so the banner
 * can offer a refresh for the new ground.
 */
function readSessionOsmDataset() {
  if (!sessionOsmDataset || SOURCE === 'overpass') {
    return null;
  }

  if (!boxCoversBox(sessionOsmDataset.box, getWorkspaceArea().box)) {
    return null;
  }

  return {
    houses: sessionOsmDataset.houses,
    osmTimestamp: sessionOsmDataset.osmTimestamp,
    datasetBox: sessionOsmDataset.box,
    source: 'osm',
  };
}

async function loadDataset(signal, campaignId) {
  const session = readSessionOsmDataset();

  if (session) {
    return session;
  }

  if (SOURCE === 'overpass') {
    const box = workspaceBoundingBox();
    const { houses, generatedAt } = await fetchHousesFromOverpass({ box, signal });

    return { houses, osmTimestamp: generatedAt, datasetBox: box, source: 'osm' };
  }

  if (SOURCE === 'snapshot') {
    const snapshot = await fetchJson(SNAPSHOT_URL, signal);

    return {
      houses: snapshot.houses ?? [],
      osmTimestamp: snapshot.osmTimestamp ?? null,
      attribution: snapshot.license ?? null,
      datasetBox: readDatasetBox(snapshot),
      source: 'snapshot',
    };
  }

  const payload = await fetchJson(
    `${BACKEND_URL}/houses${campaignQuery(campaignId)}`,
    signal,
  );

  const streets = payload.streets ?? [];

  return {
    houses: (payload.houses ?? []).map((house) => expandMapHouse(house, streets)),
    osmTimestamp: payload.osmTimestamp ?? null,
    datasetBox: readDatasetBox(payload),
    campaign: payload.campaign ?? null,
    campaigns: payload.campaigns ?? [],
    viewer: payload.viewer ?? null,
    /*
     * The server cut the set to the working-area polygon, so this client must
     * not cut it again — it no longer receives the outlines the old test used,
     * and re-testing a rounded centre would drop houses on the border.
     */
    areaApplied: payload.areaApplied === true,
    outsideArea: payload.outsideArea ?? 0,
    geometryVersion: payload.geometryVersion ?? null,
    source: 'backend',
  };
}

/**
 * One row of the map payload → the house shape the rest of the module expects.
 *
 * The wire format is deliberately not this shape: streets are sent once and
 * referenced by index, and any field sitting at its default is left out
 * altogether. On a district nobody has canvassed yet that is most of the
 * record, so the saving is largest exactly when the payload is otherwise most
 * repetitive. Rebuilding it here keeps `houseUtils`, the results list and the
 * map layer working on the same objects they always did.
 *
 * `footprint` is absent on purpose — outlines arrive from `/houses/geometry`
 * under their own cache lifetime and are merged in by `useHousesData`.
 */
function expandMapHouse(house, streets) {
  const streetShort = streets[house.street] ?? '';
  const number = house.number ?? '';

  return {
    id: house.id,
    street: streetShort,
    streetShort,
    number,
    address: `${streetShort}, ${number}`,
    fullAddress: `${streetShort}, ${number}`,
    location: { lat: house.lat, lon: house.lon },
    footprint: null,
    footprintAreaSqm: house.area ?? null,
    type: house.type ?? 'other',
    name: house.name ?? null,
    floors: house.floors ?? null,
    entrances: house.entrances ?? null,
    apartments: house.apartments ?? null,
    residentsCount: house.residents ?? null,
    source: house.source ?? 'osm',
    quality: house.quality ?? [],
    contactsCount: house.contacts ?? 0,
    precincts: (house.precincts ?? []).map((precinctId, index) => ({
      precinctId,
      district: house.districts?.[index] ?? '',
    })),
    campaign: {
      ...createEmptyCampaignState(),
      stage: house.stage ?? 'not_started',
      priority: house.priority ?? 'medium',
      lastActionAt: house.lastActionAt ?? null,
      nextActionAt: house.nextActionAt ?? null,
      openIssuesCount: house.openIssues ?? 0,
      openTasksCount: house.openTasks ?? 0,
      overdueTasksCount: house.overdueTasks ?? 0,
      todayTasksCount: house.todayTasks ?? 0,
      assignees: (house.assignees ?? []).map((email) => ({ email })),
    },
  };
}

/**
 * Building outlines for the current dataset.
 *
 * Asked for by version, which is what makes the browser able to answer from its
 * own cache instead of coming back here: the map payload names the version it
 * belongs to, and as long as that does not change this request never leaves the
 * machine a second time.
 */
export async function fetchHouseGeometry({ signal, campaignId, version } = {}) {
  const payload = await fetchJson(
    `${BACKEND_URL}/houses/geometry${campaignQuery(
      campaignId,
      version ? `v=${encodeURIComponent(version)}` : '',
    )}`,
    signal,
  );

  return {
    version: payload.version ?? null,
    footprints: payload.footprints ?? {},
  };
}

/** `[lat, lon, lat, lon, …]` → the `{lat, lon}` points the map draws from. */
export function expandFootprint(flat) {
  if (!Array.isArray(flat) || flat.length < 6) {
    return null;
  }

  const ring = new Array(flat.length / 2);

  for (let index = 0; index < ring.length; index += 1) {
    ring[index] = { lat: flat[index * 2], lon: flat[index * 2 + 1] };
  }

  return ring;
}

/** The command that rebuilds the shipped dataset for the current boundary. */
export const REFRESH_DATASET_COMMAND = 'pnpm --filter @avku/web data:houses';

/**
 * Slack allowed when asking whether a dataset reaches the territory, in metres.
 *
 * The comparison is between a box derived one way (a snapshot's recorded
 * coverage, or a circle converted to a box) and a box derived another (the
 * polygon's extent, from coordinates rounded to six decimals). Those agree to
 * within a metre or two, and an exact test turns that last metre into a
 * "dataset does not cover the territory" banner on the shipped configuration
 * itself. A margin far smaller than a city block, and far smaller than the
 * download margin, makes the answer mean what it says.
 */
const COVERAGE_TOLERANCE_METERS = 25;

/**
 * Ground the dataset misses that is too small to hide a building, in m².
 *
 * The bounding-box test is exact — a polygon lies inside a box exactly when its
 * own box does — so any overhang at all is real missing ground. It is not
 * always *meaningful* missing ground: one vertex of a hand-traced outline
 * landing thirty metres past the downloaded box carves off a triangle of a few
 * hundred square metres, and warning that the dataset "covers the border only
 * partially" because of it is how a true warning becomes a nuisance. 400 m² is
 * the footprint of a detached house — below it there is provably nothing to
 * download.
 */
const MIN_MISSING_AREA_SQM = 400;

/**
 * Whether the dataset reaches the territory it is about to be filtered against,
 * and by how much it falls short when it does not.
 *
 * `isCovered: false` is the state that used to present itself as an empty map:
 * the boundary was re-traced onto ground the snapshot never covered, so the
 * polygon is correct, the filter is correct, and there is simply nothing there
 * to find. Saying so — and offering the live refresh — is the whole point.
 *
 * The measurements beside it are what let the banner be specific instead of
 * alarming: `coveredShare` is the fraction of the territory's own ground the
 * dataset reaches (measured on the polygon, not on its bounding box, so a
 * diagonal district is not blamed for its empty corners), `missingAreaSqm` is
 * the rest of it, and `gapMeters` is how far past the data the border reaches
 * at its worst point.
 */
function describeCoverage({ datasetBox, houseCount, source = 'snapshot' }) {
  const area = getWorkspaceArea();
  const areaBox = area.box;
  const totalSqm = ringAreaSquareMeters(area.outerRing);

  const shared = {
    areaBox,
    datasetBox: datasetBox ?? null,
    marginMeters: AREA_DOWNLOAD_MARGIN_METERS,
    houseCount,
    source,
    command: REFRESH_DATASET_COMMAND,
  };

  if (!datasetBox) {
    return {
      ...shared,
      isCovered: false,
      coveredShare: 0,
      missingAreaSqm: totalSqm,
      gapMeters: null,
    };
  }

  // The tolerance is spent once, here: every number below is measured against
  // the same reach, so the share and the gap can never disagree with the yes/no.
  const reach = expandBox(datasetBox, COVERAGE_TOLERANCE_METERS);
  const covered = clipRingToBox(area.outerRing, reach);
  const coveredSqm = covered.length >= 3 ? ringAreaSquareMeters(covered) : 0;
  const missingAreaSqm = Math.max(0, totalSqm - coveredSqm);

  return {
    ...shared,
    isCovered: boxCoversBox(reach, areaBox) || missingAreaSqm < MIN_MISSING_AREA_SQM,
    coveredShare: totalSqm > 0 ? Math.min(1, coveredSqm / totalSqm) : 1,
    missingAreaSqm,
    gapMeters: Math.round(boxShortfallMeters(reach, areaBox)),
  };
}

/**
 * `GET /api/elections/houses` — every building the working-area polygon covers
 * that the caller is allowed to see, with this campaign's state merged in.
 *
 * An empty result is a state, not a failure: the map, its tiles and the traced
 * border still have to be drawn, and only a genuinely broken request (no
 * dataset at all, HTTP error) rejects.
 */
export async function fetchHouses({ signal, campaignId } = {}) {
  if (isMockErrorRequested()) {
    throw new Error('Не вдалося завантажити дані будинків із сервера.');
  }

  const dataset = await loadDataset(signal, campaignId);

  if (dataset.houses.length === 0 && SOURCE === 'snapshot') {
    throw new Error(
      `Набір будинків порожній. Оновіть його командою \`${REFRESH_DATASET_COMMAND}\`.`,
    );
  }

  /*
   * The download is a box wide enough to contain the polygon; the polygon
   * itself is what the module works with. Filtering here — and not in the map —
   * is what keeps the list, the filters, the counters and the outlines talking
   * about the same set of buildings.
   *
   * The backend now does this itself when it has a stored boundary, and says so
   * with `areaApplied`. That is not a micro-optimisation: on the live territory
   * the polygon rejects about four houses in five, and every one of them used
   * to be queried, serialised, sent, parsed and then dropped here. The snapshot
   * and Overpass sources still arrive as a raw box and are cut below.
   */
  const covered = dataset.areaApplied
    ? dataset.houses
    : filterHousesToWorkspace(dataset.houses);
  const houses = covered.map((house) => hydrateHouse(house, { campaign: dataset.campaign }));

  return {
    ...dataset,
    area: getAreaMeta(),
    coverage: describeCoverage({
      datasetBox: dataset.datasetBox,
      houseCount: covered.length,
      source: dataset.source,
    }),
    streets: listStreetNames(covered).sort(compareStreetNames),
    houses,
  };
}

/**
 * Downloads buildings for the current boundary straight from OpenStreetMap.
 *
 * This is the answer to "the shipped snapshot does not reach my new district"
 * that does not require a terminal: it queries Overpass for the polygon's own
 * bounding box. The result is kept for the rest of the session — including
 * across boundary changes that stay inside the box it was downloaded for, which
 * is what stops the coverage banner from asking again for what it just got.
 * Committing a refreshed `houses.json` is what makes it everybody's, and that
 * is still the CLI's job.
 *
 * `attempts` and `onProgress` come from the Overpass client: a browser caller
 * has somebody waiting on it, so it can afford fewer retries than the snapshot
 * script and has to be able to say which attempt is running.
 */
export async function fetchHousesFromOsm({ signal, attempts, onProgress, campaign } = {}) {
  const box = workspaceBoundingBox();
  const { houses, generatedAt } = await fetchHousesFromOverpass({
    box,
    signal,
    attempts,
    onProgress,
  });

  sessionOsmDataset = { houses, box, osmTimestamp: generatedAt };

  const covered = filterHousesToWorkspace(houses);

  return {
    houses: covered.map((house) => hydrateHouse(house, { campaign })),
    osmTimestamp: generatedAt,
    area: getAreaMeta(),
    coverage: describeCoverage({
      datasetBox: box,
      houseCount: covered.length,
      source: 'osm',
    }),
    streets: listStreetNames(covered).sort(compareStreetNames),
  };
}

/* ------------------------------------------------------------------ *
 * Reference data, identity and campaigns
 * ------------------------------------------------------------------ */

export function fetchReferenceData({ signal } = {}) {
  return request('/reference', { signal });
}

export function fetchViewer({ signal } = {}) {
  return request('/me', { signal });
}

export function fetchCampaigns({ signal } = {}) {
  return request('/campaigns', { signal });
}

export function createCampaign(payload, { signal } = {}) {
  return request('/campaigns', { method: 'POST', body: payload, signal });
}

export function archiveCampaign(campaignId, { signal } = {}) {
  return request(`/campaigns/${encodeURIComponent(campaignId)}/archive`, {
    method: 'POST',
    signal,
  });
}

export function fetchPrecincts({ signal } = {}) {
  return request('/precincts', { signal });
}

/* ------------------------------------------------------------------ *
 * One house
 * ------------------------------------------------------------------ */

/** `PATCH /houses/:id` — the building's permanent attributes. */
export async function saveHouseAttributes(houseId, patch, { campaignId, signal } = {}) {
  const house = await request(
    `/houses/${encodeURIComponent(houseId)}${campaignQuery(campaignId)}`,
    { method: 'PATCH', body: patch, signal },
  );

  return hydrateHouse(house);
}

/** `PATCH /houses/:id/state` — stage, priority and the next planned action. */
export async function saveHouseState(houseId, patch, { campaignId, signal } = {}) {
  const house = await request(
    `/houses/${encodeURIComponent(houseId)}/state${campaignQuery(campaignId)}`,
    { method: 'PATCH', body: patch, signal },
  );

  return hydrateHouse(house);
}

export function fetchHouse(houseId, { campaignId, signal } = {}) {
  return request(
    `/houses/${encodeURIComponent(houseId)}${campaignQuery(campaignId)}`,
    { signal },
  ).then((house) => hydrateHouse(house));
}

export function fetchHousePeople(houseId, { campaignId, signal } = {}) {
  return request(
    `/houses/${encodeURIComponent(houseId)}/people${campaignQuery(campaignId)}`,
    { signal },
  );
}

export function createHousePerson(houseId, payload, { campaignId, signal } = {}) {
  return request(
    `/houses/${encodeURIComponent(houseId)}/people${campaignQuery(campaignId)}`,
    { method: 'POST', body: payload, signal },
  );
}

export function updatePerson(personId, payload, { signal } = {}) {
  return request(`/people/${encodeURIComponent(personId)}`, {
    method: 'PATCH',
    body: payload,
    signal,
  });
}

export function fetchHouseActions(houseId, { campaignId, signal } = {}) {
  return request(
    `/houses/${encodeURIComponent(houseId)}/actions${campaignQuery(campaignId)}`,
    { signal },
  );
}

export function fetchHouseIssues(houseId, { campaignId, signal } = {}) {
  return request(
    `/houses/${encodeURIComponent(houseId)}/issues${campaignQuery(campaignId)}`,
    { signal },
  );
}

export function fetchHouseTasks(houseId, { campaignId, signal } = {}) {
  return request(
    `/houses/${encodeURIComponent(houseId)}/tasks${campaignQuery(campaignId)}`,
    { signal },
  );
}

export function fetchHouseAttachments(houseId, { campaignId, signal } = {}) {
  return request(
    `/houses/${encodeURIComponent(houseId)}/attachments${campaignQuery(campaignId)}`,
    { signal },
  );
}

export function fetchHouseHistory(houseId, { campaignId, signal } = {}) {
  return request(
    `/houses/${encodeURIComponent(houseId)}/history${campaignQuery(campaignId)}`,
    { signal },
  );
}

/* ------------------------------------------------------------------ *
 * Work records
 * ------------------------------------------------------------------ */

export function createAction(payload, { campaignId, signal } = {}) {
  return request(`/actions${campaignQuery(campaignId)}`, {
    method: 'POST',
    body: payload,
    signal,
  });
}

export function createIssue(payload, { campaignId, signal } = {}) {
  return request(`/issues${campaignQuery(campaignId)}`, {
    method: 'POST',
    body: payload,
    signal,
  });
}

export function updateIssue(issueId, payload, { campaignId, signal } = {}) {
  return request(`/issues/${encodeURIComponent(issueId)}${campaignQuery(campaignId)}`, {
    method: 'PATCH',
    body: payload,
    signal,
  });
}

export function createTask(payload, { campaignId, signal } = {}) {
  return request(`/tasks${campaignQuery(campaignId)}`, {
    method: 'POST',
    body: payload,
    signal,
  });
}

export function updateTask(taskId, payload, { campaignId, signal } = {}) {
  return request(`/tasks/${encodeURIComponent(taskId)}${campaignQuery(campaignId)}`, {
    method: 'PATCH',
    body: payload,
    signal,
  });
}

export function fetchTasks({ campaignId, scope, assignee, signal } = {}) {
  const extra = [
    scope ? `scope=${encodeURIComponent(scope)}` : '',
    assignee ? `assignee=${encodeURIComponent(assignee)}` : '',
  ]
    .filter(Boolean)
    .join('&');

  return request(`/tasks${campaignQuery(campaignId, extra)}`, { signal });
}

export function fetchEvents({ campaignId, signal } = {}) {
  return request(`/events${campaignQuery(campaignId)}`, { signal });
}

export function createEvent(payload, { campaignId, signal } = {}) {
  return request(`/events${campaignQuery(campaignId)}`, {
    method: 'POST',
    body: payload,
    signal,
  });
}

export function createShift(payload, { campaignId, signal } = {}) {
  return request(`/shifts${campaignQuery(campaignId)}`, {
    method: 'POST',
    body: payload,
    signal,
  });
}

export function fetchMaterialIssues({ campaignId, signal } = {}) {
  return request(`/materials${campaignQuery(campaignId)}`, { signal });
}

export function createMaterialIssue(payload, { campaignId, signal } = {}) {
  return request(`/materials${campaignQuery(campaignId)}`, {
    method: 'POST',
    body: payload,
    signal,
  });
}

/**
 * Uploads a photo or document.
 *
 * `FormData` rather than JSON, so a phone can hand over a camera capture
 * directly. The server generates the stored file name — the uploaded one is
 * kept only for display.
 */
export function uploadAttachment({ file, ownerType, ownerId, houseId, kind, note }, options = {}) {
  const form = new FormData();

  form.append('file', file, file.name);
  form.append('ownerType', ownerType);
  form.append('ownerId', ownerId);
  form.append('fileName', file.name);

  if (houseId) {
    form.append('houseId', houseId);
  }

  if (kind) {
    form.append('kind', kind);
  }

  if (note) {
    form.append('note', note);
  }

  return request(`/attachments${campaignQuery(options.campaignId)}`, {
    method: 'POST',
    body: form,
    signal: options.signal,
  });
}

/* ------------------------------------------------------------------ *
 * Assignments, search and bulk work
 * ------------------------------------------------------------------ */

export function fetchAssignments({ campaignId, signal } = {}) {
  return request(`/assignments${campaignQuery(campaignId)}`, { signal });
}

export function createAssignment(payload, { campaignId, signal } = {}) {
  return request(`/assignments${campaignQuery(campaignId)}`, {
    method: 'POST',
    body: payload,
    signal,
  });
}

export function endAssignment(assignmentId, { campaignId, signal } = {}) {
  return request(
    `/assignments/${encodeURIComponent(assignmentId)}${campaignQuery(campaignId)}`,
    { method: 'DELETE', signal },
  );
}

/** Server-side contact search, scoped to houses the caller may already see. */
export function searchContacts(query, { campaignId, signal } = {}) {
  return request(
    `/search${campaignQuery(campaignId, `q=${encodeURIComponent(query)}`)}`,
    { signal },
  );
}

export function previewBulkAssignment(houseIds, { campaignId, signal } = {}) {
  return request(`/bulk/preview${campaignQuery(campaignId)}`, {
    method: 'POST',
    body: { houseIds },
    signal,
  });
}

/**
 * Applies a bulk assignment. `confirm: true` is mandatory server-side, and is
 * set here only because the caller is the confirmation dialog itself.
 */
export function applyBulkAssignment(payload, { campaignId, signal } = {}) {
  return request(`/bulk/assign${campaignQuery(campaignId)}`, {
    method: 'POST',
    body: { ...payload, confirm: true },
    signal,
  });
}

export function fetchDuplicateHouses({ signal } = {}) {
  return request('/duplicates', { signal });
}

export function mergeHouses({ keepId, mergeId }, { signal } = {}) {
  return request('/merge', {
    method: 'POST',
    body: { keepId, mergeId, confirm: true },
    signal,
  });
}

/* ------------------------------------------------------------------ *
 * Import and export
 * ------------------------------------------------------------------ */

export function createImportBatch(payload, { campaignId, signal } = {}) {
  return request(`/import${campaignQuery(campaignId)}`, {
    method: 'POST',
    body: payload,
    signal,
  });
}

export function fetchImportBatches({ signal } = {}) {
  return request('/import', { signal });
}

export function fetchImportBatch(batchId, { signal } = {}) {
  return request(`/import/${encodeURIComponent(batchId)}`, { signal });
}

export function setImportDecisions(batchId, decisions, { signal } = {}) {
  return request(`/import/${encodeURIComponent(batchId)}/decisions`, {
    method: 'POST',
    body: { decisions },
    signal,
  });
}

export function applyImportBatch(batchId, { campaignId, signal } = {}) {
  return request(`/import/${encodeURIComponent(batchId)}/apply${campaignQuery(campaignId)}`, {
    method: 'POST',
    signal,
  });
}

export function rollbackImportBatch(batchId, { signal } = {}) {
  return request(`/import/${encodeURIComponent(batchId)}/rollback`, {
    method: 'POST',
    signal,
  });
}

/**
 * The download URL for an export.
 *
 * `scope: 'full'` is the only way personal data leaves the system, it needs the
 * manager role, and the server records every call — so this is a plain link
 * rather than a fetch: the browser's own download dialog is part of making the
 * action deliberate.
 */
export function buildExportUrl({ campaignId, scope = 'operational', reason = '' } = {}) {
  const extra = [
    scope === 'full' ? 'scope=full' : '',
    reason ? `reason=${encodeURIComponent(reason)}` : '',
  ]
    .filter(Boolean)
    .join('&');

  return `${BACKEND_URL}/export${campaignQuery(campaignId, extra)}`;
}

export function fetchChangeLog({ campaignId, entityId, limit, signal } = {}) {
  const extra = [
    entityId ? `entityId=${encodeURIComponent(entityId)}` : '',
    limit ? `limit=${limit}` : '',
  ]
    .filter(Boolean)
    .join('&');

  return request(`/history${campaignQuery(campaignId, extra)}`, { signal });
}

/** True when this build talks to the API rather than to a local dataset. */
export const IS_BACKEND_SOURCE = SOURCE === 'backend';
export const ELECTIONS_SOURCE = SOURCE;
