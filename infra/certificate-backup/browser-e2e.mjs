// Test credentials and all data are synthetic. No production URL is accepted.
import { chromium } from '../../apps/web/node_modules/@playwright/test/index.mjs';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const [lab, executablePath] = process.argv.slice(2);
if (!lab?.startsWith('/tmp/avku-backup-e2e-') || !executablePath) throw new Error('isolated namespace and browser required');
const token = await readFile(lab + '/test-token', 'utf8');
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const started = [];
  await page.route('http://127.0.0.1:18183/api/**', async route => {
    const original = route.request();
    if (original.method() === 'POST' && original.url().endsWith('/certificates/backups')) started.push(original.headers()['idempotency-key']);
    const headers = { ...original.headers(), 'cf-access-jwt-assertion': token };
    delete headers.host;
    const response = await context.request.fetch(original.url().replace('127.0.0.1:18183', '127.0.0.1:18182'), { method: original.method(), headers, data: original.postDataBuffer() ?? undefined });
    await route.fulfill({ response });
  });
  await page.goto('http://127.0.0.1:18183/certificates');
  const panel = page.getByRole('region', { name: 'Резервне копіювання' });
  await panel.getByRole('button', { name: 'Створити резервну копію' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('section[aria-label="Резервне копіювання"] button').disabled);
  assert.equal(started.length, 0, 'mount must never create a backup');
  for (let n = 1; n <= 3; n++) {
    await panel.getByRole('button', { name: 'Створити резервну копію' }).click();
    await panel.getByRole('dialog').getByRole('button', { name: 'Створити', exact: true }).dblclick();
    if (n === 1) {
      await page.reload();
      await panel.getByText(/Job ID:/).waitFor();
    }
    await panel.getByText('Резервну копію створено і перевірено', { exact: true }).waitFor({ timeout: 120000 });
    await page.waitForFunction(() => !document.querySelector('section[aria-label="Резервне копіювання"] button').disabled);
    const rows = await panel.locator('tbody tr').count();
    assert.equal(rows, Math.min(n, 2));
  }
  assert.equal(started.length, 3, 'three manual double-clicks must create exactly three jobs');
  assert.equal(new Set(started).size, 3);
  console.log(JSON.stringify({ manualButton: true, jobs: 3, slots: 2, doubleClick: true, reload: true, noStartupBackup: true, production: false }));
} finally { await browser.close(); }
