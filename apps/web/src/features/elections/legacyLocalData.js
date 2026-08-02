/**
 * The old browser-only survey data, and how to get it out safely.
 *
 * Before the backend existed, everything anybody entered about a house lived in
 * one `localStorage` key in one browser profile: invisible to colleagues, never
 * backed up, and erased along with the browser's site data. For some houses
 * that entry is still the **only** copy of real field work.
 *
 * So this module does exactly two things and nothing else:
 *
 *  • reads the key and packages it as a download, so the work can be saved
 *    before anything else happens;
 *  • reports whether the key is present and how much is in it, so the UI can
 *    ask for the export rather than hoping somebody remembers.
 *
 * It deliberately does **not** delete the key. Removing the last copy of the
 * data as a side effect of a migration is precisely the failure this exists to
 * prevent — the entry is cleared only when a person asks for it, and only after
 * the server has confirmed the import.
 */

export const LEGACY_DETAILS_KEY = 'avku-elections-details-v1';

/** Keys that are pure cache and are not worth exporting. */
export const LEGACY_CACHE_KEYS = ['avku-elections-area-v1', 'avku-elections-area-draft-v1'];

/** Marks a browser whose legacy data has already been handed to the server. */
const MIGRATION_FLAG_KEY = 'avku-elections-legacy-migrated-v1';

function readRawEntries() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return {};
  }

  try {
    const stored = window.localStorage.getItem(LEGACY_DETAILS_KEY);
    const parsed = stored ? JSON.parse(stored) : null;

    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A corrupted entry is still worth reporting as "something is here";
    // the raw text goes into the export untouched below.
    return {};
  }
}

function readRawText() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }

  try {
    return window.localStorage.getItem(LEGACY_DETAILS_KEY);
  } catch {
    return null;
  }
}

/**
 * What is in this browser: how many houses carry data, and how many contact and
 * resident rows they hold between them.
 *
 * The counts are what makes "did the migration actually move everything?" a
 * checkable question rather than an assumption — compare them with the import
 * report, not with whether the new UI opened.
 */
export function inspectLegacyData() {
  const raw = readRawText();
  const entries = readRawEntries();
  const houseIds = Object.keys(entries);

  let contactCount = 0;
  let residentCount = 0;
  let notesCount = 0;

  for (const details of Object.values(entries)) {
    contactCount += Array.isArray(details?.contacts) ? details.contacts.length : 0;
    residentCount += Array.isArray(details?.residents) ? details.residents.length : 0;
    notesCount += String(details?.notes ?? '').trim() ? 1 : 0;
  }

  return {
    isPresent: raw !== null,
    isReadable: houseIds.length > 0 || raw === null || raw === '{}',
    houseCount: houseIds.length,
    contactCount,
    residentCount,
    notesCount,
    byteSize: raw ? raw.length : 0,
    isMigrated: isLegacyMigrationRecorded(),
  };
}

/**
 * The export document.
 *
 * `entries` is the raw overlay, copied verbatim — including fields the new model
 * refuses to store. That is on purpose: this file is an archive of what the
 * browser held, and the *importer* is what drops the forbidden fields. Handing
 * the user a pre-filtered archive would quietly destroy the only evidence of
 * what was there.
 */
export function buildLegacyExport() {
  return {
    format: 'avku-elections-legacy-export',
    version: 1,
    key: LEGACY_DETAILS_KEY,
    exportedAt: new Date().toISOString(),
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    stats: inspectLegacyData(),
    entries: readRawEntries(),
  };
}

/** Filename that says which browser and which day the copy came from. */
export function buildLegacyExportFileName(now = new Date()) {
  return `avku-elections-legacy-${now.toISOString().slice(0, 10)}.json`;
}

/**
 * Triggers the download. Returns the document as well, so a caller can hand the
 * same object straight to the import endpoint without a second read.
 */
export function downloadLegacyExport() {
  const document_ = buildLegacyExport();
  const text = JSON.stringify(document_, null, 2);

  if (typeof window === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return { document: document_, isDownloaded: false, text };
  }

  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement('a');

  anchor.href = url;
  anchor.download = buildLegacyExportFileName();
  window.document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);

  return { document: document_, isDownloaded: true, text };
}

export function isLegacyMigrationRecorded() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return false;
  }

  try {
    return Boolean(window.localStorage.getItem(MIGRATION_FLAG_KEY));
  } catch {
    return false;
  }
}

/**
 * Records that this browser's data reached the server.
 *
 * Only the flag is written. The original key stays exactly where it is, so the
 * import can be reviewed — or re-run — before anybody decides the copy is
 * expendable.
 */
export function recordLegacyMigration(batchId) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return false;
  }

  try {
    window.localStorage.setItem(
      MIGRATION_FLAG_KEY,
      JSON.stringify({ batchId, at: new Date().toISOString() }),
    );

    return true;
  } catch {
    return false;
  }
}

/**
 * Deletes the legacy key — the one destructive operation here.
 *
 * Refuses unless the migration has been recorded, so "clean up" can never run
 * before "the server has it". The caller is expected to have exported the file
 * as well; the UI asks for both.
 */
export function forgetLegacyData({ force = false } = {}) {
  if (!force && !isLegacyMigrationRecorded()) {
    return { isCleared: false, reason: 'not-migrated' };
  }

  if (typeof window === 'undefined' || !window.localStorage) {
    return { isCleared: false, reason: 'unavailable' };
  }

  try {
    window.localStorage.removeItem(LEGACY_DETAILS_KEY);

    return { isCleared: true, reason: null };
  } catch {
    return { isCleared: false, reason: 'unavailable' };
  }
}
