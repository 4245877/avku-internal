import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { HttpError } from "../../http/responses";
import {
  type ChangeContext,
  logAccess,
  logCreate,
  logOperation,
  logUpdate,
} from "./change-log";
import {
  ASSIGNMENT_ROLES,
  ASSIGNMENT_SCOPES,
  CONTACT_TYPES,
  type ContactType,
  PERSON_ROLES,
  badRequest,
  normalizeContactValue,
  optionalOneOf,
  optionalText,
  optionalTimestamp,
  requireOneOf,
  requireText,
} from "./elections.types";
import {
  type ElectionsViewer,
  hasAtLeast,
  houseVisibilitySql,
  maskContactValue,
  maskPersonName,
} from "./elections-access";
import {
  assertHouseExists,
  assertHouseVisible,
  type ListHousesOptions,
} from "./house-records";

/**
 * Refuses to go on unless the viewer may work with this person.
 *
 * A person is reachable through the buildings they are linked to, so "may I
 * touch this person" is "do I hold any building they live or work in". A person
 * with no link at all is reachable by nobody below manager: an unlinked record
 * carries a name and a phone number and no territory to justify them, so the
 * safe answer is the same one an unknown id gets.
 *
 * The route layer cannot do this instead — it is handed a person id, and the
 * houses behind it are exactly what this query has to find.
 */
export function assertPersonVisible(
  database: DatabaseSync,
  personId: string,
  options: ListHousesOptions,
): void {
  if (hasAtLeast(
    options.viewer,
    "manager",
  )) {
    return;
  }

  const visibility = houseVisibilitySql(
    options.viewer,
    options.campaignId,
    "h",
  );
  const row = database.prepare(`
    SELECT 1 AS ok
    FROM house_people hp
    JOIN houses h ON h.id = hp.house_id
    WHERE hp.person_id = :personId
      AND hp.deleted_at IS NULL
      AND h.deleted_at IS NULL
      AND (${visibility.sql})
    LIMIT 1
  `).get({
    ...visibility.parameters,
    personId,
  } as never) as Record<string, unknown> | undefined;

  if (!row) {
    // Same answer as a missing id: whether a person exists at all is itself
    // information about somebody else's territory.
    throw new HttpError(
      404,
      "Особу не знайдено.",
    );
  }
}

/**
 * People, their contact channels, their link to a building, and who is
 * responsible for what.
 *
 * A person here is a *contact*: somebody with a working role in the building —
 * the head of the OSBB, the entrance elder, the concierge. The record carries a
 * name, a role and a way to reach them, and deliberately nothing else. The
 * fields this module used to keep about residents (political position, age
 * band) were removed and there is nowhere in this schema to put them back.
 *
 * A phone belongs to the person, not to the house, so one contact who looks
 * after two entrances is one record with two links rather than two copies of a
 * phone number that will diverge.
 */

export interface PersonContact {
  id: string;
  type: string;
  value: string;
  label: string;
  isPrimary: boolean;
  /** When this channel was last confirmed to still reach the person. */
  verifiedAt: string | null;
  verifiedBy: string | null;
  /** True when `value` has been masked because the viewer may not see it. */
  isMasked: boolean;
}

export interface PersonLink {
  id: string;
  houseId: string;
  houseAddress: string;
  entrance: string;
  apartment: string;
  roleInHouse: string;
  validFrom: string | null;
  validTo: string | null;
  note: string;
}

export interface Person {
  id: string;
  fullName: string;
  role: string;
  note: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  contacts: PersonContact[];
  links: PersonLink[];
  isMasked: boolean;
}

function rowToContact(
  row: Record<string, unknown>,
  reveal: boolean,
): PersonContact {
  const type = String(row.type);
  const value = String(row.value);

  return {
    id: String(row.id),
    type,
    value: reveal
      ? value
      : maskContactValue(
        type,
        value,
      ),
    label: String(row.label ?? ""),
    isPrimary: Number(row.is_primary ?? 0) === 1,
    verifiedAt: row.verified_at == null ? null : String(row.verified_at),
    verifiedBy: row.verified_by == null ? null : String(row.verified_by),
    isMasked: !reveal,
  };
}

function readContacts(
  database: DatabaseSync,
  personIds: string[],
  reveal: boolean,
): Map<string, PersonContact[]> {
  const grouped = new Map<string, PersonContact[]>();

  if (personIds.length === 0) {
    return grouped;
  }

  const placeholders = personIds.map(() => "?").join(", ");
  const rows = database.prepare(`
    SELECT id, person_id, type, value, label, is_primary,
           verified_at, verified_by
    FROM person_contacts
    WHERE person_id IN (${placeholders}) AND deleted_at IS NULL
    ORDER BY is_primary DESC, created_at
  `).all(...personIds) as Record<string, unknown>[];

  for (const row of rows) {
    const key = String(row.person_id);
    const list = grouped.get(key) ?? [];

    list.push(rowToContact(
      row,
      reveal,
    ));
    grouped.set(
      key,
      list,
    );
  }

  return grouped;
}

function readLinks(
  database: DatabaseSync,
  personIds: string[],
): Map<string, PersonLink[]> {
  const grouped = new Map<string, PersonLink[]>();

  if (personIds.length === 0) {
    return grouped;
  }

  const placeholders = personIds.map(() => "?").join(", ");
  const rows = database.prepare(`
    SELECT hp.id, hp.person_id, hp.house_id, hp.entrance, hp.apartment,
           hp.role_in_house, hp.valid_from, hp.valid_to, hp.note,
           h.address AS house_address
    FROM house_people hp
    JOIN houses h ON h.id = hp.house_id
    WHERE hp.person_id IN (${placeholders}) AND hp.deleted_at IS NULL
    ORDER BY h.street, h.number
  `).all(...personIds) as Record<string, unknown>[];

  for (const row of rows) {
    const key = String(row.person_id);
    const list = grouped.get(key) ?? [];

    list.push({
      id: String(row.id),
      houseId: String(row.house_id),
      houseAddress: String(row.house_address ?? ""),
      entrance: String(row.entrance ?? ""),
      apartment: String(row.apartment ?? ""),
      roleInHouse: String(row.role_in_house ?? "other"),
      validFrom: row.valid_from == null ? null : String(row.valid_from),
      validTo: row.valid_to == null ? null : String(row.valid_to),
      note: String(row.note ?? ""),
    });
    grouped.set(
      key,
      list,
    );
  }

  return grouped;
}

function rowToPerson(
  row: Record<string, unknown>,
  contacts: PersonContact[],
  links: PersonLink[],
  reveal: boolean,
): Person {
  const fullName = String(row.full_name);

  return {
    id: String(row.id),
    fullName: reveal ? fullName : maskPersonName(fullName),
    role: String(row.role ?? "other"),
    note: reveal ? String(row.note ?? "") : "",
    source: String(row.source ?? ""),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    contacts,
    links,
    isMasked: !reveal,
  };
}

/**
 * Contacts for one house.
 *
 * `reveal` comes from the house query, which already applied the viewer's
 * visibility — an agitator asking about a building they are not assigned to
 * never reaches this function, and a coordinator listing their territory gets
 * real values. When it is false the values are masked rather than omitted, so
 * the card can still say "a phone exists, ask your coordinator".
 *
 * Reading real contact details is journalled: a leak of the contact base has to
 * be traceable to whoever opened it.
 */
export function listHousePeople(
  database: DatabaseSync,
  houseId: string,
  viewer: ElectionsViewer,
  reveal: boolean,
  options: { campaignId?: string | null; journal?: boolean } = {},
): Person[] {
  const rows = database.prepare(`
    SELECT p.id, p.full_name, p.role, p.note, p.source, p.created_at, p.updated_at
    FROM people p
    JOIN house_people hp ON hp.person_id = p.id AND hp.deleted_at IS NULL
    WHERE hp.house_id = ? AND p.deleted_at IS NULL
    GROUP BY p.id
    ORDER BY p.full_name
  `).all(houseId) as Record<string, unknown>[];

  const ids = rows.map((row) => String(row.id));
  const contacts = readContacts(
    database,
    ids,
    reveal,
  );
  const links = readLinks(
    database,
    ids,
  );

  if (reveal && rows.length > 0 && options.journal !== false && viewer.email) {
    logAccess(
      database,
      {
        kind: "pii_view",
        actor: viewer.email,
        campaignId: options.campaignId ?? null,
        entity: "house",
        entityId: houseId,
        scope: "houseContacts",
        recordCount: rows.length,
        includesPersonal: true,
      },
    );
  }

  return rows.map((row) => {
    const id = String(row.id);

    return rowToPerson(
      row,
      contacts.get(id) ?? [],
      links.get(id) ?? [],
      reveal,
    );
  });
}

export interface PersonSearchHit {
  personId: string;
  fullName: string;
  role: string;
  houseId: string | null;
  houseAddress: string;
  matchedOn: "phone" | "name";
}

/**
 * Finds people by normalised phone or by name — but only inside the set of
 * houses the caller may already see.
 *
 * `visibleHouseIds` is computed from the house query rather than re-derived
 * here, which is what stops a phone-number search from becoming a way to
 * enumerate contacts for buildings the viewer has no access to.
 */
export function searchPeople(
  database: DatabaseSync,
  query: string,
  visibleHouseIds: string[],
  limit = 20,
): PersonSearchHit[] {
  const trimmed = query.trim();

  if (!trimmed || visibleHouseIds.length === 0) {
    return [];
  }

  const digits = trimmed.replace(/\D/g, "");
  const normalizedPhone = digits.length >= 5
    ? normalizeContactValue(
      "phone",
      trimmed,
    )
    : "";
  const placeholders = visibleHouseIds.map(() => "?").join(", ");

  const rows = database.prepare(`
    SELECT DISTINCT p.id, p.full_name, p.role, hp.house_id,
           h.address AS house_address,
           CASE WHEN pc.id IS NULL THEN 'name' ELSE 'phone' END AS matched_on
    FROM people p
    JOIN house_people hp ON hp.person_id = p.id AND hp.deleted_at IS NULL
    JOIN houses h ON h.id = hp.house_id AND h.deleted_at IS NULL
    LEFT JOIN person_contacts pc
      ON pc.person_id = p.id AND pc.deleted_at IS NULL
      AND ? != '' AND pc.value_normalized LIKE ?
    WHERE p.deleted_at IS NULL
      AND hp.house_id IN (${placeholders})
      AND (
        (? != '' AND pc.id IS NOT NULL)
        OR lower(p.full_name) LIKE ?
      )
    ORDER BY p.full_name
    LIMIT ?
  `).all(
    normalizedPhone,
    normalizedPhone ? `%${normalizedPhone.replace(/^\+/, "")}%` : "",
    ...visibleHouseIds,
    normalizedPhone,
    `%${trimmed.toLowerCase()}%`,
    limit,
  ) as Record<string, unknown>[];

  return rows.map((row) => ({
    personId: String(row.id),
    fullName: String(row.full_name),
    role: String(row.role ?? "other"),
    houseId: row.house_id == null ? null : String(row.house_id),
    houseAddress: String(row.house_address ?? ""),
    matchedOn: String(row.matched_on) === "phone" ? "phone" : "name",
  }));
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

export interface PersonInput {
  fullName?: unknown;
  role?: unknown;
  note?: unknown;
  source?: unknown;
  houseId?: unknown;
  entrance?: unknown;
  apartment?: unknown;
  validFrom?: unknown;
  contacts?: unknown;
}

interface ContactInput {
  /** The id of the row this entry came from, when it is an existing one. */
  id: string;
  type: ContactType;
  value: string;
  label: string;
  isPrimary: boolean;
  /** The caller says they have just confirmed this channel works. */
  verified: boolean;
}

function readContactInputs(value: unknown): ContactInput[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    badRequest("Поле «contacts» має бути масивом.");
  }

  if (value.length > 20) {
    badRequest("Забагато контактів для однієї особи (максимум 20).");
  }

  return value.map((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const type = requireOneOf(
      record.type,
      CONTACT_TYPES,
      `contacts[${index}].type`,
    );

    return {
      id: optionalText(
        record.id,
        `contacts[${index}].id`,
        200,
      ),
      type,
      value: requireText(
        record.value,
        `contacts[${index}].value`,
        200,
      ),
      label: optionalText(
        record.label,
        `contacts[${index}].label`,
        200,
      ),
      isPrimary: record.isPrimary === true,
      // Never a date from the client: the point of the field is that somebody
      // actually checked, so the clock and the identity are the server's.
      verified: record.verified === true,
    };
  });
}

/** What a contact carried before this write — see {@link updatePerson}. */
interface ContactStamp {
  verifiedAt: string | null;
  verifiedBy: string | null;
}

function insertContacts(
  database: DatabaseSync,
  personId: string,
  contacts: ContactInput[],
  source: string,
  context: ChangeContext,
  carried: Map<string, ContactStamp> = new Map(),
): void {
  const now = new Date().toISOString();

  for (const contact of contacts) {
    const previous = carried.get(contact.id);
    const verifiedAt = contact.verified ? now : (previous?.verifiedAt ?? null);
    const verifiedBy = contact.verified
      ? context.actor
      : (previous?.verifiedBy ?? null);

    database.prepare(`
      INSERT INTO person_contacts (
        id, person_id, type, value, value_normalized, label, is_primary,
        verified_at, verified_by, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      personId,
      contact.type,
      contact.value,
      normalizeContactValue(
        contact.type,
        contact.value,
      ),
      contact.label,
      contact.isPrimary ? 1 : 0,
      verifiedAt,
      verifiedBy,
      source,
      now,
      now,
    );
  }
}

/**
 * Creates a contact and, when a house is named, the dated link to it.
 *
 * Both rows go in through the caller's transaction, so a person is never left
 * behind without the link that makes them findable.
 */
export function createPerson(
  database: DatabaseSync,
  input: PersonInput,
  context: ChangeContext,
): string {
  const now = new Date().toISOString();
  const id = randomUUID();
  const source = optionalText(
    input.source,
    "source",
    120,
  ) || "manual";
  const fullName = requireText(
    input.fullName,
    "fullName",
    200,
  );
  const role = optionalOneOf(
    input.role,
    PERSON_ROLES,
    "role",
    "other",
  );
  const contacts = readContactInputs(input.contacts);

  database.prepare(`
    INSERT INTO people (
      id, full_name, role, note, source, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    fullName,
    role,
    optionalText(
      input.note,
      "note",
      2000,
    ),
    source,
    context.actor,
    now,
    now,
  );

  insertContacts(
    database,
    id,
    contacts,
    source,
    context,
  );

  const houseId = optionalText(
    input.houseId,
    "houseId",
    200,
  );

  if (houseId) {
    assertHouseExists(
      database,
      houseId,
    );
    insertPersonLink(
      database,
      {
        personId: id,
        houseId,
        entrance: input.entrance,
        apartment: input.apartment,
        roleInHouse: role,
        validFrom: input.validFrom,
        source,
      },
      context,
    );
  }

  // The journal records that a contact was created and their role — never the
  // phone number itself, which would put personal data in the history table.
  logCreate(
    database,
    context,
    "person",
    id,
    {
      role,
      contactCount: contacts.length,
      houseId: houseId || null,
    },
  );

  return id;
}

export interface PersonLinkInput {
  personId: string;
  houseId: string;
  entrance?: unknown;
  apartment?: unknown;
  roleInHouse?: unknown;
  validFrom?: unknown;
  validTo?: unknown;
  note?: unknown;
  source?: string;
}

/**
 * Attaches an existing resident to an existing building.
 *
 * Both ends are checked, and both matter. An unchecked target house lets a
 * resident be filed into somebody else's building; an unchecked person lets a
 * stranger's record be pulled into a building the caller does hold, which hands
 * over their phone number on the next read.
 */
export function linkPersonToHouse(
  database: DatabaseSync,
  input: PersonLinkInput,
  context: ChangeContext,
  options: ListHousesOptions,
): string {
  assertHouseExists(
    database,
    input.houseId,
  );
  assertHouseVisible(
    database,
    input.houseId,
    options,
  );
  assertPersonVisible(
    database,
    input.personId,
    options,
  );

  return insertPersonLink(
    database,
    input,
    context,
  );
}

/**
 * The insert itself, with no permission check of its own.
 *
 * Split out for {@link createPerson}, which links a resident it has just
 * created: that person has no building yet, so `assertPersonVisible` would
 * refuse the very row being created. Its caller checks the house instead, which
 * is the half that is actually in question there. Not exported — every route
 * reaches this through `linkPersonToHouse`.
 */
function insertPersonLink(
  database: DatabaseSync,
  input: PersonLinkInput,
  context: ChangeContext,
): string {
  const person = database.prepare(`
    SELECT id FROM people WHERE id = ? AND deleted_at IS NULL
  `).get(input.personId);

  if (!person) {
    throw new HttpError(
      400,
      "Вказаної особи не існує.",
    );
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  database.prepare(`
    INSERT INTO house_people (
      id, house_id, person_id, entrance, apartment, role_in_house,
      valid_from, valid_to, note, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.houseId,
    input.personId,
    optionalText(
      input.entrance,
      "entrance",
      20,
    ),
    optionalText(
      input.apartment,
      "apartment",
      20,
    ),
    optionalOneOf(
      input.roleInHouse,
      PERSON_ROLES,
      "roleInHouse",
      "other",
    ),
    optionalTimestamp(
      input.validFrom,
      "validFrom",
    ) ?? now.slice(
      0,
      10,
    ),
    optionalTimestamp(
      input.validTo,
      "validTo",
    ),
    optionalText(
      input.note,
      "note",
      1000,
    ),
    input.source ?? "manual",
    now,
    now,
  );

  logCreate(
    database,
    context,
    "housePerson",
    id,
    {
      houseId: input.houseId,
      personId: input.personId,
    },
  );

  return id;
}

export function updatePerson(
  database: DatabaseSync,
  personId: string,
  input: PersonInput,
  context: ChangeContext,
  options: ListHousesOptions,
): void {
  assertPersonVisible(
    database,
    personId,
    options,
  );

  const before = database.prepare(`
    SELECT id, full_name, role, note FROM people
    WHERE id = ? AND deleted_at IS NULL
  `).get(personId) as Record<string, unknown> | undefined;

  if (!before) {
    throw new HttpError(
      404,
      "Особу не знайдено.",
    );
  }

  const next = {
    fullName: input.fullName === undefined
      ? String(before.full_name)
      : requireText(
        input.fullName,
        "fullName",
        200,
      ),
    role: input.role === undefined
      ? String(before.role)
      : optionalOneOf(
        input.role,
        PERSON_ROLES,
        "role",
        String(before.role) as never,
      ),
    note: input.note === undefined
      ? String(before.note ?? "")
      : optionalText(
        input.note,
        "note",
        2000,
      ),
  };

  database.prepare(`
    UPDATE people SET full_name = ?, role = ?, note = ?, updated_at = ?
    WHERE id = ?
  `).run(
    next.fullName,
    next.role,
    next.note,
    new Date().toISOString(),
    personId,
  );

  logUpdate(
    database,
    context,
    "person",
    personId,
    {
      fullName: String(before.full_name),
      role: String(before.role),
      note: String(before.note ?? ""),
    },
    next,
    [
      "fullName",
      "role",
      "note",
    ],
  );

  if (input.contacts !== undefined) {
    const contacts = readContactInputs(input.contacts);
    const now = new Date().toISOString();

    /*
     * Contacts are replaced wholesale, so the "checked on" stamp has to be
     * carried across by hand or editing a person's *name* would silently reset
     * every phone number to "never verified". The stamp follows the row's id,
     * which the client echoes back — a value it cannot forge into anything but
     * a row that already exists on this person.
     */
    const carried = new Map<string, ContactStamp>(
      (database.prepare(`
        SELECT id, verified_at, verified_by FROM person_contacts
        WHERE person_id = ? AND deleted_at IS NULL
      `).all(personId) as Record<string, unknown>[]).map((row) => [
        String(row.id),
        {
          verifiedAt: row.verified_at == null ? null : String(row.verified_at),
          verifiedBy: row.verified_by == null ? null : String(row.verified_by),
        },
      ]),
    );

    // Soft delete — a number that was removed by mistake is still recoverable
    // and still in the history.
    database.prepare(`
      UPDATE person_contacts SET deleted_at = ?, updated_at = ?
      WHERE person_id = ? AND deleted_at IS NULL
    `).run(
      now,
      now,
      personId,
    );

    insertContacts(
      database,
      personId,
      contacts,
      "manual",
      context,
      carried,
    );

    logOperation(
      database,
      context,
      "person",
      personId,
      "contacts_replaced",
      {
        count: contacts.length,
      },
    );
  }
}

/**
 * Corrects where in the building a contact actually is.
 *
 * Deliberately not delete-and-recreate: the link carries `valid_from`, so
 * re-making it to fix a typo in a flat number would claim the person moved in
 * today. The row is amended in place and the change is journalled.
 */
export function updatePersonLink(
  database: DatabaseSync,
  linkId: string,
  input: Omit<PersonLinkInput, "personId" | "houseId">,
  context: ChangeContext,
  options: ListHousesOptions,
): void {
  const row = database.prepare(`
    SELECT id, house_id, person_id, entrance, apartment, role_in_house,
           valid_to, note
    FROM house_people WHERE id = ? AND deleted_at IS NULL
  `).get(linkId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new HttpError(
      404,
      "Звʼязок не знайдено.",
    );
  }

  // Same reasoning as `deletePersonLink`: the link is addressed by its own id,
  // so the building it belongs to is only known here.
  assertHouseVisible(
    database,
    String(row.house_id),
    options,
  );

  const before = {
    entrance: String(row.entrance ?? ""),
    apartment: String(row.apartment ?? ""),
    roleInHouse: String(row.role_in_house ?? "other"),
    note: String(row.note ?? ""),
  };

  const next = {
    entrance: input.entrance === undefined
      ? before.entrance
      : optionalText(
        input.entrance,
        "entrance",
        20,
      ),
    apartment: input.apartment === undefined
      ? before.apartment
      : optionalText(
        input.apartment,
        "apartment",
        20,
      ),
    roleInHouse: input.roleInHouse === undefined
      ? before.roleInHouse
      : optionalOneOf(
        input.roleInHouse,
        PERSON_ROLES,
        "roleInHouse",
        before.roleInHouse as never,
      ),
    note: input.note === undefined
      ? before.note
      : optionalText(
        input.note,
        "note",
        1000,
      ),
  };

  database.prepare(`
    UPDATE house_people
    SET entrance = ?, apartment = ?, role_in_house = ?, note = ?, updated_at = ?
    WHERE id = ?
  `).run(
    next.entrance,
    next.apartment,
    next.roleInHouse,
    next.note,
    new Date().toISOString(),
    linkId,
  );

  logUpdate(
    database,
    context,
    "housePerson",
    linkId,
    before,
    next,
    [
      "entrance",
      "apartment",
      "roleInHouse",
      "note",
    ],
  );
}

/**
 * Removes a contact person entirely, everywhere.
 *
 * Distinct from {@link deletePersonLink}, and the difference matters in the
 * field: a person who has moved out of one building loses the *link*, a person
 * recorded by mistake — or who asked to be removed — has to lose the record
 * itself, phone numbers included. Soft delete, so the journal still shows who
 * did it, and every house link goes with them or the contact count would keep
 * counting a person no query can reach.
 */
export function deletePerson(
  database: DatabaseSync,
  personId: string,
  context: ChangeContext,
  options: ListHousesOptions,
): void {
  assertPersonVisible(
    database,
    personId,
    options,
  );

  const row = database.prepare(`
    SELECT id FROM people WHERE id = ? AND deleted_at IS NULL
  `).get(personId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new HttpError(
      404,
      "Особу не знайдено.",
    );
  }

  const now = new Date().toISOString();

  for (const table of [
    "house_people",
    "person_contacts",
  ]) {
    database.prepare(`
      UPDATE ${table} SET deleted_at = ?, updated_at = ?
      WHERE person_id = ? AND deleted_at IS NULL
    `).run(
      now,
      now,
      personId,
    );
  }

  database.prepare(`
    UPDATE people SET deleted_at = ?, updated_at = ? WHERE id = ?
  `).run(
    now,
    now,
    personId,
  );

  logOperation(
    database,
    context,
    "person",
    personId,
    "delete",
    {},
  );
}

export function deletePersonLink(
  database: DatabaseSync,
  linkId: string,
  context: ChangeContext,
  options: ListHousesOptions,
): void {
  const row = database.prepare(`
    SELECT id, house_id, person_id FROM house_people
    WHERE id = ? AND deleted_at IS NULL
  `).get(linkId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new HttpError(
      404,
      "Звʼязок не знайдено.",
    );
  }

  // The link is identified by its own id, so the building it belongs to is only
  // known here — without this the caller could unpick a resident from any
  // building in the district by guessing nothing more than a link id.
  assertHouseVisible(
    database,
    String(row.house_id),
    options,
  );

  const now = new Date().toISOString();

  database.prepare(`
    UPDATE house_people SET deleted_at = ?, updated_at = ? WHERE id = ?
  `).run(
    now,
    now,
    linkId,
  );

  logOperation(
    database,
    context,
    "housePerson",
    linkId,
    "delete",
    {
      houseId: String(row.house_id),
      personId: String(row.person_id),
    },
  );
}

/** Folds one contact into another, keeping both sets of links and channels. */
export function mergePeople(
  database: DatabaseSync,
  keepId: string,
  mergeId: string,
  context: ChangeContext,
): void {
  if (keepId === mergeId) {
    badRequest("Не можна обʼєднати особу саму з собою.");
  }

  for (const id of [
    keepId,
    mergeId,
  ]) {
    const row = database.prepare(`
      SELECT id FROM people WHERE id = ? AND deleted_at IS NULL
    `).get(id);

    if (!row) {
      throw new HttpError(
        404,
        "Особу не знайдено.",
      );
    }
  }

  const now = new Date().toISOString();

  database.prepare(
    "UPDATE person_contacts SET person_id = ? WHERE person_id = ?",
  ).run(
    keepId,
    mergeId,
  );
  database.prepare(
    "UPDATE house_people SET person_id = ? WHERE person_id = ?",
  ).run(
    keepId,
    mergeId,
  );
  database.prepare(
    "UPDATE actions SET person_id = ? WHERE person_id = ?",
  ).run(
    keepId,
    mergeId,
  );
  database.prepare(`
    UPDATE people SET deleted_at = ?, merged_into = ?, updated_at = ?
    WHERE id = ?
  `).run(
    now,
    keepId,
    now,
    mergeId,
  );

  logOperation(
    database,
    context,
    "person",
    keepId,
    "merge",
    {
      mergedFrom: mergeId,
    },
  );
}

/* ------------------------------------------------------------------ *
 * Assignments
 * ------------------------------------------------------------------ */

export interface Assignment {
  id: string;
  campaignId: string;
  scope: string;
  scopeId: string;
  scopeLabel: string;
  employeeEmail: string;
  role: string;
  validFrom: string;
  validTo: string | null;
  status: string;
  note: string;
  createdBy: string;
  createdAt: string;
}

export function listAssignments(
  database: DatabaseSync,
  campaignId: string,
  filters: { employeeEmail?: string; scopeId?: string } = {},
): Assignment[] {
  const conditions = [
    "a.campaign_id = ?",
    "a.deleted_at IS NULL",
  ];
  const parameters: unknown[] = [campaignId];

  if (filters.employeeEmail) {
    conditions.push("a.employee_email = ?");
    parameters.push(filters.employeeEmail.toLowerCase());
  }

  if (filters.scopeId) {
    conditions.push("a.scope_id = ?");
    parameters.push(filters.scopeId);
  }

  const rows = database.prepare(`
    SELECT a.*, COALESCE(h.address, 'Дільниця №' || p.number, a.scope_id)
             AS scope_label
    FROM assignments a
    LEFT JOIN houses h ON a.scope = 'house' AND h.id = a.scope_id
    LEFT JOIN precincts p ON a.scope = 'precinct' AND p.id = a.scope_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY a.created_at DESC
  `).all(...parameters as never[]) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: String(row.id),
    campaignId: String(row.campaign_id),
    scope: String(row.scope),
    scopeId: String(row.scope_id),
    scopeLabel: String(row.scope_label ?? row.scope_id),
    employeeEmail: String(row.employee_email),
    role: String(row.role),
    validFrom: String(row.valid_from),
    validTo: row.valid_to == null ? null : String(row.valid_to),
    status: String(row.status),
    note: String(row.note ?? ""),
    createdBy: String(row.created_by ?? ""),
    createdAt: String(row.created_at),
  }));
}

export interface AssignmentInput {
  scope?: unknown;
  scopeId?: unknown;
  employeeEmail?: unknown;
  role?: unknown;
  validFrom?: unknown;
  validTo?: unknown;
  note?: unknown;
}

function assertScopeExists(
  database: DatabaseSync,
  scope: string,
  scopeId: string,
): void {
  const table = scope === "house" ? "houses" : "precincts";
  const row = database.prepare(`
    SELECT id FROM ${table} WHERE id = ? AND deleted_at IS NULL
  `).get(scopeId);

  if (!row) {
    throw new HttpError(
      400,
      scope === "house"
        ? "Вказаного будинку не існує."
        : "Вказаної дільниці не існує.",
    );
  }
}

/**
 * A coordinator may hand out only territory they already hold.
 *
 * Otherwise the territorial limit is decorative: a coordinator restricted to
 * two streets could simply assign *themselves* to every other house, one row at
 * a time, and read the whole campaign. Managers and admins are unrestricted —
 * granting territory is their job.
 */
function assertMayAssignScope(
  database: DatabaseSync,
  campaignId: string,
  viewer: ElectionsViewer | undefined,
  scope: string,
  scopeId: string,
): void {
  if (!viewer || hasAtLeast(
    viewer,
    "manager",
  )) {
    return;
  }

  const visibility = houseVisibilitySql(
    viewer,
    campaignId,
    "h",
  );
  const sql = scope === "house"
    ? `SELECT 1 AS ok FROM houses h
       WHERE h.id = :scopeId AND h.deleted_at IS NULL AND ${visibility.sql}`
    : `SELECT 1 AS ok FROM houses h
       JOIN house_polling_stations hps ON hps.house_id = h.id
       WHERE hps.precinct_id = :scopeId AND h.deleted_at IS NULL
         AND ${visibility.sql}
       LIMIT 1`;

  const row = database.prepare(sql).get({
    ...visibility.parameters,
    scopeId,
  } as never);

  if (!row) {
    throw new HttpError(
      403,
      "Призначати можна лише в межах власної закріпленої території.",
    );
  }
}

export function createAssignment(
  database: DatabaseSync,
  campaignId: string,
  input: AssignmentInput,
  context: ChangeContext,
  viewer?: ElectionsViewer,
): string {
  const scope = requireOneOf(
    input.scope,
    ASSIGNMENT_SCOPES,
    "scope",
  );
  const scopeId = requireText(
    input.scopeId,
    "scopeId",
    200,
  );

  assertScopeExists(
    database,
    scope,
    scopeId,
  );
  assertMayAssignScope(
    database,
    campaignId,
    viewer,
    scope,
    scopeId,
  );

  const email = requireText(
    input.employeeEmail,
    "employeeEmail",
    320,
  ).toLowerCase();

  if (!email.includes("@")) {
    badRequest("Поле «employeeEmail» має бути адресою електронної пошти.");
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  database.prepare(`
    INSERT INTO assignments (
      id, campaign_id, scope, scope_id, employee_email, role,
      valid_from, valid_to, status, note, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
  `).run(
    id,
    campaignId,
    scope,
    scopeId,
    email,
    optionalOneOf(
      input.role,
      ASSIGNMENT_ROLES,
      "role",
      "agitator",
    ),
    optionalTimestamp(
      input.validFrom,
      "validFrom",
    ) ?? now.slice(
      0,
      10,
    ),
    optionalTimestamp(
      input.validTo,
      "validTo",
    ),
    optionalText(
      input.note,
      "note",
      500,
    ),
    context.actor,
    now,
    now,
  );

  logCreate(
    database,
    {
      ...context,
      campaignId,
    },
    "assignment",
    id,
    {
      scope,
      scopeId,
      employeeEmail: email,
    },
  );

  return id;
}

export function endAssignment(
  database: DatabaseSync,
  assignmentId: string,
  context: ChangeContext,
  viewer?: ElectionsViewer,
): void {
  const row = database.prepare(`
    SELECT id, campaign_id, scope, scope_id, employee_email, status
    FROM assignments WHERE id = ? AND deleted_at IS NULL
  `).get(assignmentId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new HttpError(
      404,
      "Призначення не знайдено.",
    );
  }

  if (context.campaignId && String(row.campaign_id) !== context.campaignId) {
    throw new HttpError(
      404,
      "Призначення не знайдено.",
    );
  }

  assertMayAssignScope(
    database,
    String(row.campaign_id),
    viewer,
    String(row.scope),
    String(row.scope_id),
  );

  const now = new Date().toISOString();

  database.prepare(`
    UPDATE assignments
    SET status = 'ended', valid_to = COALESCE(valid_to, ?), updated_at = ?
    WHERE id = ?
  `).run(
    now.slice(
      0,
      10,
    ),
    now,
    assignmentId,
  );

  logOperation(
    database,
    {
      ...context,
      campaignId: String(row.campaign_id),
    },
    "assignment",
    assignmentId,
    "end",
    {
      scopeId: String(row.scope_id),
      employeeEmail: String(row.employee_email),
    },
  );
}

/**
 * Assigns many houses at once.
 *
 * Every id is checked before anything is written, and the whole batch shares
 * one `batchId` in the journal, so a bulk operation can be reviewed — or
 * reversed — as one thing rather than as 200 unrelated rows.
 */
export function bulkAssignHouses(
  database: DatabaseSync,
  campaignId: string,
  houseIds: string[],
  input: AssignmentInput,
  context: ChangeContext,
): { created: number; skipped: number; batchId: string } {
  if (houseIds.length === 0) {
    badRequest("Не вибрано жодного будинку.");
  }

  if (houseIds.length > 2000) {
    badRequest("Забагато будинків для однієї операції (максимум 2000).");
  }

  const batchId = randomUUID();
  const email = requireText(
    input.employeeEmail,
    "employeeEmail",
    320,
  ).toLowerCase();
  let created = 0;
  let skipped = 0;

  for (const houseId of houseIds) {
    assertScopeExists(
      database,
      "house",
      houseId,
    );

    const existing = database.prepare(`
      SELECT id FROM assignments
      WHERE campaign_id = ? AND scope = 'house' AND scope_id = ?
        AND employee_email = ? AND status = 'active' AND deleted_at IS NULL
    `).get(
      campaignId,
      houseId,
      email,
    );

    if (existing) {
      skipped += 1;
      continue;
    }

    createAssignment(
      database,
      campaignId,
      {
        ...input,
        scope: "house",
        scopeId: houseId,
        employeeEmail: email,
      },
      {
        ...context,
        origin: "bulk",
        batchId,
      },
    );
    created += 1;
  }

  logOperation(
    database,
    {
      ...context,
      origin: "bulk",
      batchId,
      campaignId,
    },
    "assignment",
    batchId,
    "bulk_assign",
    {
      requested: houseIds.length,
      created,
      skipped,
      employeeEmail: email,
    },
  );

  return {
    created,
    skipped,
    batchId,
  };
}

/** Every house id the viewer may see — the input to permission-aware search. */
export function listVisibleHouseIds(
  database: DatabaseSync,
  viewer: ElectionsViewer,
  campaignId: string,
): string[] {
  if (!viewer.role || !viewer.email) {
    return [];
  }

  if (hasAtLeast(
    viewer,
    "manager",
  )) {
    const rows = database.prepare(
      "SELECT id FROM houses WHERE deleted_at IS NULL",
    ).all() as Record<string, unknown>[];

    return rows.map((row) => String(row.id));
  }

  const rows = database.prepare(`
    SELECT DISTINCT h.id
    FROM houses h
    LEFT JOIN assignments ah
      ON ah.campaign_id = ? AND ah.scope = 'house' AND ah.scope_id = h.id
      AND ah.employee_email = ? AND ah.status = 'active' AND ah.deleted_at IS NULL
    LEFT JOIN house_polling_stations hps ON hps.house_id = h.id
    LEFT JOIN assignments ap
      ON ap.campaign_id = ? AND ap.scope = 'precinct'
      AND ap.scope_id = hps.precinct_id AND ap.employee_email = ?
      AND ap.status = 'active' AND ap.deleted_at IS NULL
    WHERE h.deleted_at IS NULL AND (ah.id IS NOT NULL OR ap.id IS NOT NULL)
  `).all(
    campaignId,
    viewer.email,
    campaignId,
    viewer.email,
  ) as Record<string, unknown>[];

  if (rows.length === 0 && viewer.role === "coordinator") {
    const hasAny = database.prepare(`
      SELECT 1 FROM assignments
      WHERE campaign_id = ? AND employee_email = ?
        AND status = 'active' AND deleted_at IS NULL
      LIMIT 1
    `).get(
      campaignId,
      viewer.email,
    );

    if (!hasAny) {
      const all = database.prepare(
        "SELECT id FROM houses WHERE deleted_at IS NULL",
      ).all() as Record<string, unknown>[];

      return all.map((row) => String(row.id));
    }
  }

  return rows.map((row) => String(row.id));
}
