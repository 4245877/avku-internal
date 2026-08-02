/**
 * Assign a filtered set of houses to one person.
 *
 * Handing a precinct to a team is 200 clicks otherwise, so this exists — but a
 * mass write is also the easiest way to damage a lot of records at once, so it
 * is deliberately three deliberate steps:
 *
 *   1. the set comes from the **current filter**, so what is affected is what is
 *      already on screen;
 *   2. the server returns a preview of the exact rows it would touch;
 *   3. the user types nothing but must press a confirm button, and the API
 *      refuses the request outright unless it carries `confirm: true`.
 *
 * The whole operation is one entry in the change journal, under one batch id.
 */

import { useEffect, useState } from 'react';

import {
  applyBulkAssignment,
  previewBulkAssignment,
} from '../../../features/elections/electionsApi.js';
import { ASSIGNMENT_ROLES } from '../../../features/elections/electionsTypes.js';
import { formatHouses } from '../../../features/elections/houseUtils.js';
import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import styles from '../ElectionsPage.module.css';

function BulkAssignDialog({ houses, campaignId, knownAssignees, onClose, onApplied }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('agitator');
  const [preview, setPreview] = useState(null);
  const [status, setStatus] = useState('idle');
  const [message, setMessage] = useState('');

  const houseIds = houses.map((house) => house.id);

  useEffect(() => {
    if (houseIds.length === 0) {
      setPreview(null);

      return undefined;
    }

    const controller = new AbortController();

    setStatus('loading');

    previewBulkAssignment(houseIds, { campaignId, signal: controller.signal })
      .then((result) => {
        setPreview(result);
        setStatus('idle');
      })
      .catch((error) => {
        if (error?.name === 'AbortError') {
          return;
        }

        setStatus('error');
        setMessage(error?.message ?? 'Не вдалося отримати попередній перегляд.');
      });

    return () => controller.abort();
    // The set is identified by its contents, not by the array's identity.
  }, [campaignId, houseIds.join(',')]);

  async function apply() {
    if (!email.trim()) {
      setMessage('Вкажіть пошту відповідального.');

      return;
    }

    setStatus('applying');
    setMessage('');

    try {
      const result = await applyBulkAssignment(
        { houseIds, employeeEmail: email.trim(), role },
        { campaignId },
      );

      setStatus('done');
      setMessage(
        `Призначено будинків: ${result.created}. Пропущено (вже призначені): ${result.skipped}.`,
      );
      onApplied?.();
    } catch (error) {
      setStatus('error');
      setMessage(error?.message ?? 'Не вдалося виконати масове призначення.');
    }
  }

  return (
    <section className={styles.bulkDialog} aria-label="Масове призначення">
      <header className={styles.importHeader}>
        <h2>
          <ElectionsIcon name="users" size={18} />
          Масове призначення
        </h2>

        <button
          aria-label="Закрити"
          className={styles.panelClose}
          onClick={onClose}
          type="button"
        >
          <ElectionsIcon name="close" size={18} />
        </button>
      </header>

      <p className={styles.bulkSummary}>
        Операція торкнеться <strong>{formatHouses(houseIds.length)}</strong> — це поточний
        результат фільтра. Змініть фільтри, щоб змінити набір.
      </p>

      <div className={styles.formGrid}>
        <label className={styles.formField}>
          <span>Відповідальний (пошта)</span>
          <input
            list="bulk-assignee-options"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@avku.org"
            type="email"
            value={email}
          />
          <datalist id="bulk-assignee-options">
            {knownAssignees.map((known) => (
              <option key={known} value={known} />
            ))}
          </datalist>
        </label>

        <label className={styles.formField}>
          <span>Роль у кампанії</span>
          <select onChange={(event) => setRole(event.target.value)} value={role}>
            {ASSIGNMENT_ROLES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {preview && (
        <div className={styles.bulkPreview}>
          <h3>Будуть змінені ({preview.affected})</h3>

          <ul>
            {preview.houses.map((house) => (
              <li key={house.id}>
                {house.address}
                {house.assignees.length > 0 && (
                  <small> · зараз: {house.assignees.join(', ')}</small>
                )}
              </li>
            ))}
          </ul>

          {preview.affected > preview.houses.length && (
            <p>
              …і ще {preview.affected - preview.houses.length}. Показано перші{' '}
              {preview.houses.length}.
            </p>
          )}
        </div>
      )}

      {message && (
        <p className={status === 'error' ? styles.legacyNoticeError : styles.legacyNoticeOk}>
          {message}
        </p>
      )}

      <div className={styles.importActions}>
        <button className={styles.ghostButton} onClick={onClose} type="button">
          Скасувати
        </button>

        <button
          className={styles.primaryButton}
          disabled={status === 'applying' || houseIds.length === 0}
          onClick={apply}
          type="button"
        >
          <ElectionsIcon name="check" size={16} />
          Підтвердити призначення {houseIds.length} буд.
        </button>
      </div>
    </section>
  );
}

export default BulkAssignDialog;
