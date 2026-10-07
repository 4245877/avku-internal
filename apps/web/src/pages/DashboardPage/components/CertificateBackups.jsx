import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './CertificateBackups.module.css';

const API = `${(import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '')}/certificates/backups`;
const stages = {
  accepted: 'Запит прийнято', capturing: 'Копіювання реєстру та фотографій', validating: 'Перевірка файлів',
  packaging: 'Створення архіву', uploading: 'Збереження резервної копії',
  remote_verifying: 'Перевірка резервної копії', publishing: 'Завершення збереження', cleaning: 'Завершення операції',
  succeeded: 'Резервну копію створено і перевірено', failed: 'Операція завершилася помилкою',
  interrupted: 'Операцію перервано', reconciling: 'Уточнення результату після переривання',
  needs_attention: 'Потрібна перевірка адміністратором',
};
const errors = {
  REMOTE_ACK_UNCONFIRMED: 'Перевіряємо результат збереження. Новий запуск тимчасово заблоковано.',
  REMOTE_INVENTORY_UNAVAILABLE: 'Не вдалося отримати список збережених копій.',
  LOCAL_CLEANUP_FAILED: 'Не вдалося завершити очищення тимчасових файлів. Потрібна перевірка адміністратором.',
  API_RESTART_DURING_CAPTURE: 'Застосунок перезапустився під час копіювання. Попередні копії збережені.',
  CAPTURE_FAILED_CHECK_PHOTOS_RESOURCES_AND_SPACE: 'Не вдалося створити копію. Перевірте фотографії та вільне місце.',
  SUBPROCESS_FAILED: 'Не вдалося завершити резервне копіювання. Зверніться до адміністратора.',
  SSH_TRANSFER_FAILED: 'Передача копії не завершилася. Перевіряємо результат; новий запуск тимчасово заблоковано.',
  REMOTE_CANDIDATE_REJECTED: 'Копія не пройшла перевірку. Попередні копії збережені.',
  REMOTE_CLEANUP_PENDING: 'Завершуємо очищення тимчасових файлів. Новий запуск тимчасово заблоковано.',
};
const requestErrors = {
  401: 'Увійдіть у систему, щоб користуватися резервним копіюванням.',
  403: 'Запуск резервного копіювання з цієї сторінки недоступний.',
  409: 'Резервне копіювання вже виконується. Очікуйте завершення.',
  503: 'Резервне копіювання тимчасово недоступне.',
};
const requestError = cause => ({
  message: requestErrors[cause.status] || 'Не вдалося отримати відповідь. Перевірте з’єднання та спробуйте ще раз.',
  detail: cause.message,
});
const formatDate = value => value ? new Date(value).toLocaleString('uk-UA', {
  timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
}) : 'Ще немає';
const formatSize = value => Number.isFinite(value) ? `${(value / 1024 / 1024).toFixed(2)} MiB` : '—';

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
    } catch (cause) { setAccessError([401, 403, 503].includes(cause.status)); setError(requestError(cause)); }
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
    } catch (cause) { await refresh(); setError(requestError(cause)); }
    finally { requestInFlight.current = false; setSubmitting(false); }
  };
  const job = data?.activeJob || data?.jobs?.[0];
  const running = submitting || !!data?.activeJob;
  const lastSuccessfulAt = data?.lastSuccessful?.remote?.committedAt || data?.lastSuccessful?.snapshotAt || data?.lastSuccessful?.updatedAt;
  return (
    <section className={styles.card} aria-label="Резервне копіювання">
      <div className={styles.header}>
        <div className={styles.intro}>
          <h2 className={styles.title}>Резервне копіювання</h2>
          <p className={styles.description}>Копія містить усі збережені посвідчення, включно з чернетками та фотографіями. Незбережені зміни форми до копії не потраплять. Зберігаються дві останні успішні копії.</p>
        </div>
        <button className={styles.createButton} type="button" disabled={!data || accessError || running} aria-busy={running} onClick={() => setConfirmation(true)}>
          {running && <span className={styles.spinner} aria-hidden="true" />}
          {running ? 'Резервне копіювання виконується…' : 'Створити резервну копію'}
        </button>
      </div>
      {confirmation && !running && <div className={styles.confirmation} role="group" aria-label="Підтвердити резервне копіювання">
        <p>Створити резервну копію всього збереженого реєстру? Після перевірки вона замінить найстарішу з двох копій.</p>
        <div className={styles.confirmationActions}>
          <button className={styles.createButton} type="button" onClick={start} disabled={!data || accessError || running}>Створити</button>
          <button className={styles.cancelButton} type="button" onClick={() => setConfirmation(false)}>Скасувати</button>
        </div>
      </div>}
      <div aria-live="polite" aria-atomic="true">
        {(job || submitting) && <p className={`${styles.status} ${!running && job?.status === 'succeeded' ? styles.success : ''}`}>
          {submitting ? 'Запуск резервного копіювання…' : stages[job.status] || 'Очікуємо результат резервного копіювання'}
        </p>}
      </div>
      {job?.error && <p className={styles.error} role="alert">{errors[job.error] || 'Операція потребує перевірки адміністратором.'}</p>}
      {error && <p className={styles.error} role="alert">{error.message}</p>}
      <p className={styles.lastSuccessful}>Остання успішна копія: <strong>{!data ? 'Завантаження…' : formatDate(lastSuccessfulAt)}</strong></p>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption>Збережені резервні копії</caption>
          <thead><tr><th scope="col">Дата копії</th><th scope="col">Розмір</th><th scope="col">Перевірка</th></tr></thead>
          <tbody>{data?.slots?.length ? data.slots.map(slot => <tr key={slot.slot}>
            <td><time dateTime={slot.snapshotAt}>{slot.snapshotAt ? formatDate(slot.snapshotAt) : '—'}</time></td>
            <td>{formatSize(slot.size)}</td>
            <td><span className={slot.verifiedAt ? styles.verified : styles.verificationPending}>{slot.verifiedAt ? 'Перевірено' : 'Очікує перевірки'}</span></td>
          </tr>) : <tr><td className={styles.empty} colSpan={3}>{!data ? (error ? 'Список копій недоступний.' : 'Завантаження копій…') : 'Успішних копій ще немає.'}</td></tr>}</tbody>
        </table>
      </div>
      {(job || error || data?.checkedAt) && <details className={styles.details}>
        <summary>Деталі</summary>
        {job && <p>Job ID: <code>{job.id}</code></p>}
        {job?.error && <p>Код помилки: <code>{job.error}</code></p>}
        {error && <p>{error.detail}</p>}
        {data?.checkedAt && <p>Список перевірено: {formatDate(data.checkedAt)}</p>}
      </details>}
    </section>
  );
}
