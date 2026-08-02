/**
 * Edit form for one house.
 *
 * Split in two, because the record is two different things with two different
 * lifetimes and two different permissions:
 *
 *   **Характеристики будинку** — how many entrances it has, who manages it, how
 *   to get in. Permanent facts about the building; they do not change when a
 *   campaign starts or ends, and they go to `PATCH /houses/:id`.
 *
 *   **Стан у кампанії** — the stage, the priority and what is planned next.
 *   Specific to the campaign in view; they go to `PATCH /houses/:id/state` and
 *   leave any other campaign's record untouched.
 *
 * The old «Хто вносив дані» field is gone. It was free text, so it recorded
 * whatever somebody typed; the author now comes from the verified identity on
 * every write, and is visible in the Історія tab.
 */

import { useMemo, useState } from 'react';

import { PRIORITIES, WORK_STAGES } from '../../../features/elections/electionsTypes.js';
import { campaignStateOf, formatNumber } from '../../../features/elections/houseUtils.js';
import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import styles from '../ElectionsPage.module.css';

/**
 * Counts are whole, non-negative numbers, so anything else is stripped as it is
 * typed — the field can never end up showing `NaN`. An empty field means
 * "невідомо", not zero.
 */
function parseCount(rawValue) {
  const digits = rawValue.replace(/\D/g, '');

  return digits === '' ? null : Number(digits);
}

const toInputValue = (value) => (value === null || value === undefined ? '' : String(value));

/**
 * Client-side validation is a courtesy, not a guarantee — the API re-checks
 * every one of these bounds, because a form is not a trust boundary.
 */
function validate(draft) {
  const errors = {};

  const countFields = [
    ['entrances', 'Кількість підʼїздів', 60],
    ['apartments', 'Кількість квартир', 2000],
    ['residentsCount', 'Кількість мешканців', 6000],
    ['households', 'Кількість домогосподарств', 2000],
  ];

  for (const [field, label, max] of countFields) {
    const value = draft[field];

    if (value !== null && value > max) {
      errors[field] = `${label}: значення виглядає завеликим (до ${formatNumber(max)}).`;
    }
  }

  if (!errors.apartments && draft.apartments !== null && draft.entrances !== null) {
    if (draft.apartments < draft.entrances) {
      errors.apartments = 'Квартир не може бути менше, ніж підʼїздів.';
    }
  }

  return errors;
}

function toDateInput(isoValue) {
  return isoValue ? String(isoValue).slice(0, 10) : '';
}

function HouseEditForm({ house, onCancel, onSubmitAttributes, onSubmitState, isSaving, saveError }) {
  const state = campaignStateOf(house);

  const [draft, setDraft] = useState(() => ({
    entrances: house.entrances,
    apartments: house.apartments,
    residentsCount: house.residentsCount,
    households: house.households,
    accessNote: house.accessNote ?? '',
    managingOrg: house.managingOrg ?? '',
    verified: false,
  }));

  const [stateDraft, setStateDraft] = useState(() => ({
    stage: state.stage,
    priority: state.priority,
    priorityReason: state.priorityReason ?? '',
    summary: state.summary ?? '',
    nextActionAt: toDateInput(state.nextActionAt),
  }));

  const [wasSubmitted, setWasSubmitted] = useState(false);

  const errors = useMemo(() => validate(draft), [draft]);
  const errorList = Object.values(errors);
  const showErrors = wasSubmitted && errorList.length > 0;

  function updateDraft(patch) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function updateStateDraft(patch) {
    setStateDraft((current) => ({ ...current, ...patch }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setWasSubmitted(true);

    if (Object.keys(errors).length > 0) {
      return;
    }

    // Two requests, attributes first: if the second is refused (a role that may
    // record work but not edit the building, say), the first has still landed
    // and the user is told which half failed rather than losing both.
    const savedAttributes = await onSubmitAttributes({
      ...draft,
      accessNote: draft.accessNote.trim(),
      managingOrg: draft.managingOrg.trim(),
    });

    if (!savedAttributes) {
      return;
    }

    await onSubmitState({
      ...stateDraft,
      priorityReason: stateDraft.priorityReason.trim(),
      summary: stateDraft.summary.trim(),
      nextActionAt: stateDraft.nextActionAt
        ? new Date(`${stateDraft.nextActionAt}T12:00:00`).toISOString()
        : null,
    });
  }

  return (
    <form className={styles.editForm} noValidate onSubmit={handleSubmit}>
      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>
          <ElectionsIcon name="door" size={16} />
          Характеристики будинку
        </h3>

        <p className={styles.formSectionHint}>
          Постійні дані про будівлю. Вони не залежать від кампанії.
        </p>

        <div className={styles.formGrid}>
          <label className={styles.formField}>
            <span>Кількість підʼїздів</span>
            <input
              inputMode="numeric"
              onChange={(event) => updateDraft({ entrances: parseCount(event.target.value) })}
              placeholder={
                house.estimate?.entrances ? `Оціночно ${house.estimate.entrances}` : '—'
              }
              type="text"
              value={toInputValue(draft.entrances)}
            />
            {errors.entrances && showErrors && (
              <em className={styles.fieldError}>{errors.entrances}</em>
            )}
          </label>

          <label className={styles.formField}>
            <span>Кількість квартир</span>
            <input
              inputMode="numeric"
              onChange={(event) => updateDraft({ apartments: parseCount(event.target.value) })}
              placeholder={
                house.estimate?.apartments ? `Оціночно ${house.estimate.apartments}` : '—'
              }
              type="text"
              value={toInputValue(draft.apartments)}
            />
            {errors.apartments && showErrors && (
              <em className={styles.fieldError}>{errors.apartments}</em>
            )}
          </label>

          <label className={styles.formField}>
            <span>Мешканців, орієнтовно</span>
            <input
              inputMode="numeric"
              onChange={(event) =>
                updateDraft({ residentsCount: parseCount(event.target.value) })
              }
              placeholder={
                house.estimate?.residents ? `Оціночно ${house.estimate.residents}` : '—'
              }
              type="text"
              value={toInputValue(draft.residentsCount)}
            />
            {errors.residentsCount && showErrors && (
              <em className={styles.fieldError}>{errors.residentsCount}</em>
            )}
          </label>

          <label className={styles.formField}>
            <span>Заселених квартир</span>
            <input
              inputMode="numeric"
              onChange={(event) => updateDraft({ households: parseCount(event.target.value) })}
              placeholder="Скільки квартир заселено"
              type="text"
              value={toInputValue(draft.households)}
            />
            {errors.households && showErrors && (
              <em className={styles.fieldError}>{errors.households}</em>
            )}
          </label>

          <label className={`${styles.formField} ${styles.formFieldWide}`}>
            <span>Доступ до підʼїздів</span>
            <input
              onChange={(event) => updateDraft({ accessNote: event.target.value })}
              placeholder="Код домофона, консьєрж, закритий двір…"
              type="text"
              value={draft.accessNote}
            />
          </label>

          <label className={`${styles.formField} ${styles.formFieldWide}`}>
            <span>Керуюча організація</span>
            <input
              onChange={(event) => updateDraft({ managingOrg: event.target.value })}
              placeholder="ОСББ, ЖЕК, керуюча компанія"
              type="text"
              value={draft.managingOrg}
            />
          </label>
        </div>

        {/* The date and the author of a check are stamped by the server from the
            signed-in identity — there is deliberately no field for either. */}
        <label className={styles.checkboxField}>
          <input
            checked={draft.verified}
            onChange={(event) => updateDraft({ verified: event.target.checked })}
            type="checkbox"
          />
          <span>Я перевірив(ла) ці дані на місці — зафіксувати дату й автора перевірки</span>
        </label>
      </div>

      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>
          <ElectionsIcon name="list" size={16} />
          Стан у поточній кампанії
        </h3>

        <p className={styles.formSectionHint}>
          Стосується лише активної кампанії. Результати інших кампаній не змінюються.
        </p>

        <div className={styles.formGrid}>
          <label className={styles.formField}>
            <span>Етап роботи</span>
            <select
              onChange={(event) => updateStateDraft({ stage: event.target.value })}
              value={stateDraft.stage}
            >
              {WORK_STAGES.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.label}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.formField}>
            <span>Пріоритет</span>
            <select
              onChange={(event) => updateStateDraft({ priority: event.target.value })}
              value={stateDraft.priority}
            >
              {PRIORITIES.map((priority) => (
                <option key={priority.id} value={priority.id}>
                  {priority.label}
                </option>
              ))}
            </select>
          </label>

          <label className={`${styles.formField} ${styles.formFieldWide}`}>
            <span>Причина пріоритету</span>
            <input
              onChange={(event) => updateStateDraft({ priorityReason: event.target.value })}
              placeholder="Чому цей будинок важливіший за сусідній"
              type="text"
              value={stateDraft.priorityReason}
            />
          </label>

          <label className={styles.formField}>
            <span>Наступна дія</span>
            <input
              onChange={(event) => updateStateDraft({ nextActionAt: event.target.value })}
              type="date"
              value={stateDraft.nextActionAt}
            />
          </label>
        </div>

        <label className={styles.formField}>
          <span>Коротке резюме</span>
          <textarea
            onChange={(event) => updateStateDraft({ summary: event.target.value })}
            placeholder="Одне-два речення про поточний стан роботи з будинком"
            rows="3"
            value={stateDraft.summary}
          />
        </label>
      </div>

      {showErrors && (
        <div className={styles.formErrors} role="alert">
          <strong>
            <ElectionsIcon name="warning" size={16} />
            Виправте помилки перед збереженням
          </strong>

          <ul>
            {errorList.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      )}

      {saveError && (
        <p className={styles.formSaveError} role="alert">
          <ElectionsIcon name="warning" size={16} />
          {saveError}
        </p>
      )}

      <div className={styles.formActions}>
        <button
          className={styles.ghostButton}
          disabled={isSaving}
          onClick={onCancel}
          type="button"
        >
          Скасувати
        </button>

        <button className={styles.primaryButton} disabled={isSaving} type="submit">
          {isSaving ? (
            <>
              <span aria-hidden="true" className={styles.buttonSpinner} />
              Зберігаємо…
            </>
          ) : (
            <>
              <ElectionsIcon name="check" size={17} />
              Зберегти дані
            </>
          )}
        </button>
      </div>
    </form>
  );
}

export default HouseEditForm;
