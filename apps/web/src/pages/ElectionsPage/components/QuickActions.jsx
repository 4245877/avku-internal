/**
 * The six things a canvasser does while standing in a stairwell.
 *
 * Each button opens a form with two or three fields and nothing else. That is
 * the whole design: the full edit form exists for a coordinator at a desk, and
 * it is the wrong tool for somebody holding a phone in one hand — logging "no
 * answer" must not require scrolling past entrance counts and access notes.
 *
 * The target is a visit result in about thirty seconds and three taps: open the
 * card, tap «Візит», tap a result. Everything else in the form has a default.
 */

import { useEffect, useRef, useState } from 'react';

import {
  ACTION_RESULTS,
  ISSUE_CATEGORIES,
  PERSON_ROLES,
} from '../../../features/elections/electionsTypes.js';
import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import styles from '../ElectionsPage.module.css';

/** `2026-08-02T10:30` — the value an `input[type=datetime-local]` expects. */
function toLocalInputValue(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000;

  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function toDateInputValue(daysFromNow = 0) {
  const date = new Date();

  date.setDate(date.getDate() + daysFromNow);

  return date.toISOString().slice(0, 10);
}

const QUICK_ACTIONS = [
  { id: 'call', label: 'Дзвінок', icon: 'phone' },
  { id: 'visit', label: 'Візит', icon: 'door' },
  { id: 'issue', label: 'Звернення', icon: 'warning' },
  { id: 'task', label: 'Задача', icon: 'list' },
  { id: 'photo', label: 'Фото', icon: 'building' },
  { id: 'comment', label: 'Коментар', icon: 'note' },
  { id: 'person', label: 'Контакт', icon: 'contacts' },
];

/**
 * The visit results worth a dedicated button.
 *
 * Three taps only works if the common answers are one tap each, so the four
 * that make up almost every doorstep outcome are buttons; the rest stay in the
 * dropdown underneath.
 */
const FAST_RESULTS = ['contacted', 'no_answer', 'refused', 'scheduled'];

function FormShell({ title, children, onCancel, isSaving, submitLabel = 'Зберегти' }) {
  return (
    <div className={styles.quickForm}>
      <div className={styles.quickFormHeader}>
        <strong>{title}</strong>

        <button
          aria-label="Закрити форму"
          className={styles.iconButton}
          onClick={onCancel}
          type="button"
        >
          <ElectionsIcon name="close" size={16} />
        </button>
      </div>

      {children}

      <div className={styles.quickFormActions}>
        <button className={styles.ghostButton} onClick={onCancel} type="button">
          Скасувати
        </button>

        <button className={styles.primaryButton} disabled={isSaving} type="submit">
          {isSaving ? 'Зберігаємо…' : submitLabel}
        </button>
      </div>
    </div>
  );
}

function ActionForm({ type, isSaving, onCancel, onSubmit }) {
  const [result, setResult] = useState(type === 'call' ? 'contacted' : 'no_answer');
  const [comment, setComment] = useState('');
  const [happenedAt, setHappenedAt] = useState(() => toLocalInputValue());
  const [nextActionAt, setNextActionAt] = useState('');
  const commentRef = useRef(null);

  /**
   * One tap logs the result and closes the form.
   *
   * The state is passed explicitly rather than read back after `setResult`,
   * because a React state update is not visible in the same handler — a
   * one-tap save that submitted the *previous* result would be worse than no
   * shortcut at all.
   */
  function submitFast(resultId) {
    onSubmit({
      type,
      result: resultId,
      comment: comment.trim(),
      happenedAt: new Date(happenedAt).toISOString(),
      nextActionAt: nextActionAt ? new Date(`${nextActionAt}T12:00:00`).toISOString() : null,
    });
  }

  return (
    <form
      className={styles.quickFormBody}
      onSubmit={(event) => {
        event.preventDefault();
        submitFast(result);
      }}
    >
      <FormShell
        isSaving={isSaving}
        onCancel={onCancel}
        submitLabel="Записати"
        title={type === 'call' ? 'Дзвінок' : 'Візит'}
      >
        <div className={styles.quickResultRow} role="group" aria-label="Результат">
          {ACTION_RESULTS.filter((option) => FAST_RESULTS.includes(option.id)).map((option) => (
            <button
              className={[
                styles.quickResultButton,
                result === option.id ? styles.quickResultButtonActive : '',
              ]
                .filter(Boolean)
                .join(' ')}
              disabled={isSaving}
              key={option.id}
              onClick={() => submitFast(option.id)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>

        <label className={styles.formField}>
          <span>Інший результат</span>
          <select onChange={(event) => setResult(event.target.value)} value={result}>
            {ACTION_RESULTS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.formField}>
          <span>Коментар</span>
          <input
            onChange={(event) => setComment(event.target.value)}
            placeholder="Необовʼязково"
            ref={commentRef}
            type="text"
            value={comment}
          />
        </label>

        <div className={styles.formGrid}>
          <label className={styles.formField}>
            <span>Коли</span>
            <input
              onChange={(event) => setHappenedAt(event.target.value)}
              type="datetime-local"
              value={happenedAt}
            />
          </label>

          <label className={styles.formField}>
            <span>Наступний крок</span>
            <input
              onChange={(event) => setNextActionAt(event.target.value)}
              type="date"
              value={nextActionAt}
            />
          </label>
        </div>
      </FormShell>
    </form>
  );
}

function CommentForm({ isSaving, onCancel, onSubmit }) {
  const [comment, setComment] = useState('');

  return (
    <form
      className={styles.quickFormBody}
      onSubmit={(event) => {
        event.preventDefault();

        if (!comment.trim()) {
          return;
        }

        onSubmit({
          type: 'comment',
          result: 'info_only',
          comment: comment.trim(),
          happenedAt: new Date().toISOString(),
        });
      }}
    >
      <FormShell isSaving={isSaving} onCancel={onCancel} title="Коментар">
        <label className={styles.formField}>
          <span className="sr-only">Коментар</span>
          <textarea
            autoFocus
            onChange={(event) => setComment(event.target.value)}
            placeholder="Що варто знати наступному координатору"
            rows="3"
            value={comment}
          />
        </label>
      </FormShell>
    </form>
  );
}

function IssueForm({ isSaving, onCancel, onSubmit }) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('utilities');
  const [entrance, setEntrance] = useState('');
  const [priority, setPriority] = useState('medium');

  return (
    <form
      className={styles.quickFormBody}
      onSubmit={(event) => {
        event.preventDefault();

        if (!title.trim()) {
          return;
        }

        onSubmit({ title: title.trim(), category, entrance: entrance.trim(), priority });
      }}
    >
      <FormShell isSaving={isSaving} onCancel={onCancel} title="Нове звернення">
        <label className={styles.formField}>
          <span>Суть звернення</span>
          <input
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Наприклад, не працює освітлення"
            type="text"
            value={title}
          />
        </label>

        <div className={styles.formGrid}>
          <label className={styles.formField}>
            <span>Категорія</span>
            <select onChange={(event) => setCategory(event.target.value)} value={category}>
              {ISSUE_CATEGORIES.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className={`${styles.formField} ${styles.formFieldNarrow}`}>
            <span>Підʼїзд</span>
            <input
              inputMode="numeric"
              onChange={(event) => setEntrance(event.target.value)}
              placeholder="2"
              type="text"
              value={entrance}
            />
          </label>

          <label className={styles.formField}>
            <span>Пріоритет</span>
            <select onChange={(event) => setPriority(event.target.value)} value={priority}>
              <option value="high">Високий</option>
              <option value="medium">Середній</option>
              <option value="low">Низький</option>
            </select>
          </label>
        </div>
      </FormShell>
    </form>
  );
}

function TaskForm({ isSaving, onCancel, onSubmit }) {
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState(() => toDateInputValue(1));

  return (
    <form
      className={styles.quickFormBody}
      onSubmit={(event) => {
        event.preventDefault();

        if (!title.trim()) {
          return;
        }

        onSubmit({
          title: title.trim(),
          dueAt: dueAt ? new Date(`${dueAt}T18:00:00`).toISOString() : null,
        });
      }}
    >
      <FormShell isSaving={isSaving} onCancel={onCancel} title="Нова задача">
        <label className={styles.formField}>
          <span>Що зробити</span>
          <input
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Наприклад, передзвонити голові ОСББ"
            type="text"
            value={title}
          />
        </label>

        <label className={styles.formField}>
          <span>Термін</span>
          <input
            onChange={(event) => setDueAt(event.target.value)}
            type="date"
            value={dueAt}
          />
        </label>
      </FormShell>
    </form>
  );
}

function PersonForm({ isSaving, onCancel, onSubmit }) {
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState('building_elder');
  const [phone, setPhone] = useState('');
  const [entrance, setEntrance] = useState('');

  return (
    <form
      className={styles.quickFormBody}
      onSubmit={(event) => {
        event.preventDefault();

        if (!fullName.trim()) {
          return;
        }

        onSubmit({
          fullName: fullName.trim(),
          role,
          entrance: entrance.trim(),
          contacts: phone.trim()
            ? [{ type: 'phone', value: phone.trim(), isPrimary: true }]
            : [],
        });
      }}
    >
      <FormShell isSaving={isSaving} onCancel={onCancel} title="Контактна особа">
        <label className={styles.formField}>
          <span>Імʼя</span>
          <input
            autoFocus
            onChange={(event) => setFullName(event.target.value)}
            placeholder="Коваленко Олена"
            type="text"
            value={fullName}
          />
        </label>

        <div className={styles.formGrid}>
          <label className={styles.formField}>
            <span>Роль у будинку</span>
            <select onChange={(event) => setRole(event.target.value)} value={role}>
              {PERSON_ROLES.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className={`${styles.formField} ${styles.formFieldNarrow}`}>
            <span>Підʼїзд</span>
            <input
              inputMode="numeric"
              onChange={(event) => setEntrance(event.target.value)}
              placeholder="2"
              type="text"
              value={entrance}
            />
          </label>
        </div>

        <label className={styles.formField}>
          <span>Телефон</span>
          <input
            inputMode="tel"
            onChange={(event) => setPhone(event.target.value)}
            placeholder="+380 67 123 45 67"
            type="tel"
            value={phone}
          />
        </label>
      </FormShell>
    </form>
  );
}

function QuickActions({ house, isSaving, canWrite, onAction, onIssue, onTask, onPerson, onPhoto }) {
  const [openForm, setOpenForm] = useState(null);
  const fileInputRef = useRef(null);

  // Switching to another building closes whatever half-filled form was open,
  // so a comment can never be saved against the wrong house.
  useEffect(() => setOpenForm(null), [house.id]);

  if (!canWrite) {
    return (
      <p className={styles.quickActionsLocked}>
        <ElectionsIcon name="info" size={15} />
        Для внесення даних потрібна роль у розділі «Вибори».
      </p>
    );
  }

  async function run(operation) {
    const saved = await operation();

    if (saved) {
      setOpenForm(null);
    }
  }

  return (
    <div className={styles.quickActions}>
      <div className={styles.quickActionRow} role="group" aria-label="Швидкі дії">
        {QUICK_ACTIONS.map((action) => (
          <button
            className={[
              styles.quickActionButton,
              openForm === action.id ? styles.quickActionButtonActive : '',
            ]
              .filter(Boolean)
              .join(' ')}
            key={action.id}
            onClick={() => {
              if (action.id === 'photo') {
                fileInputRef.current?.click();
                return;
              }

              setOpenForm((current) => (current === action.id ? null : action.id));
            }}
            type="button"
          >
            <ElectionsIcon name={action.icon} size={17} />
            <span>{action.label}</span>
          </button>
        ))}
      </div>

      {/* `capture` opens the camera straight away on a phone, which is the only
          way "add a photo of the entrance" is a five-second action in the field. */}
      <input
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];

          if (file) {
            onPhoto(file);
          }

          event.target.value = '';
        }}
        ref={fileInputRef}
        type="file"
      />

      {(openForm === 'call' || openForm === 'visit') && (
        <ActionForm
          isSaving={isSaving}
          onCancel={() => setOpenForm(null)}
          onSubmit={(payload) => run(() => onAction(payload))}
          type={openForm}
        />
      )}

      {openForm === 'comment' && (
        <CommentForm
          isSaving={isSaving}
          onCancel={() => setOpenForm(null)}
          onSubmit={(payload) => run(() => onAction(payload))}
        />
      )}

      {openForm === 'issue' && (
        <IssueForm
          isSaving={isSaving}
          onCancel={() => setOpenForm(null)}
          onSubmit={(payload) => run(() => onIssue(payload))}
        />
      )}

      {openForm === 'task' && (
        <TaskForm
          isSaving={isSaving}
          onCancel={() => setOpenForm(null)}
          onSubmit={(payload) => run(() => onTask(payload))}
        />
      )}

      {openForm === 'person' && (
        <PersonForm
          isSaving={isSaving}
          onCancel={() => setOpenForm(null)}
          onSubmit={(payload) => run(() => onPerson(payload))}
        />
      )}
    </div>
  );
}

export default QuickActions;
