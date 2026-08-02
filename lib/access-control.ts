import { dbJson, sql } from "./db";
import { USER_ROLES, type SessionClaims, type SessionUser, type UserRole } from "./session";

export const ACCESS_AREAS = [
  {
    key: "overview",
    label: "Overview",
    description: "Executive and planner inventory metrics.",
    href: "/dashboard",
    group: "Workspace",
    lockedForAdmin: false,
  },
  {
    key: "plan_builder",
    label: "Build a plan",
    description: "Upload files or select live data and calculate a PO plan.",
    href: "/",
    group: "Workspace",
    lockedForAdmin: false,
  },
  {
    key: "review_orders",
    label: "Review orders",
    description: "Review recommendations and turn selected lines into draft POs.",
    href: "/review-orders",
    group: "Workspace",
    lockedForAdmin: false,
  },
  {
    key: "forecast_health",
    label: "Forecast health",
    description: "Inspect forecast accuracy, bias and automation readiness.",
    href: "/forecast",
    group: "Workspace",
    lockedForAdmin: false,
  },
  {
    key: "purchase_orders",
    label: "Purchase orders",
    description: "Create, approve, send, receive and close purchase orders.",
    href: "/purchase-orders",
    group: "Workspace",
    lockedForAdmin: false,
  },
  {
    key: "planning_readiness",
    label: "Planning readiness",
    description: "Check data, supplier and automation readiness in one place.",
    href: "/readiness",
    group: "Manage",
    lockedForAdmin: false,
  },
  {
    key: "plan_history",
    label: "Plan history",
    description: "Open and compare prior planning versions.",
    href: "/history",
    group: "Manage",
    lockedForAdmin: false,
  },
  {
    key: "supplier_mapping",
    label: "Supplier mapping",
    description: "Maintain the style-to-supplier commercial master.",
    href: "/supplier-mappings",
    group: "Manage",
    lockedForAdmin: false,
  },
  {
    key: "data_automation",
    label: "Data & automation",
    description: "Inspect connected data and configure automated planning runs.",
    href: "/automation",
    group: "Manage",
    lockedForAdmin: false,
  },
  {
    key: "admin_access_control",
    label: "Admin & access control",
    description: "Manage users, system health and page access.",
    href: "/admin",
    group: "Administration",
    lockedForAdmin: true,
  },
] as const;

export type AccessAreaKey = (typeof ACCESS_AREAS)[number]["key"];
export type AccessEffect = "allow" | "deny";
export type AccessOverrideEffect = AccessEffect | "inherit";
export type AreaAccessMap = Record<AccessAreaKey, boolean>;

export type RoleAccessChange = {
  role: UserRole;
  areaKey: AccessAreaKey;
  allowed: boolean;
};

export type UserAccessChange = {
  userId: string;
  areaKey: AccessAreaKey;
  effect: AccessOverrideEffect;
};

export type AccessControlChanges = {
  expectedRevision: number;
  roleAccess: RoleAccessChange[];
  userOverrides: UserAccessChange[];
  reason: string | null;
};

export class AccessControlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessControlValidationError";
  }
}

const AREA_KEYS = new Set<string>(ACCESS_AREAS.map((area) => area.key));
const ADMIN_AREA: AccessAreaKey = "admin_access_control";

export function isAccessAreaKey(value: unknown): value is AccessAreaKey {
  return typeof value === "string" && AREA_KEYS.has(value);
}

/** The compiled policy mirrors access before page-level controls existed. */
export function defaultAreaAccess(role: UserRole): AreaAccessMap {
  return Object.fromEntries(
    ACCESS_AREAS.map((area) => [
      area.key,
      area.key === ADMIN_AREA ? role === "admin" : true,
    ])
  ) as AreaAccessMap;
}

export function effectiveAreaDecision(values: {
  role: UserRole;
  areaKey: AccessAreaKey;
  roleAllowed?: boolean;
  userOverride?: AccessEffect | null;
}): boolean {
  if (values.areaKey === ADMIN_AREA) return values.role === "admin";
  if (values.userOverride === "allow") return true;
  if (values.userOverride === "deny") return false;
  return values.roleAllowed ?? defaultAreaAccess(values.role)[values.areaKey];
}

export function parseAccessControlChanges(input: unknown): AccessControlChanges {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AccessControlValidationError("The access-control request must be a JSON object.");
  }
  const body = input as Record<string, unknown>;
  const expectedRevision = Number(body.expectedRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new AccessControlValidationError("Reload access control and try again; its revision is missing or invalid.");
  }

  const roleAccess = parseRoleChanges(body.roleAccess);
  const userOverrides = parseUserChanges(body.userOverrides);
  if (!roleAccess.length && !userOverrides.length) {
    throw new AccessControlValidationError("Make at least one access change before saving.");
  }

  const reasonText = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reasonText.length > 500) {
    throw new AccessControlValidationError("The audit reason cannot exceed 500 characters.");
  }

  return {
    expectedRevision,
    roleAccess,
    userOverrides,
    reason: reasonText || null,
  };
}

function parseRoleChanges(value: unknown): RoleAccessChange[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new AccessControlValidationError("Role access changes must be an array.");
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new AccessControlValidationError(`Role access change ${index + 1} is invalid.`);
    }
    const row = item as Record<string, unknown>;
    const role = row.role;
    const areaKey = row.areaKey;
    if (typeof role !== "string" || !(USER_ROLES as readonly string[]).includes(role)) {
      throw new AccessControlValidationError(`Role access change ${index + 1} has an unknown role.`);
    }
    if (!isAccessAreaKey(areaKey)) {
      throw new AccessControlValidationError(`Role access change ${index + 1} has an unknown application area.`);
    }
    if (typeof row.allowed !== "boolean") {
      throw new AccessControlValidationError(`Role access change ${index + 1} must specify allowed as true or false.`);
    }
    if (areaKey === ADMIN_AREA && (role !== "admin" || row.allowed !== true)) {
      throw new AccessControlValidationError(
        "Admin & access control must remain available to Administrators and unavailable to other roles."
      );
    }
    const key = `${role}:${areaKey}`;
    if (seen.has(key)) {
      throw new AccessControlValidationError(`Role access change ${index + 1} duplicates ${key}.`);
    }
    seen.add(key);
    return { role: role as UserRole, areaKey, allowed: row.allowed };
  });
}

function parseUserChanges(value: unknown): UserAccessChange[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new AccessControlValidationError("User access changes must be an array.");
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new AccessControlValidationError(`User access change ${index + 1} is invalid.`);
    }
    const row = item as Record<string, unknown>;
    const userId = typeof row.userId === "string" ? row.userId.trim() : "";
    const areaKey = row.areaKey;
    const effect = row.effect;
    if (!userId || userId.length > 200) {
      throw new AccessControlValidationError(`User access change ${index + 1} has an invalid user.`);
    }
    if (!isAccessAreaKey(areaKey)) {
      throw new AccessControlValidationError(`User access change ${index + 1} has an unknown application area.`);
    }
    if (effect !== "allow" && effect !== "deny" && effect !== "inherit") {
      throw new AccessControlValidationError(`User access change ${index + 1} has an invalid effect.`);
    }
    if (areaKey === ADMIN_AREA && effect !== "inherit") {
      throw new AccessControlValidationError(
        "Admin & access control follows the Administrator role and cannot have a personal exception."
      );
    }
    const key = `${userId}:${areaKey}`;
    if (seen.has(key)) {
      throw new AccessControlValidationError(`User access change ${index + 1} duplicates ${key}.`);
    }
    seen.add(key);
    return { userId, areaKey, effect };
  });
}

function isMissingAccessSchemaError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "42P01"
  );
}

/**
 * Returns current effective page access. An installation being upgraded, with
 * no access tables yet, retains the compiled legacy defaults. Other database
 * failures are not treated as permission grants.
 */
export async function getEffectiveAreaAccess(
  user: Pick<SessionUser, "id" | "role">,
  database: any = sql()
): Promise<AreaAccessMap> {
  const defaults = defaultAreaAccess(user.role);
  try {
    const [roleRows, overrideRows] = await Promise.all([
      database`SELECT area_key,allowed FROM role_area_access WHERE role=${user.role}`,
      database`SELECT area_key,effect FROM user_area_access_overrides WHERE user_id=${user.id}`,
    ]);
    const rolePolicy = new Map<string, boolean>(
      roleRows.map((row: any) => [String(row.area_key), Boolean(row.allowed)])
    );
    const overrides = new Map<string, AccessEffect>(
      overrideRows.map((row: any) => [String(row.area_key), row.effect as AccessEffect])
    );
    return Object.fromEntries(
      ACCESS_AREAS.map((area) => [
        area.key,
        effectiveAreaDecision({
          role: user.role,
          areaKey: area.key,
          roleAllowed: rolePolicy.has(area.key) ? rolePolicy.get(area.key) : defaults[area.key],
          userOverride: overrides.get(area.key),
        }),
      ])
    ) as AreaAccessMap;
  } catch (error) {
    if (isMissingAccessSchemaError(error)) return defaults;
    throw error;
  }
}

export async function getAllowedAreas(
  user: Pick<SessionUser, "id" | "role">,
  database: any = sql()
): Promise<AccessAreaKey[]> {
  const access = await getEffectiveAreaAccess(user, database);
  return ACCESS_AREAS.filter((area) => access[area.key]).map((area) => area.key);
}

export async function getAccessControlSnapshot(database: any = sql()) {
  const [stateRows, roleRows, overrideRows, users] = await Promise.all([
    database`SELECT revision,updated_at FROM access_control_state WHERE id='default'`,
    database`SELECT role,area_key,allowed FROM role_area_access`,
    database`SELECT user_id,area_key,effect FROM user_area_access_overrides ORDER BY user_id,area_key`,
    database`SELECT id,username,display_name,email,role,is_active FROM app_users ORDER BY is_active DESC,display_name,username`,
  ]);
  const roleAccess = Object.fromEntries(
    USER_ROLES.map((role) => [role, defaultAreaAccess(role)])
  ) as Record<UserRole, AreaAccessMap>;
  for (const row of roleRows) {
    if (
      (USER_ROLES as readonly string[]).includes(String(row.role)) &&
      isAccessAreaKey(row.area_key)
    ) {
      const role = row.role as UserRole;
      const areaKey = row.area_key as AccessAreaKey;
      roleAccess[role][areaKey] = effectiveAreaDecision({
        role,
        areaKey,
        roleAllowed: Boolean(row.allowed),
      });
    }
  }
  // The reserved area is invariant even if legacy/manual data contains a bad row.
  for (const role of USER_ROLES) roleAccess[role][ADMIN_AREA] = role === "admin";

  return {
    revision: Number(stateRows[0]?.revision ?? 1),
    updatedAt: stateRows[0]?.updated_at ?? null,
    areas: ACCESS_AREAS,
    roles: USER_ROLES,
    users: users.map((row: any) => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      email: row.email,
      role: row.role,
      isActive: Boolean(row.is_active),
    })),
    roleAccess,
    userOverrides: overrideRows
      .filter((row: any) => isAccessAreaKey(row.area_key) && row.area_key !== ADMIN_AREA)
      .map((row: any) => ({
        userId: row.user_id,
        areaKey: row.area_key as AccessAreaKey,
        effect: row.effect as AccessEffect,
      })),
  };
}

export async function saveAccessControlChanges(
  changes: AccessControlChanges,
  administrator: Pick<SessionUser, "id" | "displayName">,
  database: any = sql()
): Promise<number> {
  const userIds = [...new Set(changes.userOverrides.map((change) => change.userId))];
  if (userIds.length) {
    const rows = await database`
      SELECT id FROM app_users
      WHERE id IN (SELECT jsonb_array_elements_text(${dbJson(userIds)}::jsonb))
    `;
    if (rows.length !== userIds.length) {
      throw new AccessControlValidationError("One or more users no longer exist. Reload access control and try again.");
    }
  }

  const rolePayload = changes.roleAccess.map((change) => ({
    role: change.role,
    areaKey: change.areaKey,
    allowed: change.allowed,
  }));
  const overridePayload = changes.userOverrides.map((change) => ({
    userId: change.userId,
    areaKey: change.areaKey,
    effect: change.effect,
  }));
  const auditPayload = {
    roleAccess: rolePayload,
    userOverrides: overridePayload,
  };

  const rows = await database`
    WITH revision_change AS (
      UPDATE access_control_state
      SET revision=revision+1,updated_by_user_id=${administrator.id},updated_at=now()
      WHERE id='default' AND revision=${changes.expectedRevision}
      RETURNING revision
    ), role_values AS (
      SELECT * FROM jsonb_to_recordset(${dbJson(rolePayload)}::jsonb)
      AS value(role TEXT,"areaKey" TEXT,allowed BOOLEAN)
    ), role_saved AS (
      INSERT INTO role_area_access (role,area_key,allowed,updated_by_user_id,updated_at)
      SELECT value.role,value."areaKey",value.allowed,${administrator.id},now()
      FROM role_values value CROSS JOIN revision_change
      ON CONFLICT (role,area_key) DO UPDATE
      SET allowed=EXCLUDED.allowed,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now()
      RETURNING role
    ), override_values AS (
      SELECT * FROM jsonb_to_recordset(${dbJson(overridePayload)}::jsonb)
      AS value("userId" TEXT,"areaKey" TEXT,effect TEXT)
    ), overrides_removed AS (
      DELETE FROM user_area_access_overrides existing
      USING override_values value,revision_change
      WHERE value.effect='inherit'
        AND existing.user_id=value."userId"
        AND existing.area_key=value."areaKey"
      RETURNING existing.user_id
    ), overrides_saved AS (
      INSERT INTO user_area_access_overrides
        (user_id,area_key,effect,updated_by_user_id,updated_at)
      SELECT value."userId",value."areaKey",value.effect,${administrator.id},now()
      FROM override_values value CROSS JOIN revision_change
      WHERE value.effect IN ('allow','deny')
      ON CONFLICT (user_id,area_key) DO UPDATE
      SET effect=EXCLUDED.effect,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now()
      RETURNING user_id
    ), event_saved AS (
      INSERT INTO access_control_events
        (revision,actor_user_id,actor,reason,changes)
      SELECT revision,${administrator.id},${administrator.displayName},${changes.reason},${dbJson(auditPayload)}::jsonb
      FROM revision_change
      RETURNING revision
    )
    SELECT revision FROM revision_change
  `;
  if (!rows.length) return 0;
  return Number(rows[0].revision);
}

export function accessRequirementForRequest(
  pathname: string,
  method = "GET"
): AccessAreaKey[] | null {
  const verb = method.toUpperCase();

  // Browser pages.
  if (pathname === "/") return ["plan_builder"];
  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) return ["overview"];
  if (pathname === "/review-orders" || pathname.startsWith("/review-orders/") || pathname.startsWith("/results/")) return ["review_orders"];
  if (pathname === "/forecast" || pathname.startsWith("/forecast/")) return ["forecast_health"];
  if (pathname === "/purchase-orders" || pathname.startsWith("/purchase-orders/")) return ["purchase_orders"];
  if (pathname === "/readiness" || pathname.startsWith("/readiness/")) return ["planning_readiness"];
  if (pathname === "/history" || pathname.startsWith("/history/")) return ["plan_history"];
  if (pathname === "/supplier-mappings" || pathname.startsWith("/supplier-mappings/")) return ["supplier_mapping"];
  if (pathname === "/automation" || pathname.startsWith("/automation/")) return ["data_automation"];
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return [ADMIN_AREA];

  // API routes shared by Planning readiness intentionally accept either the
  // source page or readiness access. Mutations still require their own area.
  if (pathname === "/api/dashboard") return ["overview", "planning_readiness"];
  if (pathname === "/api/forecast") return ["forecast_health"];
  if (pathname === "/api/upload" || pathname === "/api/generate" || pathname.startsWith("/api/data/live/")) return ["plan_builder"];
  if (pathname.startsWith("/api/demo-files/")) return ["plan_builder", "supplier_mapping"];
  if (pathname === "/api/batches") return ["plan_history"];
  if (pathname.startsWith("/api/batches/")) return verb === "GET" ? ["review_orders", "plan_history"] : ["plan_history"];
  if (pathname.startsWith("/api/export/")) return ["review_orders"];
  if (pathname === "/api/purchase-orders/resolve-supplier-and-create") return ["review_orders", "purchase_orders"];
  if (pathname === "/api/purchase-orders") return ["review_orders", "purchase_orders"];
  if (pathname === "/api/purchase-orders" || pathname.startsWith("/api/purchase-orders/")) return ["purchase_orders"];
  if (pathname === "/api/vendor-mappings" && verb === "GET") return ["supplier_mapping", "planning_readiness", "review_orders"];
  if (pathname.startsWith("/api/vendor-mappings")) return ["supplier_mapping"];
  if (pathname === "/api/automation" && verb === "GET") return ["data_automation", "planning_readiness"];
  if (pathname === "/api/automation" || pathname.startsWith("/api/automation/")) return ["data_automation"];
  if (pathname === "/api/admin" || pathname.startsWith("/api/admin/")) return [ADMIN_AREA];

  // Auth, profile, health and global search remain available to every signed-in
  // account. Profile must stay reachable so users can secure their account.
  return null;
}

export async function accessForSessionClaims(
  claims: Pick<SessionClaims, "sub" | "role">,
  database: any = sql()
): Promise<AreaAccessMap> {
  return getEffectiveAreaAccess({ id: claims.sub, role: claims.role }, database);
}
