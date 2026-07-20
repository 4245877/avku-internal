import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { attachPhotoNetworkRecorder, getRecordIdFromPhotoUrl } from './photoNetworkRecorder.js';

/**
 * Reproduction harness for "a photo stops loading after several record
 * switches".
 *
 * Response latency is applied with CDP bandwidth throttling rather than
 * `route.fulfill()` on purpose. Fulfilling from Playwright serves the body out
 * of the driver and releases the socket immediately, which destroys the very
 * thing under test — the browser's per-origin HTTP/1.1 connection pool. Real
 * throttling keeps every load on a real socket, so an abandoned download still
 * holds its connection exactly as it does for an operator on a slow tunnel.
 */

const ARTIFACT_DIR = path.join(process.cwd(), 'e2e-results', 'network');

/** Bandwidth tiers chosen so a typical ~200KB preview takes roughly this long. */
const LATENCY_TIERS = {
  '300ms': 700_000,
  '1s': 200_000,
  '3s': 65_000,
};

async function throttle(page, bytesPerSecond) {
  const client = await page.context().newCDPSession(page);

  await client.send('Network.enable');
  await client.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 20,
    downloadThroughput: bytesPerSecond,
    uploadThroughput: bytesPerSecond,
  });

  return client;
}

async function loadRecords(request, baseURL) {
  const response = await request.get(`${baseURL}/api/certificates?limit=25`);

  expect(response.ok(), 'registry API must answer before the UI test starts').toBeTruthy();

  const records = await response.json();

  return records.filter((record) => record.photoUrl);
}

function cropperFrame(page) {
  return page.locator('[role="application"]');
}

/** What the cropper is actually showing: the loaded photo, or which placeholder. */
async function readCropperState(page) {
  return cropperFrame(page).evaluate((frame) => {
    const image = frame.querySelector('img');
    const placeholder = frame.querySelector('span');

    return {
      hasImage: Boolean(image),
      src: image?.getAttribute('src') ?? null,
      complete: image?.complete ?? false,
      naturalWidth: image?.naturalWidth ?? 0,
      naturalHeight: image?.naturalHeight ?? 0,
      placeholder: placeholder?.textContent?.trim() ?? null,
    };
  });
}

async function selectRecord(page, record) {
  await page
    .locator('article')
    .filter({ hasText: record.certificateNumber })
    .locator('button')
    .filter({ hasText: record.fullName })
    .first()
    .click();
}

async function saveArtifacts(recorder, name) {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(
    path.join(ARTIFACT_DIR, `${name}.json`),
    JSON.stringify(recorder.toJSON(), null, 2),
    'utf8',
  );
}

/**
 * Switches through `records` at `switchDelayMs`, then asserts the cropper is
 * showing the photo of the record selected last. Returns the diagnostics so a
 * failure can be explained rather than merely reported.
 */
async function switchThrough(page, recorder, records, switchDelayMs) {
  for (const record of records) {
    recorder.mark(`select ${record.id} (${record.fullName})`);
    await selectRecord(page, record);

    if (switchDelayMs > 0) {
      await page.waitForTimeout(switchDelayMs);
    }
  }
}

async function expectPhotoOf(page, record, recorder, artifactName) {
  const expectedFile = record.photoUrl.split('/').pop();

  let state = await readCropperState(page);

  try {
    await expect
      .poll(async () => {
        state = await readCropperState(page);

        return state.hasImage && state.naturalWidth > 0 && state.src?.includes(expectedFile);
      }, {
        message:
          `cropper never settled on the photo of "${record.fullName}" (${record.id}); ` +
          `expected src to contain ${expectedFile}`,
        timeout: 20_000,
      })
      .toBe(true);
  } catch (error) {
    const pending = recorder.pending();

    await saveArtifacts(recorder, artifactName);

    throw new Error(
      [
        error.message,
        '',
        `cropper state: ${JSON.stringify(state)}`,
        `photo requests still unfinished: ${pending.length}`,
        ...pending.map(
          (entry) =>
            `  pending recordId=${entry.recordId} startMs=${entry.startMs} ` +
            `inFlightAtStart=${entry.inFlightAtStart} url=${entry.url}`,
        ),
        `peak concurrent photo requests: ${recorder.peakInFlight()}`,
        `network log: ${path.join(ARTIFACT_DIR, `${artifactName}.json`)}`,
      ].join('\n'),
    );
  }
}

for (const [tierName, bytesPerSecond] of Object.entries(LATENCY_TIERS)) {
  test(`photo keeps up with rapid record switching @ ${tierName} photo latency`, async ({
    page,
    request,
    baseURL,
  }, testInfo) => {
    const artifactName = `${testInfo.project.name}-${tierName}`.replace(/\W+/g, '-');
    const records = (await loadRecords(request, baseURL)).slice(0, 20);

    expect(records.length, 'need at least 15 records with photos to reproduce').toBeGreaterThanOrEqual(15);

    const recorder = attachPhotoNetworkRecorder(page);

    await page.goto('/certificates');
    await expect(page.locator('article').first()).toBeVisible();

    await throttle(page, bytesPerSecond);

    // Three passes of fast switching, as an operator working down the registry.
    for (let pass = 0; pass < 3; pass += 1) {
      recorder.mark(`pass ${pass} start`);
      await switchThrough(page, recorder, records, 150);

      // The photo now on screen must be the one selected last.
      await expectPhotoOf(page, records[records.length - 1], recorder, `${artifactName}-pass${pass}`);
    }

    // Going back to the first record must show its photo, not a stale neighbour's.
    recorder.mark('return to first record');
    await selectRecord(page, records[0]);
    await expectPhotoOf(page, records[0], recorder, `${artifactName}-return`);

    await saveArtifacts(recorder, `${artifactName}-passed`);

    // Cross-check: every photo that was served belonged to a record we selected.
    const selectedIds = new Set(records.map((record) => record.id));
    const foreign = recorder.entries.filter(
      (entry) => entry.recordId && !selectedIds.has(entry.recordId),
    );

    expect(foreign, 'no photo may be requested for a record that was never selected').toEqual([]);
  });
}

test('abandoned photo loads do not outlive the switch away from them', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const records = (await loadRecords(request, baseURL)).slice(0, 20);
  const recorder = attachPhotoNetworkRecorder(page);

  await page.goto('/certificates');
  await expect(page.locator('article').first()).toBeVisible();

  await throttle(page, LATENCY_TIERS['3s']);

  // Switch fast enough that each photo is abandoned long before it can finish.
  await switchThrough(page, recorder, records, 120);

  // Let the last switch's cleanup land. Aborting is asynchronous by a few
  // milliseconds, so sampling an exact instant would test the clock, not the
  // behaviour.
  await page.waitForTimeout(500);

  await saveArtifacts(recorder, `${testInfo.project.name}-abandoned`.replace(/\W+/g, '-'));

  const currentRecordId = records[records.length - 1].id;
  const abandoned = recorder.entries.filter((entry) => entry.recordId !== currentRecordId);
  const describe = (entry) =>
    `  recordId=${entry.recordId} outcome=${entry.outcome} failure=${entry.failure} ` +
    `startMs=${entry.startMs} endMs=${entry.endMs}`;

  // Hypothesis 8, as an invariant: a load the operator has switched away from
  // must not still be running. Either it was already complete, or switching
  // away aborted it — never left open to compete with the photo now on screen.
  const stillRunning = abandoned.filter((entry) => entry.outcome === 'pending');

  expect(
    stillRunning,
    `photo loads for records the operator left are still running:\n${stillRunning.map(describe).join('\n')}`,
  ).toEqual([]);

  // The starvation itself: with abandoned loads released, only the current
  // record's photo is ever in flight, so nothing can queue behind a stale one.
  expect(
    recorder.peakInFlight(),
    `too many photo requests in flight at once — abandoned loads are accumulating:\n${recorder.entries.map(describe).join('\n')}`,
  ).toBeLessThanOrEqual(3);
});
