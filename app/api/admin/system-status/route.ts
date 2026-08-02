import { NextRequest, NextResponse } from "next/server";
import { AuthError, assertAuthConfiguration, requireUser } from "@/lib/auth";
import { buildAdminSystemStatus, REQUIRED_SYSTEM_TABLES } from "@/lib/admin-system-status";
import { sql } from "@/lib/db";
import { emailProviderStatus } from "@/lib/email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requireUser(request, ["admin"]);
    const db = sql();
    const heartbeatStartedAt = Date.now();
    const [heartbeatRows, tableRows, batchRows, inboundRows, userRows] = await Promise.all([
      db`SELECT now() AS server_time`,
      db`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`,
      db`SELECT
          id,
          label,
          status,
          created_at,
          NULLIF(planning_settings->>'asOfDate','') AS data_as_of,
          NULLIF(planning_settings->>'sourceType','') AS source_type,
          NULLIF(planning_settings->>'methodologyVersion','') AS methodology_version,
          CASE WHEN jsonb_typeof(sales_data)='array' THEN jsonb_array_length(sales_data) ELSE 0 END AS sales_rows,
          CASE WHEN jsonb_typeof(inventory_data)='array' THEN jsonb_array_length(inventory_data) ELSE 0 END AS inventory_rows,
          CASE WHEN jsonb_typeof(open_po_data)='array' THEN jsonb_array_length(open_po_data) ELSE 0 END AS open_po_rows,
          CASE WHEN jsonb_typeof(vendor_master_data)='array' THEN jsonb_array_length(vendor_master_data) ELSE 0 END AS style_master_rows
        FROM batches
        WHERE status <> 'archived'
        ORDER BY created_at DESC
        LIMIT 1`,
      db`SELECT integration,status,created_at
        FROM integration_runs
        WHERE direction='inbound'
        ORDER BY created_at DESC
        LIMIT 1`,
      db`SELECT
          COUNT(*)::int AS total_users,
          COUNT(*) FILTER (WHERE is_active=true)::int AS active_users,
          COUNT(*) FILTER (WHERE is_active=true AND role='admin')::int AS active_admins,
          COUNT(*) FILTER (WHERE is_active=true AND must_change_password=true)::int AS temporary_password_users,
          BOOL_OR(
            lower(username)='admin'
            AND is_active=true
            AND must_change_password=true
            AND password_changed_at IS NULL
          ) AS admin_first_login_pending
        FROM app_users`,
    ]);
    const responseTimeMs = Date.now() - heartbeatStartedAt;
    const tableNames = new Set(tableRows.map((row: { table_name: string }) => row.table_name));
    const batch = batchRows[0];
    const inbound = inboundRows[0];
    const users = userRows[0] ?? {};
    const email = emailProviderStatus();
    const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
    const localDatabase = /(?:localhost|127\.0\.0\.1|\[::1\])/.test(connectionString);
    const environment = process.env.VERCEL || process.env.NODE_ENV === "production" ? "deployment" : "local";
    let sessionSigningReady = true;
    try {
      assertAuthConfiguration();
    } catch {
      sessionSigningReady = false;
    }
    const bootstrapCredentialsConfigured = Boolean(
      process.env.BOOTSTRAP_ADMIN_USERNAME?.trim() && process.env.BOOTSTRAP_ADMIN_PASSWORD
    );

    return NextResponse.json(buildAdminSystemStatus({
      now: new Date(),
      environment,
      database: {
        mode: localDatabase ? "Local PostgreSQL" : "Managed PostgreSQL",
        responseTimeMs,
        serverTime: heartbeatRows[0]?.server_time ?? new Date(),
        schemaTables: tableNames.size,
        requiredSchemaTables: REQUIRED_SYSTEM_TABLES.length,
        requiredSchemaReady: REQUIRED_SYSTEM_TABLES.every(table => tableNames.has(table)),
      },
      snapshot: batch ? {
        id: String(batch.id),
        label: batch.label ? String(batch.label) : null,
        status: String(batch.status),
        createdAt: batch.created_at,
        dataAsOf: batch.data_as_of ? String(batch.data_as_of) : null,
        sourceType: batch.source_type ? String(batch.source_type) : null,
        methodologyVersion: batch.methodology_version ? String(batch.methodology_version) : null,
        salesRows: Number(batch.sales_rows || 0),
        inventoryRows: Number(batch.inventory_rows || 0),
        openPoRows: Number(batch.open_po_rows || 0),
        styleMasterRows: Number(batch.style_master_rows || 0),
      } : null,
      latestInbound: inbound ? {
        integration: String(inbound.integration),
        status: String(inbound.status),
        createdAt: inbound.created_at,
      } : null,
      email: {
        provider: email.provider,
        configured: email.configured,
        mode: email.mode,
        forceToEnabled: email.forceToEnabled,
      },
      authentication: {
        totalUsers: Number(users.total_users || 0),
        activeUsers: Number(users.active_users || 0),
        activeAdmins: Number(users.active_admins || 0),
        temporaryPasswordUsers: Number(users.temporary_password_users || 0),
        localDefaultBootstrapPending: environment === "local" && !bootstrapCredentialsConfigured && Boolean(users.admin_first_login_pending),
        sessionSigningReady,
        bootstrapCredentialsConfigured,
      },
    }), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(error);
    return NextResponse.json({ error: "System health could not be checked. Confirm that PostgreSQL is running and initialized." }, { status: 503 });
  }
}
