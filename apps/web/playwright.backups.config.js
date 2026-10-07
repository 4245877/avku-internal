import { defineConfig } from '@playwright/test';

// Layout and manual-request checks use intercepted API responses only.
export default defineConfig({
  testDir: './e2e',
  testMatch: 'dashboard-backups.spec.js',
  outputDir: '/tmp/avku-backup-ui-e2e-results',
  workers: 1,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:14175',
    launchOptions: process.env.AVKU_CHROMIUM_PATH
      ? { executablePath: process.env.AVKU_CHROMIUM_PATH } : {},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'tablet', use: { viewport: { width: 768, height: 1024 } } },
    { name: 'mobile', use: { viewport: { width: 375, height: 812 } } },
    { name: 'narrow-mobile', use: { viewport: { width: 320, height: 800 } } },
  ],
  webServer: {
    command: 'node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 14175 --strictPort',
    url: 'http://127.0.0.1:14175',
    reuseExistingServer: false,
  },
});
