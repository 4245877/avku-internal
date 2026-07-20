import { defineConfig, devices } from '@playwright/test';

/**
 * E2E configuration for the certificates photo-switching investigation.
 *
 * The app under test is always an already-running deployment (the local nginx
 * on :18080 or the Cloudflare-fronted host), so there is no `webServer` block —
 * these tests exercise the real edge, which is the whole point: the suspected
 * fault is in how abandoned image loads interact with the browser's per-origin
 * connection pool, and that only reproduces against a real HTTP/1.1 server.
 *
 * Chromium only, by design: the connection-pool behaviour under investigation
 * is Chromium's, and the operators run Chrome.
 */

const baseURL = process.env.AVKU_E2E_BASE_URL || 'http://192.168.0.151:18080';

/**
 * Cloudflare Access sits in front of internal.avku.org. Authenticate once by
 * hand and point this at the saved state; it is deliberately read from an
 * absolute path outside the repository so no cookie or token is ever staged
 * into Git. See docs/certificates-photo-switching-investigation.md.
 */
const storageState = process.env.AVKU_E2E_STORAGE_STATE || undefined;

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e-results',
  // The diagnostics runs switch through 20 records several times over a tunnel.
  timeout: 180_000,
  expect: {
    timeout: 15_000,
  },
  // Serialised on purpose: parallel workers would share the origin's rate-limit
  // bucket and each other's connection pressure, contaminating the measurement.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: [
    ['list'],
    ['html', { outputFolder: './e2e-report', open: 'never' }],
  ],
  use: {
    baseURL,
    storageState,
    // Trace and HAR for every failing run — the network evidence the
    // investigation is built on.
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
});
