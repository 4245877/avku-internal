import { useEffect, useMemo, useState } from 'react';

import {
  WAREHOUSE_CATEGORIES,
  createFormFromItem,
  getEmptyItemForm,
  hasValidationErrors,
  validateItemForm,
} from '../../../features/warehouse/warehouseUtils.js';
import styles from '../AidOperationsPage.module.css';

function WarehouseItemDialog({
  item,
  isOpen,
  isSaving,
  onClose,
  onSubmit,
}) {
  const isEdit = Boolean(item);
  const initialForm = useMemo(
    () => (item ? createFormFromItem(item) : getEmptyItemForm()),
    [item],
  );
  const [form, setForm] = useState(initialForm);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (isOpen) {
      setForm(initialForm);
      setErrors({});
    }
  }, [initialForm, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !isSaving) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSaving, onClose]);

  if (!isOpen) {
    return null;
  }

  const updateField = (field, value) => {
    setForm((currentForm) => ({
      ...currentForm,
      [field]: value,
    }));
    setErrors((currentErrors) => ({
      ...currentErrors,
      [field]: '',
    }));
  };

  const handleSubmit = (event) => {
    event.preventDefault();

    const nextErrors = validateItemForm(form);

    setErrors(nextErrors);

    if (hasValidationErrors(nextErrors)) {
      return;
    }

    onSubmit(form);
  };

  return (
    <div className={styles.modalBackdrop}>
      <section
        className={styles.formDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="warehouse-item-dialog-title"
      >
        <div className={styles.dialogHeader}>
          <p className={styles.eyebrow}>Склад / Позиція</p>
          <h2 id="warehouse-item-dialog-title">
            {isEdit ? 'Редагувати позицію' : 'Нова позиція на складі'}
          </h2>
        </div>

        <form className={styles.dialogForm} onSubmit={handleSubmit} noValidate>
          <label className={styles.field}>
            <span>Назва позиції</span>
            <input
              className={styles.fieldInput}
              type="text"
              value={form.name}
              onChange={(event) => updateField('name', event.target.value)}
              placeholder="Напр. Генератори 3 кВт"
              autoFocus
            />
            {errors.name ? (
              <small className={styles.fieldError}>{errors.name}</small>
            ) : null}
          </label>

          <div className={styles.fieldRow}>
            <label className={styles.field}>
              <span>Категорія</span>
              <select
                className={styles.fieldInput}
                value={form.category}
                onChange={(event) => updateField('category', event.target.value)}
              >
                {WAREHOUSE_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
              {errors.category ? (
                <small className={styles.fieldError}>{errors.category}</small>
              ) : null}
            </label>

            <label className={styles.field}>
              <span>Одиниця виміру</span>
              <input
                className={styles.fieldInput}
                type="text"
                value={form.unit}
                onChange={(event) => updateField('unit', event.target.value)}
                placeholder="шт., компл., наборів"
              />
              {errors.unit ? (
                <small className={styles.fieldError}>{errors.unit}</small>
              ) : null}
            </label>
          </div>

          <div className={styles.fieldRow}>
            <label className={styles.field}>
              <span>Загальна кількість</span>
              <input
                className={styles.fieldInput}
                type="number"
                min="0"
                step="1"
                value={form.quantity}
                onChange={(event) => updateField('quantity', event.target.value)}
              />
              {errors.quantity ? (
                <small className={styles.fieldError}>{errors.quantity}</small>
              ) : null}
            </label>

            <label className={styles.field}>
              <span>Доступно зараз</span>
              <input
                className={styles.fieldInput}
                type="number"
                min="0"
                step="1"
                value={form.availableNow}
                onChange={(event) =>
                  updateField('availableNow', event.target.value)
                }
              />
              {errors.availableNow ? (
                <small className={styles.fieldError}>{errors.availableNow}</small>
              ) : null}
            </label>
          </div>

          <label className={styles.field}>
            <span>Стан / опис</span>
            <input
              className={styles.fieldInput}
              type="text"
              value={form.condition}
              onChange={(event) => updateField('condition', event.target.value)}
              placeholder="Напр. Після сервісу, готові"
            />
          </label>

          <label className={styles.field}>
            <span>Місце зберігання</span>
            <input
              className={styles.fieldInput}
              type="text"
              value={form.location}
              onChange={(event) => updateField('location', event.target.value)}
              placeholder="Напр. Київ, склад A / стелаж 2"
            />
          </label>

          <label className={styles.field}>
            <span>Резерв (кому / заявка)</span>
            <input
              className={styles.fieldInput}
              type="text"
              value={form.reservedFor}
              onChange={(event) => updateField('reservedFor', event.target.value)}
              placeholder="Порожньо, якщо резерву немає"
            />
          </label>

          <label className={styles.checkboxField}>
            <input
              type="checkbox"
              checked={form.needsCheck}
              onChange={(event) => updateField('needsCheck', event.target.checked)}
            />
            <span>Потребує перевірки / доукомплектації перед видачею</span>
          </label>

          <div className={styles.dialogActions}>
            <button
              className={styles.secondaryButton}
              type="button"
              onClick={onClose}
              disabled={isSaving}
            >
              Скасувати
            </button>
            <button
              className={styles.primaryButton}
              type="submit"
              disabled={isSaving}
            >
              {isSaving
                ? 'Збереження…'
                : isEdit
                  ? 'Зберегти зміни'
                  : 'Додати позицію'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export default WarehouseItemDialog;
