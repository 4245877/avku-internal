import { HttpError } from "../../http/responses";

/**
 * Roles and visibility for the "Вибори" module.
 *
 * Before this change the module had no authorization at all: `access-auth.ts`
 * treats a request with no JWT as trusted local access, and the elections route
 * used the resolved identity only to fill in a text field. Anybody on the LAN
 * could rewrite the territory boundary — which decides which houses exist for
 * everyone.
 *
 * The rules here are deliberately blunt:
 *
 *  • no identity and no explicitly enabled dev mode ⇒ no role ⇒ every write is
 *    403 and personal data is never returned;
 *  • an agitator sees the houses assigned to them and nothing else, so a phone
 *    number for somebody else's building is never even loaded;
 *  • dev mode is opt-in through two environment variables, is refused outright
 *    in production, and is reported back to the UI so it cannot be mistaken for
 *    a real login.
 */

export const ELECTIONS_ROLES = [
  "agitator",
  "coordinator",
  "manager",
  "admin",
] as const;
export type ElectionsRole = (typeof ELECTIONS_ROLES)[number];

/** Higher wins. Used for "at least this role" checks. */
const ROLE_RANK: Record<ElectionsRole, number> = {
  agitator: 1,
  coordinator: 2,
  manager: 3,
  admin: 4,
};

export interface ElectionsViewer {
  email: string | null;
  role: ElectionsRole | null;
  /** True when the role came from the dev override rather than an identity. */
  isDevAuth: boolean;
  /**
   * True when the identity came from `ELECTIONS_LOCAL_EMAIL` rather than from a
   * verified Access assertion — a LAN deployment standing in for a login.
   */
  isLocalAuth: boolean;
}

export const ANONYMOUS_VIEWER: ElectionsViewer = {
  email: null,
  role: null,
  isDevAuth: false,
  isLocalAuth: false,
};

export function hasAtLeast(
  viewer: ElectionsViewer,
  role: ElectionsRole,
): boolean {
  if (!viewer.role) {
    return false;
  }

  return ROLE_RANK[viewer.role] >= ROLE_RANK[role];
}

/**
 * Throws 401 when nobody is identified and 403 when the caller is identified
 * but not permitted. The two are genuinely different: the first is fixed by
 * logging in, the second by asking for a role.
 */
export function requireRole(
  viewer: ElectionsViewer,
  role: ElectionsRole,
): asserts viewer is ElectionsViewer & { email: string; role: ElectionsRole } {
  if (!viewer.role || !viewer.email) {
    throw new HttpError(
      401,
      "Потрібна автентифікація для роботи з розділом «Вибори».",
    );
  }

  if (!hasAtLeast(
    viewer,
    role,
  )) {
    throw new HttpError(
      403,
      `Недостатньо прав: потрібна роль «${role}» або вища.`,
    );
  }
}

/** Any role at all — the floor for every write in the module. */
export function requireAnyRole(
  viewer: ElectionsViewer,
): asserts viewer is ElectionsViewer & { email: string; role: ElectionsRole } {
  requireRole(
    viewer,
    "agitator",
  );
}

/* ------------------------------------------------------------------ *
 * Resolving a role
 * ------------------------------------------------------------------ */

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();

  return value && value !== "" ? value : undefined;
}

function parseEmailList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

function isValidRole(value: string | undefined): value is ElectionsRole {
  return (ELECTIONS_ROLES as readonly string[]).includes(value ?? "");
}

let hasWarnedAboutDevAuth = false;

/**
 * Whether the local development role override is active.
 *
 * Two conditions, both explicit: `ELECTIONS_DEV_AUTH=1` and a valid role in
 * `ELECTIONS_DEV_ROLE`. Missing a token is not one of them. In production the
 * override is ignored entirely and the attempt is logged.
 */
export function resolveDevRole(): ElectionsRole | null {
  if (readEnv("ELECTIONS_DEV_AUTH") !== "1") {
    return null;
  }

  const role = readEnv("ELECTIONS_DEV_ROLE");

  if (!isValidRole(role)) {
    return null;
  }

  if (readEnv("NODE_ENV") === "production") {
    console.error(
      "[elections] ELECTIONS_DEV_AUTH is set in production and was ignored. " +
        "Remove it from the deployment environment.",
    );

    return null;
  }

  if (!hasWarnedAboutDevAuth) {
    hasWarnedAboutDevAuth = true;
    console.warn(
      `[elections] DEV AUTH ACTIVE — every request is treated as "${role}". ` +
        "This must never be enabled outside local development.",
    );
  }

  return role;
}

let hasWarnedAboutLocalAuth = false;

/**
 * The identity to assume for a request that carries no Access assertion.
 *
 * The LAN entry point is deliberately anonymous: `infra/nginx/app.conf` strips
 * `Cf-Access-*` from every host except the tunnel's, so a request from the
 * office network has no email and therefore no role — and `houseVisibilitySql`
 * shows a roleless viewer nothing at all. That is the correct default for a
 * public origin, but it leaves a LAN-bound internal deployment with an empty
 * map and no way to sign in.
 *
 * `ELECTIONS_LOCAL_EMAIL` is the deliberate way out: the operator names the
 * person the LAN is trusted to be, and that email still has to earn its role
 * through `ELECTIONS_ADMIN_EMAILS` or a stored one. Unlike the dev override it
 * stays available in production — a LAN appliance is a production deployment —
 * so it is reported back to the UI and warned about once at startup rather than
 * being allowed to pass for a real login.
 */
function resolveLocalEmail(): string | null {
  const email = readEnv("ELECTIONS_LOCAL_EMAIL")?.toLowerCase() ?? null;

  if (email && !hasWarnedAboutLocalAuth) {
    hasWarnedAboutLocalAuth = true;
    console.warn(
      `[elections] LOCAL AUTH ACTIVE — requests without a Cloudflare Access ` +
        `assertion are treated as "${email}". Only enable this where the ` +
        "origin is reachable from a trusted network.",
    );
  }

  return email;
}

export interface RoleSources {
  /** Role stored against the employee, if any. */
  storedRole?: string | null;
  email?: string | null;
}

/**
 * The effective role for a request.
 *
 * Bootstrap matters here: on a fresh deployment nobody has a role, so nobody
 * could grant one. `ELECTIONS_ADMIN_EMAILS` is the way in — a deployment-level
 * allowlist that always resolves to `admin`, checked before the stored role so
 * it cannot be locked out by a bad edit.
 */
export function resolveViewer(sources: RoleSources): ElectionsViewer {
  const identifiedEmail = sources.email?.trim().toLowerCase() || null;
  // Only ever a fallback: a real Access identity is never overridden by the
  // LAN stand-in, so enabling it cannot silently re-label a signed-in user.
  const localEmail = identifiedEmail ? null : resolveLocalEmail();
  const email = identifiedEmail ?? localEmail;
  const isLocalAuth = email !== null && email === localEmail;

  if (email) {
    if (parseEmailList(readEnv("ELECTIONS_ADMIN_EMAILS")).has(email)) {
      return {
        email,
        role: "admin",
        isDevAuth: false,
        isLocalAuth,
      };
    }

    if (isValidRole(sources.storedRole ?? undefined)) {
      return {
        email,
        role: sources.storedRole as ElectionsRole,
        isDevAuth: false,
        isLocalAuth,
      };
    }
  }

  const devRole = resolveDevRole();

  if (devRole) {
    return {
      email: email ?? "dev@localhost",
      role: devRole,
      isDevAuth: true,
      isLocalAuth: false,
    };
  }

  // An identified employee with no role assigned yet can read what the module
  // shows to everybody (the map, aggregate counts) but writes nothing.
  return {
    email,
    role: null,
    isDevAuth: false,
    isLocalAuth,
  };
}

/* ------------------------------------------------------------------ *
 * Row-level visibility
 * ------------------------------------------------------------------ */

export interface VisibilityClause {
  sql: string;
  /** Named parameters, merged into the caller's single parameter object. */
  parameters: Record<string, unknown>;
}

/**
 * The `WHERE` fragment that limits a house query to what the viewer may work
 * with.
 *
 *   admin / manager — the whole campaign.
 *   coordinator     — the houses and precincts they are assigned to, and nothing
 *                     else. An unassigned coordinator sees an empty map: that is
 *                     the correct answer, not a reason to hand over the campaign.
 *   agitator        — houses assigned to them, directly or through a precinct.
 *   no role         — nothing.
 *
 * There used to be a fallback here that gave a coordinator with no assignment
 * the whole campaign, so that a newly created coordinator would not face an
 * empty map. It meant territory access was granted by *forgetting* to assign
 * somebody — the widest possible permission produced by the least deliberate
 * act — and it silently extended to contacts, because `canSeeContacts` trusts
 * the query to have been narrowed already. Territory is now only ever granted
 * explicitly.
 *
 * Written as SQL rather than a post-filter on purpose: a house the viewer may
 * not see is never read, so its contact rows are never in memory to leak.
 */
export function houseVisibilitySql(
  viewer: ElectionsViewer,
  campaignId: string,
  alias: string,
): VisibilityClause {
  if (!viewer.role || !viewer.email) {
    return {
      sql: "0 = 1",
      parameters: {},
    };
  }

  if (hasAtLeast(
    viewer,
    "manager",
  )) {
    return {
      sql: "1 = 1",
      parameters: {},
    };
  }

  const assignedHouses = `
    EXISTS (
      SELECT 1 FROM assignments a
      WHERE a.campaign_id = :visCampaignId
        AND a.deleted_at IS NULL
        AND a.status = 'active'
        AND a.employee_email = :visEmail
        AND a.scope = 'house'
        AND a.scope_id = ${alias}.id
    )
  `;

  const assignedPrecincts = `
    EXISTS (
      SELECT 1 FROM assignments a
      JOIN house_polling_stations hps ON hps.precinct_id = a.scope_id
      WHERE a.campaign_id = :visCampaignId
        AND a.deleted_at IS NULL
        AND a.status = 'active'
        AND a.employee_email = :visEmail
        AND a.scope = 'precinct'
        AND hps.house_id = ${alias}.id
    )
  `;

  const parameters = {
    visCampaignId: campaignId,
    visEmail: viewer.email,
  };

  return {
    sql: `(${assignedHouses} OR ${assignedPrecincts})`,
    parameters,
  };
}

/**
 * The `WHERE` fragment that limits an activity row — an action, a task, an
 * issue — to what the viewer may read.
 *
 * The house lists were already filtered; these tables were not, so
 * `GET /api/elections/actions` handed any caller the entire campaign's work log
 * including the comment field, and `GET /api/elections/tasks` handed over every
 * task with its house address. Filtering here rather than after the fact means
 * a row for a building the viewer has no access to is never read into memory.
 *
 * A row with no house is campaign-wide rather than territorial: below manager
 * it is shown only to the person named on it (`personColumns`), because
 * otherwise "no house" would be a way to bypass the house filter entirely.
 */
export function activityVisibilitySql(
  viewer: ElectionsViewer,
  campaignId: string,
  houseColumn: string,
  personColumns: string[] = [],
): VisibilityClause {
  if (!viewer.role || !viewer.email) {
    return {
      sql: "0 = 1",
      parameters: {},
    };
  }

  if (hasAtLeast(
    viewer,
    "manager",
  )) {
    return {
      sql: "1 = 1",
      parameters: {},
    };
  }

  const houseClause = houseVisibilitySql(
    viewer,
    campaignId,
    "vish",
  );
  const ownRow = personColumns
    .map((column) => `LOWER(${column}) = :visEmail`)
    .join(" OR ");

  return {
    sql: `(
      EXISTS (
        SELECT 1 FROM houses vish
        WHERE vish.id = ${houseColumn}
          AND vish.deleted_at IS NULL
          AND ${houseClause.sql}
      )
      OR (${houseColumn} IS NULL${ownRow ? ` AND (${ownRow})` : " AND 0 = 1"})
    )`,
    parameters: {
      ...houseClause.parameters,
      visCampaignId: campaignId,
      visEmail: viewer.email.toLowerCase(),
    },
  };
}

/**
 * Whether names and phone numbers may be shown for a house.
 *
 * Coordinators and above see contacts for every house their query returned —
 * visibility has already been narrowed to their territory. An agitator sees
 * them only where they are the named assignee, which is what stops a shared
 * device from becoming a district-wide contact list.
 */
export function canSeeContacts(
  viewer: ElectionsViewer,
  assignees: { email: string }[],
): boolean {
  if (!viewer.role || !viewer.email) {
    return false;
  }

  if (hasAtLeast(
    viewer,
    "coordinator",
  )) {
    return true;
  }

  return assignees.some((assignee) =>
    assignee.email.toLowerCase() === viewer.email?.toLowerCase());
}

/**
 * Replaces the middle of a phone number, so a list can show that a contact
 * exists without handing over the number itself.
 */
export function maskContactValue(
  type: string,
  value: string,
): string {
  if (!value) {
    return "";
  }

  if (type === "phone" || type === "viber") {
    const digits = value.replace(/\D/g, "");

    if (digits.length < 4) {
      return "•••";
    }

    return `${value.startsWith("+") ? "+" : ""}${digits.slice(
      0,
      3,
    )}•••••${digits.slice(-2)}`;
  }

  if (type === "email") {
    const [name, domain] = value.split("@");

    return domain ? `${name.slice(0, 1)}•••@${domain}` : "•••";
  }

  return "•••";
}

/** `Коваленко Олена Петрівна` → `Коваленко О. П.` for masked list views. */
export function maskPersonName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);

  if (parts.length <= 1) {
    return parts[0] ? `${parts[0].slice(0, 1)}•••` : "•••";
  }

  return [
    parts[0],
    ...parts.slice(1).map((part) => `${part.slice(0, 1)}.`),
  ].join(" ");
}
