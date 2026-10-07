// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import CertificateBackups from './CertificateBackups.jsx';

const job = { id: '95f2ceab-9a9e-436c-b52a-4ce897e89ca2', status: 'uploading', idempotencyKey: 'key', createdAt: '2026-10-06T12:00:00Z' };
const empty = { activeJob: null, jobs: [], lastSuccessful: null, slots: [], checkedAt: null };
const json = (data, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => data });
beforeEach(() => { sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

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
    expect(screen.getByRole('group', { name: 'Підтвердити резервне копіювання' })).toBeTruthy(); expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Скасувати' }));
    expect(screen.queryByRole('group', { name: 'Підтвердити резервне копіювання' })).toBeNull();
  });
  it('reload restores active job, disables creation and never claims success before commit', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json({ ...empty, activeJob: job, jobs: [job] })));
    const page = render(<CertificateBackups />);
    await screen.findByText('Збереження резервної копії');
    expect(screen.getByRole('button', { name: /виконується/ }).disabled).toBe(true);
    expect(screen.queryByText('Резервну копію створено і перевірено')).toBeNull();
    page.unmount(); render(<CertificateBackups />);
    await screen.findByText(job.id);
    expect(screen.getByRole('button', { name: /виконується/ }).disabled).toBe(true);
  });
  it('double-click submits once to the existing endpoint and blocks creation until verified completion', async () => {
    let state = empty;
    let acceptRequest;
    const fetch = vi.fn((url, options) => {
      if (options.method === 'POST') {
        state = { ...empty, activeJob: job, jobs: [job] };
        return new Promise(resolve => { acceptRequest = () => resolve({ ok: true, json: async () => ({ job }) }); });
      }
      return json(state);
    }); vi.stubGlobal('fetch', fetch);
    render(<CertificateBackups />);
    const button = await screen.findByRole('button', { name: 'Створити резервну копію' });
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button); const confirm = screen.getByRole('button', { name: 'Створити' });
    fireEvent.click(confirm); fireEvent.click(confirm);
    expect(screen.getByRole('button', { name: /виконується/ }).disabled).toBe(true);
    expect(screen.getByText('Запуск резервного копіювання…')).toBeTruthy();
    await act(async () => { acceptRequest(); });
    await screen.findByText('Збереження резервної копії');
    expect(fetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
    const [url, post] = fetch.mock.calls.find(([, options]) => options.method === 'POST');
    expect(url).toBe('/api/certificates/backups');
    expect(post).toMatchObject({ credentials: 'same-origin', cache: 'no-store', body: '{}', headers: { 'Content-Type': 'application/json', 'X-Avku-Backup': 'manual' } });
    expect(post.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.getByRole('button', { name: /виконується/ }).disabled).toBe(true);
    expect(screen.queryByText('Резервну копію створено і перевірено')).toBeNull();

    vi.useFakeTimers();
    const succeeded = { ...job, status: 'succeeded', remote: { committedAt: '2026-10-06T12:01:00Z' } };
    // Remount resumes read-only polling of the accepted job.
    cleanup();
    render(<CertificateBackups />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole('button', { name: /виконується/ }).disabled).toBe(true);
    state = { ...empty, jobs: [succeeded], lastSuccessful: succeeded };
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText('Резервну копію створено і перевірено')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Створити резервну копію' }).disabled).toBe(false);
    expect(fetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
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
    expect(screen.queryByText('slot-1')).toBeNull(); expect(screen.queryByText('slot-2')).toBeNull();
    expect(screen.getAllByText('1.00 MiB')).toHaveLength(2);
    const table = screen.getByRole('table', { name: 'Збережені резервні копії' });
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Дата копії', 'Розмір', 'Перевірка']);
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getAllByText('Перевірено')).toHaveLength(2);
    expect(within(table).getAllByText('06.10.2026, 15:00')).toHaveLength(2);
    expect(screen.getByText('06.10.2026, 15:01')).toBeTruthy();
    const details = screen.getByText('Деталі').closest('details');
    expect(details.open).toBe(false);
    expect(within(details).getByText(job.id)).toBeTruthy();
    expect(table.textContent).not.toMatch(/job-1|job-2|generation|publisher|SFTP|candidate|receipt/);
  });
  it('never resumes a manual submission from a saved key on mount, polling or remount', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem('avku-certificate-backup-idem', '5b7ff1a3-79d2-4511-92f5-daa0b501b7df');
    const fetch = vi.fn(() => json(empty));
    vi.stubGlobal('fetch', fetch);
    const page = render(<CertificateBackups />);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(fetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
    page.unmount();
    const callsBefore = fetch.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(fetch).toHaveBeenCalledTimes(callsBefore);
    render(<CertificateBackups />);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(fetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
  });
  it.each(['REMOTE_CANDIDATE_REJECTED', 'SSH_TRANSFER_FAILED', 'LOCAL_CLEANUP_FAILED'])('keeps %s diagnostics in closed details', async (code) => {
    vi.stubGlobal('fetch', vi.fn(() => json({ ...empty, jobs: [{ ...job, status: 'failed', error: code }] })));
    render(<CertificateBackups />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toMatch(/candidate|SFTP|staging|job ID|REMOTE_|SSH_|LOCAL_/);
    const details = screen.getByText('Деталі').closest('details');
    expect(details.open).toBe(false);
    expect(within(details).getByText(code)).toBeTruthy();
  });
  it('hides an active job ID included in a conflict response', async () => {
    const fetch = vi.fn((url, options) => options.method === 'POST'
      ? json({ error: `Резервне копіювання вже виконується: ${job.id}` }, 409) : json(empty));
    vi.stubGlobal('fetch', fetch);
    render(<CertificateBackups />);
    const button = await screen.findByRole('button', { name: 'Створити резервну копію' });
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button); fireEvent.click(screen.getByRole('button', { name: 'Створити' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Резервне копіювання вже виконується. Очікуйте завершення.');
    const details = screen.getByText('Деталі').closest('details');
    expect(details.open).toBe(false);
    expect(details.textContent).toContain(job.id);
  });
  it('does not claim verification when its date is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json({ ...empty, slots: [{ slot: 'slot-1', snapshotAt: job.createdAt, size: 1048576 }] })));
    render(<CertificateBackups />);
    await screen.findByText('Очікує перевірки');
    expect(screen.queryByText('Перевірено')).toBeNull();
  });
});
