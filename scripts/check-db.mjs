import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import postgres from "postgres";

try {
  const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[2].startsWith("#")) continue;
    const value = match[2].replace(/^['"]|['"]$/g, "");
    if (!process.env[match[1]]) process.env[match[1]] = value;
  }
} catch {}

const connection = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!connection) {
  console.error("Database check skipped: add DATABASE_URL to .env.local first.");
  process.exit(1);
}

function isLocalConnection(connectionString) {
  try {
    const hostname = new URL(connectionString).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return ["", "localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(hostname);
  } catch {
    return false;
  }
}

const local = isLocalConnection(connection);
const sql = local ? postgres(connection, { max: 1 }) : neon(connection);

const requiredTables = [
  "access_control_events",
  "access_control_state",
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
  "role_area_access",
  "user_area_access_overrides",
];
const requiredColumns = {
  access_control_state: ["revision", "updated_by_user_id"],
  app_users: ["session_version", "must_change_password", "locked_until"],
  batches: ["planning_settings", "vendor_master_data", "recommendations"],
  email_deliveries: ["idempotency_key", "provider_message_id", "completed_at"],
  purchase_orders: ["currency", "revision", "created_by_user_id", "approved_by_user_id"],
  supplier_style_mappings: ["mapping_key", "mapping_status", "nlc_inr", "revision"],
  role_area_access: ["role", "area_key", "allowed"],
  user_area_access_overrides: ["user_id", "area_key", "effect"],
};
const requiredConstraints = [
  "app_users_identity_shape_check",
  "batches_shape_check",
  "purchase_orders_business_integrity_check",
  "email_deliveries_status_check",
  "email_deliveries_shape_check",
  "supplier_style_mappings_commercial_shape_check",
  "supplier_style_mappings_readiness_check",
  "automation_rules_business_check",
  "role_area_access_admin_boundary_check",
  "user_area_access_overrides_admin_boundary_check",
];

try {
  const tables = await sql`SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' ORDER BY table_name`;
  const names = tables.map(row => String(row.table_name));
  const missingTables = requiredTables.filter(name => !names.includes(name));
  if (missingTables.length) throw new Error(`Missing table(s): ${missingTables.join(", ")}. Run npm run db:init.`);

  const columns = await sql`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema='public'`;
  const availableColumns = new Set(columns.map(row => `${row.table_name}.${row.column_name}`));
  const missingColumns = Object.entries(requiredColumns).flatMap(([table, names]) =>
    names.filter(name => !availableColumns.has(`${table}.${name}`)).map(name => `${table}.${name}`)
  );
  if (missingColumns.length) throw new Error(`Missing column(s): ${missingColumns.join(", ")}. Run npm run db:init.`);

  const constraints = await sql`SELECT conname FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace`;
  const constraintNames = new Set(constraints.map(row => String(row.conname)));
  const missingConstraints = requiredConstraints.filter(name => !constraintNames.has(name));
  if (missingConstraints.length) throw new Error(`Missing integrity constraint(s): ${missingConstraints.join(", ")}. Run npm run db:init.`);

  const [integrity] = await sql`SELECT
    (SELECT COUNT(*)::int FROM app_users WHERE role='admin' AND is_active=true) AS active_admins,
    (SELECT COUNT(*)::int FROM purchase_orders WHERE currency <> 'INR') AS non_inr_orders,
    (SELECT COUNT(*)::int FROM purchase_orders
      WHERE jsonb_path_exists(lines, '$[*] ? (@.currency != "INR")')) AS non_inr_lines,
    (SELECT COUNT(*)::int FROM purchase_orders
      WHERE jsonb_typeof(lines) <> 'array' OR subtotal < 0 OR freight < 0 OR discount < 0 OR tax < 0 OR total < 0
        OR discount > subtotal + freight OR total <> subtotal + freight - discount + tax) AS invalid_orders,
    (SELECT COUNT(*)::int FROM batches
      WHERE coverage_days NOT BETWEEN 1 AND 365
        OR status NOT IN ('uploaded','processing','generated','failed','archived')
        OR (label IS NOT NULL AND char_length(label) > 160)
        OR jsonb_typeof(sales_data) <> 'array' OR jsonb_typeof(inventory_data) <> 'array'
        OR jsonb_typeof(open_po_data) <> 'array' OR jsonb_typeof(planning_settings) <> 'object'
        OR (vendor_master_data IS NOT NULL AND jsonb_typeof(vendor_master_data) <> 'array')
        OR (recommendations IS NOT NULL AND jsonb_typeof(recommendations) <> 'array')
        OR jsonb_path_exists(open_po_data, '$[*] ? (@.currency != "INR")')
        OR (vendor_master_data IS NOT NULL AND jsonb_path_exists(vendor_master_data, '$[*] ? (@.currency != "INR")'))
      ) AS invalid_batches,
    (SELECT COUNT(*)::int FROM supplier_style_mappings
      WHERE (mapping_status='unmapped' AND vendor IS NOT NULL)
        OR (mapping_status='mapped' AND (vendor IS NULL OR nlc_inr IS NULL OR supplier_sku IS NULL
          OR supplier_email IS NULL OR hsn_code IS NULL OR gst_rate IS NULL OR supplier_gstin IS NULL
          OR supplier_state IS NULL OR lead_time_days IS NULL OR moq IS NULL OR pack_size IS NULL))
        OR (mapping_status='incomplete' AND (vendor IS NULL OR (
          nlc_inr IS NOT NULL AND supplier_sku IS NOT NULL AND supplier_email IS NOT NULL AND hsn_code IS NOT NULL
          AND gst_rate IS NOT NULL AND supplier_gstin IS NOT NULL AND supplier_state IS NOT NULL
          AND lead_time_days IS NOT NULL AND moq IS NOT NULL AND pack_size IS NOT NULL
        )))) AS invalid_mappings,
    (SELECT COUNT(*)::int FROM access_control_state WHERE id='default' AND revision >= 1) AS access_state,
    (SELECT COUNT(*)::int FROM role_area_access
      WHERE area_key='admin_access_control'
        AND ((role='admin' AND allowed=false) OR (role<>'admin' AND allowed=true))) AS invalid_admin_role_access,
    (SELECT COUNT(*)::int FROM user_area_access_overrides
      WHERE area_key='admin_access_control') AS invalid_admin_overrides,
    (SELECT COUNT(*)::int FROM schema_migrations WHERE version='2026-08-02-industry-ready-v1') AS current_migration,
    (SELECT COUNT(*)::int FROM schema_migrations WHERE version='2026-08-02-page-access-control-v1') AS access_migration`;
  if (Number(integrity.active_admins) < 1) throw new Error("No active administrator exists. Set bootstrap credentials and rerun npm run db:init.");
  if (Number(integrity.non_inr_orders) > 0) throw new Error(`${integrity.non_inr_orders} purchase order(s) are not in INR.`);
  if (Number(integrity.non_inr_lines) > 0) throw new Error(`${integrity.non_inr_lines} purchase order(s) contain a non-INR line.`);
  if (Number(integrity.invalid_orders) > 0) throw new Error(`${integrity.invalid_orders} purchase order(s) violate amount or line integrity.`);
  if (Number(integrity.invalid_batches) > 0) throw new Error(`${integrity.invalid_batches} planning batch(es) contain invalid JSON shapes.`);
  if (Number(integrity.invalid_mappings) > 0) throw new Error(`${integrity.invalid_mappings} supplier mapping(s) have an inconsistent readiness status.`);
  if (Number(integrity.access_state) !== 1) throw new Error("The access-control revision record is missing.");
  if (Number(integrity.invalid_admin_role_access) > 0 || Number(integrity.invalid_admin_overrides) > 0) throw new Error("Administrator access-control invariants are invalid.");
  if (Number(integrity.current_migration) !== 1) throw new Error("The current schema migration marker is missing. Run npm run db:init.");
  if (Number(integrity.access_migration) !== 1) throw new Error("The access-control schema migration marker is missing. Run npm run db:init.");

  const [{ database, server_time: serverTime }] = await sql`SELECT current_database() AS database, now() AS server_time`;
  console.log(`Database ready: ${database} · ${requiredTables.length} required tables · INR integrity verified · ${serverTime}`);
} catch (error) {
  console.error(`Database check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (local) await sql.end();
}
