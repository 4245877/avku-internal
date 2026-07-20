import { expect, test } from '@playwright/test';

import { attachPhotoNetworkRecorder } from './photoNetworkRecorder.js';

/**
 * The same rapid-switching invariant as the local suite, but against the
 * Cloudflare-fronted host. This is the only run that exercises the real tunnel:
 * a hop that adds genuine latency and its own connection reuse on top of the
 * origin's, which is exactly the condition operators hit.
 *
 * Cloudflare Access sits in front of internal.avku.org, so the run needs a
 * browser state saved from a completed Access login:
 *
 *   AVKU_E2E_STORAGE_STATE=/abs/path/to/access.storageState.json \
 *   AVKU_E2E_BASE_URL=https://internal.avku.org \
 *   pnpm exec playwright test e2e/certificates-photo-switching.cloudflare.spec.js
 *
 * That file is a bearer credential — it is read from an absolute path outside
 * the repository and matched by `**\/*.storageState.json` in .gitignore so it
 * can never be staged. Without it the run is *skipped*, not failed: an
 * unauthenticated run would only ever measure the Access login page, and a red
 * suite would say "the fix is broken" when it means "nobody logged in".
 */

const STORAGE_STATE = process.env.AVKU_E2E_STORAGE_STATE;
const BASE_URL = process.env.AVKU_E2E_BASE_URL || '';
const IS_CLOUDFLARE_TARGET = /internal\.avku\.org/.test(BASE_URL);

test.describe('certificates photo switching over Cloudflare', () => {
  test.skip(
    !STORAGE_STATE,
    'AVKU_E2E_STORAGE_STATE is not set — skipping the Cloudflare run. ' +
      'Log in to https://internal.avku.org once, save the browser state, and point ' +
      'AVKU_E2E_STORAGE_STATE at it (see docs/certificates-photo-switching-investigation.md).',
  );
  test.skip(
    !IS_CLOUDFLARE_TARGET,
    `AVKU_E2E_BASE_URL is "${BASE_URL || 'unset'}", not the Cloudflare host — ` +
      'skipping. Set AVKU_E2E_BASE_URL=https://internal.avku.org to run this.',
  );

  test('photo follows the selected record across the tunnel', async ({ page, request, baseURL }) => {
    const response = await request.get(`${baseURL}/api/certificates?limit=25`);

    // A redirect into the Access login means the saved state has expired. Say so
    // plainly — the alternative is a timeout that looks like a product bug.
    expect(
      response.ok(),
      'registry API did not answer over the tunnel — the Cloudflare Access state ' +
        'in AVKU_E2E_STORAGE_STATE has most likely expired; log in again and re-save it',
    ).toBeTruthy();

    const records = (await response.json()).filter((record) => record.photoUrl).slice(0, 20);

    expect(records.length, 'need at least 15 records with photos').toBeGreaterThanOrEqual(15);

    const recorder = attachPhotoNetworkRecorder(page);
    const consoleErrors = [];

    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });

    await page.goto('/certificates');
    await expect(page.locator('article').first()).toBeVisible();

    // No CDP throttling here: the tunnel supplies the latency, and shaping it
    // further would measure the emulator instead of the edge.
    for (const record of records) {
      recorder.mark(`select ${record.id}`);
      await page
        .locator('article')
        .filter({ hasText: record.certificateNumber })
        .locator('button')
        .filter({ hasText: record.fullName })
        .first()
        .click();
      await page.waitForTimeout(150);
    }

    const last = records[records.length - 1];
    const expectedFile = last.photoUrl.split('/').pop();

    await expect
      .poll(
        async () =>
          page.locator('[role="application"] img').first().getAttribute('src').catch(() => null),
        {
          message: `cropper never settled on the photo of "${last.fullName}" over the tunnel`,
          timeout: 30_000,
        },
      )
      .toContain(expectedFile);

    await page.waitForTimeout(500);

    // Same invariant as locally: nothing the operator switched away from may
    // still be occupying a connection.
    const stillRunning = recorder
      .entries.filter((entry) => entry.recordId !== last.id && entry.outcome === 'pending');

    expect(stillRunning, 'abandoned photo loads are still running over the tunnel').toEqual([]);

    // The tunnel is where 404/503 would surface if an asset path or the origin
    // were wrong behind Cloudflare.
    const badStatuses = recorder.entries.filter((entry) => entry.status && entry.status >= 400);

    expect(badStatuses, 'photo requests returned error statuses over the tunnel').toEqual([]);
    expect(consoleErrors, 'browser console reported errors').toEqual([]);
  });
});
