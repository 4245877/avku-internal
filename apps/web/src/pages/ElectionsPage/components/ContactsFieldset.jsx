/**
 * Repeatable editor for a house's contact details.
 */

import {
  CONTACT_TYPES,
  contactTypesById,
  createEmptyContact,
} from '../../../features/elections/electionsTypes.js';
import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import styles from '../ElectionsPage.module.css';

const placeholders = {
  phone: '+380 67 123 45 67',
  viber: '+380 67 123 45 67',
  telegram: '@nickname',
  email: 'name@example.com',
  other: 'Спосіб звʼязку',
};

function ContactsFieldset({ contacts, onChange }) {
  function updateContact(id, patch) {
    onChange(contacts.map((contact) => (contact.id === id ? { ...contact, ...patch } : contact)));
  }

  return (
    <fieldset className={styles.fieldset}>
      <legend className={styles.fieldsetLegend}>
        <ElectionsIcon name="contacts" size={16} />
        Контактні дані
        <span className={styles.fieldsetCount}>{contacts.length}</span>
      </legend>

      {contacts.length === 0 && (
        <p className={styles.fieldsetEmpty}>
          Контактів ще немає. Додайте телефон старости, голови ОСББ або будь-який
          інший канал звʼязку з будинком.
        </p>
      )}

      <ul className={styles.repeatableList}>
        {contacts.map((contact, index) => (
          <li className={styles.repeatableRow} key={contact.id}>
            <div className={styles.repeatableHeader}>
              <span className={styles.repeatableIndex}>
                <ElectionsIcon
                  name={contactTypesById[contact.type]?.icon ?? 'link'}
                  size={15}
                />
                Контакт {index + 1}
              </span>

              <button
                aria-label={`Видалити контакт ${index + 1}`}
                className={styles.iconButton}
                onClick={() => onChange(contacts.filter((item) => item.id !== contact.id))}
                type="button"
              >
                <ElectionsIcon name="trash" size={16} />
              </button>
            </div>

            <div className={styles.formGrid}>
              <label className={styles.formField}>
                <span>Тип</span>
                <select
                  onChange={(event) => updateContact(contact.id, { type: event.target.value })}
                  value={contact.type}
                >
                  {CONTACT_TYPES.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className={styles.formField}>
                <span>Значення</span>
                <input
                  onChange={(event) => updateContact(contact.id, { value: event.target.value })}
                  placeholder={placeholders[contact.type] ?? placeholders.other}
                  type={contactTypesById[contact.type]?.inputType ?? 'text'}
                  value={contact.value}
                />
              </label>

              <label className={`${styles.formField} ${styles.formFieldWide}`}>
                <span>Кому належить</span>
                <input
                  onChange={(event) => updateContact(contact.id, { label: event.target.value })}
                  placeholder="Наприклад, голова ОСББ"
                  type="text"
                  value={contact.label}
                />
              </label>
            </div>
          </li>
        ))}
      </ul>

      <button
        className={styles.addRowButton}
        onClick={() => onChange([...contacts, createEmptyContact()])}
        type="button"
      >
        <ElectionsIcon name="plus" size={16} />
        Додати контакт
      </button>
    </fieldset>
  );
}

export default ContactsFieldset;
