/**
 * «Відповідальні» — who works this building in this campaign.
 *
 * Two kinds of responsibility reach a house and only one of them can be edited
 * here. A **house** assignment is about this building and is managed on this
 * screen. A **precinct** assignment covers every building filed under a polling
 * station, so ending it from a house card would quietly take a colleague off
 * forty other addresses; those are listed read-only, with the precinct named,
 * and a link to where they belong.
 *
 * Handing out territory is a coordinator action, and the API additionally
 * refuses to let a coordinator assign anything outside the territory they
 * already hold — otherwise the territorial limit would be decorative, since
 * anybody could assign themselves the rest of the district one row at a time.
 */

import { useEffect, useState } from 'react';

import { ASSIGNMENT_ROLES } from '../../../../features/elections/electionsTypes.js';
import {
  createAssignment,
  endAssignment,
  fetchAssignments,
} from '../../../../features/elections/electionsApi.js';
import { formatAssignee, formatShortDate } from '../../../../features/elections/houseUtils.js';
import { useEditorMutation } from '../../../../features/elections/useEditorMutation.js';
import ElectionsIcon from '../../../../features/elections/ElectionsIcon.jsx';
import {
  Badge,
  Button,
  Card,
  ConfirmButton,
  EmptyState,
  FieldGrid,
  FormStatus,
  SelectField,
  TextField,
} from './editorFields.jsx';
import styles from './HouseEditor.module.css';

const roleLabels = Object.fromEntries(
  ASSIGNMENT_ROLES.map((role) => [role.id, role.label]),
);

/**
 * Assignments for this house.
 *
 * Fetched here rather than through `useEditorCollections` because the endpoint
 * is campaign-scoped with a `scopeId` filter rather than house-scoped, and
 * because the section is the only thing that ever wants it.
 */
function useHouseAssignments(houseId, campaignId, refreshToken) {
  const [state, setState] = useState({ status: 'loading', items: [], error: null });

  useEffect(() => {
    if (!houseId) {
      return undefined;
    }

    const controller = new AbortController();

    setState((current) => ({ ...current, status: 'loading', error: null }));

    fetchAssignments({ campaignId, signal: controller.signal })
      .then((items) => {
        if (controller.signal.aborted) {
          return;
        }

        setState({
          status: 'ready',
          // The house's own rows, plus the precinct rows that reach it.
          items: (items ?? []).filter((one) => one.scope === 'house'
            ? one.scopeId === houseId
            : false),
          error: null,
        });
      })
      .catch((error) => {
        if (controller.signal.aborted || error?.name === 'AbortError') {
          return;
        }

        setState({
          status: 'error',
          items: [],
          error: error?.message ?? 'Не вдалося завантажити призначення.',
        });
      });

    return () => controller.abort();
  }, [campaignId, houseId, refreshToken]);

  return state;
}

function AssigneesSection({
  house,
  campaignId,
  canAssign,
  isReadOnly,
  knownAssignees,
  onChanged,
}) {
  const [refreshToken, setRefreshToken] = useState(0);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('agitator');
  const state = useHouseAssignments(house.id, campaignId, refreshToken);
  const mutation = useEditorMutation();

  const reload = () => {
    setRefreshToken((current) => current + 1);
    onChanged();
  };

  /* Precinct-scoped responsibility, from the house record itself: the campaign
   * state already resolves it, so it needs no second request. */
  const viaPrecinct = (house.campaign?.assignees ?? []).filter(
    (one) => one.scope === 'precinct',
  );

  async function add(event) {
    event.preventDefault();

    if (!email.trim()) {
      return;
    }

    const saved = await mutation.run(
      () =>
        createAssignment(
          { scope: 'house', scopeId: house.id, employeeEmail: email.trim(), role },
          { campaignId },
        ),
      'Відповідального призначено.',
    );

    if (saved) {
      setEmail('');
      reload();
    }
  }

  const canEdit = canAssign && !isReadOnly;

  return (
    <>
      <Card
        hint="Стосується лише цього будинку в поточній кампанії."
        icon="users"
        title="Відповідальні за будинок"
      >
        {state.status === 'loading' && (
          <p className={styles.loading} role="status">
            <span aria-hidden="true" className={styles.spinner} />
            Завантаження…
          </p>
        )}

        {state.status === 'error' && (
          <p className={styles.inlineError} role="alert">
            <ElectionsIcon name="warning" size={15} />
            {state.error}
          </p>
        )}

        {state.status === 'ready' && state.items.length === 0 && (
          <EmptyState icon="users" title="Відповідального ще не призначено">
            Будинок без відповідального легко випадає з обходу — призначте
            агітатора або координатора.
          </EmptyState>
        )}

        {state.items.length > 0 && (
          <ul className={styles.recordList}>
            {state.items.map((assignment) => (
              <li className={styles.recordRow} key={assignment.id}>
                <div className={styles.recordTop}>
                  <strong>{formatAssignee(assignment.employeeEmail)}</strong>
                  <Badge tone={assignment.status === 'active' ? 'success' : 'muted'}>
                    {roleLabels[assignment.role] ?? assignment.role}
                  </Badge>
                </div>

                <small className={styles.recordMeta}>
                  {assignment.employeeEmail} · з {formatShortDate(assignment.validFrom)}
                  {assignment.validTo ? ` до ${formatShortDate(assignment.validTo)}` : ''}
                  {assignment.status !== 'active' ? ' · завершено' : ''}
                </small>

                {canEdit && assignment.status === 'active' && (
                  <div className={styles.recordActions}>
                    <ConfirmButton
                      confirmLabel="Завершити"
                      isBusy={mutation.isBusy}
                      onConfirm={async () => {
                        const done = await mutation.run(
                          () => endAssignment(assignment.id, { campaignId }),
                          'Призначення завершено.',
                        );

                        if (done) {
                          reload();
                        }

                        return Boolean(done);
                      }}
                      question="Завершити призначення?"
                      variant="quiet"
                    >
                      Завершити призначення
                    </ConfirmButton>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {canEdit && (
          <form className={styles.inlineForm} onSubmit={add}>
            <FieldGrid columns={3}>
              <TextField
                label="Пошта співробітника"
                list="editor-assignee-options"
                onChange={setEmail}
                placeholder="name@avku.org"
                type="email"
                value={email}
              />

              <SelectField
                label="Роль у кампанії"
                onChange={setRole}
                options={ASSIGNMENT_ROLES}
                value={role}
              />

              <div className={styles.inlineFormAction}>
                <Button
                  disabled={!email.trim()}
                  icon="plus"
                  isBusy={mutation.isBusy}
                  type="submit"
                  variant="ghost"
                >
                  Призначити
                </Button>
              </div>
            </FieldGrid>

            <datalist id="editor-assignee-options">
              {knownAssignees.map((known) => (
                <option key={known} value={known} />
              ))}
            </datalist>
          </form>
        )}

        <FormStatus error={mutation.error} notice={mutation.notice} />
      </Card>

      {viaPrecinct.length > 0 && (
        <Card
          hint="Через дільницю — керується в розділі дільниць, а не тут."
          icon="pin"
          title="Відповідальні через дільницю"
        >
          <ul className={styles.chipList}>
            {viaPrecinct.map((one) => (
              <li className={styles.chipRow} key={one.id}>
                <span>
                  <strong>{formatAssignee(one.email)}</strong>
                  <small> · {roleLabels[one.role] ?? one.role}</small>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

export default AssigneesSection;
