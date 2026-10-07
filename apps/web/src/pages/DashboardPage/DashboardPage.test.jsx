import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import DashboardPage from './DashboardPage.jsx';

vi.mock('../../features/certificates/certificateApi.js', () => ({ fetchCertificates: vi.fn(async () => []) }));
vi.mock('../../features/warehouse/warehouseApi.js', () => ({ fetchWarehouseItems: vi.fn(async () => []) }));
vi.mock('../../features/logistics/logisticsApi.js', () => ({ fetchTransfers: vi.fn(async () => []) }));

beforeEach(() => { sessionStorage.clear(); });
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
