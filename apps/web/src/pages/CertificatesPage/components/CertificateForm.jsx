import { getTemplateLabel } from '../../../features/certificates/certificateUtils.js';
import styles from '../CertificatesPage.module.css';
import DateField from './DateField.jsx';

function CertificateForm({
  form,
  templateOptions = [],
  errors,
  isSaving,
  isDirty,
  onChange,
  onRenew,
  onSave,
  onReset,
}) {
  return (
    <section className={styles.editorPane} aria-label="Редактор посвідчення">
      <div className={styles.paneHeader}>
        <div>
          <p className={styles.paneEyebrow}>Редактор</p>
          <h2 className={styles.paneTitle}>{form.id ? 'Редагування запису' : 'Новий запис'}</h2>
        </div>

        <div className={styles.inlineActions}>
          <button className={styles.secondaryButtonCompact} type="button" onClick={onRenew}>
            +1 рік
          </button>
          <button className={styles.secondaryButtonCompact} type="button" onClick={onReset}>
            Нова
          </button>
        </div>
      </div>

      <div className={styles.formGrid}>
        <label className={styles.field}>
          <span>Локалізація</span>
          <select
            className={`${styles.input} ${errors.templateId ? styles.inputError : ''}`}
            value={form.templateId}
            onChange={(event) => onChange('templateId', event.target.value)}
            aria-invalid={Boolean(errors.templateId)}
          >
            {templateOptions.length === 0 ? (
              <option value={form.templateId}>Українська</option>
            ) : null}
            {templateOptions.map((template) => (
              <option key={template.id} value={template.id}>
                {getTemplateLabel(template)}
              </option>
            ))}
          </select>
          {errors.templateId ? <small className={styles.fieldError}>{errors.templateId}</small> : null}
        </label>

        <label className={styles.field}>
          <span>ПІБ</span>
          <input
            className={`${styles.input} ${errors.fullName ? styles.inputError : ''}`}
            value={form.fullName}
            onChange={(event) => onChange('fullName', event.target.value)}
            placeholder="Прізвище Ім'я По батькові"
            aria-invalid={Boolean(errors.fullName)}
          />
          {errors.fullName ? <small className={styles.fieldError}>{errors.fullName}</small> : null}
        </label>

        <label className={styles.field}>
          <span>Ім'я англійською</span>
          <input
            className={`${styles.input} ${errors.firstNameEn ? styles.inputError : ''}`}
            value={form.firstNameEn}
            onChange={(event) => onChange('firstNameEn', event.target.value)}
            placeholder="First name"
            aria-invalid={Boolean(errors.firstNameEn)}
          />
          {errors.firstNameEn ? (
            <small className={styles.fieldError}>{errors.firstNameEn}</small>
          ) : null}
        </label>

        <label className={styles.field}>
          <span>Прізвище англійською</span>
          <input
            className={`${styles.input} ${errors.lastNameEn ? styles.inputError : ''}`}
            value={form.lastNameEn}
            onChange={(event) => onChange('lastNameEn', event.target.value)}
            placeholder="Last name"
            aria-invalid={Boolean(errors.lastNameEn)}
          />
          {errors.lastNameEn ? (
            <small className={styles.fieldError}>{errors.lastNameEn}</small>
          ) : null}
        </label>

        <label className={styles.field}>
          <span>Номер посвідчення</span>
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

        <DateField
          label="Дата видачі"
          value={form.issuedAt}
          error={errors.issuedAt}
          onChange={(value) => onChange('issuedAt', value)}
        />

        <DateField
          label="Дійсне до"
          value={form.validUntil}
          error={errors.validUntil}
          onChange={(value) => onChange('validUntil', value)}
        />
      </div>

      <div className={styles.formActions}>
        <button className={styles.primaryButton} type="button" onClick={onSave} disabled={isSaving}>
          {isSaving ? 'Збереження…' : form.id ? 'Зберегти зміни' : 'Зберегти посвідчення'}
        </button>

        {isDirty ? <span className={styles.unsavedState}>Є незбережені зміни</span> : null}
      </div>
    </section>
  );
}

export default CertificateForm;
