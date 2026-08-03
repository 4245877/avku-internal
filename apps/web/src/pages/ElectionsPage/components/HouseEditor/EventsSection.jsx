/**
 * «Події» — meetings, clean-ups and tents held at this address.
 *
 * An event is never stored as a house even when it sits at one: it has a start
 * and an end, and a building does not. So this section reads
 * `GET /houses/:id/events`, which is the campaign's event list narrowed to this
 * building rather than a separate table.
 *
 * Creating one needs a coordinator — an event commits other people's time.
 */

import { useState } from 'react';

import { EVENT_TYPES, eventTypesById } from '../../../../features/elections/electionsTypes.js';
import { createEvent, deleteEvent } from '../../../../features/elections/electionsApi.js';
import { formatAssignee, formatDate } from '../../../../features/elections/houseUtils.js';
import { useEditorMutation } from '../../../../features/elections/useEditorMutation.js';
import ElectionsIcon from '../../../../features/elections/ElectionsIcon.jsx';
import {
  Badge,
  Button,
  Card,
  CollectionState,
  ConfirmButton,
  FieldGrid,
  FormStatus,
  SelectField,
  TextAreaField,
  TextField,
} from './editorFields.jsx';
import styles from './HouseEditor.module.css';

const STATUS_TONES = {
  planned: 'info',
  active: 'warning',
  done: 'success',
  cancelled: 'muted',
};

const STATUS_LABELS = {
  planned: 'Заплановано',
  active: 'Триває',
  done: 'Відбулась',
  cancelled: 'Скасовано',
};

function toLocalInput(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;

  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function emptyDraft() {
  return {
    type: 'meeting',
    title: '',
    description: '',
    startsAt: toLocalInput(),
    endsAt: '',
    status: 'planned',
  };
}

function EventsSection({
  house,
  campaignId,
  state,
  canManageEvents,
  isReadOnly,
  onChanged,
}) {
  const [draft, setDraft] = useState(null);
  const mutation = useEditorMutation();

  async function create(event) {
    event.preventDefault();

    if (!draft.title.trim()) {
      return;
    }

    const saved = await mutation.run(
      () =>
        createEvent(
          {
            type: draft.type,
            title: draft.title.trim(),
            description: draft.description.trim(),
            houseId: house.id,
            address: house.address,
            startsAt: new Date(draft.startsAt).toISOString(),
            endsAt: draft.endsAt ? new Date(draft.endsAt).toISOString() : null,
            status: draft.status,
          },
          { campaignId },
        ),
      'Подію створено.',
    );

    if (saved) {
      setDraft(null);
      onChanged();
    }
  }

  const canEdit = canManageEvents && !isReadOnly;
  const addButton = canEdit && !draft && (
    <Button icon="plus" onClick={() => setDraft(emptyDraft())} variant="primary">
      Нова подія
    </Button>
  );

  return (
    <Card actions={state.items.length > 0 ? addButton : null} icon="users" title="Події">
      {draft && (
        <form className={styles.subForm} onSubmit={create}>
          <FieldGrid>
            <TextField
              autoFocus
              label="Назва"
              onChange={(title) => setDraft({ ...draft, title })}
              placeholder="Зустріч із мешканцями 3 підʼїзду"
              required
              value={draft.title}
              wide
            />

            <SelectField
              label="Тип"
              onChange={(type) => setDraft({ ...draft, type })}
              options={EVENT_TYPES}
              required
              value={draft.type}
            />

            <SelectField
              label="Статус"
              onChange={(status) => setDraft({ ...draft, status })}
              options={Object.entries(STATUS_LABELS).map(([id, label]) => ({ id, label }))}
              value={draft.status}
            />

            <TextField
              label="Початок"
              onChange={(startsAt) => setDraft({ ...draft, startsAt })}
              required
              type="datetime-local"
              value={draft.startsAt}
            />

            <TextField
              label="Завершення"
              onChange={(endsAt) => setDraft({ ...draft, endsAt })}
              type="datetime-local"
              value={draft.endsAt}
            />
          </FieldGrid>

          <TextAreaField
            label="Опис"
            onChange={(description) => setDraft({ ...draft, description })}
            placeholder="Про що йтиметься, хто проводить"
            rows={2}
            value={draft.description}
          />

          <div className={styles.subFormActions}>
            <Button onClick={() => setDraft(null)} variant="quiet">
              Скасувати
            </Button>

            <Button
              disabled={!draft.title.trim()}
              icon="check"
              isBusy={mutation.isBusy}
              type="submit"
              variant="primary"
            >
              Створити подію
            </Button>
          </div>
        </form>
      )}

      <FormStatus error={mutation.error} notice={mutation.notice} />

      <CollectionState
        action={addButton}
        emptyIcon="users"
        emptyText="Зустрічі, суботники й намети, привʼязані до цієї адреси, зʼявляться тут."
        emptyTitle="Подій за цією адресою немає"
        state={state}
      />

      <ul className={styles.recordList}>
        {state.items.map((one) => (
          <li className={styles.recordRow} key={one.id}>
            <div className={styles.recordTop}>
              <strong>{one.title}</strong>

              <Badge tone={STATUS_TONES[one.status] ?? 'neutral'}>
                {STATUS_LABELS[one.status] ?? one.status}
              </Badge>

              <Badge tone="info">
                {eventTypesById[one.type]?.label ?? one.type}
              </Badge>
            </div>

            <small className={styles.recordMeta}>
              {formatDate(one.startsAt)}
              {one.endsAt ? ` — ${formatDate(one.endsAt)}` : ''}
              {one.createdBy ? ` · ${formatAssignee(one.createdBy)}` : ''}
            </small>

            {one.description && <p className={styles.recordText}>{one.description}</p>}

            {one.shifts?.length > 0 && (
              <p className={styles.recordNext}>
                <ElectionsIcon name="users" size={14} />
                Змін заплановано: {one.shifts.length}
              </p>
            )}

            {canEdit && (
              <div className={styles.recordActions}>
                <ConfirmButton
                  confirmLabel="Видалити"
                  isBusy={mutation.isBusy}
                  onConfirm={async () => {
                    const done = await mutation.run(
                      () => deleteEvent(one.id, { campaignId }),
                      'Подію видалено.',
                    );

                    if (done) {
                      onChanged();
                    }

                    return Boolean(done);
                  }}
                  question="Видалити подію?"
                  variant="quiet"
                >
                  Видалити
                </ConfirmButton>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default EventsSection;
