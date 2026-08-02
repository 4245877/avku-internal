/**
 * Whether the "the OSM data does not cover this territory" banner has been put
 * away, and for what.
 *
 * The warning itself is usually right — a boundary really can reach past the
 * downloaded patch — but being right is not the same as being wanted on screen
 * forever. A canvasser who has read it, decided the missing strip is a field
 * nobody lives in, and gone back to work should not have it re-open on the next
 * render, the next dataset reload or the next visit.
 *
 * So a dismissal is not a boolean: it is a receipt for one particular state of
 * the world. What was dismissed is recorded as a *signature* of the coverage —
 * the traced boundary, the downloaded patch, the dataset it came from and the
 * size of the gap between them. The banner stays away for exactly as long as
 * that signature holds, and comes back by itself the moment any of it moves,
 * because then it is news again rather than the notice that was already read.
 *
 * The receipt lives in `localStorage` for the same reason: a page reload, a
 * rebuild or a remounted map is not new information about the territory, and
 * none of them should reopen a banner the user closed.
 */

import { useCallback, useMemo, useState } from 'react';

/** Where the receipt is kept. Versioned, so the shape can change later. */
export const COVERAGE_NOTICE_STORAGE_KEY = 'avku-elections-coverage-notice-v1';

/**
 * Five decimals is about a metre of latitude.
 *
 * The threshold decides what counts as "the territory changed": below it lie
 * float noise and re-serialisation drift, which must never reopen the banner;
 * above it lies a boundary somebody actually re-traced, which must.
 */
const DEGREE_PRECISION = 5;

/** Share of covered ground, to a hundredth of a per cent. */
const SHARE_PRECISION = 4;

function roundTo(value, decimals) {
  const factor = 10 ** decimals;

  return Math.round(value * factor) / factor;
}

/** A box as four rounded numbers, or `null` when there is no box at all. */
function describeBox(box) {
  if (!box) {
    return null;
  }

  return [box.minLat, box.minLon, box.maxLat, box.maxLon].map((degrees) =>
    roundTo(degrees, DEGREE_PRECISION),
  );
}

/**
 * The identity of one uncovered-territory situation.
 *
 * Everything the banner tells the user is derived from these fields, so two
 * states with the same signature would put the same sentence on screen — which
 * is the definition of "nothing new to say".
 */
export function describeCoverageSignature(coverage) {
  if (!coverage) {
    return null;
  }

  return JSON.stringify({
    // The territory the user traced…
    area: describeBox(coverage.areaBox),
    // …the ground the data actually reaches, and where it came from…
    dataset: describeBox(coverage.datasetBox),
    source: coverage.source ?? null,
    houses: coverage.houseCount ?? 0,
    // …and the gap between the two, in the terms the banner reports it.
    share: roundTo(coverage.coveredShare ?? 0, SHARE_PRECISION),
    missingSqm: Math.round(coverage.missingAreaSqm ?? 0),
    gapMeters: coverage.gapMeters ?? null,
  });
}

/* Reading the property is itself what throws in a locked-down browser, so even
 * asking whether storage exists has to be allowed to fail. */
function hasStorage() {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return Boolean(window.localStorage);
  } catch {
    return false;
  }
}

/** The signature the user last closed the banner for, if any. */
export function readDismissedCoverage() {
  if (!hasStorage()) {
    return null;
  }

  try {
    const stored = window.localStorage.getItem(COVERAGE_NOTICE_STORAGE_KEY);

    return typeof stored === 'string' && stored.length > 0 ? stored : null;
  } catch {
    // Private mode or storage disabled: the dismissal holds for this session.
    return null;
  }
}

export function writeDismissedCoverage(signature) {
  if (!hasStorage()) {
    return false;
  }

  try {
    window.localStorage.setItem(COVERAGE_NOTICE_STORAGE_KEY, signature);

    return true;
  } catch {
    return false;
  }
}

export function clearDismissedCoverage() {
  if (!hasStorage()) {
    return;
  }

  try {
    window.localStorage.removeItem(COVERAGE_NOTICE_STORAGE_KEY);
  } catch {
    // Nothing to clean up when storage is unavailable.
  }
}

/**
 * Whether the coverage banner should be on screen, and the way to close it.
 *
 * The receipt is read in the state initialiser rather than in an effect: a
 * banner that flashes for one frame on every mount and then disappears is not
 * meaningfully closed, and remounting the map is not an event the user asked to
 * be re-notified about.
 *
 * Closing writes and nothing else. It starts no request, touches no dataset and
 * moves no boundary — the gap it describes is still there, and the map under
 * the banner is exactly as it was.
 */
export function useCoverageNotice(coverage) {
  const signature = useMemo(() => describeCoverageSignature(coverage), [coverage]);
  const [dismissedSignature, setDismissedSignature] = useState(readDismissedCoverage);

  const dismiss = useCallback(() => {
    if (!signature) {
      return;
    }

    setDismissedSignature(signature);
    writeDismissedCoverage(signature);
  }, [signature]);

  return {
    isDismissed: signature !== null && dismissedSignature === signature,
    dismiss,
  };
}
