/**
 * Draft state for the full-screen house editor.
 *
 * The editor holds **two** records with two different lifetimes, two different
 * permissions and two different endpoints, and the whole hook exists to keep
 * them apart:
 *
 *   `house` — what the building *is*. Address, block, type, entrances, who
 *   manages it, how to get in. `PATCH /houses/:id`, coordinator and above.
 *
 *   `state` — what has been done about it *this campaign*. Stage, priority,
 *   what is planned next. `PATCH /houses/:id/state`, any role.
 *
 * Typing goes into a local draft and nothing is sent until «Зберегти». That is
 * what makes tab switching free — a canvasser who fills in the entrance count,
 * opens «Дії» to check the last visit and comes back finds their number still
 * there — and it is why the editor has to warn before it closes.
 *
 * Three failure modes are handled explicitly, because each one used to lose
 * work:
 *
 *   • **a rejected save keeps the draft.** The fields are never cleared on
 *     failure, so a 403 or a dropped connection costs a retry, not the form.
 *   • **a double click saves once.** `isSaving` gates the button *and* the
 *     handler, so the second press cannot start a second request.
 *   • **a stale copy is refused, not merged.** Each request carries the
 *     `updatedAt` the editor loaded; the server answers 409 when somebody else
 *     has written since, and the caller is offered the choice rather than
 *     silently rolling their colleague's edit back.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { campaignStateOf } from './houseUtils.js';
import { saveHouseAttributes, saveHouseState } from './electionsApi.js';

/** Status of the last save attempt. */
export const SAVE_IDLE = 'idle';
export const SAVE_RUNNING = 'saving';
export const SAVE_DONE = 'saved';
export const SAVE_FAILED = 'error';

const toDateInput = (isoValue) => (isoValue ? String(isoValue).slice(0, 10) : '');
const toText = (value) => (value === null || value === undefined ? '' : String(value));
const toCount = (value) => (value === null || value === undefined ? '' : String(value));

/**
 * A blank field means "невідомо", not zero — so an empty count is `null` and a
 * typed one keeps only its digits. Nothing here can produce `NaN`.
 */
function parseCount(rawValue) {
  const digits = String(rawValue ?? '').replace(/\D/g, '');

  return digits === '' ? null : Number(digits);
}

/** The permanent record, as form values. */
function buildHouseDraft(house) {
  return {
    street: toText(house.street),
    streetShort: toText(house.streetShort),
    number: toText(house.number),
    block: toText(house.block),
    city: toText(house.city),
    postalCode: toText(house.postalCode),
    type: house.type ?? 'other',
    floors: toCount(house.floors),
    entrances: toCount(house.entrances),
    apartments: toCount(house.apartments),
    households: toCount(house.households),
    residentsCount: toCount(house.residentsCount),
    builtYear: toCount(house.builtYear),
    managingOrg: toText(house.managingOrg),
    accessNote: toText(house.accessNote),
    source: toText(house.source),
    name: toText(house.name),
    /* Coordinates are deliberately not in this draft — see
     * `HouseGeometrySection`. They move only through their own guarded mode. */
    verified: false,
  };
}

/** This campaign's state, as form values. */
function buildStateDraft(house) {
  const state = campaignStateOf(house);

  return {
    stage: state.stage,
    priority: state.priority,
    priorityReason: toText(state.priorityReason),
    summary: toText(state.summary),
    nextStep: toText(state.nextStep),
    nextActionAt: toDateInput(state.nextActionAt),
  };
}

function buildBaseline(house) {
  return {
    houseId: house?.id ?? null,
    house: house ? buildHouseDraft(house) : null,
    state: house ? buildStateDraft(house) : null,
    /* The two concurrency tokens. They are separate because the two records
     * are: editing the stage does not make somebody else's address edit stale. */
    houseUpdatedAt: house?.updatedAt ?? null,
    stateUpdatedAt: house ? (campaignStateOf(house).updatedAt ?? null) : null,
  };
}

function isSameDraft(left, right) {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return Object.keys(left).every((key) => left[key] === right[key]);
}

/**
 * What the API is sent for the permanent record.
 *
 * Counts go back as numbers or `null`, text is trimmed, and `verified` is only
 * ever `true` — the date and the author of a check are stamped by the server
 * from the signed-in identity, and there is deliberately no field for either.
 */
function toHousePayload(draft) {
  return {
    street: draft.street.trim(),
    streetShort: draft.streetShort.trim(),
    number: draft.number.trim(),
    block: draft.block.trim(),
    city: draft.city.trim(),
    postalCode: draft.postalCode.trim(),
    type: draft.type,
    floors: parseCount(draft.floors),
    entrances: parseCount(draft.entrances),
    apartments: parseCount(draft.apartments),
    households: parseCount(draft.households),
    residentsCount: parseCount(draft.residentsCount),
    builtYear: parseCount(draft.builtYear),
    managingOrg: draft.managingOrg.trim(),
    accessNote: draft.accessNote.trim(),
    source: draft.source.trim(),
    name: draft.name.trim(),
    ...(draft.verified ? { verified: true } : {}),
  };
}

function toStatePayload(draft) {
  return {
    stage: draft.stage,
    priority: draft.priority,
    priorityReason: draft.priorityReason.trim(),
    summary: draft.summary.trim(),
    nextStep: draft.nextStep.trim(),
    // Midday, so a date never lands on the previous day in a western timezone.
    nextActionAt: draft.nextActionAt
      ? new Date(`${draft.nextActionAt}T12:00:00`).toISOString()
      : null,
  };
}

/**
 * Client-side validation is a courtesy, not a guarantee — every one of these
 * bounds is re-checked by the API, because a form is not a trust boundary.
 * Keyed by field so the message can sit under the input that caused it.
 */
export function validateHouseDraft(draft) {
  const errors = {};

  if (!draft.street.trim()) {
    errors.street = 'Вулиця обовʼязкова.';
  }

  if (!draft.number.trim()) {
    errors.number = 'Номер будинку обовʼязковий.';
  }

  const bounds = [
    ['entrances', 'Підʼїздів', 60],
    ['floors', 'Поверхів', 200],
    ['apartments', 'Квартир', 2000],
    ['households', 'Заселених квартир', 2000],
    ['residentsCount', 'Мешканців', 6000],
  ];

  for (const [field, label, max] of bounds) {
    const value = parseCount(draft[field]);

    if (value !== null && value > max) {
      errors[field] = `${label}: до ${max}.`;
    }
  }

  const apartments = parseCount(draft.apartments);
  const entrances = parseCount(draft.entrances);

  if (!errors.apartments && apartments !== null && entrances !== null &&
    apartments < entrances) {
    errors.apartments = 'Квартир не може бути менше, ніж підʼїздів.';
  }

  const builtYear = parseCount(draft.builtYear);

  if (builtYear !== null && (builtYear < 1500 || builtYear > 2200)) {
    errors.builtYear = 'Рік побудови виглядає неправильним.';
  }

  return errors;
}

/**
 * @param {object|null} house      The full record the editor is open on.
 * @param {{campaignId?: string, canEditHouse?: boolean, canEditState?: boolean,
 *          onSaved?: (house: object) => void}} options
 */
export function useHouseEditor(house, options = {}) {
  const { campaignId, canEditHouse = false, canEditState = false, onSaved } = options;

  const [baseline, setBaseline] = useState(() => buildBaseline(house));
  const [draft, setDraft] = useState(() => ({
    house: baseline.house,
    state: baseline.state,
  }));
  const [status, setStatus] = useState(SAVE_IDLE);
  const [error, setError] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [wasSubmitted, setWasSubmitted] = useState(false);

  /* Read inside the save handler so a second click cannot start a second
   * request before React has re-rendered the disabled button. */
  const isSavingRef = useRef(false);

  /*
   * A different house is a different form, so the draft is rebuilt. The *same*
   * house arriving again is not: it happens after every write and on every
   * background refresh, and rebuilding there would wipe whatever is half-typed.
   */
  useEffect(() => {
    if (!house || house.id === baseline.houseId) {
      return;
    }

    const next = buildBaseline(house);

    setBaseline(next);
    setDraft({ house: next.house, state: next.state });
    setStatus(SAVE_IDLE);
    setError(null);
    setConflict(null);
    setWasSubmitted(false);
  }, [baseline.houseId, house]);

  /*
   * The record arrives in two stages — the map's light copy on click, the full
   * one a round trip later — so the first baseline is built from a record that
   * has no access note and no priority reason. Adopting the full one is not
   * optional: without it the first save would send empty strings over fields
   * the user never saw. Only while the form is still untouched.
   */
  useEffect(() => {
    if (!house || house.id !== baseline.houseId) {
      return;
    }

    if (baseline.houseUpdatedAt === house.updatedAt) {
      return;
    }

    const isPristine =
      isSameDraft(draft.house, baseline.house) &&
      isSameDraft(draft.state, baseline.state);

    if (!isPristine) {
      return;
    }

    const next = buildBaseline(house);

    setBaseline(next);
    setDraft({ house: next.house, state: next.state });
  }, [baseline, draft, house]);

  const isHouseDirty = !isSameDraft(draft.house, baseline.house);
  const isStateDirty = !isSameDraft(draft.state, baseline.state);
  const isDirty = isHouseDirty || isStateDirty;

  const errors = useMemo(
    () => (draft.house ? validateHouseDraft(draft.house) : {}),
    [draft.house],
  );
  const hasErrors = Object.keys(errors).length > 0;

  const updateHouse = useCallback((patch) => {
    setDraft((current) => ({ ...current, house: { ...current.house, ...patch } }));
    setStatus((current) => (current === SAVE_DONE ? SAVE_IDLE : current));
  }, []);

  const updateState = useCallback((patch) => {
    setDraft((current) => ({ ...current, state: { ...current.state, ...patch } }));
    setStatus((current) => (current === SAVE_DONE ? SAVE_IDLE : current));
  }, []);

  /** Throws the draft away and goes back to the server's last known copy. */
  const reset = useCallback(() => {
    setDraft({ house: baseline.house, state: baseline.state });
    setStatus(SAVE_IDLE);
    setError(null);
    setConflict(null);
    setWasSubmitted(false);
  }, [baseline]);

  /**
   * Re-baselines onto a record the caller has just re-read from the server.
   * Used by the conflict banner's «Оновити дані».
   */
  const adopt = useCallback((nextHouse) => {
    const next = buildBaseline(nextHouse);

    setBaseline(next);
    setDraft({ house: next.house, state: next.state });
    setStatus(SAVE_IDLE);
    setError(null);
    setConflict(null);
  }, []);

  /**
   * Sends whichever halves are dirty.
   *
   * Attributes first: if the second request is refused — a role that may record
   * work but not edit the building, say — the first has still landed, and the
   * user is told which half failed instead of losing both.
   *
   * `force` drops the concurrency tokens. It is only ever reached from the
   * conflict banner, where the user has been told what it means.
   */
  const save = useCallback(
    async ({ force = false } = {}) => {
      if (isSavingRef.current || !house) {
        return false;
      }

      setWasSubmitted(true);

      if (isHouseDirty && canEditHouse && hasErrors) {
        setStatus(SAVE_FAILED);
        setError('Виправте позначені поля перед збереженням.');

        return false;
      }

      if (!isDirty) {
        return true;
      }

      isSavingRef.current = true;
      setStatus(SAVE_RUNNING);
      setError(null);
      setConflict(null);

      let saved = null;

      try {
        if (isHouseDirty && canEditHouse) {
          saved = await saveHouseAttributes(
            house.id,
            {
              ...toHousePayload(draft.house),
              ...(force ? {} : { expectedUpdatedAt: baseline.houseUpdatedAt }),
            },
            { campaignId },
          );
        }

        if (isStateDirty && canEditState) {
          saved = await saveHouseState(
            house.id,
            {
              ...toStatePayload(draft.state),
              ...(force ? {} : { expectedUpdatedAt: baseline.stateUpdatedAt }),
            },
            { campaignId },
          );
        }

        if (saved) {
          const next = buildBaseline(saved);

          setBaseline(next);
          // The draft is replaced by what the server actually stored, not by
          // what was typed: trimming, normalisation and the address it rebuilt
          // are all its answer, and the form has to show that answer.
          setDraft({ house: next.house, state: next.state });
          onSaved?.(saved);
        }

        setStatus(SAVE_DONE);
        setWasSubmitted(false);

        return true;
      } catch (caught) {
        setStatus(SAVE_FAILED);
        setError(caught?.message ?? 'Не вдалося зберегти зміни.');

        // 409 is the only failure with a *choice* behind it, so it gets its own
        // state rather than being one more red line the user can only re-read.
        if (caught?.status === 409) {
          setConflict({ message: caught.message });
        }

        return false;
      } finally {
        isSavingRef.current = false;
      }
    },
    [
      baseline.houseUpdatedAt,
      baseline.stateUpdatedAt,
      campaignId,
      canEditHouse,
      canEditState,
      draft.house,
      draft.state,
      hasErrors,
      house,
      isDirty,
      isHouseDirty,
      isStateDirty,
      onSaved,
    ],
  );

  const dismissStatus = useCallback(() => {
    setStatus(SAVE_IDLE);
    setError(null);
  }, []);

  return {
    houseDraft: draft.house,
    stateDraft: draft.state,
    updateHouse,
    updateState,
    reset,
    adopt,
    save,
    dismissStatus,
    isDirty,
    isHouseDirty,
    isStateDirty,
    isSaving: status === SAVE_RUNNING,
    isSaved: status === SAVE_DONE,
    status,
    error,
    conflict,
    errors,
    /** Errors are shown after a save attempt, not while the user is typing. */
    showErrors: wasSubmitted,
  };
}
