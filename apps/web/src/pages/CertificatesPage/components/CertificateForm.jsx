import styles from '../CertificatesPage.module.css';

function CertificateForm({
  form,
  errors,
  isSaving,
  isDirty,
  onChange,
  onRenew,
  onSave,
  onReset,
}) {
  return (
    <section className={styles.editorPane} aria-label="Редактор удостоверения">
      <div className={styles.paneHeader}>
        <div>
          <p className={styles.paneEyebrow}>Редактор</p>
          <h2 className={styles.paneTitle}>{form.id ? 'Редактирование записи' : 'Новая запись'}</h2>
        </div>

        <div className={styles.inlineActions}>
          <button className={styles.secondaryButtonCompact} type="button" onClick={onRenew}>
            +1 год
          </button>
          <button className={styles.secondaryButtonCompact} type="button" onClick={onReset}>
            Новая
          </button>
        </div>
      </div>

      <div className={styles.formGrid}>
        <label className={styles.field}>
          <span>ФИО</span>
          <input
            className={`${styles.input} ${errors.fullName ? styles.inputError : ''}`}
            value={form.fullName}
            onChange={(event) => onChange('fullName', event.target.value)}
            placeholder="Фамилия Имя Отчество"
            aria-invalid={Boolean(errors.fullName)}
          />
          {errors.fullName ? <small className={styles.fieldError}>{errors.fullName}</small> : null}
        </label>

        <label className={styles.field}>
          <span>Номер удостоверения</span>
          <input
            className={`${styles.input} ${errors.certificateNumber ? styles.inputError : ''}`}
            value={form.certificateNumber}
            onChange={(event) => onChange('certificateNumber', event.target.value)}
            placeholder="0001"
            aria-invalid={Boolean(errors.certificateNumber)}
          />
          {errors.certificateNumber ? (
            <small className={styles.fieldError}>{errors.certificateNumber}</small>
          ) : null}
        </label>

        <label className={styles.field}>
          <span>Дата выдачи</span>
          <input
            className={`${styles.input} ${errors.issuedAt ? styles.inputError : ''}`}
            type="date"
            value={form.issuedAt}
            onChange={(event) => onChange('issuedAt', event.target.value)}
            aria-invalid={Boolean(errors.issuedAt)}
          />
          {errors.issuedAt ? <small className={styles.fieldError}>{errors.issuedAt}</small> : null}
        </label>

        <label className={styles.field}>
          <span>Действительно до</span>
          <input
            className={`${styles.input} ${errors.validUntil ? styles.inputError : ''}`}
            type="date"
            value={form.validUntil}
            onChange={(event) => onChange('validUntil', event.target.value)}
            aria-invalid={Boolean(errors.validUntil)}
          />
          {errors.validUntil ? <small className={styles.fieldError}>{errors.validUntil}</small> : null}
        </label>
      </div>

      <div className={styles.formActions}>
        <button className={styles.primaryButton} type="button" onClick={onSave} disabled={isSaving}>
          {isSaving ? 'Сохранение...' : form.id ? 'Сохранить изменения' : 'Сохранить удостоверение'}
        </button>

        {isDirty ? <span className={styles.unsavedState}>Есть несохранённые изменения</span> : null}
      </div>
    </section>
  );
}

export default CertificateForm;
