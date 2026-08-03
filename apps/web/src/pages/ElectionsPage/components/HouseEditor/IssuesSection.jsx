/**
 * «Звернення» — what residents of this building have asked for.
 *
 * The full record, not a note: category, title, description, priority, status,
 * who owns it, when it is due, how it ended and whether it is restricted. A
 * `restricted` issue keeps its title and status for everybody — the card still
 * has to show that something is open — but the API only sends its description
 * to a coordinator and above, so the field is simply absent for others rather
 * than blanked out here.
 */

import { useMemo, useState } from 'react';

import {
  ISSUE_CATEGORIES,
  ISSUE_STATUSES,
  PRIORITIES,
  issueCategoriesById,
  issueStatusesById,
  prioritiesById,
} from '../../../../features/elections/electionsTypes.js';
import { createIssue, updateIssue } from '../../../../features/elections/electionsApi.js';
import { formatAssignee, formatShortDate } from '../../../../features/elections/houseUtils.js';
import { useEditorMutation } from '../../../../features/elections/useEditorMutation.js';
import {
  Badge,
  Button,
  Card,
  CollectionState,
  DateField,
  FieldGrid,
  FormStatus,
  ListToolbar,
  SelectField,
  TextAreaField,
  TextField,
  ToolbarSelect,
} from './editorFields.jsx';
import styles from './HouseEditor.module.css';

const CONFIDENTIALITY = [
  { id: 'normal', label: 'Звичайне' },
  { id: 'restricted', label: 'Обмежений доступ' },
];

const SORT_OPTIONS = [
  { id: 'due', label: 'За терміном' },
  { id: 'newest', label: 'Спочатку нові' },
];

const STATUS_FILTERS = [
  { id: 'open', label: 'Відкриті' },
  { id: 'all', label: 'Усі' },
  ...ISSUE_STATUSES,
];

function emptyDraft() {
  return {
    category: 'utilities',
    title: '',
    description: '',
    entrance: '',
    priority: 'medium',
    status: 'open',
    assigneeEmail: '',
    dueAt: '',
    resolution: '',
    confidentiality: 'normal',
  };
}

function toDraft(issue) {
  return {
    category: issue.category,
    title: issue.title,
    description: issue.description ?? '',
    entrance: issue.entrance ?? '',
    priority: issue.priority,
    status: issue.status,
    assigneeEmail: issue.assigneeEmail ?? '',
    dueAt: issue.dueAt ? String(issue.dueAt).slice(0, 10) : '',
    resolution: issue.resolution ?? '',
    confidentiality: issue.confidentiality ?? 'normal',
  };
}

function toPayload(draft) {
  return {
    category: draft.category,
    title: draft.title.trim(),
    description: draft.description.trim(),
    entrance: draft.entrance.trim(),
    priority: draft.priority,
    status: draft.status,
    assigneeEmail: draft.assigneeEmail.trim() || null,
    dueAt: draft.dueAt ? new Date(`${draft.dueAt}T18:00:00`).toISOString() : null,
    resolution: draft.resolution.trim(),
    confidentiality: draft.confidentiality,
  };
}

function IssueForm({ draft, onChange, onSubmit, onCancel, isBusy, submitLabel, knownAssignees }) {
  return (
    <form
      className={styles.subForm}
      onSubmit={(event) => {
        event.preventDefault();

        if (draft.title.trim()) {
          onSubmit();
        }
      }}
    >
      <FieldGrid>
        <TextField
          autoFocus
          label="Назва звернення"
          onChange={(title) => onChange({ title })}
          placeholder="Не працює освітлення в підʼїзді"
          required
          value={draft.title}
          wide
        />

        <SelectField
          label="Категорія"
          onChange={(category) => onChange({ category })}
          options={ISSUE_CATEGORIES}
          required
          value={draft.category}
        />

        <TextField
          inputMode="numeric"
          label="Підʼїзд"
          onChange={(entrance) => onChange({ entrance })}
          placeholder="2"
          value={draft.entrance}
        />

        <SelectField
          label="Пріоритет"
          onChange={(priority) => onChange({ priority })}
          options={PRIORITIES}
          value={draft.priority}
        />

        <SelectField
          label="Статус"
          onChange={(status) => onChange({ status })}
          options={ISSUE_STATUSES}
          value={draft.status}
        />

        <TextField
          label="Відповідальний"
          list="editor-issue-assignees"
          onChange={(assigneeEmail) => onChange({ assigneeEmail })}
          placeholder="name@avku.org"
          type="email"
          value={draft.assigneeEmail}
        />

        <DateField
          label="Термін"
          onChange={(dueAt) => onChange({ dueAt })}
          value={draft.dueAt}
        />

        <SelectField
          hint="Обмежений опис бачать лише координатори й вище"
          label="Конфіденційність"
          onChange={(confidentiality) => onChange({ confidentiality })}
          options={CONFIDENTIALITY}
          value={draft.confidentiality}
        />
      </FieldGrid>

      <datalist id="editor-issue-assignees">
        {knownAssignees.map((known) => (
          <option key={known} value={known} />
        ))}
      </datalist>

      <TextAreaField
        label="Опис"
        onChange={(description) => onChange({ description })}
        placeholder="Що саме сталося, з чиїх слів, що вже робили"
        value={draft.description}
      />

      <TextAreaField
        label="Результат"
        onChange={(resolution) => onChange({ resolution })}
        placeholder="Чим завершилось"
        rows={2}
        value={draft.resolution}
      />

      <div className={styles.subFormActions}>
        <Button onClick={onCancel} variant="quiet">
          Скасувати
        </Button>

        <Button
          disabled={!draft.title.trim()}
          icon="check"
          isBusy={isBusy}
          type="submit"
          variant="primary"
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function IssuesSection({
  house,
  campaignId,
  state,
  canWrite,
  isReadOnly,
  knownAssignees,
  onChanged,
}) {
  const [draft, setDraft] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [sort, setSort] = useState('due');
  const mutation = useEditorMutation();

  const visible = useMemo(() => {
    const rows = state.items.filter((issue) => {
      if (statusFilter === 'all') {
        return true;
      }

      if (statusFilter === 'open') {
        return issue.isOpen;
      }

      return issue.status === statusFilter;
    });

    return [...rows].sort((left, right) => {
      if (sort === 'newest') {
        return String(right.openedAt).localeCompare(String(left.openedAt));
      }

      // No due date sorts last: an issue nobody put a date on is not urgent by
      // default, and sorting empties first would bury the dated ones.
      const leftDue = left.dueAt ?? '9999';
      const rightDue = right.dueAt ?? '9999';

      return String(leftDue).localeCompare(String(rightDue));
    });
  }, [sort, state.items, statusFilter]);

  async function create() {
    const saved = await mutation.run(
      () => createIssue({ ...toPayload(draft), houseId: house.id }, { campaignId }),
      'Звернення створено.',
    );

    if (saved) {
      setDraft(null);
      onChanged();
    }
  }

  async function saveEdit() {
    const saved = await mutation.run(
      () => updateIssue(editingId, toPayload(draft), { campaignId }),
      'Звернення оновлено.',
    );

    if (saved) {
      setEditingId(null);
      setDraft(null);
      onChanged();
    }
  }

  async function resolve(issue) {
    const saved = await mutation.run(
      () => updateIssue(issue.id, { status: 'resolved' }, { campaignId }),
      'Звернення позначено вирішеним.',
    );

    if (saved) {
      onChanged();
    }
  }

  const addButton = canWrite && !isReadOnly && !draft && (
    <Button icon="plus" onClick={() => setDraft(emptyDraft())} variant="primary">
      Нове звернення
    </Button>
  );

  return (
    <Card
      actions={state.items.length > 0 ? addButton : null}
      icon="warning"
      title="Звернення"
    >
      {draft && !editingId && (
        <IssueForm
          draft={draft}
          isBusy={mutation.isBusy}
          knownAssignees={knownAssignees}
          onCancel={() => setDraft(null)}
          onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
          onSubmit={create}
          submitLabel="Створити звернення"
        />
      )}

      <FormStatus error={mutation.error} notice={mutation.notice} />

      {state.items.length > 1 && (
        <ListToolbar>
          <ToolbarSelect
            label="Статус"
            onChange={setStatusFilter}
            options={STATUS_FILTERS}
            value={statusFilter}
          />

          <ToolbarSelect
            label="Порядок"
            onChange={setSort}
            options={SORT_OPTIONS}
            value={sort}
          />
        </ListToolbar>
      )}

      <CollectionState
        action={addButton}
        emptyIcon="warning"
        emptyText="Тут зберігаються прохання й скарги мешканців — з категорією, терміном і відповідальним."
        emptyTitle="Звернень від цього будинку немає"
        state={state}
      />

      {visible.length === 0 && state.items.length > 0 && (
        <p className={styles.mutedLine}>За цим фільтром звернень немає.</p>
      )}

      <ul className={styles.recordList}>
        {visible.map((issue) => (
          <li className={styles.recordRow} key={issue.id}>
            {editingId === issue.id
              ? (
                <IssueForm
                  draft={draft}
                  isBusy={mutation.isBusy}
                  knownAssignees={knownAssignees}
                  onCancel={() => {
                    setEditingId(null);
                    setDraft(null);
                  }}
                  onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
                  onSubmit={saveEdit}
                  submitLabel="Зберегти звернення"
                />
              )
              : (
                <>
                  <div className={styles.recordTop}>
                    <strong>{issue.title}</strong>

                    <Badge tone={issueStatusesById[issue.status]?.tone ?? 'neutral'}>
                      {issueStatusesById[issue.status]?.label ?? issue.status}
                    </Badge>

                    {issue.priority === 'high' && (
                      <Badge tone="danger">{prioritiesById.high.label}</Badge>
                    )}

                    {issue.confidentiality === 'restricted' && (
                      <Badge tone="muted">Обмежений доступ</Badge>
                    )}
                  </div>

                  <small className={styles.recordMeta}>
                    {issueCategoriesById[issue.category]?.label ?? issue.category}
                    {issue.entrance ? ` · підʼїзд ${issue.entrance}` : ''}
                    {` · відкрито ${formatShortDate(issue.openedAt)}`}
                    {issue.dueAt ? ` · термін ${formatShortDate(issue.dueAt)}` : ''}
                    {issue.assigneeEmail
                      ? ` · ${formatAssignee(issue.assigneeEmail)}`
                      : ' · без відповідального'}
                  </small>

                  {issue.description && (
                    <p className={styles.recordText}>{issue.description}</p>
                  )}

                  {issue.resolution && (
                    <p className={styles.recordNext}>Результат: {issue.resolution}</p>
                  )}

                  {canWrite && !isReadOnly && (
                    <div className={styles.recordActions}>
                      <Button
                        icon="edit"
                        onClick={() => {
                          setEditingId(issue.id);
                          setDraft(toDraft(issue));
                        }}
                        variant="quiet"
                      >
                        Редагувати
                      </Button>

                      {issue.isOpen && (
                        <Button
                          icon="check"
                          isBusy={mutation.isBusy}
                          onClick={() => resolve(issue)}
                          variant="quiet"
                        >
                          Позначити вирішеним
                        </Button>
                      )}
                    </div>
                  )}
                </>
              )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default IssuesSection;
