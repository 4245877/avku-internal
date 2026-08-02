/**
 * The rescue path for work that only exists in this browser.
 *
 * If `avku-elections-details-v1` is present, somebody entered data here before
 * the backend existed and that entry may be the only copy of it. The banner
 * appears until it has been dealt with, and it offers the two steps in the only
 * safe order:
 *
 *   1. **Download the file.** Always available, always first. Nothing else in
 *      the module can run until there is a copy outside the browser.
 *   2. **Send it to the server**, where it becomes an import batch that a person
 *      reviews row by row — it is not applied by pressing this button.
 *
 * The original key is never deleted automatically. Clearing it is a separate,
 * explicitly confirmed action that only becomes available after the server has
 * accepted the data.
 */

import { useState } from 'react';

import {
  downloadLegacyExport,
  forgetLegacyData,
  inspectLegacyData,
  recordLegacyMigration,
} from '../../../features/elections/legacyLocalData.js';
import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import styles from '../ElectionsPage.module.css';

function LegacyDataNotice({ canImport, onUpload }) {
  const [stats, setStats] = useState(() => inspectLegacyData());
  const [status, setStatus] = useState('idle');
  const [message, setMessage] = useState('');
  const [batchId, setBatchId] = useState(null);
  const [isDismissed, setIsDismissed] = useState(false);

  if (!stats.isPresent || isDismissed) {
    return null;
  }

  function handleExport() {
    const { isDownloaded } = downloadLegacyExport();

    setMessage(
      isDownloaded
        ? 'Файл збережено. Перевірте його перед перенесенням у базу.'
        : 'Не вдалося завантажити файл у цьому браузері.',
    );
  }

  async function handleUpload() {
    setStatus('uploading');
    setMessage('');

    // Exported again here rather than reusing the download: the file the user
    // saved and the payload the server receives must be the same bytes, and
    // this guarantees it even if the download was a while ago.
    const { document } = downloadLegacyExport();

    try {
      const batch = await onUpload(document);

      setBatchId(batch?.batch?.id ?? null);
      recordLegacyMigration(batch?.batch?.id ?? 'unknown');
      setStats(inspectLegacyData());
      setStatus('uploaded');
      setMessage(
        `Дані передано на сервер як партію імпорту. Рядків: ${
          batch?.batch?.totalRows ?? 0
        }. Відкрийте сторінку імпорту, щоб перевірити збіги та застосувати їх.`,
      );
    } catch (error) {
      setStatus('error');
      setMessage(error?.message ?? 'Не вдалося передати дані на сервер.');
    }
  }

  function handleForget() {
    const confirmed = window.confirm(
      'Видалити старі дані з цього браузера? Файл експорту та серверна копія ' +
        'залишаться. Цю дію не можна скасувати.',
    );

    if (!confirmed) {
      return;
    }

    const result = forgetLegacyData();

    setStats(inspectLegacyData());
    setMessage(
      result.isCleared
        ? 'Локальну копію видалено.'
        : 'Спочатку передайте дані на сервер.',
    );
  }

  return (
    <section className={styles.legacyNotice} role="region" aria-label="Старі локальні дані">
      <div className={styles.legacyNoticeMain}>
        <h2>
          <ElectionsIcon name="warning" size={17} />
          У цьому браузері є дані, яких немає на сервері
        </h2>

        <p>
          Ключ <code>avku-elections-details-v1</code> містить дані по{' '}
          <strong>{stats.houseCount}</strong> будинках: контактів —{' '}
          {stats.contactCount}, записів про мешканців — {stats.residentCount}, нотаток —{' '}
          {stats.notesCount}. Це може бути єдина копія вже виконаної роботи.
        </p>

        <p className={styles.legacyNoticeHint}>
          Спершу збережіть файл. Політичні позиції та вікові групи зі старих
          записів у базу не переносяться — імпорт їх відкидає й повідомляє лише
          кількість очищених полів.
        </p>

        {message && (
          <p
            className={status === 'error' ? styles.legacyNoticeError : styles.legacyNoticeOk}
            role="status"
          >
            {message}
          </p>
        )}

        {batchId && (
          <p className={styles.legacyNoticeOk}>
            Партія: <code>{batchId}</code>
          </p>
        )}
      </div>

      <div className={styles.legacyNoticeActions}>
        <button className={styles.primaryButton} onClick={handleExport} type="button">
          <ElectionsIcon name="layers" size={16} />
          Експортувати у файл
        </button>

        {canImport && (
          <button
            className={styles.ghostButton}
            disabled={status === 'uploading'}
            onClick={handleUpload}
            type="button"
          >
            <ElectionsIcon name="refresh" size={16} />
            {status === 'uploading' ? 'Передаємо…' : 'Передати на сервер'}
          </button>
        )}

        {stats.isMigrated && (
          <button className={styles.ghostButton} onClick={handleForget} type="button">
            <ElectionsIcon name="trash" size={16} />
            Прибрати з браузера
          </button>
        )}

        <button
          className={styles.linkButton}
          onClick={() => setIsDismissed(true)}
          type="button"
        >
          Приховати до наступного відкриття
        </button>
      </div>
    </section>
  );
}

export default LegacyDataNotice;
