import { useEffect, useRef, useState } from 'react';
import { formatDate, parseFlexibleDate } from '../../../features/certificates/certificateUtils.js';
import styles from '../CertificatesPage.module.css';

function toDisplayValue(value) {
  return value ? formatDate(value) : '';
}

/**
 * Date input that accepts typing and pasting (`31.12.2027`, `31 12 2027`,
 * `31,12,2027`, `31122027`) while keeping the native calendar one click away.
 * The typed text lives in local state so a half-finished date is not thrown
 * away mid-keystroke; the parsed `yyyy-mm-dd` value is what reaches the form.
 * Text that does not parse leaves the form value empty, so validation reports
 * it instead of the field silently keeping an older date.
 */
function DateField({ label, value, error, onChange }) {
  const [text, setText] = useState(() => toDisplayValue(value));
  const textRef = useRef(text);
  const pickerRef = useRef(null);

  const applyText = (nextText) => {
    textRef.current = nextText;
    setText(nextText);
  };

  // Follow the form value only when it stops matching what is typed — during
  // editing the text is the source of truth, so keystrokes are never clobbered.
  useEffect(() => {
    if (parseFlexibleDate(textRef.current) !== value) {
      applyText(toDisplayValue(value));
    }
  }, [value]);

  const handleTextChange = (event) => {
    const nextText = event.target.value;

    applyText(nextText);
    onChange(parseFlexibleDate(nextText));
  };

  const handleBlur = () => {
    const parsed = parseFlexibleDate(textRef.current);

    if (parsed) {
      applyText(formatDate(parsed));
    }
  };

  const openPicker = () => {
    pickerRef.current?.showPicker?.();
  };

  return (
    <label className={styles.field}>
      <span>{label}</span>

      <div className={styles.dateField}>
        <input
          className={`${styles.input} ${error ? styles.inputError : ''}`}
          value={text}
          onChange={handleTextChange}
          onBlur={handleBlur}
          placeholder="дд.мм.рррр"
          inputMode="numeric"
          autoComplete="off"
          aria-invalid={Boolean(error)}
        />

        <button
          className={styles.dateFieldButton}
          type="button"
          onClick={openPicker}
          aria-label={`${label}: обрати в календарі`}
        >
          📅
        </button>

        <input
          className={styles.dateFieldPicker}
          ref={pickerRef}
          type="date"
          value={value || ''}
          onChange={(event) => {
            applyText(toDisplayValue(event.target.value));
            onChange(event.target.value);
          }}
          tabIndex={-1}
          aria-hidden="true"
        />
      </div>

      {error ? <small className={styles.fieldError}>{error}</small> : null}
    </label>
  );
}

export default DateField;
