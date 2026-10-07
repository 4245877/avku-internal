import { expect, test } from '@playwright/test';

const job = {
  id: '95f2ceab-9a9e-436c-b52a-4ce897e89ca2',
  status: 'uploading',
  createdAt: '2026-10-06T12:00:00Z',
};
const succeeded = { ...job, status: 'succeeded', remote: { committedAt: '2026-10-06T12:01:00Z' } };
const slots = [1, 2].map(number => ({
  slot: `slot-${number}`,
  jobId: `retained-job-${number}`,
  status: 'succeeded',
  snapshotAt: `2026-10-0${7 - number}T12:00:00Z`,
  verifiedAt: `2026-10-0${7 - number}T12:01:00Z`,
  size: 1048576 * number,
}));
const completed = { activeJob: null, jobs: [succeeded], lastSuccessful: succeeded, slots, checkedAt: '2026-10-06T12:01:00Z' };

async function mockApi(page, initial = completed) {
  let data = initial;
  const requests = [];
  const unexpected = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/certificates/backups') {
      requests.push(request);
      if (request.method() === 'POST') {
        data = { ...completed, activeJob: job, jobs: [job, succeeded] };
        await route.fulfill({ status: 202, json: { job } });
      } else if (request.method() === 'GET') {
        await route.fulfill({ json: data });
      } else {
        unexpected.push(`${request.method()} ${pathname}`);
        await route.abort();
      }
      return;
    }
    if (request.method() === 'GET' && ['/api/certificates', '/api/warehouse', '/api/logistics'].includes(pathname)) {
      await route.fulfill({ json: [] });
    } else if (request.method() === 'GET' && pathname === '/api/certificates/templates') {
      // The existing local template fallback keeps this check self-contained.
      await route.fulfill({ status: 503, json: { error: 'Test template fallback' } });
    } else if (request.method() === 'GET' && pathname.startsWith('/api/assets/')) {
      // Certificate fallback URLs are normalized through the API prefix.
      await route.fulfill({ response: await route.fetch({ url: request.url().replace('/api/assets/', '/assets/') }) });
    } else {
      unexpected.push(`${request.method()} ${pathname}`);
      await route.abort();
    }
  });
  return { requests, unexpected, setData: next => { data = next; } };
}

test('backup card is last, prominent, responsive, and absent from certificates', async ({ page }, testInfo) => {
  const api = await mockApi(page);
  await page.goto('/');
  const card = page.getByRole('region', { name: 'Резервне копіювання' });
  const button = card.getByRole('button', { name: 'Створити резервну копію' });
  await expect(button).toBeEnabled();
  await expect(card).toContainText('Резервну копію створено і перевірено');
  await expect(card).toContainText('Остання успішна копія: 06.10.2026, 15:01');
  expect(await card.evaluate(element => element === element.closest('main').lastElementChild)).toBe(true);
  const table = card.getByRole('table', { name: 'Збережені резервні копії' });
  await expect(table.getByRole('columnheader')).toHaveText(['Дата копії', 'Розмір', 'Перевірка']);
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(table.getByText('Перевірено', { exact: true })).toHaveCount(2);
  await expect(card.getByText(job.id, { exact: true })).toBeHidden();
  const visibleText = await card.innerText();
  expect(visibleText).not.toMatch(/Job ID|retained-job|slot-|generation|publisher|SFTP|candidate|receipt|Snapshot/);
  const appearance = await button.evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, color: style.color, height: element.getBoundingClientRect().height };
  });
  expect(appearance.background).toBe('rgb(44, 95, 138)');
  expect(appearance.color).toBe('rgb(244, 247, 251)');
  expect(appearance.height).toBeGreaterThanOrEqual(44);
  await button.scrollIntoViewIfNeeded();
  const dimensions = await card.evaluate(element => ({
    card: element.getBoundingClientRect().toJSON(),
    button: element.querySelector('button').getBoundingClientRect().toJSON(),
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
    viewport: window.innerWidth,
  }));
  expect(dimensions.card.left).toBeGreaterThanOrEqual(0);
  expect(dimensions.card.right).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.button.left).toBeGreaterThanOrEqual(dimensions.card.left);
  expect(dimensions.button.right).toBeLessThanOrEqual(dimensions.card.right);
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  await card.screenshot({ path: testInfo.outputPath('backup-card-light.png') });
  await card.getByText('Деталі', { exact: true }).click();
  await expect(card.getByText(job.id, { exact: true })).toBeVisible();
  await card.getByText('Деталі', { exact: true }).click();
  await page.getByRole('button', { name: 'Перемкнути на темну тему' }).click();
  await card.screenshot({ path: testInfo.outputPath('backup-card-dark.png') });
  expect(api.requests.every(request => request.method() === 'GET')).toBe(true);

  await page.getByRole('navigation', { name: 'Основна навігація' }).locator('a[href="/certificates"]').click();
  await expect(page).toHaveURL('/certificates');
  await expect(page.getByRole('heading', { name: 'Посвідчення', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Резервне копіювання' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Створити резервну копію' })).toHaveCount(0);
  const backupRequestsBeforeReload = api.requests.length;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Посвідчення', exact: true })).toBeVisible();
  expect(api.requests).toHaveLength(backupRequestsBeforeReload);
  expect(api.unexpected).toEqual([]);
});

test('manual action calls the existing endpoint once and remains blocked through reload until success', async ({ page }) => {
  const api = await mockApi(page);
  await page.goto('/');
  const card = page.getByRole('region', { name: 'Резервне копіювання' });
  const button = card.getByRole('button', { name: 'Створити резервну копію' });
  await expect(button).toBeEnabled();
  await button.click();
  const confirmation = card.getByRole('group', { name: 'Підтвердити резервне копіювання' });
  await expect(confirmation).toBeVisible();
  expect(api.requests.filter(request => request.method() === 'POST')).toHaveLength(0);
  await confirmation.getByRole('button', { name: 'Створити', exact: true }).click();
  const runningButton = card.getByRole('button', { name: 'Резервне копіювання виконується…' });
  await expect(runningButton).toBeDisabled();
  await expect(runningButton).toHaveAttribute('aria-busy', 'true');
  await expect(card).toContainText('Збереження резервної копії');
  await expect(card.getByText('Резервну копію створено і перевірено')).toHaveCount(0);
  const posts = api.requests.filter(request => request.method() === 'POST');
  expect(posts).toHaveLength(1);
  expect(new URL(posts[0].url()).pathname).toBe('/api/certificates/backups');
  expect(posts[0].headers()['x-avku-backup']).toBe('manual');
  expect(posts[0].headers()['content-type']).toBe('application/json');
  expect(posts[0].headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  expect(posts[0].postData()).toBe('{}');
  await page.reload();
  await expect(runningButton).toBeDisabled();
  api.setData(completed);
  await expect(card).toContainText('Резервну копію створено і перевірено', { timeout: 8000 });
  await expect(button).toBeEnabled();
  expect(api.requests.filter(request => request.method() === 'POST')).toHaveLength(1);
  expect(api.unexpected).toEqual([]);
});

test('opening or reloading Dashboard with a pending request key never creates a backup', async ({ page }) => {
  const api = await mockApi(page);
  await page.addInitScript(() => sessionStorage.setItem('avku-certificate-backup-idem', '5b7ff1a3-79d2-4511-92f5-daa0b501b7df'));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Створити резервну копію' })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Створити резервну копію' })).toBeEnabled();
  await page.getByRole('button', { name: 'Створити резервну копію' }).click();
  await page.getByRole('button', { name: 'Скасувати', exact: true }).click();
  expect(api.requests.every(request => request.method() === 'GET')).toBe(true);
  expect(api.unexpected).toEqual([]);
});
