import { useEffect } from 'react';

import styles from '../AidOperationsPage.module.css';

function DeleteTransferDialog({
  transfer,
  isDeleting,
  onCancel,
  onConfirm,
}) {
  useEffect(() => {
    if (!transfer) {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !isDeleting) {
        onCancel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isDeleting, transfer, onCancel]);

  if (!transfer) {
    return null;
  }

  return (
    <div className={styles.modalBackdrop}>
      <section
        className={styles.confirmDialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-transfer-title"
      >
        <div className={styles.dialogHeader}>
          <p className={styles.eyebrow}>Підтвердження</p>
          <h2 id="delete-transfer-title">Видалити передачу?</h2>
        </div>

        <p className={styles.confirmText}>
          Передачу «{transfer.route}» ({transfer.code}) та її історію подій буде
          прибрано. Цю дію не можна скасувати.
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

export default DeleteTransferDialog;
