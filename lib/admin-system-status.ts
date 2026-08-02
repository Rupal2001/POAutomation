export type AdminReadiness = "ready" | "attention" | "empty";

export const REQUIRED_SYSTEM_TABLES = [
  "app_users",
  "automation_rules",
  "batches",
  "email_deliveries",
  "integration_runs",
  "po_events",
  "po_recommendation_claims",
  "purchase_orders",
  "schema_migrations",
  "supplier_style_mappings",
] as const;

export interface AdminSystemStatusInput {
  now: Date;
  environment: "local" | "deployment";
  database: {
    mode: "Local PostgreSQL" | "Managed PostgreSQL";
    responseTimeMs: number;
    serverTime: string | Date;
    schemaTables: number;
    requiredSchemaTables: number;
    requiredSchemaReady: boolean;
  };
  snapshot: null | {
    id: string;
    label: string | null;
    status: string;
    createdAt: string | Date;
    dataAsOf: string | null;
    sourceType: string | null;
    methodologyVersion: string | null;
    salesRows: number;
    inventoryRows: number;
    openPoRows: number;
    styleMasterRows: number;
  };
  latestInbound: null | {
    integration: string;
    status: string;
    createdAt: string | Date;
  };
  email: {
    provider: "preview" | "resend";
    configured: boolean;
    mode: string;
    forceToEnabled: boolean;
  };
  authentication: {
    totalUsers: number;
    activeUsers: number;
    activeAdmins: number;
    temporaryPasswordUsers: number;
    localDefaultBootstrapPending: boolean;
    sessionSigningReady: boolean;
    bootstrapCredentialsConfigured: boolean;
  };
}

/**
 * Creates the deliberately non-sensitive status payload used by the admin UI.
 * Connection strings, credentials, user identities and email addresses never
 * enter this shape, which makes accidental exposure through the endpoint less
 * likely as the operational screen evolves.
 */
export function buildAdminSystemStatus(input: AdminSystemStatusInput) {
  const snapshot = buildSnapshotStatus(input.snapshot, input.latestInbound, input.now);
  const authentication = buildAuthenticationStatus(input.authentication, input.environment);
  const emailDeliveryEnabled = input.email.provider === "resend" && input.email.configured;
  const emailStatus: AdminReadiness = input.email.provider === "preview"
    ? "attention"
    : emailDeliveryEnabled ? "ready" : "attention";

  return {
    generatedAt: input.now.toISOString(),
    environment: input.environment,
    database: {
      status: input.database.requiredSchemaReady ? "ready" as const : "attention" as const,
      name: "PostgreSQL",
      mode: input.database.mode,
      responseTimeMs: Math.max(0, Math.round(input.database.responseTimeMs)),
      serverTime: toIso(input.database.serverTime),
      schemaTables: Math.max(0, input.database.schemaTables),
      requiredSchemaTables: Math.max(0, input.database.requiredSchemaTables),
      requiredSchemaReady: input.database.requiredSchemaReady,
    },
    planning: snapshot,
    email: {
      status: emailStatus,
      provider: input.email.provider,
      configured: input.email.configured,
      deliveryEnabled: emailDeliveryEnabled,
      mode: input.email.mode,
      safetyOverrideEnabled: input.email.forceToEnabled,
      explanation: input.email.provider === "preview"
        ? "Preview mode records the workflow but does not send anything outside StyleFlow."
        : emailDeliveryEnabled
          ? "Approved purchase orders can be delivered through the configured Resend account."
          : "Resend is selected, but the sender identity or API key is not configured.",
    },
    authentication,
    liveDataNotice: "Connected planning reads the latest immutable StyleFlow PostgreSQL snapshot. It is not a direct Myntra production API connection.",
  };
}

function buildSnapshotStatus(
  snapshot: AdminSystemStatusInput["snapshot"],
  latestInbound: AdminSystemStatusInput["latestInbound"],
  now: Date
) {
  if (!snapshot) {
    return {
      status: "empty" as const,
      connectionName: "StyleFlow planning warehouse",
      snapshot: null,
      explanation: "No planning snapshot exists yet. Upload the methodology workbook or separate source files first.",
    };
  }

  const loadedAgeHours = differenceHours(now, snapshot.createdAt);
  const dataAgeDays = snapshot.dataAsOf ? differenceIndiaCalendarDays(now, snapshot.dataAsOf) : null;
  const hasRequiredRows = snapshot.salesRows > 0 && snapshot.inventoryRows > 0;
  const currentBusinessDate = dataAgeDays !== null && dataAgeDays >= 0 && dataAgeDays <= 7;
  const status: AdminReadiness = hasRequiredRows && currentBusinessDate ? "ready" : "attention";

  return {
    status,
    connectionName: "StyleFlow planning warehouse",
    snapshot: {
      ...snapshot,
      createdAt: toIso(snapshot.createdAt),
      loadedAgeHours,
      dataAgeDays,
      latestInbound: latestInbound ? {
        integration: humanizeIdentifier(latestInbound.integration),
        status: latestInbound.status,
        createdAt: toIso(latestInbound.createdAt),
      } : null,
    },
    explanation: !hasRequiredRows
      ? "The latest snapshot is missing sell-out or inventory rows required for planning."
      : dataAgeDays === null
        ? "The snapshot is usable, but its business data date is not available."
        : dataAgeDays < 0
          ? "The snapshot business date is in the future and should be checked."
          : dataAgeDays > 7
            ? `The snapshot business data is ${dataAgeDays} days old. Refresh it before a production buy decision.`
            : "The latest immutable snapshot is available for filtered connected planning.",
  };
}

function buildAuthenticationStatus(
  authentication: AdminSystemStatusInput["authentication"],
  environment: AdminSystemStatusInput["environment"]
) {
  const warnings: string[] = [];
  if (!authentication.sessionSigningReady) {
    warnings.push("AUTH_SECRET is missing or too short, so signed sessions are not ready.");
  }
  if (authentication.activeAdmins < 1) {
    warnings.push("There is no active administrator account.");
  }
  if (authentication.localDefaultBootstrapPending) {
    warnings.push("The local bootstrap administrator still has a temporary first-login password. Sign in and change it now.");
  }
  if (authentication.temporaryPasswordUsers > 0 && !authentication.localDefaultBootstrapPending) {
    warnings.push(`${authentication.temporaryPasswordUsers} active ${authentication.temporaryPasswordUsers === 1 ? "user still has" : "users still have"} a temporary password.`);
  }
  if (
    environment === "deployment" &&
    authentication.totalUsers === 0 &&
    !authentication.bootstrapCredentialsConfigured
  ) {
    warnings.push("No users exist and deployment bootstrap credentials are not configured.");
  }

  return {
    status: warnings.length ? "attention" as const : "ready" as const,
    sessionSigningReady: authentication.sessionSigningReady,
    totalUsers: authentication.totalUsers,
    activeUsers: authentication.activeUsers,
    activeAdmins: authentication.activeAdmins,
    temporaryPasswordUsers: authentication.temporaryPasswordUsers,
    warnings,
  };
}

function differenceHours(now: Date, past: string | Date) {
  const timestamp = new Date(past).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((now.getTime() - timestamp) / 3_600_000));
}

function differenceIndiaCalendarDays(now: Date, date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const left = Date.parse(`${today}T00:00:00Z`);
  const right = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(right) ? Math.round((left - right) / 86_400_000) : null;
}

function toIso(value: string | Date) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function humanizeIdentifier(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase());
}
