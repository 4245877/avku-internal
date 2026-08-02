/**
 * What a dismissal of the coverage banner is a dismissal *of*.
 *
 * The whole design rests on one question — "is this the same gap the user
 * already closed?" — so these tests are about where that answer changes and,
 * just as importantly, where it must not.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  COVERAGE_NOTICE_STORAGE_KEY,
  clearDismissedCoverage,
  describeCoverageSignature,
  readDismissedCoverage,
  writeDismissedCoverage,
} from './coverageNotice.js';

/** A boundary that reaches ~7% past the downloaded patch — the reported case. */
function coverageState(overrides = {}) {
  return {
    areaBox: { minLat: 50.4, minLon: 30.5, maxLat: 50.42, maxLon: 30.54 },
    datasetBox: { minLat: 50.4, minLon: 30.5, maxLat: 50.418, maxLon: 30.54 },
    source: 'snapshot',
    houseCount: 1441,
    isCovered: false,
    coveredShare: 0.93,
    missingAreaSqm: 220_000,
    gapMeters: 739,
    command: 'npm run data:houses',
    ...overrides,
  };
}

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe('coverage signature', () => {
  it('has nothing to identify while the coverage is unknown', () => {
    expect(describeCoverageSignature(null)).toBeNull();
    expect(describeCoverageSignature(undefined)).toBeNull();
  });

  it('is the same for two loads of the same territory and dataset', () => {
    // A reload rebuilds the whole coverage object; nothing about the world
    // changed, so nothing about the identity may.
    expect(describeCoverageSignature(coverageState())).toBe(
      describeCoverageSignature(coverageState()),
    );
  });

  it('ignores drift far below a metre', () => {
    const drifted = coverageState({
      areaBox: { minLat: 50.4000000001, minLon: 30.5, maxLat: 50.42, maxLon: 30.54 },
      coveredShare: 0.93 + 1e-9,
      missingAreaSqm: 220_000.4,
    });

    expect(describeCoverageSignature(drifted)).toBe(describeCoverageSignature(coverageState()));
  });

  it('changes when the boundary is re-traced', () => {
    const moved = coverageState({
      areaBox: { minLat: 50.4, minLon: 30.5, maxLat: 50.44, maxLon: 30.54 },
    });

    expect(describeCoverageSignature(moved)).not.toBe(describeCoverageSignature(coverageState()));
  });

  it('changes when the OSM dataset moves or grows', () => {
    const wider = coverageState({
      datasetBox: { minLat: 50.4, minLon: 30.5, maxLat: 50.4195, maxLon: 30.54 },
    });
    const refilled = coverageState({ houseCount: 1509 });
    const downloaded = coverageState({ source: 'overpass' });

    for (const state of [wider, refilled, downloaded]) {
      expect(describeCoverageSignature(state)).not.toBe(
        describeCoverageSignature(coverageState()),
      );
    }
  });

  it('changes when the size of the gap changes', () => {
    const smallerGap = coverageState({ coveredShare: 0.97, missingAreaSqm: 90_000, gapMeters: 210 });

    expect(describeCoverageSignature(smallerGap)).not.toBe(
      describeCoverageSignature(coverageState()),
    );
  });

  /* The state where there is no dataset at all is a legitimate one, and it has
   * to be distinguishable from a dataset that merely falls short. */
  it('tells a missing dataset apart from a partial one', () => {
    const nothing = coverageState({ datasetBox: null, houseCount: 0, coveredShare: 0 });

    expect(describeCoverageSignature(nothing)).not.toBe(
      describeCoverageSignature(coverageState()),
    );
  });
});

describe('dismissal storage', () => {
  it('round-trips a signature', () => {
    const signature = describeCoverageSignature(coverageState());

    expect(writeDismissedCoverage(signature)).toBe(true);
    expect(readDismissedCoverage()).toBe(signature);
    expect(window.localStorage.getItem(COVERAGE_NOTICE_STORAGE_KEY)).toBe(signature);

    clearDismissedCoverage();

    expect(readDismissedCoverage()).toBeNull();
  });

  it('reports nothing dismissed when storage is unusable', () => {
    const storage = window.localStorage;

    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled');
      },
    });

    try {
      // A private-mode browser must not throw its way out of a render.
      expect(() => readDismissedCoverage()).not.toThrow();
      expect(readDismissedCoverage()).toBeNull();
      expect(writeDismissedCoverage('x')).toBe(false);
      expect(() => clearDismissedCoverage()).not.toThrow();
    } finally {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        writable: true,
        value: storage,
      });
    }
  });
});
