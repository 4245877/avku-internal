import { useCallback, useEffect, useRef, useState } from 'react';

const API = `${(import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '')}/certificates/backups`;
const stages = {
  accepted: 'Запит прийнято', capturing: 'Копіювання реєстру та фотографій', validating: 'Перевірка файлів',
  packaging: 'Створення архіву', uploading: 'Передача на backup-сервер',
  remote_verifying: 'Перевірка на backup-сервері', publishing: 'Публікація у слот', cleaning: 'Очищення staging',
  succeeded: 'Резервну копію створено і перевірено', failed: 'Операція завершилася помилкою',
  interrupted: 'Операцію перервано', reconciling: 'Уточнення результату після переривання',
  needs_attention: 'Потрібна перевірка адміністратором',
};
const errors = {
  REMOTE_ACK_UNCONFIRMED: 'Не отримано підтвердження backup-сервера. Перевіряємо результат; повторний backup заблоковано.',
  REMOTE_INVENTORY_UNAVAILABLE: 'Не вдалося отримати список копій з backup-сервера.',
  LOCAL_CLEANUP_FAILED: 'Не вдалося очистити локальний staging. Потрібна перевірка адміністратором.',
  API_RESTART_DURING_CAPTURE: 'Застосунок перезапустився під час capture. Попередні remote-копії збережені.',
  CAPTURE_FAILED_CHECK_PHOTOS_RESOURCES_AND_SPACE: 'Не вдалося створити узгоджений snapshot. Перевірте фотографії, ресурси і вільне місце.',
  SUBPROCESS_FAILED: 'Операція з архівом або передачею не завершилася. Адміністратор може перевірити етап за job ID.',
  SSH_TRANSFER_FAILED: 'SSH/SFTP передача не завершилася. Перевіряємо підтвердження на backup-сервері; новий запуск тимчасово заблоковано.',
  REMOTE_CANDIDATE_REJECTED: 'Backup-сервер відхилив candidate. Попередні копії збережені.',
  REMOTE_CLEANUP_PENDING: 'На backup-сервері залишилися тимчасові файли операції. Новий запуск заблоковано до очищення.',
};
const formatDate = value => value ? new Date(value).toLocaleString('uk-UA') : 'Ще немає';
const formatSize = value => `${((value || 0) / 1024 / 1024).toFixed(2)} MiB`;

function idempotencyKey() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // The existing LAN HTTP entry point does not expose randomUUID in browsers.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || 'Помилка резервного копіювання.'); error.status = response.status; throw error; }
  return data;
}

export default function CertificateBackups() {
  const [data, setData] = useState(null), [error, setError] = useState(''), [submitting, setSubmitting] = useState(false);
  const [confirmation, setConfirmation] = useState(false), [accessError, setAccessError] = useState(false);
  const pendingKey = useRef(sessionStorage.getItem('avku-certificate-backup-idem'));
  const requestInFlight = useRef(false);
  const refresh = useCallback(async () => {
    try {
      const next = await jsonRequest(API);
      setData(next); setAccessError(false); setError('');
      if (pendingKey.current && next.jobs?.some(job => job.idempotencyKey === pendingKey.current)) {
        sessionStorage.removeItem('avku-certificate-backup-idem'); pendingKey.current = null;
      }
    } catch (cause) { setAccessError([401, 403, 503].includes(cause.status)); setError(cause.message); }
  }, []);
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 3000);
    return () => clearInterval(interval);
  }, [refresh]);
  const start = async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true; setSubmitting(true); setError(''); setConfirmation(false);
    try {
      if (!pendingKey.current) { pendingKey.current = idempotencyKey(); sessionStorage.setItem('avku-certificate-backup-idem', pendingKey.current); }
      const accepted = await jsonRequest(API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Avku-Backup': 'manual', 'Idempotency-Key': pendingKey.current }, body: '{}' });
      setData(previous => ({ ...previous, activeJob: accepted.job, jobs: [accepted.job, ...(previous?.jobs || [])] }));
      pendingKey.current = null; sessionStorage.removeItem('avku-certificate-backup-idem');
      await refresh();
    } catch (cause) { await refresh(); setError(cause.message); }
    finally { requestInFlight.current = false; setSubmitting(false); }
  };
  const job = data?.activeJob || data?.jobs?.[0];
  return (
    <section aria-label="Резервне копіювання" style={{ border: '1px solid #cbd5e1', borderRadius: 12, padding: 20, marginBottom: 20 }}>
      <h2>Резервне копіювання</h2>
      <p>Копія містить усі збережені посвідчення, включно з чернетками. Незбережені зміни форми до копії не потраплять. На сервері зберігаються максимум дві останні успішні копії.</p>
      <button type="button" disabled={!data || accessError || submitting || !!data.activeJob} onClick={() => setConfirmation(true)}>
        {submitting || data?.activeJob ? 'Резервне копіювання виконується…' : 'Створити резервну копію'}
      </button>
      {confirmation && <div role="dialog" aria-modal="true" aria-label="Підтвердити резервне копіювання">
        <p>Створити резервну копію всього збереженого реєстру? Після перевірки вона замінить найстарішу з двох копій.</p>
        <button type="button" onClick={start} disabled={submitting}>Створити</button>{' '}
        <button type="button" onClick={() => setConfirmation(false)}>Скасувати</button>
      </div>}
      <p>Остання успішна копія: {formatDate(data?.lastSuccessful?.remote?.committedAt)}</p>
      {job && <div aria-live="polite"><p>{stages[job.status] || job.status}</p><p>Job ID: <code>{job.id}</code></p>
        {job.error && <p role="alert">{errors[job.error] || 'Операція потребує перевірки адміністратором.'} Код: {job.error}</p>}
      </div>}
      {error && <p role="alert">{error}</p>}
      {data?.slots?.length > 0 && <table><caption>Завершені копії на backup-сервері</caption>
        <thead><tr><th>Слот</th><th>Snapshot</th><th>Розмір</th><th>Перевірка</th></tr></thead>
        <tbody>{data.slots.map(slot => <tr key={slot.slot}><td>{slot.slot}<br/><code>{slot.jobId}</code></td><td>{formatDate(slot.snapshotAt)}</td><td>{formatSize(slot.size)}</td><td>SHA-256 підтверджено<br/>{formatDate(slot.verifiedAt)}</td></tr>)}</tbody>
      </table>}
      {data?.checkedAt && <p>Список перевірено: {formatDate(data.checkedAt)}</p>}
    </section>
  );
}
