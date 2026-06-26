import { useEffect, useState } from 'react';

import { formatDate } from '../../../features/certificates/certificateUtils.js';
import styles from '../CertificatesPage.module.css';

const CONFIRM_DELAY_SECONDS = 5;

function DeleteCertificateDialog({
  record,
  isDeleting,
  onCancel,
  onConfirm,
}) {
  const [remainingSeconds, setRemainingSeconds] = useState(CONFIRM_DELAY_SECONDS);

  useEffect(() => {
    setRemainingSeconds(CONFIRM_DELAY_SECONDS);
  }, [record?.id]);

  useEffect(() => {
    if (!record || remainingSeconds <= 0) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setRemainingSeconds((currentSeconds) => Math.max(currentSeconds - 1, 0));
    }, 1000);

    return () => window.clearTimeout(timeoutId);
  }, [record, remainingSeconds]);

  useEffect(() => {
    if (!record) {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !isDeleting) {
        onCancel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isDeleting, onCancel, record]);

  if (!record) {
    return null;
  }

  const canConfirm = remainingSeconds === 0 && !isDeleting;

  return (
    <div className={styles.modalBackdrop}>
      <section
        className={styles.confirmDialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-certificate-title"
        aria-describedby="delete-certificate-description"
      >
        <div className={styles.confirmHeader}>
          <p className={styles.paneEyebrow}>Підтвердження</p>
          <h2 className={styles.confirmTitle} id="delete-certificate-title">
            Видалити посвідчення?
          </h2>
        </div>

        <p className={styles.confirmText} id="delete-certificate-description">
          Запис буде прибрано з реєстру. Цю дію не можна скасувати.
        </p>

        <dl className={styles.confirmDetails}>
          <div>
            <dt>ПІБ</dt>
            <dd>{record.fullName}</dd>
          </div>
          <div>
            <dt>Номер</dt>
            <dd>{record.certificateNumber}</dd>
          </div>
          <div>
            <dt>Дійсне до</dt>
            <dd>{formatDate(record.validUntil)}</dd>
          </div>
        </dl>

        <div className={styles.countdownNotice} aria-live="polite">
          {remainingSeconds > 0
            ? `Підтвердити можна через ${remainingSeconds} с.`
            : 'Тепер можна підтвердити видалення.'}
        </div>

        <div className={styles.confirmActions}>
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
            disabled={!canConfirm}
          >
            {isDeleting
              ? 'Видалення…'
              : remainingSeconds > 0
                ? `Видалити через ${remainingSeconds} с`
                : 'Видалити'}
          </button>
        </div>
      </section>
    </div>
  );
}

export default DeleteCertificateDialog;
