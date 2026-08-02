/**
 * Import review.
 *
 * The pipeline the request specifies, made visible: a file becomes rows, the
 * rows are normalised *beside* their originals, ambiguous ones are held back,
 * a person decides each one, and only then is anything written — in a single
 * transaction, reversible by batch id.
 *
 * Three properties this screen has to preserve, and does:
 *
 *  • a row that matched nothing is shown, not dropped;
 *  • a doubtful match is never applied without a choice;
 *  • the batch can be rolled back completely after the fact.
 */

import { useEffect, useState } from 'react';

import {
  applyImportBatch,
  createImportBatch,
  fetchImportBatch,
  fetchImportBatches,
  rollbackImportBatch,
  setImportDecisions,
} from '../../../features/elections/electionsApi.js';
import { formatUpdatedAt } from '../../../features/elections/houseUtils.js';
import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import styles from '../ElectionsPage.module.css';

const ROW_STATUS_LABELS = {
  pending: 'Очікує',
  ready: 'Готово',
  needs_review: 'Потрібне рішення',
  applied: 'Застосовано',
  skipped: 'Пропущено',
  failed: 'Помилка',
};

const BATCH_STATUS_LABELS = {
  draft: 'Чернетка',
  previewed: 'Попередній перегляд',
  applied: 'Застосовано',
  rolled_back: 'Відкочено',
  failed: 'Помилка',
};

/**
 * Parses a CSV file into row objects.
 *
 * Deliberately small: the server keeps the original text of every row, so this
 * only has to be good enough to *show* the file. Anything it misreads is
 * visible next to the original in the preview, where a person can catch it.
 */
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());

  if (lines.length < 2) {
    return [];
  }

  const separator = lines[0].includes(';') ? ';' : ',';
  const headers = lines[0].split(separator).map((header) => header.trim().replace(/^"|"$/g, ''));

  return lines.slice(1).map((line) => {
    const cells = line.split(separator);

    return Object.fromEntries(
      headers.map((header, index) => [
        header,
        (cells[index] ?? '').trim().replace(/^"|"$/g, ''),
      ]),
    );
  });
}

function ImportPanel({ campaignId, onClose }) {
  const [batches, setBatches] = useState([]);
  const [batch, setBatch] = useState(null);
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState('idle');
  const [message, setMessage] = useState('');
  const [report, setReport] = useState(null);

  useEffect(() => {
    fetchImportBatches()
      .then(setBatches)
      .catch((error) => setMessage(error?.message ?? 'Не вдалося завантажити партії.'));
  }, []);

  async function openBatch(batchId) {
    setStatus('loading');

    try {
      const payload = await fetchImportBatch(batchId);

      setBatch(payload.batch);
      setRows(payload.rows);
      setReport(payload.batch.report ?? null);
      setStatus('idle');
      setMessage('');
    } catch (error) {
      setStatus('error');
      setMessage(error?.message ?? 'Не вдалося відкрити партію.');
    }
  }

  async function handleFile(file) {
    setStatus('uploading');
    setMessage('');

    try {
      const text = await file.text();
      const isJson = file.name.endsWith('.json');
      const payload = isJson
        ? { kind: 'legacy_local', fileName: file.name, document: JSON.parse(text) }
        : { kind: 'csv', fileName: file.name, rows: parseCsv(text) };

      const created = await createImportBatch(payload, { campaignId });

      setBatch(created.batch);
      setRows(created.rows);
      setBatches((current) => [created.batch, ...current]);
      setStatus('idle');
      setMessage(
        `Файл прийнято. Рядків: ${created.batch.totalRows}. ` +
          `Очищено заборонених полів: ${created.batch.cleanedFieldsCount}.`,
      );
    } catch (error) {
      setStatus('error');
      setMessage(error?.message ?? 'Не вдалося прочитати файл.');
    }
  }

  function changeDecision(rowId, decision) {
    setRows((current) =>
      current.map((row) => (row.id === rowId ? { ...row, decision } : row)),
    );
  }

  async function saveDecisions() {
    setStatus('saving');

    try {
      await setImportDecisions(
        batch.id,
        rows
          .filter((row) => row.status !== 'applied')
          .map((row) => ({
            rowId: row.id,
            decision: row.decision ?? 'review',
            matchHouseId: row.matchHouseId,
          })),
      );

      await openBatch(batch.id);
      setMessage('Рішення збережено.');
    } catch (error) {
      setStatus('error');
      setMessage(error?.message ?? 'Не вдалося зберегти рішення.');
    }
  }

  async function apply() {
    const confirmed = window.confirm(
      'Застосувати партію? Записи буде створено однією транзакцією. ' +
        'Операцію можна повністю відкотити за номером партії.',
    );

    if (!confirmed) {
      return;
    }

    setStatus('applying');

    try {
      const result = await applyImportBatch(batch.id, { campaignId });

      setReport(result.report);
      setBatch(result.batch);
      await openBatch(batch.id);
      setMessage('Партію застосовано.');
    } catch (error) {
      setStatus('error');
      setMessage(error?.message ?? 'Не вдалося застосувати партію.');
    }
  }

  async function rollback() {
    const confirmed = window.confirm(
      'Відкотити всю партію? Створені записи буде вилучено, оновлені — повернуто ' +
        'до попередніх значень.',
    );

    if (!confirmed) {
      return;
    }

    setStatus('rolling-back');

    try {
      const result = await rollbackImportBatch(batch.id);

      setBatch(result.batch);
      await openBatch(batch.id);
      setMessage(`Відкочено записів: ${result.reverted}.`);
    } catch (error) {
      setStatus('error');
      setMessage(error?.message ?? 'Не вдалося відкотити партію.');
    }
  }

  const needsReview = rows.filter((row) => row.status === 'needs_review').length;

  return (
    <section className={styles.importPanel} aria-label="Імпорт даних">
      <header className={styles.importHeader}>
        <h2>
          <ElectionsIcon name="layers" size={18} />
          Імпорт даних
        </h2>

        <button
          aria-label="Закрити імпорт"
          className={styles.panelClose}
          onClick={onClose}
          type="button"
        >
          <ElectionsIcon name="close" size={18} />
        </button>
      </header>

      <div className={styles.importUpload}>
        <label className={styles.primaryButton}>
          <ElectionsIcon name="plus" size={16} />
          Завантажити файл (CSV або експорт браузера)
          <input
            accept=".csv,.json,text/csv,application/json"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];

              if (file) {
                handleFile(file);
              }

              event.target.value = '';
            }}
            type="file"
          />
        </label>

        {batches.length > 0 && (
          <label className={styles.selectField}>
            <span className="sr-only">Попередні партії</span>
            <select
              onChange={(event) => event.target.value && openBatch(event.target.value)}
              value={batch?.id ?? ''}
            >
              <option value="">Відкрити попередню партію…</option>
              {batches.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.fileName || item.kind} · {BATCH_STATUS_LABELS[item.status] ?? item.status}{' '}
                  · {formatUpdatedAt(item.createdAt)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {message && (
        <p className={status === 'error' ? styles.legacyNoticeError : styles.legacyNoticeOk}>
          {message}
        </p>
      )}

      {batch && (
        <>
          <dl className={styles.importSummary}>
            <div>
              <dt>Партія</dt>
              <dd>
                <code>{batch.id}</code>
              </dd>
            </div>
            <div>
              <dt>Стан</dt>
              <dd>{BATCH_STATUS_LABELS[batch.status] ?? batch.status}</dd>
            </div>
            <div>
              <dt>Рядків</dt>
              <dd>{batch.totalRows}</dd>
            </div>
            <div>
              <dt>Очищено полів</dt>
              <dd>{batch.cleanedFieldsCount}</dd>
            </div>
            <div>
              <dt>Потребує рішення</dt>
              <dd>{needsReview}</dd>
            </div>
          </dl>

          {report && (
            <dl className={styles.importSummary}>
              <div>
                <dt>Створено</dt>
                <dd>{report.created}</dd>
              </div>
              <div>
                <dt>Оновлено</dt>
                <dd>{report.updated}</dd>
              </div>
              <div>
                <dt>Обʼєднано</dt>
                <dd>{report.merged}</dd>
              </div>
              <div>
                <dt>Пропущено</dt>
                <dd>{report.skipped}</dd>
              </div>
              <div>
                <dt>Потребує перевірки</dt>
                <dd>{report.needsReview}</dd>
              </div>
            </dl>
          )}

          {report?.unmatchedAddresses?.length > 0 && (
            <div className={styles.importUnmatched}>
              <h3>Не зіставлені рядки — дані не втрачено</h3>
              <ul>
                {report.unmatchedAddresses.slice(0, 50).map((address, index) => (
                  <li key={`${address}-${index}`}>{address}</li>
                ))}
              </ul>
            </div>
          )}

          <div className={styles.importActions}>
            {batch.status !== 'applied' && batch.status !== 'rolled_back' && (
              <>
                <button className={styles.ghostButton} onClick={saveDecisions} type="button">
                  Зберегти рішення
                </button>
                <button className={styles.primaryButton} onClick={apply} type="button">
                  Застосувати партію
                </button>
              </>
            )}

            {batch.status === 'applied' && (
              <button className={styles.dangerButton} onClick={rollback} type="button">
                <ElectionsIcon name="refresh" size={16} />
                Відкотити всю партію
              </button>
            )}
          </div>

          <div className={styles.importRows}>
            <table>
              <thead>
                <tr>
                  <th>№</th>
                  <th>Розпізнано</th>
                  <th>Збіг</th>
                  <th>Зауваження</th>
                  <th>Рішення</th>
                </tr>
              </thead>

              <tbody>
                {rows.slice(0, 300).map((row) => (
                  <tr
                    className={row.status === 'needs_review' ? styles.importRowReview : ''}
                    key={row.id}
                  >
                    <td>{row.rowNumber}</td>
                    <td>
                      <strong>{row.normalized?.addressText || '—'}</strong>
                      <small>
                        {row.normalized?.contactName
                          ? `контакт: ${row.normalized.contactName}`
                          : ''}
                        {row.normalized?.phoneNormalized
                          ? ` · ${row.normalized.phoneNormalized}`
                          : ''}
                      </small>
                    </td>
                    <td>
                      {row.matchHouseId ? (
                        <span className={`${styles.badge} ${styles.badgeSuccess}`}>
                          {row.matchConfidence || 'збіг'}
                        </span>
                      ) : (
                        <span className={`${styles.badge} ${styles.badgeWarning}`}>
                          немає
                        </span>
                      )}
                    </td>
                    <td>
                      <ul className={styles.importNotes}>
                        {row.notes.map((note, index) => (
                          <li key={index}>{note}</li>
                        ))}
                      </ul>
                    </td>
                    <td>
                      {row.status === 'applied' ? (
                        ROW_STATUS_LABELS.applied
                      ) : (
                        <select
                          onChange={(event) => changeDecision(row.id, event.target.value)}
                          value={row.decision ?? 'review'}
                        >
                          <option value="merge" disabled={!row.matchHouseId}>
                            Обʼєднати з будинком
                          </option>
                          <option value="skip">Пропустити</option>
                          <option value="review">Залишити на перевірці</option>
                        </select>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

export default ImportPanel;
