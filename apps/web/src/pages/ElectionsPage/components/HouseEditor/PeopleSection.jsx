/**
 * «Контактні особи» — who to talk to in this building, and how.
 *
 * A person is a record of its own, linked to the house by a dated row, and the
 * section keeps that distinction visible because it is the one people get
 * wrong: **«Відвʼязати» removes the link, «Видалити» removes the human being.**
 * Somebody who moved out should lose the link and keep their record — they may
 * be the head of the ОСББ two streets over. Only a manager can do the second.
 *
 * A phone belongs to the person, not to the wall, so one contact who looks
 * after two entrances is one record with two links rather than two copies of a
 * number that will diverge. Each channel carries when it was last confirmed to
 * work: a number that was right two years ago and one checked last week are not
 * the same datum to somebody about to dial it.
 *
 * Before a new person is created the section looks for one who already exists —
 * by normalised phone first, then by name — because the commonest way to end up
 * with two records for the same head of an ОСББ is two canvassers typing the
 * same name a week apart.
 *
 * There is deliberately no political position, no age band and no support
 * score. Those were removed from the module and there is nowhere to put them.
 */

import { useEffect, useRef, useState } from 'react';

import {
  CONTACT_TYPES,
  PERSON_ROLES,
  contactTypesById,
  createLocalId,
} from '../../../../features/elections/electionsTypes.js';
import {
  formatShortDate,
  getPersonRoleLabel,
  normalizePhoneDigits,
} from '../../../../features/elections/houseUtils.js';
import {
  createHousePerson,
  deletePerson,
  deletePersonLink,
  linkPersonToHouse,
  searchContacts,
  updatePerson,
  updatePersonLink,
} from '../../../../features/elections/electionsApi.js';
import { useEditorMutation } from '../../../../features/elections/useEditorMutation.js';
import ElectionsIcon from '../../../../features/elections/ElectionsIcon.jsx';
import {
  Badge,
  Button,
  Card,
  CheckboxField,
  CollectionState,
  ConfirmButton,
  FieldGrid,
  FormStatus,
  SelectField,
  TextAreaField,
  TextField,
} from './editorFields.jsx';
import styles from './HouseEditor.module.css';

/** A phone is worth tapping; an email is worth a `mailto:`. */
function contactHref(contact) {
  const value = String(contact.value ?? '').trim();

  if (!value || contact.isMasked) {
    return null;
  }

  if (contact.type === 'phone') {
    return `tel:${value.replace(/[^\d+]/g, '')}`;
  }

  if (contact.type === 'viber') {
    return `viber://chat?number=${encodeURIComponent(value.replace(/[^\d+]/g, ''))}`;
  }

  if (contact.type === 'email') {
    return `mailto:${value}`;
  }

  if (contact.type === 'telegram') {
    return `https://t.me/${value.replace(/^@/, '')}`;
  }

  return null;
}

function emptyContactDraft() {
  return {
    key: createLocalId('contact'),
    id: '',
    type: 'phone',
    value: '',
    label: '',
    isPrimary: false,
    verified: false,
    verifiedAt: null,
    verifiedBy: null,
  };
}

function toContactDrafts(contacts) {
  if (!contacts || contacts.length === 0) {
    return [emptyContactDraft()];
  }

  return contacts.map((contact) => ({
    key: contact.id,
    id: contact.id,
    type: contact.type,
    value: contact.value,
    label: contact.label ?? '',
    isPrimary: Boolean(contact.isPrimary),
    verified: false,
    verifiedAt: contact.verifiedAt ?? null,
    verifiedBy: contact.verifiedBy ?? null,
  }));
}

/** Drops the blank rows, so an untouched empty channel is not a save error. */
function toContactPayload(drafts) {
  return drafts
    .filter((contact) => contact.value.trim())
    .map((contact) => ({
      id: contact.id || undefined,
      type: contact.type,
      value: contact.value.trim(),
      label: contact.label.trim(),
      isPrimary: contact.isPrimary,
      // Never a date — the server stamps its own clock and the actor.
      verified: contact.verified,
    }));
}

/** The repeated phone/email rows inside a person form. */
function ContactRows({ contacts, onChange, disabled }) {
  function update(key, patch) {
    onChange(contacts.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  return (
    <div className={styles.contactRows}>
      {contacts.map((contact) => (
        <div className={styles.contactRow} key={contact.key}>
          <FieldGrid columns={3}>
            <SelectField
              disabled={disabled}
              label="Канал"
              onChange={(type) => update(contact.key, { type })}
              options={CONTACT_TYPES}
              value={contact.type}
            />

            <TextField
              disabled={disabled}
              inputMode={contact.type === 'phone' ? 'tel' : undefined}
              label="Значення"
              onChange={(value) => update(contact.key, { value })}
              placeholder={contact.type === 'phone' ? '+380 67 123 45 67' : ''}
              type={contactTypesById[contact.type]?.inputType ?? 'text'}
              value={contact.value}
            />

            <TextField
              disabled={disabled}
              label="Підпис"
              onChange={(label) => update(contact.key, { label })}
              placeholder="робочий, син"
              value={contact.label}
            />
          </FieldGrid>

          <div className={styles.contactRowFooter}>
            <CheckboxField
              checked={contact.isPrimary}
              disabled={disabled}
              label="Основний контакт"
              onChange={(isPrimary) => update(contact.key, { isPrimary })}
            />

            <CheckboxField
              checked={contact.verified}
              disabled={disabled}
              hint={
                contact.verifiedAt
                  ? `перевірено ${formatShortDate(contact.verifiedAt)}`
                  : 'ще не перевірявся'
              }
              label="Телефон актуальний — записати дату перевірки"
              onChange={(verified) => update(contact.key, { verified })}
            />

            {contacts.length > 1 && !disabled && (
              <Button
                onClick={() =>
                  onChange(contacts.filter((row) => row.key !== contact.key))}
                variant="quiet"
              >
                <ElectionsIcon name="close" size={14} />
                Прибрати
              </Button>
            )}
          </div>
        </div>
      ))}

      {!disabled && (
        <Button
          icon="plus"
          onClick={() => onChange([...contacts, emptyContactDraft()])}
          variant="quiet"
        >
          Ще один контакт
        </Button>
      )}
    </div>
  );
}

/**
 * The duplicate check.
 *
 * Runs against `GET /search`, which only ever looks inside the houses the
 * caller may already see — so it cannot become a way to discover a contact in
 * somebody else's territory. Debounced, because it fires while a name is being
 * typed.
 */
function useDuplicateCheck({ fullName, phone, campaignId, enabled }) {
  const [matches, setMatches] = useState([]);

  useEffect(() => {
    const digits = normalizePhoneDigits(phone);
    const query = digits.length >= 5 ? phone.trim() : fullName.trim();

    if (!enabled || query.length < 3) {
      setMatches([]);

      return undefined;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      searchContacts(query, { campaignId, signal: controller.signal })
        .then((hits) => {
          if (!controller.signal.aborted) {
            setMatches(hits ?? []);
          }
        })
        .catch(() => {
          // A failed duplicate check must not block creating a contact: the
          // worst case is the duplicate the module already tolerates today.
          setMatches([]);
        });
    }, 400);

    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [campaignId, enabled, fullName, phone]);

  return matches;
}

function AddPersonForm({ houseId, campaignId, onAdded, onCancel, onNotice }) {
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState('building_elder');
  const [entrance, setEntrance] = useState('');
  const [apartment, setApartment] = useState('');
  const [note, setNote] = useState('');
  const [contacts, setContacts] = useState(() => [emptyContactDraft()]);
  const mutation = useEditorMutation();

  const primaryPhone = contacts.find((contact) => contact.type === 'phone')?.value ?? '';
  const duplicates = useDuplicateCheck({
    campaignId,
    enabled: true,
    fullName,
    phone: primaryPhone,
  });

  async function submit(event) {
    event.preventDefault();

    if (!fullName.trim()) {
      return;
    }

    const saved = await mutation.run(
      () =>
        createHousePerson(
          houseId,
          {
            fullName: fullName.trim(),
            role,
            note: note.trim(),
            entrance: entrance.trim(),
            apartment: apartment.trim(),
            contacts: toContactPayload(contacts),
          },
          { campaignId },
        ),
      'Контактну особу додано.',
    );

    if (saved) {
      // The confirmation is handed up before this form unmounts: a notice
      // rendered inside it would be destroyed in the same tick as it appeared,
      // which is indistinguishable from a save that silently did nothing.
      onNotice('Контактну особу додано.');
      onAdded();
    }
  }

  /** Attaches somebody the duplicate check already found. */
  async function linkExisting(personId) {
    const saved = await mutation.run(
      () =>
        linkPersonToHouse(
          personId,
          {
            houseId,
            entrance: entrance.trim(),
            apartment: apartment.trim(),
            roleInHouse: role,
          },
          { campaignId },
        ),
      'Особу привʼязано до будинку.',
    );

    if (saved) {
      onNotice('Особу привʼязано до будинку.');
      onAdded();
    }
  }

  return (
    <form className={styles.subForm} onSubmit={submit}>
      <FieldGrid>
        <TextField
          autoFocus
          label="Імʼя"
          onChange={setFullName}
          placeholder="Коваленко Олена Петрівна"
          required
          value={fullName}
          wide
        />

        <SelectField
          label="Роль у будинку"
          onChange={setRole}
          options={PERSON_ROLES}
          value={role}
        />

        <TextField
          inputMode="numeric"
          label="Підʼїзд"
          onChange={setEntrance}
          placeholder="2"
          value={entrance}
        />

        <TextField
          label="Квартира"
          onChange={setApartment}
          placeholder="12"
          value={apartment}
        />
      </FieldGrid>

      <ContactRows contacts={contacts} onChange={setContacts} />

      <TextAreaField
        label="Примітка"
        onChange={setNote}
        placeholder="Коли зручно телефонувати, що вже обговорювали"
        rows={2}
        value={note}
      />

      {duplicates.length > 0 && (
        <div className={styles.duplicateWarning} role="status">
          <strong>
            <ElectionsIcon name="warning" size={15} />
            Схожі контакти вже є
          </strong>

          <ul>
            {duplicates.slice(0, 5).map((hit) => (
              <li key={`${hit.personId}-${hit.houseId ?? ''}`}>
                <span>
                  {hit.fullName} · {getPersonRoleLabel(hit.role)}
                  {hit.houseAddress && <small> · {hit.houseAddress}</small>}
                  <small> · збіг за {hit.matchedOn === 'phone' ? 'телефоном' : 'імʼям'}</small>
                </span>

                <Button
                  isBusy={mutation.isBusy}
                  onClick={() => linkExisting(hit.personId)}
                  variant="quiet"
                >
                  Це та сама особа
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <FormStatus error={mutation.error} notice={mutation.notice} />

      <div className={styles.subFormActions}>
        <Button onClick={onCancel} variant="quiet">
          Скасувати
        </Button>

        <Button
          disabled={!fullName.trim()}
          icon="check"
          isBusy={mutation.isBusy}
          type="submit"
          variant="primary"
        >
          Додати особу
        </Button>
      </div>
    </form>
  );
}

function PersonCard({
  person,
  houseId,
  campaignId,
  canEditPeople,
  canDeletePeople,
  onChanged,
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [fullName, setFullName] = useState(person.fullName);
  const [role, setRole] = useState(person.role);
  const [note, setNote] = useState(person.note ?? '');
  const [contacts, setContacts] = useState(() => toContactDrafts(person.contacts));
  const mutation = useEditorMutation();

  const link = (person.links ?? []).find((one) => one.houseId === houseId)
    ?? person.links?.[0]
    ?? null;
  const [entrance, setEntrance] = useState(link?.entrance ?? '');
  const [apartment, setApartment] = useState(link?.apartment ?? '');

  /* A refreshed list arrives as new objects; the open form keeps whatever is
   * being typed, and a closed one adopts the server's copy. */
  const wasEditing = useRef(false);

  useEffect(() => {
    if (isEditing) {
      wasEditing.current = true;

      return;
    }

    wasEditing.current = false;
    setFullName(person.fullName);
    setRole(person.role);
    setNote(person.note ?? '');
    setContacts(toContactDrafts(person.contacts));
    setEntrance(link?.entrance ?? '');
    setApartment(link?.apartment ?? '');
  }, [isEditing, link?.apartment, link?.entrance, person]);

  async function save(event) {
    event.preventDefault();

    if (!fullName.trim()) {
      return;
    }

    const saved = await mutation.run(async () => {
      await updatePerson(
        person.id,
        {
          fullName: fullName.trim(),
          role,
          note: note.trim(),
          contacts: toContactPayload(contacts),
        },
        { campaignId },
      );

      // The flat and the entrance live on the link, not on the person, so a
      // second request — and only when one of them actually changed.
      if (link && (entrance.trim() !== (link.entrance ?? '') ||
        apartment.trim() !== (link.apartment ?? ''))) {
        await updatePersonLink(
          link.id,
          {
            entrance: entrance.trim(),
            apartment: apartment.trim(),
            roleInHouse: role,
          },
          { campaignId },
        );
      }

      return true;
    }, 'Контакт збережено.');

    if (saved) {
      setIsEditing(false);
      onChanged();
    }
  }

  if (isEditing) {
    return (
      <li className={styles.personCard}>
        <form className={styles.subForm} onSubmit={save}>
          <FieldGrid>
            <TextField
              label="Імʼя"
              onChange={setFullName}
              required
              value={fullName}
              wide
            />

            <SelectField
              label="Роль у будинку"
              onChange={setRole}
              options={PERSON_ROLES}
              value={role}
            />

            <TextField
              inputMode="numeric"
              label="Підʼїзд"
              onChange={setEntrance}
              value={entrance}
            />

            <TextField label="Квартира" onChange={setApartment} value={apartment} />
          </FieldGrid>

          <ContactRows contacts={contacts} onChange={setContacts} />

          <TextAreaField label="Примітка" onChange={setNote} rows={2} value={note} />

          <FormStatus error={mutation.error} notice={mutation.notice} />

          <div className={styles.subFormActions}>
            <Button onClick={() => setIsEditing(false)} variant="quiet">
              Скасувати
            </Button>

            <Button
              icon="check"
              isBusy={mutation.isBusy}
              type="submit"
              variant="primary"
            >
              Зберегти контакт
            </Button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className={styles.personCard}>
      <div className={styles.personTop}>
        <strong>{person.fullName}</strong>
        <Badge tone="info">{getPersonRoleLabel(person.role)}</Badge>

        {link && (link.entrance || link.apartment) && (
          <span className={styles.personPlace}>
            {[
              link.entrance ? `підʼїзд ${link.entrance}` : '',
              link.apartment ? `кв. ${link.apartment}` : '',
            ]
              .filter(Boolean)
              .join(', ')}
          </span>
        )}
      </div>

      {(person.contacts ?? []).length > 0 && (
        <ul className={styles.contactList}>
          {person.contacts.map((contact) => {
            const href = contactHref(contact);
            const meta = contactTypesById[contact.type];

            return (
              <li className={styles.contactLine} key={contact.id}>
                <span aria-hidden="true" className={styles.contactIcon}>
                  <ElectionsIcon name={meta?.icon ?? 'link'} size={16} />
                </span>

                <span className={styles.contactBody}>
                  {href
                    ? (
                      <a className={styles.contactValue} href={href}>
                        {contact.value}
                      </a>
                    )
                    : <span className={styles.contactValue}>{contact.value}</span>}

                  <small>
                    {contact.label || meta?.label}
                    {contact.isPrimary ? ' · основний' : ''}
                    {contact.verifiedAt
                      ? ` · перевірено ${formatShortDate(contact.verifiedAt)}`
                      : ' · не перевірявся'}
                  </small>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {person.note && <p className={styles.personNote}>{person.note}</p>}

      <FormStatus error={mutation.error} notice={mutation.notice} />

      {canEditPeople && (
        <div className={styles.personActions}>
          <Button icon="edit" onClick={() => setIsEditing(true)} variant="quiet">
            Редагувати
          </Button>

          {link && (
            <ConfirmButton
              confirmLabel="Відвʼязати"
              isBusy={mutation.isBusy}
              onConfirm={async () => {
                const done = await mutation.run(
                  () => deletePersonLink(link.id, { campaignId }),
                  'Особу відвʼязано від будинку.',
                );

                if (done) {
                  onChanged();
                }

                return Boolean(done);
              }}
              question="Прибрати звʼязок із цим будинком? Сам контакт залишиться."
              variant="quiet"
            >
              Відвʼязати від будинку
            </ConfirmButton>
          )}

          {canDeletePeople && (
            <ConfirmButton
              confirmLabel="Видалити особу"
              isBusy={mutation.isBusy}
              onConfirm={async () => {
                const done = await mutation.run(
                  () => deletePerson(person.id, { campaignId }),
                  'Контактну особу видалено.',
                );

                if (done) {
                  onChanged();
                }

                return Boolean(done);
              }}
              question="Видалити особу разом з усіма телефонами?"
            >
              Видалити контакт
            </ConfirmButton>
          )}
        </div>
      )}
    </li>
  );
}

function PeopleSection({
  house,
  campaignId,
  state,
  canWrite,
  canEditPeople,
  canDeletePeople,
  isReadOnly,
  onChanged,
}) {
  const [isAdding, setIsAdding] = useState(false);
  /* Outlives the add form, so its confirmation survives the form closing. */
  const sectionStatus = useEditorMutation();

  const addButton = canWrite && !isReadOnly && (
    <Button icon="plus" onClick={() => setIsAdding(true)} variant="primary">
      Додати контакт
    </Button>
  );

  return (
    <Card
      actions={!isAdding && state.items.length > 0 ? addButton : null}
      icon="contacts"
      title="Контактні особи"
    >
      {!house.canSeeContacts && (
        <p className={styles.warningLine}>
          <ElectionsIcon name="info" size={15} />
          Контакти цього будинку приховані — вони видимі відповідальному за нього.
        </p>
      )}

      {isAdding && (
        <AddPersonForm
          campaignId={campaignId}
          houseId={house.id}
          onAdded={() => {
            setIsAdding(false);
            onChanged();
          }}
          onCancel={() => setIsAdding(false)}
          onNotice={(message) => sectionStatus.run(async () => true, message)}
        />
      )}

      <FormStatus notice={sectionStatus.notice} />

      <CollectionState
        action={addButton}
        emptyIcon="contacts"
        emptyText="Телефон старости чи голови ОСББ суттєво спрощує наступний обхід."
        emptyTitle="Контактних осіб ще немає"
        state={state}
      />

      {state.items.length > 0 && (
        <ul className={styles.personList}>
          {state.items.map((person) => (
            <PersonCard
              campaignId={campaignId}
              canDeletePeople={canDeletePeople && !isReadOnly}
              canEditPeople={canEditPeople && !isReadOnly}
              houseId={house.id}
              key={person.id}
              onChanged={onChanged}
              person={person}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

export default PeopleSection;
