/**
 * Repeatable editor for known residents of a house.
 *
 * Rows are owned by the parent form: this component only ever calls
 * `onChange` with the next array, which keeps the whole form a single
 * controlled value that is easy to submit to an API later.
 */

import {
  AGE_GROUPS,
  SUPPORT_STANCES,
  createEmptyResident,
} from '../../../features/elections/electionsTypes.js';
import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import styles from '../ElectionsPage.module.css';

function ResidentsFieldset({ residents, onChange }) {
  function updateResident(id, patch) {
    onChange(
      residents.map((resident) =>
        resident.id === id ? { ...resident, ...patch } : resident,
      ),
    );
  }

  function removeResident(id) {
    onChange(residents.filter((resident) => resident.id !== id));
  }

  return (
    <fieldset className={styles.fieldset}>
      <legend className={styles.fieldsetLegend}>
        <ElectionsIcon name="users" size={16} />
        Мешканці
        <span className={styles.fieldsetCount}>{residents.length}</span>
      </legend>

      {residents.length === 0 && (
        <p className={styles.fieldsetEmpty}>
          Даних про мешканців ще немає. Додайте контактну особу, старосту підʼїзду
          або будь-кого, з ким уже вдалося поговорити.
        </p>
      )}

      <ul className={styles.repeatableList}>
        {residents.map((resident, index) => (
          <li className={styles.repeatableRow} key={resident.id}>
            <div className={styles.repeatableHeader}>
              <span className={styles.repeatableIndex}>№{index + 1}</span>

              <button
                aria-label={`Видалити мешканця №${index + 1}`}
                className={styles.iconButton}
                onClick={() => removeResident(resident.id)}
                type="button"
              >
                <ElectionsIcon name="trash" size={16} />
              </button>
            </div>

            <div className={styles.formGrid}>
              <label className={styles.formField}>
                <span>Імʼя та прізвище</span>
                <input
                  onChange={(event) =>
                    updateResident(resident.id, { name: event.target.value })
                  }
                  placeholder="Наприклад, Коваленко Олена"
                  type="text"
                  value={resident.name}
                />
              </label>

              <label className={`${styles.formField} ${styles.formFieldNarrow}`}>
                <span>Квартира</span>
                <input
                  inputMode="numeric"
                  onChange={(event) =>
                    updateResident(resident.id, { apartment: event.target.value })
                  }
                  placeholder="12"
                  type="text"
                  value={resident.apartment}
                />
              </label>

              <label className={styles.formField}>
                <span>Позиція</span>
                <select
                  onChange={(event) =>
                    updateResident(resident.id, { stance: event.target.value })
                  }
                  value={resident.stance}
                >
                  {SUPPORT_STANCES.map((stance) => (
                    <option key={stance.id} value={stance.id}>
                      {stance.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className={styles.formField}>
                <span>Вік</span>
                <select
                  onChange={(event) =>
                    updateResident(resident.id, { ageGroup: event.target.value })
                  }
                  value={resident.ageGroup}
                >
                  {AGE_GROUPS.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className={`${styles.formField} ${styles.formFieldWide}`}>
                <span>Примітка</span>
                <input
                  onChange={(event) =>
                    updateResident(resident.id, { note: event.target.value })
                  }
                  placeholder="Зручний час для контакту, роль у будинку…"
                  type="text"
                  value={resident.note}
                />
              </label>
            </div>
          </li>
        ))}
      </ul>

      <button
        className={styles.addRowButton}
        onClick={() => onChange([...residents, createEmptyResident()])}
        type="button"
      >
        <ElectionsIcon name="plus" size={16} />
        Додати мешканця
      </button>
    </fieldset>
  );
}

export default ResidentsFieldset;
