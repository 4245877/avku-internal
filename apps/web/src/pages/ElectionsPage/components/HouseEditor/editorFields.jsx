/**
 * The form and list primitives every editor section is built from.
 *
 * They exist so that ten sections agree on what a required field looks like,
 * where an error message sits, how an empty list asks to be filled and how a
 * destructive button confirms — rather than each one inventing its own. All of
 * them are plain wrappers over native controls: a date is `input[type=date]`, a
 * status is a `select`, a phone is `input[type=tel]`. Nothing here reimplements
 * a control the browser already gets right on a phone.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import ElectionsIcon from '../../../../features/elections/ElectionsIcon.jsx';
import styles from './HouseEditor.module.css';

const toneClassNames = {
  success: styles.toneSuccess,
  warning: styles.toneWarning,
  danger: styles.toneDanger,
  info: styles.toneInfo,
  accent: styles.toneAccent,
  neutral: styles.toneNeutral,
  muted: styles.toneMuted,
};

export function Badge({ tone = 'neutral', children }) {
  return (
    <span className={`${styles.badge} ${toneClassNames[tone] ?? styles.toneNeutral}`}>
      {children}
    </span>
  );
}

/** A titled block of related fields. Sections are built out of these. */
export function Card({ title, icon, hint, actions, children, id }) {
  return (
    <section className={styles.card} id={id}>
      {(title || actions) && (
        <header className={styles.cardHeader}>
          <div className={styles.cardHeading}>
            <h3 className={styles.cardTitle}>
              {icon && <ElectionsIcon name={icon} size={16} />}
              {title}
            </h3>

            {hint && <p className={styles.cardHint}>{hint}</p>}
          </div>

          {actions && <div className={styles.cardActions}>{actions}</div>}
        </header>
      )}

      {children}
    </section>
  );
}

/** A responsive field grid. `columns` is a maximum, never a minimum. */
export function FieldGrid({ children, columns = 2 }) {
  return (
    <div className={styles.fieldGrid} data-columns={columns}>
      {children}
    </div>
  );
}

let fieldSequence = 0;

/**
 * One labelled control.
 *
 * The label is a real `<label for>` rather than a wrapper, so a screen reader
 * announces it and tapping it focuses the control — which on a phone is the
 * difference between a 44px target and a 16px one.
 */
export function Field({
  label,
  hint,
  error,
  required,
  wide,
  children,
  htmlFor,
}) {
  const generated = useRef(null);

  if (!generated.current) {
    fieldSequence += 1;
    generated.current = `editor-field-${fieldSequence}`;
  }

  const id = htmlFor ?? generated.current;

  return (
    <div className={[styles.field, wide ? styles.fieldWide : ''].filter(Boolean).join(' ')}>
      <label className={styles.fieldLabel} htmlFor={id}>
        {label}
        {required && (
          <span aria-label="обовʼязкове поле" className={styles.fieldRequired}>
            *
          </span>
        )}
      </label>

      {typeof children === 'function'
        ? children({ id, 'aria-invalid': error ? 'true' : undefined })
        : children}

      {error
        ? (
          <em className={styles.fieldError} role="alert">
            {error}
          </em>
        )
        : hint
          ? <small className={styles.fieldHint}>{hint}</small>
          : null}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  required,
  wide,
  type = 'text',
  disabled,
  placeholder,
  inputMode,
  ...rest
}) {
  return (
    <Field error={error} hint={hint} label={label} required={required} wide={wide}>
      {({ id, ...aria }) => (
        <input
          {...aria}
          {...rest}
          className={styles.input}
          disabled={disabled}
          id={id}
          inputMode={inputMode}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          type={type}
          value={value ?? ''}
        />
      )}
    </Field>
  );
}

/** Digits only, and an empty field means "невідомо" rather than zero. */
export function CountField(props) {
  return <TextField {...props} inputMode="numeric" />;
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  hint,
  error,
  required,
  wide,
  disabled,
  placeholder,
}) {
  return (
    <Field error={error} hint={hint} label={label} required={required} wide={wide}>
      {({ id, ...aria }) => (
        <select
          {...aria}
          className={styles.input}
          disabled={disabled}
          id={id}
          onChange={(event) => onChange(event.target.value)}
          value={value ?? ''}
        >
          {placeholder && <option value="">{placeholder}</option>}
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function DateField(props) {
  return <TextField {...props} type="date" />;
}

/**
 * A textarea that grows with its content.
 *
 * A three-row box that has to be scrolled to re-read the sentence above is how
 * a summary field ends up holding one line. It grows to fit and stops at a
 * height that still leaves the rest of the form on screen.
 */
export function TextAreaField({
  label,
  value,
  onChange,
  hint,
  error,
  required,
  wide = true,
  disabled,
  placeholder,
  rows = 3,
}) {
  const ref = useRef(null);

  const resize = useCallback(() => {
    const node = ref.current;

    if (!node) {
      return;
    }

    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 420)}px`;
  }, []);

  useEffect(resize, [resize, value]);

  return (
    <Field error={error} hint={hint} label={label} required={required} wide={wide}>
      {({ id, ...aria }) => (
        <textarea
          {...aria}
          className={`${styles.input} ${styles.textarea}`}
          disabled={disabled}
          id={id}
          onChange={(event) => {
            onChange(event.target.value);
            resize();
          }}
          placeholder={placeholder}
          ref={ref}
          rows={rows}
          value={value ?? ''}
        />
      )}
    </Field>
  );
}

export function CheckboxField({ label, checked, onChange, hint, disabled }) {
  return (
    <label className={styles.checkbox}>
      <input
        checked={Boolean(checked)}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />

      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

/** A read-only fact. Used where a value is the server's to set, not the form's. */
export function ReadOnlyField({ label, value, hint }) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <p className={styles.readOnlyValue}>{value || '—'}</p>
      {hint && <small className={styles.fieldHint}>{hint}</small>}
    </div>
  );
}

export function Button({
  children,
  variant = 'ghost',
  icon,
  isBusy,
  disabled,
  type = 'button',
  ...rest
}) {
  const className = {
    primary: styles.primaryButton,
    ghost: styles.ghostButton,
    danger: styles.dangerButton,
    quiet: styles.quietButton,
  }[variant] ?? styles.ghostButton;

  return (
    <button
      {...rest}
      className={className}
      // Busy implies disabled, so a save cannot be started twice from one
      // render — the guard in the handler is the second half of the same rule.
      disabled={disabled || isBusy}
      type={type}
    >
      {isBusy
        ? <span aria-hidden="true" className={styles.spinner} />
        : icon
          ? <ElectionsIcon name={icon} size={16} />
          : null}
      {children}
    </button>
  );
}

/**
 * A destructive button that asks first, in place.
 *
 * Not a modal: the editor is already a full-screen surface, and a dialog on top
 * of it would be the third layer of window the brief rules out.
 */
export function ConfirmButton({
  children,
  confirmLabel = 'Підтвердити',
  question,
  onConfirm,
  isBusy,
  disabled,
  variant = 'danger',
}) {
  const [isAsking, setIsAsking] = useState(false);

  if (!isAsking) {
    /*
     * The trigger is quiet even when the action is destructive: a list of ten
     * contacts with a solid red button on every row reads as ten warnings, and
     * the colour stops meaning anything. The red appears on the confirmation,
     * which is the moment it is actually about to happen.
     */
    return (
      <Button
        disabled={disabled}
        isBusy={isBusy}
        onClick={() => setIsAsking(true)}
        variant="quiet"
      >
        {children}
      </Button>
    );
  }

  return (
    <span className={styles.confirmRow}>
      <span className={styles.confirmQuestion}>{question}</span>

      <Button onClick={() => setIsAsking(false)} variant="quiet">
        Ні
      </Button>

      <Button
        isBusy={isBusy}
        onClick={async () => {
          const done = await onConfirm();

          if (done !== false) {
            setIsAsking(false);
          }
        }}
        variant={variant}
      >
        {confirmLabel}
      </Button>
    </span>
  );
}

/**
 * What a section shows when it has nothing yet.
 *
 * Never an empty table with eight column headers: a heading nobody can fill in
 * is worse than a sentence saying what the section is for and a button that
 * starts it.
 */
export function EmptyState({ icon = 'note', title, children, action }) {
  return (
    <div className={styles.empty}>
      <span aria-hidden="true" className={styles.emptyIcon}>
        <ElectionsIcon name={icon} size={22} />
      </span>

      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/** Loading / error / empty for one lazily loaded collection. */
export function CollectionState({ state, emptyTitle, emptyText, emptyIcon, action }) {
  if (state.status === 'loading' || state.status === 'idle') {
    return (
      <p className={styles.loading} role="status">
        <span aria-hidden="true" className={styles.spinner} />
        Завантаження…
      </p>
    );
  }

  if (state.status === 'error') {
    return (
      <p className={styles.inlineError} role="alert">
        <ElectionsIcon name="warning" size={15} />
        {state.error}
      </p>
    );
  }

  if (state.items.length === 0) {
    return (
      <EmptyState action={action} icon={emptyIcon} title={emptyTitle}>
        {emptyText}
      </EmptyState>
    );
  }

  return null;
}

/** The filter/sort strip above a record list. */
export function ListToolbar({ children }) {
  return <div className={styles.listToolbar}>{children}</div>;
}

export function ToolbarSelect({ label, value, onChange, options }) {
  return (
    <label className={styles.toolbarSelect}>
      <span>{label}</span>

      <select onChange={(event) => onChange(event.target.value)} value={value}>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The success / failure line a self-saving sub-form shows under itself. */
export function FormStatus({ error, notice }) {
  if (error) {
    return (
      <p className={styles.inlineError} role="alert">
        <ElectionsIcon name="warning" size={15} />
        {error}
      </p>
    );
  }

  if (notice) {
    return (
      <p className={styles.inlineNotice} role="status">
        <ElectionsIcon name="check" size={15} />
        {notice}
      </p>
    );
  }

  return null;
}
