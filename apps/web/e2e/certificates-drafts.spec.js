import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';

const require = createRequire(import.meta.url);
const sharp = require('../../api/node_modules/sharp');
const prefix = `DRAFT-E2E-${Date.now()}`;

test.beforeAll(({ baseURL }) => {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseURL)) {
    throw new Error('Draft lifecycle tests require an isolated localhost deployment.');
  }
});

async function createDraft(request, suffix, fields = {}) {
  const response = await request.post('/api/certificates', { data: {
    status: 'draft', fullName: 'Тестовий Чернетка Перевірка',
    certificateNumber: `${prefix}-${suffix}`, ...fields,
  } });
  expect(response.status()).toBe(201);
  return response.json();
}

function dateInput(page, label) {
  return page.locator('label').filter({ hasText: label }).locator('input:not([type="date"])');
}

async function openRecord(page, record) {
  const registry = page.getByRole('complementary', { name: 'Реєстр посвідчень' });
  await registry.getByRole('searchbox').fill(record.certificateNumber);
  const card = registry.locator('article').filter({ hasText: record.certificateNumber });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Чернетка');
  await card.getByRole('button', { name: 'Відкрити', exact: true }).click();
  await expect(page.getByPlaceholder('0001')).toHaveValue(record.certificateNumber);
  return card;
}

test('create a draft through the editor without photo or dates, reload and edit it', async ({ page, request }) => {
  await page.goto('/certificates');
  await page.getByPlaceholder("Прізвище Ім'я По батькові").fill('Тестовий Новий Чернетка');
  await page.getByPlaceholder('0001').fill(`${prefix}-UI-CREATE`);
  await expect(dateInput(page, 'Дата видачі')).toHaveValue('');
  await expect(dateInput(page, 'Дійсне до')).toHaveValue('');
  await page.getByRole('button', { name: /Зберегти чернетку/ }).click();
  await expect(page.getByText(/Чернетку збережено/)).toBeVisible();
  const response = await request.get(`/api/certificates?search=${prefix}-UI-CREATE`);
  const [saved] = await response.json();
  expect(saved.status).toBe('draft');
  expect(saved.issuedAt).toBeNull();
  expect(saved.validUntil).toBeNull();
  expect(saved.photoFileName).toBeNull();
  expect(saved.photoUrl).toBe('');
  await page.reload();
  await openRecord(page, saved);
  await page.getByPlaceholder("Прізвище Ім'я По батькові").fill('Тестовий Відредагований Чернетка');
  await page.getByRole('button', { name: /Зберегти чернетку/ }).click();
  await expect(page.getByText(/Чернетку збережено/)).toBeVisible();
  const edited = await (await request.get(`/api/certificates/${saved.id}`)).json();
  expect(edited.fullName).toBe('Тестовий Відредагований Чернетка');
  expect(edited.status).toBe('draft');
  expect(edited.issuedAt).toBeNull();
});

test('existing incomplete draft opens; photo/date upload saves draft and explicit activation completes it', async ({ page, request }, testInfo) => {
  const draft = await createDraft(request, 'COMPLETE', { validUntil: '2030-12-31' });
  await page.goto('/certificates');
  const card = await openRecord(page, draft);
  await expect(dateInput(page, 'Дата видачі')).toHaveValue('');
  await expect(card.getByRole('button', { name: 'PNG', exact: true })).toBeDisabled();
  await expect(card.getByRole('button', { name: 'Подовжити', exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('draft-open.png'), fullPage: true });
  const incomplete = await request.patch(`/api/certificates/${draft.id}/activate`, { data: {} });
  expect(incomplete.status()).toBe(400);
  expect((await (await request.get(`/api/certificates/${draft.id}`)).json()).status).toBe('draft');
  await page.getByRole('button', { name: 'Оформити посвідчення', exact: true }).click();
  expect((await (await request.get(`/api/certificates/${draft.id}`)).json()).status).toBe('draft');
  await dateInput(page, 'Дата видачі').fill('01.01.2026');
  const photo = await sharp({ create: { width: 600, height: 800, channels: 3,
    background: { r: 130, g: 150, b: 190 } } }).png().toBuffer();
  // Synthetic test fixture exists only in this isolated test store.
  await page.locator('input[type="file"]').setInputFiles({
    name: 'test-fixture.png', mimeType: 'image/png', buffer: photo,
  });
  await page.getByRole('button', { name: /Зберегти чернетку/ }).click();
  await expect(page.getByText(/Чернетку збережено/)).toBeVisible();
  const filled = await (await request.get(`/api/certificates/${draft.id}`)).json();
  expect(filled.status).toBe('draft');
  expect(filled.issuedAt).toBe('2026-01-01');
  expect(filled.photoFileName).toBeTruthy();
  expect((await request.get(`/api/certificates/${draft.id}/export.png`)).status()).toBe(400);
  await page.getByRole('button', { name: 'Оформити посвідчення', exact: true }).click();
  await expect(page.getByText(/Посвідчення оформлено/)).toBeVisible();
  const active = await (await request.get(`/api/certificates/${draft.id}`)).json();
  expect(active.status).toBe('active');
  expect(active.issuedAt).toBe('2026-01-01');
  expect(active.photoFileName).toBe(filled.photoFileName);
  expect((await request.get(`/api/certificates/${draft.id}/export.png`)).status()).toBe(200);
  await page.screenshot({ path: testInfo.outputPath('draft-activated.png'), fullPage: true });
});

test('draft with photo but no issue date stays editable and cannot activate; ordinary records remain readable', async ({ page, request }) => {
  const photo = await sharp({ create: { width: 600, height: 800, channels: 3,
    background: { r: 120, g: 140, b: 190 } } }).png().toBuffer();
  const draft = await createDraft(request, 'NO-DATE', {
    validUntil: '2030-12-31', photoDataUrl: `data:image/png;base64,${photo.toString('base64')}`,
  });
  expect(draft.issuedAt).toBeNull();
  expect(draft.photoUrl).toBeTruthy();
  await page.goto('/certificates');
  await openRecord(page, draft);
  await expect(dateInput(page, 'Дата видачі')).toHaveValue('');
  expect((await request.patch(`/api/certificates/${draft.id}/activate`, { data: {} })).status()).toBe(400);
  const activeCreate = await request.post('/api/certificates', { data: {
    status: 'active', fullName: 'Тестовий Неоформлений Запис', certificateNumber: `${prefix}-INVALID-ACTIVE`,
  } });
  expect(activeCreate.status()).toBe(400);
  const list = await (await request.get('/api/certificates')).json();
  const ordinary = list.find((record) => record.status === 'active' && /^\d+$/.test(record.certificateNumber));
  expect(ordinary).toBeTruthy();
  await page.getByRole('complementary', { name: 'Реєстр посвідчень' }).getByRole('searchbox').fill(ordinary.certificateNumber);
  const card = page.locator('article').filter({ hasText: `№ ${ordinary.certificateNumber} ·` });
  await card.getByRole('button', { name: 'Відкрити', exact: true }).click();
  await expect(page.getByPlaceholder('0001')).toHaveValue(ordinary.certificateNumber);
  await expect(card.getByRole('button', { name: 'PNG', exact: true })).toBeEnabled();
});
