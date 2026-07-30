/**
 * Edit form for one house's survey data.
 *
 * The whole record is edited as a single controlled draft and submitted in one
 * call, which is exactly the shape a `PATCH /houses/:id/details` request needs.
 * The parent keys this component by house id, so switching houses always starts
 * from a clean draft.
 */

import { useMemo, useState } from 'react';

import {
  CANVASS_STATUSES,
  PRIORITIES,
} from '../../../features/elections/electionsTypes.js';
import { formatNumber } from '../../../features/elections/houseUtils.js';
import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import ContactsFieldset from './ContactsFieldset.jsx';
import ResidentsFieldset from './ResidentsFieldset.jsx';
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

function validate(draft) {
  const errors = {};

  const countFields = [
    ['entrances', 'Кількість підʼїздів', 60],
    ['apartments', 'Кількість квартир', 2000],
    ['residentsCount', 'Кількість мешканців', 6000],
    ['householdsCount', 'Кількість домогосподарств', 2000],
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

  for (const contact of draft.contacts) {
    if (!contact.value.trim()) {
      errors.contacts = 'Заповніть або видаліть порожні контакти.';
      break;
    }
  }

  for (const resident of draft.residents) {
    if (!resident.name.trim()) {
      errors.residents = 'У кожного мешканця має бути імʼя, або видаліть рядок.';
      break;
    }
  }

  return errors;
}

function HouseEditForm({ house, onCancel, onSubmit, isSaving, saveError }) {
  const [draft, setDraft] = useState(() => ({ ...house.details }));
  const [wasSubmitted, setWasSubmitted] = useState(false);

  const errors = useMemo(() => validate(draft), [draft]);
  const errorList = Object.values(errors);
  const showErrors = wasSubmitted && errorList.length > 0;

  function updateDraft(patch) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function handleSubmit(event) {
    event.preventDefault();
    setWasSubmitted(true);

    if (Object.keys(errors).length > 0) {
      return;
    }

    onSubmit({
      ...draft,
      accessNote: draft.accessNote.trim(),
      notes: draft.notes.trim(),
      updatedBy: draft.updatedBy.trim(),
      residents: draft.residents.map((resident) => ({
        ...resident,
        name: resident.name.trim(),
        apartment: resident.apartment.trim(),
        note: resident.note.trim(),
      })),
      contacts: draft.contacts.map((contact) => ({
        ...contact,
        value: contact.value.trim(),
        label: contact.label.trim(),
      })),
    });
  }

  return (
    <form className={styles.editForm} noValidate onSubmit={handleSubmit}>
      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>
          <ElectionsIcon name="door" size={16} />
          Будинок
        </h3>

        <div className={styles.formGrid}>
          <label className={styles.formField}>
            <span>Кількість підʼїздів</span>
            <input
              inputMode="numeric"
              onChange={(event) => updateDraft({ entrances: parseCount(event.target.value) })}
              placeholder={`Оціночно ${house.estimate.entrances}`}
              type="text"
              value={toInputValue(draft.entrances)}
            />
            {errors.entrances && showErrors && (
              <em className={styles.fieldError}>{errors.entrances}</em>
            )}
          </label>

          <label className={styles.formField}>
            <span>Квартир, орієнтовно</span>
            <input
              inputMode="numeric"
              onChange={(event) => updateDraft({ apartments: parseCount(event.target.value) })}
              placeholder={`Оціночно ${house.estimate.apartments}`}
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
              placeholder={`Оціночно ${house.estimate.residents}`}
              type="text"
              value={toInputValue(draft.residentsCount)}
            />
            {errors.residentsCount && showErrors && (
              <em className={styles.fieldError}>{errors.residentsCount}</em>
            )}
          </label>

          <label className={styles.formField}>
            <span>Домогосподарств</span>
            <input
              inputMode="numeric"
              onChange={(event) =>
                updateDraft({ householdsCount: parseCount(event.target.value) })
              }
              placeholder="Скільки квартир заселено"
              type="text"
              value={toInputValue(draft.householdsCount)}
            />
            {errors.householdsCount && showErrors && (
              <em className={styles.fieldError}>{errors.householdsCount}</em>
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
        </div>
      </div>

      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>
          <ElectionsIcon name="list" size={16} />
          Стан обходу
        </h3>

        <div className={styles.formGrid}>
          <label className={styles.formField}>
            <span>Статус</span>
            <select
              onChange={(event) => updateDraft({ canvassStatus: event.target.value })}
              value={draft.canvassStatus}
            >
              {CANVASS_STATUSES.map((status) => (
                <option key={status.id} value={status.id}>
                  {status.label}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.formField}>
            <span>Пріоритет</span>
            <select
              onChange={(event) => updateDraft({ priority: event.target.value })}
              value={draft.priority}
            >
              {PRIORITIES.map((priority) => (
                <option key={priority.id} value={priority.id}>
                  {priority.label}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.formField}>
            <span>Дата обходу</span>
            <input
              onChange={(event) => updateDraft({ surveyedAt: event.target.value })}
              type="date"
              value={draft.surveyedAt}
            />
          </label>

          <label className={styles.formField}>
            <span>Хто вносив дані</span>
            <input
              onChange={(event) => updateDraft({ updatedBy: event.target.value })}
              placeholder="Імʼя координатора"
              type="text"
              value={draft.updatedBy}
            />
          </label>
        </div>
      </div>

      <ResidentsFieldset
        onChange={(residents) => updateDraft({ residents })}
        residents={draft.residents}
      />

      <ContactsFieldset
        contacts={draft.contacts}
        onChange={(contacts) => updateDraft({ contacts })}
      />

      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>
          <ElectionsIcon name="note" size={16} />
          Нотатки та додаткова інформація
        </h3>

        <label className={styles.formField}>
          <span className="sr-only">Нотатки</span>
          <textarea
            onChange={(event) => updateDraft({ notes: event.target.value })}
            placeholder="Настрої мешканців, зручний час обходу, локальні проблеми, домовленості…"
            rows="4"
            value={draft.notes}
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
