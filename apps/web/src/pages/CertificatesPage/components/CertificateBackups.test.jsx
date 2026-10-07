// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CertificateBackups from './CertificateBackups.jsx';

const job = { id: '95f2ceab-9a9e-436c-b52a-4ce897e89ca2', status: 'uploading', idempotencyKey: 'key', createdAt: '2026-10-06T12:00:00Z' };
const empty = { activeJob: null, jobs: [], lastSuccessful: null, slots: [], checkedAt: null };
const json = (data, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => data });
beforeEach(() => { sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('manual certificate backups UI', () => {
  it('supports the existing LAN HTTP entry point without randomUUID', async () => {
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    vi.stubGlobal('crypto', { getRandomValues });
    const fetch = vi.fn((url, options) => options.method ? json({ job }, 202) : json(empty));
    vi.stubGlobal('fetch', fetch);
    render(<CertificateBackups />);
    const button = await screen.findByRole('button', { name: 'Створити резервну копію' });
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button); fireEvent.click(screen.getByRole('button', { name: 'Створити' }));
    await waitFor(() => expect(fetch.mock.calls.some(([, options]) => options.method === 'POST')).toBe(true));
    const post = fetch.mock.calls.find(([, options]) => options.method === 'POST')[1];
    expect(post.headers['Idempotency-Key']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('never starts a backup on mount, explains drafts/unsaved changes and asks confirmation', async () => {
    const fetch = vi.fn(() => json(empty)); vi.stubGlobal('fetch', fetch);
    render(<CertificateBackups />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Створити резервну копію' }).disabled).toBe(false));
    expect(fetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
    expect(screen.getByText(/включно з чернетками/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Створити резервну копію' }));
    expect(screen.getByRole('dialog')).toBeTruthy(); expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Скасувати' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('reload restores active job, disables creation and never claims success before commit', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json({ ...empty, activeJob: job, jobs: [job] })));
    const page = render(<CertificateBackups />);
    await screen.findByText('Передача на backup-сервер');
    expect(screen.getByRole('button', { name: /виконується/ }).disabled).toBe(true);
    expect(screen.queryByText('Резервну копію створено і перевірено')).toBeNull();
    page.unmount(); render(<CertificateBackups />);
    await screen.findByText(job.id);
    expect(screen.getByRole('button', { name: /виконується/ }).disabled).toBe(true);
  });
  it('double-click submits once and shows remote-verified completion with two slots', async () => {
    let state = empty;
    const fetch = vi.fn((url, options) => {
      if (options.method === 'POST') {
        state = { ...empty, activeJob: job, jobs: [job] };
        return new Promise(resolve => setTimeout(() => resolve({ ok: true, json: async () => ({ job }) }), 20));
      }
      return json(state);
    }); vi.stubGlobal('fetch', fetch);
    render(<CertificateBackups />);
    const button = await screen.findByRole('button', { name: 'Створити резервну копію' });
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button); const confirm = screen.getByRole('button', { name: 'Створити' });
    fireEvent.click(confirm); fireEvent.click(confirm);
    await screen.findByText('Передача на backup-сервер');
    expect(fetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
    const post = fetch.mock.calls.find(([, options]) => options.method === 'POST')[1];
    expect(post.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/); expect(post.headers['X-Avku-Backup']).toBe('manual');
  });
  it('denies unauthenticated external access and shows a clear message', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json({ error: 'Для резервного копіювання увійдіть через Cloudflare Access.' }, 401)));
    render(<CertificateBackups />);
    await screen.findByRole('alert'); expect(screen.getByRole('button', { name: 'Створити резервну копію' }).disabled).toBe(true);
  });
  it('retains the same idempotency key after a lost HTTP acknowledgement and reload', async () => {
    const key = '5b7ff1a3-79d2-4511-92f5-daa0b501b7df'; sessionStorage.setItem('avku-certificate-backup-idem', key);
    const fetch = vi.fn((url, options) => options.method ? Promise.reject(new Error('network interruption')) : json(empty));
    vi.stubGlobal('fetch', fetch);
    render(<CertificateBackups />);
    const button = await screen.findByRole('button', { name: 'Створити резервну копію' }); await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button); fireEvent.click(screen.getByRole('button', { name: 'Створити' }));
    await screen.findByText('network interruption');
    expect(fetch.mock.calls.find(([, options]) => options.method === 'POST')[1].headers['Idempotency-Key']).toBe(key);
    expect(sessionStorage.getItem('avku-certificate-backup-idem')).toBe(key);
  });
  it('shows both committed backups, dates and sizes', async () => {
    const succeeded = { ...job, status: 'succeeded', remote: { committedAt: '2026-10-06T12:01:00Z' } };
    vi.stubGlobal('fetch', vi.fn(() => json({ ...empty, jobs: [succeeded], lastSuccessful: succeeded,
      slots: [1, 2].map(n => ({ slot: `slot-${n}`, jobId: `job-${n}`, snapshotAt: '2026-10-06T12:00:00Z', verifiedAt: '2026-10-06T12:01:00Z', size: 1048576 })) })));
    render(<CertificateBackups />);
    await screen.findByText('Резервну копію створено і перевірено');
    expect(screen.getByText('slot-1')).toBeTruthy(); expect(screen.getByText('slot-2')).toBeTruthy();
    expect(screen.getAllByText('1.00 MiB')).toHaveLength(2);
  });
});
