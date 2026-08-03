/**
 * «Дії» — the work log for one building.
 *
 * Each kind of action gets its own form rather than one «Примітка» box, because
 * the fields genuinely differ: a call has no entrance, a material hand-out has
 * a count, a meeting has people. What they share — when it happened, how it
 * went, what is next — is the shell.
 *
 * An action can be corrected, not only deleted. A mistyped result used to mean
 * deleting the record and re-entering it, which threw away the original author
 * and timestamp and left a hole where a correction belonged.
 */

import { useMemo, useState } from 'react';

import {
  ACTION_RESULTS,
  ACTION_TYPES,
  actionResultsById,
  actionTypesById,
} from '../../../../features/elections/electionsTypes.js';
import {
  createAction,
  deleteAction,
  updateAction,
} from '../../../../features/elections/electionsApi.js';
import { formatAssignee, formatDate } from '../../../../features/elections/houseUtils.js';
import { useEditorMutation } from '../../../../features/elections/useEditorMutation.js';
import ElectionsIcon from '../../../../features/elections/ElectionsIcon.jsx';
import {
  Badge,
  Button,
  Card,
  CollectionState,
  ConfirmButton,
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

/** `2026-08-03T10:30` — what `input[type=datetime-local]` expects. */
function toLocalInput(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;

  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

const SORT_OPTIONS = [
  { id: 'newest', label: 'Спочатку нові' },
  { id: 'oldest', label: 'Спочатку старі' },
];

const ALL = { id: 'all', label: 'Усі' };

function emptyDraft(type = 'visit') {
  return {
    type,
    result: type === 'comment' ? 'info_only' : 'contacted',
    happenedAt: toLocalInput(),
    comment: '',
    nextStep: '',
    nextActionAt: '',
  };
}

function toPayload(draft) {
  return {
    type: draft.type,
    result: draft.result,
    happenedAt: new Date(draft.happenedAt).toISOString(),
    comment: draft.comment.trim(),
    nextStep: draft.nextStep.trim(),
    nextActionAt: draft.nextActionAt
      ? new Date(`${draft.nextActionAt}T12:00:00`).toISOString()
      : null,
  };
}

function ActionForm({ draft, onChange, onSubmit, onCancel, isBusy, submitLabel }) {
  return (
    <form
      className={styles.subForm}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <FieldGrid>
        <SelectField
          label="Тип дії"
          onChange={(type) => onChange({ type })}
          options={ACTION_TYPES}
          required
          value={draft.type}
        />

        <SelectField
          label="Результат"
          onChange={(result) => onChange({ result })}
          options={ACTION_RESULTS}
          required
          value={draft.result}
        />

        <TextField
          label="Коли"
          onChange={(happenedAt) => onChange({ happenedAt })}
          type="datetime-local"
          value={draft.happenedAt}
        />

        <DateField
          label="Термін наступного кроку"
          onChange={(nextActionAt) => onChange({ nextActionAt })}
          value={draft.nextActionAt}
        />

        <TextField
          label="Наступний крок"
          onChange={(nextStep) => onChange({ nextStep })}
          placeholder="Зайти в суботу зранку"
          value={draft.nextStep}
          wide
        />
      </FieldGrid>

      <TextAreaField
        label="Коментар"
        onChange={(comment) => onChange({ comment })}
        placeholder="Що варто знати наступному координатору"
        rows={2}
        value={draft.comment}
      />

      <div className={styles.subFormActions}>
        <Button onClick={onCancel} variant="quiet">
          Скасувати
        </Button>

        <Button icon="check" isBusy={isBusy} type="submit" variant="primary">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function ActionsSection({
  house,
  campaignId,
  state,
  canWrite,
  canDelete,
  isReadOnly,
  onChanged,
}) {
  const [draft, setDraft] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [typeFilter, setTypeFilter] = useState('all');
  const [sort, setSort] = useState('newest');
  const mutation = useEditorMutation();

  const visible = useMemo(() => {
    const rows = state.items.filter(
      (action) => typeFilter === 'all' || action.type === typeFilter,
    );

    return [...rows].sort((left, right) => {
      const delta = String(right.happenedAt).localeCompare(String(left.happenedAt));

      return sort === 'newest' ? delta : -delta;
    });
  }, [sort, state.items, typeFilter]);

  async function create() {
    const saved = await mutation.run(
      () => createAction({ ...toPayload(draft), houseId: house.id }, { campaignId }),
      'Дію записано.',
    );

    if (saved) {
      setDraft(null);
      onChanged();
    }
  }

  async function saveEdit() {
    const saved = await mutation.run(
      () => updateAction(editingId, toPayload(draft), { campaignId }),
      'Дію оновлено.',
    );

    if (saved) {
      setEditingId(null);
      setDraft(null);
      onChanged();
    }
  }

  const addButton = canWrite && !isReadOnly && !draft && (
    <Button icon="plus" onClick={() => setDraft(emptyDraft())} variant="primary">
      Записати дію
    </Button>
  );

  return (
    <Card actions={state.items.length > 0 ? addButton : null} icon="list" title="Дії">
      {draft && !editingId && (
        <ActionForm
          draft={draft}
          isBusy={mutation.isBusy}
          onCancel={() => setDraft(null)}
          onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
          onSubmit={create}
          submitLabel="Записати дію"
        />
      )}

      <FormStatus error={mutation.error} notice={mutation.notice} />

      {state.items.length > 1 && (
        <ListToolbar>
          <ToolbarSelect
            label="Тип"
            onChange={setTypeFilter}
            options={[ALL, ...ACTION_TYPES]}
            value={typeFilter}
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
        emptyIcon="list"
        emptyText="Дзвінки, візити та зустрічі, записані тут, формують історію роботи з будинком."
        emptyTitle="Дій ще не записано"
        state={state}
      />

      {visible.length === 0 && state.items.length > 0 && (
        <p className={styles.mutedLine}>За цим фільтром дій немає.</p>
      )}

      <ol className={styles.timeline}>
        {visible.map((action) => (
          <li className={styles.timelineRow} key={action.id}>
            <span aria-hidden="true" className={styles.timelineIcon}>
              <ElectionsIcon
                name={actionTypesById[action.type]?.icon ?? 'list'}
                size={15}
              />
            </span>

            <div className={styles.timelineBody}>
              {editingId === action.id
                ? (
                  <ActionForm
                    draft={draft}
                    isBusy={mutation.isBusy}
                    onCancel={() => {
                      setEditingId(null);
                      setDraft(null);
                    }}
                    onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
                    onSubmit={saveEdit}
                    submitLabel="Зберегти дію"
                  />
                )
                : (
                  <>
                    <div className={styles.recordTop}>
                      <strong>{actionTypesById[action.type]?.label ?? action.type}</strong>
                      <Badge tone={actionResultsById[action.result]?.tone ?? 'neutral'}>
                        {actionResultsById[action.result]?.label ?? action.result}
                      </Badge>
                    </div>

                    <small className={styles.recordMeta}>
                      {formatDate(action.happenedAt)} · {formatAssignee(action.authorEmail)}
                    </small>

                    {action.comment && (
                      <p className={styles.recordText}>{action.comment}</p>
                    )}

                    {action.nextStep && (
                      <p className={styles.recordNext}>
                        Наступний крок: {action.nextStep}
                      </p>
                    )}

                    {canWrite && !isReadOnly && (
                      <div className={styles.recordActions}>
                        <Button
                          icon="edit"
                          onClick={() => {
                            setEditingId(action.id);
                            setDraft({
                              type: action.type,
                              result: action.result,
                              happenedAt: toLocalInput(action.happenedAt),
                              comment: action.comment ?? '',
                              nextStep: action.nextStep ?? '',
                              nextActionAt: action.nextActionAt
                                ? String(action.nextActionAt).slice(0, 10)
                                : '',
                            });
                          }}
                          variant="quiet"
                        >
                          Редагувати
                        </Button>

                        {canDelete && (
                          <ConfirmButton
                            confirmLabel="Видалити"
                            isBusy={mutation.isBusy}
                            onConfirm={async () => {
                              const done = await mutation.run(
                                () => deleteAction(action.id, { campaignId }),
                                'Дію видалено.',
                              );

                              if (done) {
                                onChanged();
                              }

                              return Boolean(done);
                            }}
                            question="Видалити цей запис?"
                            variant="quiet"
                          >
                            Видалити
                          </ConfirmButton>
                        )}
                      </div>
                    )}
                  </>
                )}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export default ActionsSection;
