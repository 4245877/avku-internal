import { useEffect, useState } from 'react';

import styles from '../AidOperationsPage.module.css';

const MOVEMENT_OPTIONS = [
  {
    type: 'issue',
    label: 'Видати',
    description: 'Зменшує доступний та загальний залишок.',
    needsAmount: true,
  },
  {
    type: 'receipt',
    label: 'Поповнити',
    description: 'Збільшує загальний залишок і доступну кількість.',
    needsAmount: true,
  },
  {
    type: 'reserve',
    label: 'Зарезервувати',
    description: 'Прибирає кількість із доступної та фіксує отримувача.',
    needsAmount: true,
  },
  {
    type: 'note',
    label: 'Нотатка',
    description: 'Додає запис в історію без зміни залишків.',
    needsAmount: false,
  },
];

function getDefaultState() {
  return {
    type: 'issue',
    amount: '',
    reservedFor: '',
    title: '',
    meta: '',
  };
}

function WarehouseMovementDialog({
  item,
  isOpen,
  isSaving,
  onClose,
  onSubmit,
}) {
  const [state, setState] = useState(getDefaultState);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) {
      setState(getDefaultState());
      setError('');
    }
  }, [isOpen, item?.id]);

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

  if (!isOpen || !item) {
    return null;
  }

  const activeOption =
    MOVEMENT_OPTIONS.find((option) => option.type === state.type) ??
    MOVEMENT_OPTIONS[0];

  const updateState = (field, value) => {
    setState((current) => ({
      ...current,
      [field]: value,
    }));
    setError('');
  };

  const handleSubmit = (event) => {
    event.preventDefault();

    const amount = Number(state.amount);

    if (activeOption.needsAmount) {
      if (
        state.amount === '' ||
        !Number.isFinite(amount) ||
        !Number.isInteger(amount) ||
        amount <= 0
      ) {
        setError('Вкажіть ціле число більше нуля.');
        return;
      }

      if (
        (state.type === 'issue' || state.type === 'reserve') &&
        amount > item.availableNow
      ) {
        setError(`Доступно лише ${item.availableNow} ${item.unit}.`);
        return;
      }
    }

    onSubmit({
      type: state.type,
      amount: activeOption.needsAmount ? amount : undefined,
      reservedFor: state.type === 'reserve' ? state.reservedFor.trim() : undefined,
      title: state.title.trim() || undefined,
      meta: state.meta.trim() || undefined,
    });
  };

  return (
    <div className={styles.modalBackdrop}>
      <section
        className={styles.formDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="warehouse-movement-dialog-title"
      >
        <div className={styles.dialogHeader}>
          <p className={styles.eyebrow}>{item.code}</p>
          <h2 id="warehouse-movement-dialog-title">Рух по позиції</h2>
          <p className={styles.dialogSubtitle}>
            {item.name} · доступно {item.availableNow} {item.unit} з{' '}
            {item.quantity} {item.unit}
          </p>
        </div>

        <form className={styles.dialogForm} onSubmit={handleSubmit} noValidate>
          <div className={styles.segmented} role="group" aria-label="Тип руху">
            {MOVEMENT_OPTIONS.map((option) => (
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

          {activeOption.needsAmount ? (
            <label className={styles.field}>
              <span>Кількість ({item.unit})</span>
              <input
                className={styles.fieldInput}
                type="number"
                min="1"
                step="1"
                value={state.amount}
                onChange={(event) => updateState('amount', event.target.value)}
                autoFocus
              />
            </label>
          ) : null}

          {state.type === 'reserve' ? (
            <label className={styles.field}>
              <span>Кому / заявка</span>
              <input
                className={styles.fieldInput}
                type="text"
                value={state.reservedFor}
                onChange={(event) =>
                  updateState('reservedFor', event.target.value)
                }
                placeholder="Напр. 93 ОМБр, заявка REQ-2026-031"
              />
            </label>
          ) : null}

          <label className={styles.field}>
            <span>Коментар до запису (необов'язково)</span>
            <input
              className={styles.fieldInput}
              type="text"
              value={state.meta}
              onChange={(event) => updateState('meta', event.target.value)}
              placeholder="Деталі операції для історії руху"
            />
          </label>

          {error ? (
            <small className={styles.fieldError}>{error}</small>
          ) : null}

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
              {isSaving ? 'Збереження…' : 'Записати рух'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export default WarehouseMovementDialog;
