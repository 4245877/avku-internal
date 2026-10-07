import { defineConfig, devices } from '@playwright/test';

// Draft lifecycle tests write fixtures. Use an isolated API/store, never production.
export default defineConfig({
  testDir: './e2e',
  testMatch: 'certificates-drafts.spec.js',
  outputDir: './draft-e2e-results',
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.AVKU_DRAFT_TEST_URL || 'http://127.0.0.1:14174',
    launchOptions: process.env.AVKU_CHROMIUM_PATH
      ? { executablePath: process.env.AVKU_CHROMIUM_PATH } : {},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
