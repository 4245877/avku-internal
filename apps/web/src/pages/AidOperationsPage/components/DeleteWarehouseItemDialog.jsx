import { useEffect } from 'react';

import styles from '../AidOperationsPage.module.css';

function DeleteWarehouseItemDialog({
  item,
  isDeleting,
  onCancel,
  onConfirm,
}) {
  useEffect(() => {
    if (!item) {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !isDeleting) {
        onCancel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isDeleting, item, onCancel]);

  if (!item) {
    return null;
  }

  return (
    <div className={styles.modalBackdrop}>
      <section
        className={styles.confirmDialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-warehouse-title"
      >
        <div className={styles.dialogHeader}>
          <p className={styles.eyebrow}>Підтвердження</p>
          <h2 id="delete-warehouse-title">Видалити позицію?</h2>
        </div>

        <p className={styles.confirmText}>
          Позицію «{item.name}» ({item.code}) та її історію руху буде прибрано зі
          складу. Цю дію не можна скасувати.
        </p>

        <div className={styles.dialogActions}>
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={onCancel}
            disabled={isDeleting}
            autoFocus
          >
            Скасувати
          </button>
          <button
            className={styles.dangerButton}
            type="button"
            onClick={onConfirm}
            disabled={isDeleting}
          >
            {isDeleting ? 'Видалення…' : 'Видалити'}
          </button>
        </div>
      </section>
    </div>
  );
}

export default DeleteWarehouseItemDialog;
