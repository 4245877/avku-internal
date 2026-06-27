import { useEffect, useMemo, useState } from 'react';

import {
  ACT_STATE_OPTIONS,
  PHOTO_STATE_OPTIONS,
  TRANSFER_STATUS_OPTIONS,
  createFormFromTransfer,
  getEmptyTransferForm,
  hasValidationErrors,
  validateTransferForm,
} from '../../../features/logistics/logisticsUtils.js';
import styles from '../AidOperationsPage.module.css';

function TransferDialog({
  transfer,
  isOpen,
  isSaving,
  onClose,
  onSubmit,
}) {
  const isEdit = Boolean(transfer);
  const initialForm = useMemo(
    () => (transfer ? createFormFromTransfer(transfer) : getEmptyTransferForm()),
    [transfer],
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

  const updateManifestLine = (index, field, value) => {
    setForm((currentForm) => ({
      ...currentForm,
      manifest: currentForm.manifest.map((line, lineIndex) =>
        lineIndex === index ? { ...line, [field]: value } : line,
      ),
    }));
    setErrors((currentErrors) => ({
      ...currentErrors,
      manifest: '',
    }));
  };

  const addManifestLine = () => {
    setForm((currentForm) => ({
      ...currentForm,
      manifest: [...currentForm.manifest, { name: '', quantity: '' }],
    }));
  };

  const removeManifestLine = (index) => {
    setForm((currentForm) => ({
      ...currentForm,
      manifest:
        currentForm.manifest.length > 1
          ? currentForm.manifest.filter((_, lineIndex) => lineIndex !== index)
          : currentForm.manifest,
    }));
  };

  const handleSubmit = (event) => {
    event.preventDefault();

    const nextErrors = validateTransferForm(form);

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
        aria-labelledby="transfer-dialog-title"
      >
        <div className={styles.dialogHeader}>
          <p className={styles.eyebrow}>Логістика / Передача</p>
          <h2 id="transfer-dialog-title">
            {isEdit ? 'Редагувати передачу' : 'Нова передача допомоги'}
          </h2>
        </div>

        <form className={styles.dialogForm} onSubmit={handleSubmit} noValidate>
          <label className={styles.field}>
            <span>Маршрут</span>
            <input
              className={styles.fieldInput}
              type="text"
              value={form.route}
              onChange={(event) => updateField('route', event.target.value)}
              placeholder="Напр. Київ - Харків - Куп'янський напрямок"
              autoFocus
            />
            {errors.route ? (
              <small className={styles.fieldError}>{errors.route}</small>
            ) : null}
          </label>

          <div className={styles.fieldRow}>
            <label className={styles.field}>
              <span>Отримувач</span>
              <input
                className={styles.fieldInput}
                type="text"
                value={form.recipient}
                onChange={(event) =>
                  updateField('recipient', event.target.value)
                }
                placeholder="Напр. Медична рота, Харківська область"
              />
              {errors.recipient ? (
                <small className={styles.fieldError}>{errors.recipient}</small>
              ) : null}
            </label>

            <label className={styles.field}>
              <span>Водій або волонтер</span>
              <input
                className={styles.fieldInput}
                type="text"
                value={form.driver}
                onChange={(event) => updateField('driver', event.target.value)}
                placeholder="Напр. Ірина Коваль / бус Renault Master"
              />
              {errors.driver ? (
                <small className={styles.fieldError}>{errors.driver}</small>
              ) : null}
            </label>
          </div>

          <div className={styles.fieldRow}>
            <label className={styles.field}>
              <span>Дата передачі</span>
              <input
                className={styles.fieldInput}
                type="date"
                value={form.transferDate}
                onChange={(event) =>
                  updateField('transferDate', event.target.value)
                }
              />
              {errors.transferDate ? (
                <small className={styles.fieldError}>
                  {errors.transferDate}
                </small>
              ) : null}
            </label>

            <label className={styles.field}>
              <span>Статус</span>
              <select
                className={styles.fieldInput}
                value={form.status}
                onChange={(event) => updateField('status', event.target.value)}
              >
                {TRANSFER_STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className={styles.checkboxField}>
            <input
              type="checkbox"
              checked={form.routeConfirmed}
              onChange={(event) =>
                updateField('routeConfirmed', event.target.checked)
              }
            />
            <span>Маршрут і час з отримувачем погоджено</span>
          </label>

          <div className={styles.fieldRow}>
            <label className={styles.field}>
              <span>Акт передачі</span>
              <select
                className={styles.fieldInput}
                value={form.actState}
                onChange={(event) =>
                  updateField('actState', event.target.value)
                }
              >
                {ACT_STATE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            {form.actState !== 'missing' ? (
              <label className={styles.field}>
                <span>Номер / файл акта</span>
                <input
                  className={styles.fieldInput}
                  type="text"
                  value={form.actReference}
                  onChange={(event) =>
                    updateField('actReference', event.target.value)
                  }
                  placeholder="Напр. ACT-2026-049.pdf"
                />
              </label>
            ) : (
              <div aria-hidden="true" />
            )}
          </div>

          <div className={styles.fieldRow}>
            <label className={styles.field}>
              <span>Фото передачі</span>
              <select
                className={styles.fieldInput}
                value={form.photoState}
                onChange={(event) =>
                  updateField('photoState', event.target.value)
                }
              >
                {PHOTO_STATE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            {form.photoState === 'ready' ? (
              <label className={styles.field}>
                <span>Кількість фото</span>
                <input
                  className={styles.fieldInput}
                  type="number"
                  min="0"
                  step="1"
                  value={form.photoCount}
                  onChange={(event) =>
                    updateField('photoCount', event.target.value)
                  }
                />
                {errors.photoCount ? (
                  <small className={styles.fieldError}>
                    {errors.photoCount}
                  </small>
                ) : null}
              </label>
            ) : (
              <div aria-hidden="true" />
            )}
          </div>

          <div className={styles.field}>
            <span>Що передається</span>
            <div className={styles.manifestEditor}>
              {form.manifest.map((line, index) => (
                // eslint-disable-next-line react/no-array-index-key
                <div className={styles.manifestEditorRow} key={index}>
                  <input
                    className={styles.fieldInput}
                    type="text"
                    value={line.name}
                    onChange={(event) =>
                      updateManifestLine(index, 'name', event.target.value)
                    }
                    placeholder="Назва позиції"
                    aria-label={`Назва позиції ${index + 1}`}
                  />
                  <input
                    className={styles.fieldInput}
                    type="text"
                    value={line.quantity}
                    onChange={(event) =>
                      updateManifestLine(index, 'quantity', event.target.value)
                    }
                    placeholder="Кількість"
                    aria-label={`Кількість позиції ${index + 1}`}
                  />
                  <button
                    className={styles.manifestRemoveButton}
                    type="button"
                    onClick={() => removeManifestLine(index)}
                    disabled={form.manifest.length <= 1}
                    aria-label={`Прибрати позицію ${index + 1}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button
              className={styles.smallButton}
              type="button"
              onClick={addManifestLine}
            >
              Додати позицію
            </button>
            {errors.manifest ? (
              <small className={styles.fieldError}>{errors.manifest}</small>
            ) : null}
          </div>

          <div className={styles.fieldRow}>
            <label className={styles.field}>
              <span>Заявка</span>
              <input
                className={styles.fieldInput}
                type="text"
                value={form.requestId}
                onChange={(event) =>
                  updateField('requestId', event.target.value)
                }
                placeholder="Напр. REQ-2026-044"
              />
            </label>

            <label className={styles.field}>
              <span>Склад</span>
              <input
                className={styles.fieldInput}
                type="text"
                value={form.warehouseId}
                onChange={(event) =>
                  updateField('warehouseId', event.target.value)
                }
                placeholder="Напр. WH-FOOD-027"
              />
            </label>
          </div>

          <label className={styles.field}>
            <span>Звіт</span>
            <input
              className={styles.fieldInput}
              type="text"
              value={form.reportId}
              onChange={(event) => updateField('reportId', event.target.value)}
              placeholder="Напр. REP-2026-019"
            />
          </label>

          <label className={styles.field}>
            <span>Нотатка</span>
            <textarea
              className={styles.fieldTextarea}
              value={form.notes}
              onChange={(event) => updateField('notes', event.target.value)}
              placeholder="Що проконтролювати перед виїздом або після передачі"
              rows={3}
            />
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
                  : 'Додати передачу'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export default TransferDialog;
