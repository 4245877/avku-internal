import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { fetchCertificates } from '../../features/certificates/certificateApi.js';
import DashboardPage from './DashboardPage.jsx';

vi.mock('../../features/certificates/certificateApi.js', () => ({ fetchCertificates: vi.fn(async () => []) }));
vi.mock('../../features/warehouse/warehouseApi.js', () => ({ fetchWarehouseItems: vi.fn(async () => []) }));
vi.mock('../../features/logistics/logisticsApi.js', () => ({ fetchTransfers: vi.fn(async () => []) }));

beforeEach(() => {
  sessionStorage.clear();
  fetchCertificates.mockReset().mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('places the manual backup card after all dashboard content and only reads its existing API', async () => {
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ activeJob: null, jobs: [], slots: [], lastSuccessful: null }) }));
  vi.stubGlobal('fetch', fetch);
  render(<MemoryRouter><DashboardPage /></MemoryRouter>);
  const card = screen.getByRole('region', { name: 'Резервне копіювання' });
  expect(screen.getByRole('main').lastElementChild).toBe(card);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Створити резервну копію' }).disabled).toBe(false));
  expect(screen.getByRole('heading', { name: 'Останні операційні записи' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Швидкі дії' })).toBeTruthy();
  expect(fetch).toHaveBeenCalledWith('/api/certificates/backups', { credentials: 'same-origin', cache: 'no-store' });
  expect(fetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
});

function summaryValue(label) {
  const summary = screen.getByRole('region', { name: 'Оперативна статистика' });
  return within(summary).getByText(label, { exact: true }).closest('article').querySelector('strong').textContent;
}

function mockBackupInventory() {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ activeJob: null, jobs: [], slots: [], lastSuccessful: null }),
  })));
}

it('keeps a future-dated draft out of active metrics and labels its operational row as draft', async () => {
  fetchCertificates.mockResolvedValue([
    { id: 'future-draft', fullName: 'Майбутня чернетка', status: 'draft', validUntil: '2099-01-01' },
    { id: 'legacy-active', fullName: 'Оформлене посвідчення', validUntil: '2099-01-01' },
  ]);
  mockBackupInventory();
  render(<MemoryRouter><DashboardPage /></MemoryRouter>);

  await waitFor(() => expect(summaryValue('Посвідчення')).toBe('2'));
  expect(summaryValue('Дійсні посвідчення')).toBe('1');
  expect(summaryValue('Чернетки посвідчень')).toBe('1');
  expect(summaryValue('Спливають')).toBe('0');
  const draftRow = screen.getByRole('row', { name: /Майбутня чернетка/ });
  expect(within(draftRow).getByText('Чернетка', { exact: true })).toBeTruthy();
  expect(within(draftRow).queryByText('Дійсне', { exact: true })).toBeNull();
});

it('counts 169 records as 116 active certificates and 53 drafts regardless of draft expiry dates', async () => {
  fetchCertificates.mockResolvedValue(Array.from({ length: 169 }, (_, index) => ({
    id: `certificate-${index}`,
    fullName: `Тестове посвідчення ${index}`,
    status: index < 116 ? 'active' : 'draft',
    validUntil: '2099-01-01',
  })));
  mockBackupInventory();
  render(<MemoryRouter><DashboardPage /></MemoryRouter>);

  await waitFor(() => expect(summaryValue('Посвідчення')).toBe('169'));
  expect(summaryValue('Дійсні посвідчення')).toBe('116');
  expect(summaryValue('Чернетки посвідчень')).toBe('53');
  expect(summaryValue('Спливають')).toBe('0');
});
