/**
 * Getting the old browser-only work out safely.
 *
 * For some houses the `avku-elections-details-v1` entry is the only copy of
 * real field work that has ever existed. Everything here exists to make sure
 * the migration cannot be the thing that destroys it:
 *
 *   • the export is a faithful copy, including fields the new model refuses to
 *     store — filtering the *archive* would erase the evidence of what was
 *     there, and it is the importer's job to drop them;
 *   • the counts are reported, so "did it all move?" is a checkable question
 *     rather than "the new screen opened, so presumably yes";
 *   • the original key is never removed as a side effect of anything.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LEGACY_DETAILS_KEY,
  buildLegacyExport,
  buildLegacyExportFileName,
  forgetLegacyData,
  inspectLegacyData,
  isLegacyMigrationRecorded,
  recordLegacyMigration,
} from './legacyLocalData.js';

/** Two houses of real work, in the exact shape the old overlay stored. */
const LEGACY_ENTRIES = {
  'way/180170140': {
    entrances: 4,
    apartments: 128,
    residentsCount: null,
    householdsCount: null,
    canvassStatus: 'done',
    priority: 'high',
    accessNote: 'Домофон 45В',
    notes: 'Просили полагодити освітлення у 2 підʼїзді',
    surveyedAt: '2026-05-12',
    updatedBy: 'Іван',
    contacts: [{ id: 'c1', type: 'phone', value: '067 111 22 33', label: 'голова ОСББ' }],
    residents: [
      {
        id: 'r1',
        name: 'Коваленко Олена',
        apartment: '12',
        // The two fields the rebuild removes. They are archived verbatim and
        // dropped by the importer — never the other way round.
        stance: 'against',
        ageGroup: '56-70',
        note: '',
      },
    ],
  },
  'way/999': {
    entrances: 2,
    canvassStatus: 'planned',
    priority: 'medium',
    notes: '',
    contacts: [],
    residents: [],
  },
};

function seedLegacyData(entries = LEGACY_ENTRIES) {
  window.localStorage.setItem(LEGACY_DETAILS_KEY, JSON.stringify(entries));
}

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe('inspectLegacyData', () => {
  it('reports nothing to rescue on a clean browser', () => {
    expect(inspectLegacyData()).toMatchObject({
      isPresent: false,
      houseCount: 0,
      contactCount: 0,
    });
  });

  /*
   * These numbers are the whole point: they are what the import report is
   * compared against. "The new interface opened" is not evidence of a
   * successful migration; "2 houses in, 2 houses accounted for" is.
   */
  it('counts what is actually there, so the migration can be checked', () => {
    seedLegacyData();

    expect(inspectLegacyData()).toMatchObject({
      isPresent: true,
      houseCount: 2,
      contactCount: 1,
      residentCount: 1,
      notesCount: 1,
    });
  });

  it('still reports a corrupted entry as present rather than as absent', () => {
    window.localStorage.setItem(LEGACY_DETAILS_KEY, '{not json');

    const stats = inspectLegacyData();

    expect(stats.isPresent).toBe(true);
    expect(stats.byteSize).toBeGreaterThan(0);
  });
});

describe('buildLegacyExport', () => {
  it('copies the entries verbatim, forbidden fields and all', () => {
    seedLegacyData();

    const document_ = buildLegacyExport();

    expect(document_.key).toBe(LEGACY_DETAILS_KEY);
    expect(Object.keys(document_.entries)).toEqual(['way/180170140', 'way/999']);
    expect(document_.entries['way/180170140'].notes).toContain('освітлення');

    // The archive is a copy of what the browser held. Stripping it here would
    // destroy the only record of what was collected; the importer is what
    // refuses to write these into a working table.
    expect(document_.entries['way/180170140'].residents[0].stance).toBe('against');
  });

  it('carries the counts with it, so the file is self-describing', () => {
    seedLegacyData();

    const document_ = buildLegacyExport();

    expect(document_.stats.houseCount).toBe(2);
    expect(document_.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('names the file after the day it was taken', () => {
    expect(buildLegacyExportFileName(new Date('2026-08-02T10:00:00Z')))
      .toBe('avku-elections-legacy-2026-08-02.json');
  });
});

describe('clearing the browser copy', () => {
  it('refuses until the server has confirmed it has the data', () => {
    seedLegacyData();

    expect(forgetLegacyData()).toEqual({ isCleared: false, reason: 'not-migrated' });
    expect(window.localStorage.getItem(LEGACY_DETAILS_KEY)).not.toBeNull();
  });

  it('clears only after a migration was recorded, and only on request', () => {
    seedLegacyData();
    recordLegacyMigration('batch-1');

    expect(isLegacyMigrationRecorded()).toBe(true);
    // Recording the migration must not itself remove anything.
    expect(window.localStorage.getItem(LEGACY_DETAILS_KEY)).not.toBeNull();

    expect(forgetLegacyData()).toEqual({ isCleared: true, reason: null });
    expect(window.localStorage.getItem(LEGACY_DETAILS_KEY)).toBeNull();
  });

  it('reports the migration in the stats, so the banner can stop asking', () => {
    seedLegacyData();
    recordLegacyMigration('batch-1');

    expect(inspectLegacyData().isMigrated).toBe(true);
  });
});
