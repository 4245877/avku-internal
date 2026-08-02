import type { DatabaseSync } from "node:sqlite";

import {
  ACTION_RESULTS,
  ACTION_TYPES,
  ASSIGNMENT_ROLES,
  ASSIGNMENT_SCOPES,
  ASSIGNMENT_STATUSES,
  ATTACHMENT_ACCESS_LEVELS,
  ATTACHMENT_KINDS,
  ATTACHMENT_OWNER_TYPES,
  CAMPAIGN_STATUSES,
  CONFIDENTIALITY_LEVELS,
  CONTACT_TYPES,
  EVENT_STATUSES,
  EVENT_TYPES,
  HOUSE_TYPES,
  IMPORT_BATCH_KINDS,
  IMPORT_BATCH_STATUSES,
  IMPORT_ROW_DECISIONS,
  IMPORT_ROW_STATUSES,
  ISSUE_CATEGORIES,
  ISSUE_STATUSES,
  PERSON_ROLES,
  PRIORITIES,
  TASK_STATUSES,
  WORK_STAGES,
} from "./elections.types";

/**
 * Schema for the "Вибори" domain database.
 *
 * Migrations are inline TypeScript stepped by `PRAGMA user_version`, the same
 * mechanism the warehouse and certificate modules use — the project has no
 * `.sql` migration runner and this change does not introduce one.
 *
 * Every step is written to be safe to run twice: `CREATE TABLE IF NOT EXISTS`,
 * `CREATE INDEX IF NOT EXISTS`, and column additions guarded by a `PRAGMA
 * table_info` lookup. Nothing here drops or rewrites a table, so an existing
 * database is upgraded in place and no user data is destroyed.
 *
 * The central design decision: **a house is a permanent physical record with
 * its own id**, and everything that changes — stage, priority, who is
 * responsible, what was done — hangs off the pair (house, campaign) or off the
 * house through a dated relation. `osm_type`/`osm_id` are matching attributes,
 * so regenerating the OSM snapshot updates a house instead of orphaning
 * everything ever recorded against it.
 */

export const ELECTIONS_SCHEMA_VERSION = 1;

/** `'a','b','c'` — a CHECK list built from the shared vocabulary. */
function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

function columnExists(
  database: DatabaseSync,
  table: string,
  column: string,
): boolean {
  const rows = database.prepare(
    `PRAGMA table_info(${table})`,
  ).all() as Record<string, unknown>[];

  return rows.some((row) => String(row.name) === column);
}

/**
 * Adds a column only when it is missing. SQLite has no `ADD COLUMN IF NOT
 * EXISTS`, and a migration that throws on the second run is not idempotent.
 */
export function addColumnIfMissing(
  database: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  if (columnExists(
    database,
    table,
    column,
  )) {
    return;
  }

  database.exec(
    `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,
  );
}

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare(
    "PRAGMA user_version",
  ).get() as Record<string, unknown> | undefined;

  return Number(row?.user_version ?? 0);
}

/* ------------------------------------------------------------------ *
 * Step 1 — the whole domain model.
 * ------------------------------------------------------------------ */

const CREATE_CAMPAIGNS = `
  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK (status IN (${sqlList(CAMPAIGN_STATUSES)})),
    starts_on TEXT,
    ends_on TEXT,
    -- The territory of this campaign. Replaces the boundary that used to be a
    -- single file plus a hardcoded centre in the client.
    area_geojson TEXT,
    hq_house_id TEXT REFERENCES houses(id) ON DELETE SET NULL,
    hq_address TEXT NOT NULL DEFAULT '',
    hq_lat REAL CHECK (hq_lat IS NULL OR (hq_lat >= -90 AND hq_lat <= 90)),
    hq_lon REAL CHECK (hq_lon IS NULL OR (hq_lon >= -180 AND hq_lon <= 180)),
    note TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    deleted_at TEXT
  );
`;

const CREATE_PRECINCTS = `
  CREATE TABLE IF NOT EXISTS precincts (
    id TEXT PRIMARY KEY NOT NULL,
    number TEXT NOT NULL CHECK (length(trim(number)) > 0),
    district TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    lat REAL CHECK (lat IS NULL OR (lat >= -90 AND lat <= 90)),
    lon REAL CHECK (lon IS NULL OR (lon >= -180 AND lon <= 180)),
    boundary_geojson TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    verified_at TEXT,
    verified_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_precincts_number
    ON precincts(number) WHERE deleted_at IS NULL;

  -- Turnout and roll size are per election year, so they cannot live on the
  -- precinct row itself without overwriting last time's numbers.
  CREATE TABLE IF NOT EXISTS precinct_year_stats (
    precinct_id TEXT NOT NULL REFERENCES precincts(id) ON DELETE CASCADE,
    year INTEGER NOT NULL,
    registered_voters INTEGER,
    turnout INTEGER,
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (precinct_id, year)
  );
`;

const CREATE_HOUSES = `
  CREATE TABLE IF NOT EXISTS houses (
    -- Internal, permanent. Never an OSM id: an OSM way is renumbered whenever a
    -- mapper redraws the outline, which used to orphan every note on the house.
    id TEXT PRIMARY KEY NOT NULL,
    osm_type TEXT CHECK (osm_type IS NULL OR osm_type IN ('way', 'relation')),
    osm_id INTEGER,
    osm_timestamp TEXT,
    -- 'present' | 'missing' — set by the snapshot importer when an object it
    -- previously saw is no longer in OSM. The house and its history stay.
    osm_status TEXT NOT NULL DEFAULT 'present'
      CHECK (osm_status IN ('present', 'missing', 'manual')),

    street TEXT NOT NULL DEFAULT '',
    street_short TEXT NOT NULL DEFAULT '',
    number TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    full_address TEXT NOT NULL DEFAULT '',
    address_normalized TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    postal_code TEXT NOT NULL DEFAULT '',

    lat REAL NOT NULL CHECK (lat >= -90 AND lat <= 90),
    lon REAL NOT NULL CHECK (lon >= -180 AND lon <= 180),
    footprint TEXT,
    footprint_area_sqm REAL,

    name TEXT,
    type TEXT NOT NULL DEFAULT 'other'
      CHECK (type IN (${sqlList(HOUSE_TYPES)})),
    building TEXT NOT NULL DEFAULT '',
    floors INTEGER,
    built_year INTEGER,

    -- Confirmed counts only. Geometry estimates are computed on read and
    -- labelled as estimates; storing them would make a guess indistinguishable
    -- from a measurement a year later.
    entrances INTEGER CHECK (entrances IS NULL OR entrances >= 0),
    apartments INTEGER CHECK (apartments IS NULL OR apartments >= 0),
    households INTEGER CHECK (households IS NULL OR households >= 0),
    residents_count INTEGER CHECK (residents_count IS NULL OR residents_count >= 0),

    managing_org TEXT NOT NULL DEFAULT '',
    access_note TEXT NOT NULL DEFAULT '',

    source TEXT NOT NULL DEFAULT 'manual',
    geocode_status TEXT NOT NULL DEFAULT 'osm'
      CHECK (geocode_status IN ('osm', 'manual', 'imported', 'unverified')),
    verified_at TEXT,
    verified_by TEXT,

    merged_into TEXT REFERENCES houses(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  -- The OSM link is unique when present, which is what makes re-import an
  -- update instead of a duplicate. The address is only indexed, never unique:
  -- the live snapshot genuinely holds 225 repeated street+number pairs (up to
  -- eight buildings on one address), so a unique constraint there would reject
  -- real data. Duplicates are surfaced as a data-quality finding instead.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_houses_osm
    ON houses(osm_type, osm_id)
    WHERE osm_id IS NOT NULL AND deleted_at IS NULL;

  CREATE INDEX IF NOT EXISTS idx_houses_address_normalized
    ON houses(address_normalized) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_houses_street ON houses(street);
  CREATE INDEX IF NOT EXISTS idx_houses_location ON houses(lat, lon);
`;

const CREATE_HOUSE_CAMPAIGN_STATE = `
  -- One row per (house, campaign). This is what lets a second campaign run over
  -- the same buildings without touching the first one's results.
  CREATE TABLE IF NOT EXISTS house_campaign_state (
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
    stage TEXT NOT NULL DEFAULT 'not_started'
      CHECK (stage IN (${sqlList(WORK_STAGES)})),
    priority TEXT NOT NULL DEFAULT 'medium'
      CHECK (priority IN (${sqlList(PRIORITIES)})),
    priority_reason TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    next_action_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (campaign_id, house_id)
  );

  CREATE INDEX IF NOT EXISTS idx_house_state_stage
    ON house_campaign_state(campaign_id, stage);
  CREATE INDEX IF NOT EXISTS idx_house_state_priority
    ON house_campaign_state(campaign_id, priority);
`;

const CREATE_HOUSE_POLLING_STATIONS = `
  -- Not a single precinct_id on the house: different entrances (and different
  -- flat ranges within one entrance) of the same building routinely vote at
  -- different stations, and a scalar column cannot say that.
  CREATE TABLE IF NOT EXISTS house_polling_stations (
    id TEXT PRIMARY KEY NOT NULL,
    house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
    precinct_id TEXT NOT NULL REFERENCES precincts(id) ON DELETE CASCADE,
    entrance TEXT NOT NULL DEFAULT '',
    apartment_from INTEGER,
    apartment_to INTEGER,
    source TEXT NOT NULL DEFAULT 'manual',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_house_polling_unique
    ON house_polling_stations(
      house_id,
      precinct_id,
      entrance,
      COALESCE(apartment_from, -1),
      COALESCE(apartment_to, -1)
    );
  CREATE INDEX IF NOT EXISTS idx_house_polling_house
    ON house_polling_stations(house_id);
  CREATE INDEX IF NOT EXISTS idx_house_polling_precinct
    ON house_polling_stations(precinct_id);
`;

const CREATE_PEOPLE = `
  -- A person, with a working role and nothing else. No political position, no
  -- age band, no prediction of behaviour: those were removed from the module
  -- and there is deliberately nowhere to put them back.
  CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY NOT NULL,
    full_name TEXT NOT NULL CHECK (length(trim(full_name)) > 0),
    role TEXT NOT NULL DEFAULT 'other'
      CHECK (role IN (${sqlList(PERSON_ROLES)})),
    note TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    merged_into TEXT REFERENCES people(id) ON DELETE SET NULL,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_people_name ON people(full_name);

  -- A phone belongs to a person, not to a wall.
  CREATE TABLE IF NOT EXISTS person_contacts (
    id TEXT PRIMARY KEY NOT NULL,
    person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN (${sqlList(CONTACT_TYPES)})),
    value TEXT NOT NULL CHECK (length(trim(value)) > 0),
    value_normalized TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_person_contacts_person
    ON person_contacts(person_id) WHERE deleted_at IS NULL;
  -- Search by phone, and duplicate detection on import, both run on this.
  CREATE INDEX IF NOT EXISTS idx_person_contacts_normalized
    ON person_contacts(value_normalized) WHERE deleted_at IS NULL;

  -- The link between a person and a building is dated, so a move or a change of
  -- role is history rather than an overwrite.
  CREATE TABLE IF NOT EXISTS house_people (
    id TEXT PRIMARY KEY NOT NULL,
    house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
    person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    entrance TEXT NOT NULL DEFAULT '',
    apartment TEXT NOT NULL DEFAULT '',
    role_in_house TEXT NOT NULL DEFAULT 'other'
      CHECK (role_in_house IN (${sqlList(PERSON_ROLES)})),
    valid_from TEXT,
    valid_to TEXT,
    note TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_house_people_house
    ON house_people(house_id) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_house_people_person
    ON house_people(person_id) WHERE deleted_at IS NULL;
`;

const CREATE_ASSIGNMENTS = `
  -- Several people can be responsible for one house, and one person can hold a
  -- whole precinct. Both are the same row shape with a different scope.
  CREATE TABLE IF NOT EXISTS assignments (
    id TEXT PRIMARY KEY NOT NULL,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (scope IN (${sqlList(ASSIGNMENT_SCOPES)})),
    scope_id TEXT NOT NULL,
    employee_email TEXT NOT NULL CHECK (length(trim(employee_email)) > 0),
    role TEXT NOT NULL DEFAULT 'agitator'
      CHECK (role IN (${sqlList(ASSIGNMENT_ROLES)})),
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN (${sqlList(ASSIGNMENT_STATUSES)})),
    note TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_assignments_scope
    ON assignments(campaign_id, scope, scope_id) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_assignments_employee
    ON assignments(campaign_id, employee_email) WHERE deleted_at IS NULL;
`;

const CREATE_ACTIVITY = `
  -- The main log of work done. "When were we last here" is answered from this
  -- table, not from free text in a notes field.
  CREATE TABLE IF NOT EXISTS actions (
    id TEXT PRIMARY KEY NOT NULL,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    house_id TEXT REFERENCES houses(id) ON DELETE CASCADE,
    person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
    event_id TEXT,
    type TEXT NOT NULL CHECK (type IN (${sqlList(ACTION_TYPES)})),
    result TEXT NOT NULL CHECK (result IN (${sqlList(ACTION_RESULTS)})),
    happened_at TEXT NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    next_step TEXT NOT NULL DEFAULT '',
    next_action_at TEXT,
    author_email TEXT NOT NULL CHECK (length(trim(author_email)) > 0),
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_actions_house
    ON actions(campaign_id, house_id, happened_at DESC) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_actions_author
    ON actions(campaign_id, author_email, happened_at DESC) WHERE deleted_at IS NULL;

  CREATE TABLE IF NOT EXISTS issues (
    id TEXT PRIMARY KEY NOT NULL,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    house_id TEXT REFERENCES houses(id) ON DELETE CASCADE,
    entrance TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL CHECK (category IN (${sqlList(ISSUE_CATEGORIES)})),
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    description TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'medium'
      CHECK (priority IN (${sqlList(PRIORITIES)})),
    status TEXT NOT NULL DEFAULT 'open'
      CHECK (status IN (${sqlList(ISSUE_STATUSES)})),
    assignee_email TEXT,
    due_at TEXT,
    resolution TEXT NOT NULL DEFAULT '',
    confidentiality TEXT NOT NULL DEFAULT 'normal'
      CHECK (confidentiality IN (${sqlList(CONFIDENTIALITY_LEVELS)})),
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_issues_house
    ON issues(campaign_id, house_id, status) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_issues_status
    ON issues(campaign_id, status, due_at) WHERE deleted_at IS NULL;

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY NOT NULL,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    house_id TEXT REFERENCES houses(id) ON DELETE CASCADE,
    issue_id TEXT REFERENCES issues(id) ON DELETE CASCADE,
    event_id TEXT,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    description TEXT NOT NULL DEFAULT '',
    assignee_email TEXT,
    due_at TEXT,
    status TEXT NOT NULL DEFAULT 'todo'
      CHECK (status IN (${sqlList(TASK_STATUSES)})),
    priority TEXT NOT NULL DEFAULT 'medium'
      CHECK (priority IN (${sqlList(PRIORITIES)})),
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_house
    ON tasks(campaign_id, house_id, status) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_tasks_due
    ON tasks(campaign_id, status, due_at) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_tasks_assignee
    ON tasks(campaign_id, assignee_email, status) WHERE deleted_at IS NULL;

  -- A tent or a street meeting is a point on the map with a start and an end.
  -- It is deliberately not a house: it has no address, no entrances, and it
  -- stops existing on Sunday evening.
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY NOT NULL,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN (${sqlList(EVENT_TYPES)})),
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    description TEXT NOT NULL DEFAULT '',
    lat REAL CHECK (lat IS NULL OR (lat >= -90 AND lat <= 90)),
    lon REAL CHECK (lon IS NULL OR (lon >= -180 AND lon <= 180)),
    address TEXT NOT NULL DEFAULT '',
    house_id TEXT REFERENCES houses(id) ON DELETE SET NULL,
    starts_at TEXT NOT NULL,
    ends_at TEXT,
    status TEXT NOT NULL DEFAULT 'planned'
      CHECK (status IN (${sqlList(EVENT_STATUSES)})),
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_events_campaign
    ON events(campaign_id, starts_at) WHERE deleted_at IS NULL;

  CREATE TABLE IF NOT EXISTS shifts (
    id TEXT PRIMARY KEY NOT NULL,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    starts_at TEXT NOT NULL,
    ends_at TEXT,
    location TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_shifts_campaign
    ON shifts(campaign_id, starts_at) WHERE deleted_at IS NULL;

  CREATE TABLE IF NOT EXISTS shift_members (
    id TEXT PRIMARY KEY NOT NULL,
    shift_id TEXT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
    employee_email TEXT NOT NULL CHECK (length(trim(employee_email)) > 0),
    role TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'planned',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_shift_members_unique
    ON shift_members(shift_id, employee_email);

  -- Material hand-outs point at the existing warehouse module by item id. The
  -- code and name are copied for display only; the catalogue is not duplicated
  -- here and quantities are checked against the warehouse before insert.
  CREATE TABLE IF NOT EXISTS material_issues (
    id TEXT PRIMARY KEY NOT NULL,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    warehouse_item_id TEXT NOT NULL,
    warehouse_item_code TEXT NOT NULL DEFAULT '',
    warehouse_item_name TEXT NOT NULL DEFAULT '',
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit TEXT NOT NULL DEFAULT '',
    issued_to_email TEXT NOT NULL DEFAULT '',
    issued_to_name TEXT NOT NULL DEFAULT '',
    house_id TEXT REFERENCES houses(id) ON DELETE SET NULL,
    event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
    issued_at TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_material_issues_campaign
    ON material_issues(campaign_id, issued_at DESC) WHERE deleted_at IS NULL;
`;

const CREATE_ATTACHMENTS = `
  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY NOT NULL,
    campaign_id TEXT REFERENCES campaigns(id) ON DELETE CASCADE,
    owner_type TEXT NOT NULL
      CHECK (owner_type IN (${sqlList(ATTACHMENT_OWNER_TYPES)})),
    owner_id TEXT NOT NULL,
    house_id TEXT REFERENCES houses(id) ON DELETE CASCADE,
    event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN (${sqlList(ATTACHMENT_KINDS)})),
    -- The name the uploader saw. Never used to build a path.
    file_name TEXT NOT NULL CHECK (length(trim(file_name)) > 0),
    -- Generated: '<uuid>.<safe-ext>'. This is the only thing that touches disk,
    -- so a crafted upload name cannot escape the storage directory.
    stored_name TEXT NOT NULL UNIQUE,
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    byte_size INTEGER NOT NULL CHECK (byte_size > 0),
    access_level TEXT NOT NULL DEFAULT 'team'
      CHECK (access_level IN (${sqlList(ATTACHMENT_ACCESS_LEVELS)})),
    note TEXT NOT NULL DEFAULT '',
    uploaded_by TEXT NOT NULL CHECK (length(trim(uploaded_by)) > 0),
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_attachments_owner
    ON attachments(owner_type, owner_id) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_attachments_house
    ON attachments(house_id) WHERE deleted_at IS NULL;
`;

const CREATE_JOURNALS = `
  -- Cross-cutting history. Field-level for updates, whole-record for creates
  -- and deletes, and always attributed to a verified identity — never to a name
  -- somebody typed into a form.
  CREATE TABLE IF NOT EXISTS change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    field TEXT,
    old_value TEXT,
    new_value TEXT,
    changed_by TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    -- 'api' | 'import' | 'script' | 'bulk'
    origin TEXT NOT NULL DEFAULT 'api',
    -- Import batch id or bulk-operation id, so a whole operation is one query.
    batch_id TEXT,
    campaign_id TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_change_log_entity
    ON change_log(entity, entity_id, changed_at DESC);
  CREATE INDEX IF NOT EXISTS idx_change_log_batch
    ON change_log(batch_id) WHERE batch_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_change_log_changed_at
    ON change_log(changed_at DESC);

  -- Who looked at contact details, and who took data out of the system.
  CREATE TABLE IF NOT EXISTS access_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('pii_view', 'export')),
    actor_email TEXT NOT NULL,
    at TEXT NOT NULL,
    campaign_id TEXT,
    entity TEXT NOT NULL DEFAULT '',
    entity_id TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    record_count INTEGER NOT NULL DEFAULT 0,
    includes_personal INTEGER NOT NULL DEFAULT 0
      CHECK (includes_personal IN (0, 1))
  );

  CREATE INDEX IF NOT EXISTS idx_access_log_at ON access_log(at DESC);
  CREATE INDEX IF NOT EXISTS idx_access_log_actor
    ON access_log(actor_email, at DESC);
`;

const CREATE_IMPORT = `
  CREATE TABLE IF NOT EXISTS import_batches (
    id TEXT PRIMARY KEY NOT NULL,
    campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN (${sqlList(IMPORT_BATCH_KINDS)})),
    file_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK (status IN (${sqlList(IMPORT_BATCH_STATUSES)})),
    total_rows INTEGER NOT NULL DEFAULT 0,
    cleaned_fields_count INTEGER NOT NULL DEFAULT 0,
    report TEXT,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    applied_at TEXT,
    rolled_back_at TEXT
  );

  -- The original row is written once and never modified: normalisation happens
  -- in the normalized column, so it is always possible to go back to the
  -- source text.
  CREATE TABLE IF NOT EXISTS import_rows (
    id TEXT PRIMARY KEY NOT NULL,
    batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
    row_number INTEGER NOT NULL,
    raw TEXT NOT NULL,
    normalized TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN (${sqlList(IMPORT_ROW_STATUSES)})),
    decision TEXT CHECK (decision IS NULL OR decision IN (${sqlList(IMPORT_ROW_DECISIONS)})),
    match_house_id TEXT,
    match_person_id TEXT,
    match_confidence TEXT NOT NULL DEFAULT '',
    notes TEXT,
    created_entity_type TEXT,
    created_entity_id TEXT,
    cleaned_fields_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_import_rows_unique
    ON import_rows(batch_id, row_number);
  CREATE INDEX IF NOT EXISTS idx_import_rows_status
    ON import_rows(batch_id, status);

  -- Everything a batch touched, with the pre-image of any row it updated. This
  -- is what makes an import reversible by batch id rather than by hand.
  CREATE TABLE IF NOT EXISTS import_effects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('insert', 'update')),
    previous TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_import_effects_batch
    ON import_effects(batch_id, id DESC);
`;

/**
 * Brings a connection up to {@link ELECTIONS_SCHEMA_VERSION}.
 *
 * Safe on a fresh file, safe on an existing one, and safe to call twice in a
 * row — which is exactly what happens every time the API restarts.
 */
export function migrateElectionsDatabase(database: DatabaseSync): void {
  const version = readUserVersion(database);

  if (version >= ELECTIONS_SCHEMA_VERSION) {
    return;
  }

  // Foreign keys are declared before the tables they point at (campaigns →
  // houses), which SQLite only tolerates with deferred enforcement during the
  // creation itself. The pragma is per-connection and restored below.
  database.exec("PRAGMA foreign_keys = OFF");

  try {
    database.exec("BEGIN IMMEDIATE");

    try {
      database.exec(CREATE_HOUSES);
      database.exec(CREATE_CAMPAIGNS);
      database.exec(CREATE_PRECINCTS);
      database.exec(CREATE_HOUSE_CAMPAIGN_STATE);
      database.exec(CREATE_HOUSE_POLLING_STATIONS);
      database.exec(CREATE_PEOPLE);
      database.exec(CREATE_ASSIGNMENTS);
      database.exec(CREATE_ACTIVITY);
      database.exec(CREATE_ATTACHMENTS);
      database.exec(CREATE_JOURNALS);
      database.exec(CREATE_IMPORT);
      database.exec(`PRAGMA user_version = ${ELECTIONS_SCHEMA_VERSION}`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}
