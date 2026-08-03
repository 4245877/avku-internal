/**
 * «Завдання» — what still has to be done about this building.
 *
 * A task can hang off an issue or an event, and the two selects offer only what
 * this house actually has: linking a task to an issue on the other side of the
 * district is not something a house editor should be able to do by accident.
 * The lists come from the sections beside this one, which are already loaded by
 * the time somebody is filing a task against one.
 */

import { useMemo, useState } from 'react';

import {
  PRIORITIES,
  TASK_STATUSES,
  prioritiesById,
  taskStatusesById,
} from '../../../../features/elections/electionsTypes.js';
import { createTask, updateTask } from '../../../../features/elections/electionsApi.js';
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

const SORT_OPTIONS = [
  { id: 'due', label: 'За терміном' },
  { id: 'newest', label: 'Спочатку нові' },
];

const STATUS_FILTERS = [
  { id: 'open', label: 'Відкриті' },
  { id: 'all', label: 'Усі' },
  ...TASK_STATUSES,
];

function emptyDraft() {
  return {
    title: '',
    description: '',
    assigneeEmail: '',
    dueAt: '',
    priority: 'medium',
    status: 'todo',
    issueId: '',
    eventId: '',
  };
}

function toDraft(task) {
  return {
    title: task.title,
    description: task.description ?? '',
    assigneeEmail: task.assigneeEmail ?? '',
    dueAt: task.dueAt ? String(task.dueAt).slice(0, 10) : '',
    priority: task.priority,
    status: task.status,
    issueId: task.issueId ?? '',
    eventId: task.eventId ?? '',
  };
}

function toPayload(draft) {
  return {
    title: draft.title.trim(),
    description: draft.description.trim(),
    assigneeEmail: draft.assigneeEmail.trim() || null,
    dueAt: draft.dueAt ? new Date(`${draft.dueAt}T18:00:00`).toISOString() : null,
    priority: draft.priority,
    status: draft.status,
    issueId: draft.issueId || null,
    eventId: draft.eventId || null,
  };
}

function TaskForm({
  draft,
  onChange,
  onSubmit,
  onCancel,
  isBusy,
  submitLabel,
  knownAssignees,
  issues,
  events,
}) {
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
          label="Що зробити"
          onChange={(title) => onChange({ title })}
          placeholder="Передзвонити голові ОСББ"
          required
          value={draft.title}
          wide
        />

        <TextField
          label="Виконавець"
          list="editor-task-assignees"
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
          label="Пріоритет"
          onChange={(priority) => onChange({ priority })}
          options={PRIORITIES}
          value={draft.priority}
        />

        <SelectField
          label="Статус"
          onChange={(status) => onChange({ status })}
          options={TASK_STATUSES}
          value={draft.status}
        />

        {issues.length > 0 && (
          <SelectField
            label="Повʼязане звернення"
            onChange={(issueId) => onChange({ issueId })}
            options={issues}
            placeholder="Немає"
            value={draft.issueId}
          />
        )}

        {events.length > 0 && (
          <SelectField
            label="Повʼязана подія"
            onChange={(eventId) => onChange({ eventId })}
            options={events}
            placeholder="Немає"
            value={draft.eventId}
          />
        )}
      </FieldGrid>

      <datalist id="editor-task-assignees">
        {knownAssignees.map((known) => (
          <option key={known} value={known} />
        ))}
      </datalist>

      <TextAreaField
        label="Опис"
        onChange={(description) => onChange({ description })}
        placeholder="Деталі, які знадобляться виконавцю"
        rows={2}
        value={draft.description}
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

function TasksSection({
  house,
  campaignId,
  state,
  issuesState,
  eventsState,
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

  const issueOptions = useMemo(
    () => issuesState.items.map((issue) => ({ id: issue.id, label: issue.title })),
    [issuesState.items],
  );

  const eventOptions = useMemo(
    () => eventsState.items.map((one) => ({ id: one.id, label: one.title })),
    [eventsState.items],
  );

  const visible = useMemo(() => {
    const rows = state.items.filter((task) => {
      if (statusFilter === 'all') {
        return true;
      }

      if (statusFilter === 'open') {
        return task.status === 'todo' || task.status === 'in_progress';
      }

      return task.status === statusFilter;
    });

    return [...rows].sort((left, right) => {
      if (sort === 'newest') {
        return String(right.createdAt).localeCompare(String(left.createdAt));
      }

      return String(left.dueAt ?? '9999').localeCompare(String(right.dueAt ?? '9999'));
    });
  }, [sort, state.items, statusFilter]);

  async function create() {
    const saved = await mutation.run(
      () => createTask({ ...toPayload(draft), houseId: house.id }, { campaignId }),
      'Задачу створено.',
    );

    if (saved) {
      setDraft(null);
      onChanged();
    }
  }

  async function saveEdit() {
    const saved = await mutation.run(
      () => updateTask(editingId, toPayload(draft), { campaignId }),
      'Задачу оновлено.',
    );

    if (saved) {
      setEditingId(null);
      setDraft(null);
      onChanged();
    }
  }

  async function complete(task) {
    const saved = await mutation.run(
      () => updateTask(task.id, { status: 'done' }, { campaignId }),
      'Задачу позначено виконаною.',
    );

    if (saved) {
      onChanged();
    }
  }

  const addButton = canWrite && !isReadOnly && !draft && (
    <Button icon="plus" onClick={() => setDraft(emptyDraft())} variant="primary">
      Нова задача
    </Button>
  );

  return (
    <Card actions={state.items.length > 0 ? addButton : null} icon="check" title="Завдання">
      {draft && !editingId && (
        <TaskForm
          draft={draft}
          events={eventOptions}
          isBusy={mutation.isBusy}
          issues={issueOptions}
          knownAssignees={knownAssignees}
          onCancel={() => setDraft(null)}
          onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
          onSubmit={create}
          submitLabel="Створити задачу"
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
        emptyIcon="check"
        emptyText="Задача з виконавцем і терміном — те, що не дає будинку випасти з роботи."
        emptyTitle="Задач за цим будинком немає"
        state={state}
      />

      {visible.length === 0 && state.items.length > 0 && (
        <p className={styles.mutedLine}>За цим фільтром задач немає.</p>
      )}

      <ul className={styles.recordList}>
        {visible.map((task) => (
          <li
            className={[styles.recordRow, task.isOverdue ? styles.recordRowOverdue : '']
              .filter(Boolean)
              .join(' ')}
            key={task.id}
          >
            {editingId === task.id
              ? (
                <TaskForm
                  draft={draft}
                  events={eventOptions}
                  isBusy={mutation.isBusy}
                  issues={issueOptions}
                  knownAssignees={knownAssignees}
                  onCancel={() => {
                    setEditingId(null);
                    setDraft(null);
                  }}
                  onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
                  onSubmit={saveEdit}
                  submitLabel="Зберегти задачу"
                />
              )
              : (
                <>
                  <div className={styles.recordTop}>
                    <strong>{task.title}</strong>

                    <Badge tone={taskStatusesById[task.status]?.tone ?? 'neutral'}>
                      {taskStatusesById[task.status]?.label ?? task.status}
                    </Badge>

                    {task.priority === 'high' && (
                      <Badge tone="danger">{prioritiesById.high.label}</Badge>
                    )}
                  </div>

                  <small className={styles.recordMeta}>
                    {task.dueAt ? `Термін ${formatShortDate(task.dueAt)}` : 'без терміну'}
                    {task.isOverdue ? ' · прострочено' : ''}
                    {task.assigneeEmail
                      ? ` · ${formatAssignee(task.assigneeEmail)}`
                      : ' · без виконавця'}
                  </small>

                  {task.description && (
                    <p className={styles.recordText}>{task.description}</p>
                  )}

                  {canWrite && !isReadOnly && (
                    <div className={styles.recordActions}>
                      <Button
                        icon="edit"
                        onClick={() => {
                          setEditingId(task.id);
                          setDraft(toDraft(task));
                        }}
                        variant="quiet"
                      >
                        Редагувати
                      </Button>

                      {task.status !== 'done' && (
                        <Button
                          icon="check"
                          isBusy={mutation.isBusy}
                          onClick={() => complete(task)}
                          variant="quiet"
                        >
                          Позначити виконаною
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

export default TasksSection;
