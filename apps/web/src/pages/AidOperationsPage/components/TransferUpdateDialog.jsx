import { useEffect, useState } from 'react';

import {
  ACT_STATE_OPTIONS,
  PHOTO_STATE_OPTIONS,
  TRANSFER_STATUS_OPTIONS,
} from '../../../features/logistics/logisticsUtils.js';
import styles from '../AidOperationsPage.module.css';

const UPDATE_OPTIONS = [
  {
    type: 'status',
    label: 'Статус',
    description: 'Змінює стан передачі у списку та підсумках.',
  },
  {
    type: 'act',
    label: 'Акт',
    description: 'Фіксує підготовку або підписання акта передачі.',
  },
  {
    type: 'photo',
    label: 'Фото',
    description: 'Відмічає завантаження фото підтвердження передачі.',
  },
  {
    type: 'note',
    label: 'Нотатка',
    description: 'Додає запис в історію без зміни даних передачі.',
  },
];

function getInitialState(transfer) {
  return {
    type: 'status',
    status: transfer?.status ?? 'planned',
    actState: transfer?.actState ?? 'missing',
    actReference: transfer?.actReference ?? '',
    photoState: transfer?.photoState ?? 'missing',
    photoCount:
      transfer?.photoCount === undefined || transfer?.photoCount === null
        ? ''
        : String(transfer.photoCount),
    meta: '',
  };
}

function TransferUpdateDialog({
  transfer,
  isOpen,
  isSaving,
  onClose,
  onSubmit,
}) {
  const [state, setState] = useState(() => getInitialState(transfer));
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) {
      setState(getInitialState(transfer));
      setError('');
    }
  }, [isOpen, transfer]);

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

  if (!isOpen || !transfer) {
    return null;
  }

  const activeOption =
    UPDATE_OPTIONS.find((option) => option.type === state.type) ??
    UPDATE_OPTIONS[0];

  const updateState = (field, value) => {
    setState((current) => ({
      ...current,
      [field]: value,
    }));
    setError('');
  };

  const handleSubmit = (event) => {
    event.preventDefault();

    if (state.type === 'note' && !state.meta.trim()) {
      setError('Додайте текст нотатки.');
      return;
    }

    if (state.type === 'photo' && state.photoState === 'ready') {
      const count = Number(state.photoCount);

      if (
        state.photoCount !== '' &&
        (!Number.isFinite(count) || !Number.isInteger(count) || count < 0)
      ) {
        setError('Кількість фото має бути цілим числом від 0.');
        return;
      }
    }

    const meta = state.meta.trim() || undefined;

    if (state.type === 'status') {
      onSubmit({ type: 'status', status: state.status, meta });
      return;
    }

    if (state.type === 'act') {
      onSubmit({
        type: 'act',
        actState: state.actState,
        actReference:
          state.actState === 'missing' ? undefined : state.actReference.trim(),
        meta,
      });
      return;
    }

    if (state.type === 'photo') {
      onSubmit({
        type: 'photo',
        photoState: state.photoState,
        photoCount:
          state.photoState === 'missing' || state.photoCount === ''
            ? 0
            : Number(state.photoCount),
        meta,
      });
      return;
    }

    onSubmit({ type: 'note', meta });
  };

  return (
    <div className={styles.modalBackdrop}>
      <section
        className={styles.formDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="transfer-update-dialog-title"
      >
        <div className={styles.dialogHeader}>
          <p className={styles.eyebrow}>{transfer.code}</p>
          <h2 id="transfer-update-dialog-title">Оновлення передачі</h2>
          <p className={styles.dialogSubtitle}>
            {transfer.recipient} · {transfer.route}
          </p>
        </div>

        <form className={styles.dialogForm} onSubmit={handleSubmit} noValidate>
          <div className={styles.segmented} role="group" aria-label="Тип оновлення">
            {UPDATE_OPTIONS.map((option) => (
              <button
                key={option.type}
                type="button"
                className={
                  option.type === state.type
                    ? `${styles.segmentedButton} ${styles.segmentedButtonActive}`
                    : styles.segmentedButton
                }
                onClick={() => updateState('type', option.type)}
              >
                {option.label}
              </button>
            ))}
          </div>

          <p className={styles.dialogHint}>{activeOption.description}</p>

          {state.type === 'status' ? (
            <label className={styles.field}>
              <span>Новий статус</span>
              <select
                className={styles.fieldInput}
                value={state.status}
                onChange={(event) => updateState('status', event.target.value)}
              >
                {TRANSFER_STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {state.type === 'act' ? (
            <>
              <label className={styles.field}>
                <span>Стан акта</span>
                <select
                  className={styles.fieldInput}
                  value={state.actState}
                  onChange={(event) =>
                    updateState('actState', event.target.value)
                  }
                >
                  {ACT_STATE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              {state.actState !== 'missing' ? (
                <label className={styles.field}>
                  <span>Номер / файл акта</span>
                  <input
                    className={styles.fieldInput}
                    type="text"
                    value={state.actReference}
                    onChange={(event) =>
                      updateState('actReference', event.target.value)
                    }
                    placeholder="Напр. ACT-2026-049.pdf"
                  />
                </label>
              ) : null}
            </>
          ) : null}

          {state.type === 'photo' ? (
            <>
              <label className={styles.field}>
                <span>Стан фото</span>
                <select
                  className={styles.fieldInput}
                  value={state.photoState}
                  onChange={(event) =>
                    updateState('photoState', event.target.value)
                  }
                >
                  {PHOTO_STATE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              {state.photoState === 'ready' ? (
                <label className={styles.field}>
                  <span>Кількість фото</span>
                  <input
                    className={styles.fieldInput}
                    type="number"
                    min="0"
                    step="1"
                    value={state.photoCount}
                    onChange={(event) =>
                      updateState('photoCount', event.target.value)
                    }
                  />
                </label>
              ) : null}
            </>
          ) : null}

          <label className={styles.field}>
            <span>
              {state.type === 'note'
                ? 'Текст нотатки'
                : "Коментар до запису (необов'язково)"}
            </span>
            <input
              className={styles.fieldInput}
              type="text"
              value={state.meta}
              onChange={(event) => updateState('meta', event.target.value)}
              placeholder="Деталі для історії передачі"
            />
          </label>

          {error ? <small className={styles.fieldError}>{error}</small> : null}

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
              {isSaving ? 'Збереження…' : 'Записати'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export default TransferUpdateDialog;
