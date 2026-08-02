import { neon } from "@neondatabase/serverless";
import postgres from "postgres";

// Local PostgreSQL uses postgres.js. The current remote/serverless path is
// intentionally Neon-specific; generic hosted PostgreSQL providers require an
// explicitly configured and tested driver rather than being guessed by URL.
function getConnectionString(): string {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    throw new Error(
      "No database connection string found. Set DATABASE_URL (or POSTGRES_URL) in your environment. " +
        "See README.md for the supported local PostgreSQL and remote Neon configurations."
    );
  }
  return url;
}

// Next.js development hot reload can evaluate this module repeatedly. Keeping
// the pool on globalThis prevents every refresh from abandoning another
// postgres.js pool (and eventually exhausting PostgreSQL's client limit).
const globalDatabase = globalThis as typeof globalThis & {
  __styleflowLocalPostgresClient?: ReturnType<typeof postgres>;
};
let localClient: ReturnType<typeof postgres> | null =
  globalDatabase.__styleflowLocalPostgresClient ?? null;

/** Host-aware check; never infer locality from credentials or database names. */
export function isLocalPostgresConnection(connectionString: string) {
  try {
    const parsed = new URL(connectionString);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return hostname === "" || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "0.0.0.0";
  } catch {
    // Treat an unparseable target as remote. This prevents local-only bootstrap
    // behavior from being enabled by a password containing the word localhost.
    return false;
  }
}

export function sql(): any {
  const connectionString = getConnectionString();
  const isLocal = isLocalPostgresConnection(connectionString);
  if (isLocal) {
    if (!localClient) {
      localClient = postgres(connectionString, { max: 10 });
      if (process.env.NODE_ENV !== "production") {
        globalDatabase.__styleflowLocalPostgresClient = localClient;
      }
    }
    return localClient;
  }
  return neon(connectionString);
}

/** Drivers differ: postgres.js accepts objects, Neon HTTP expects JSON text. */
export function dbJson(value: unknown) {
  if (value === null || value === undefined) return null;
  const connectionString = getConnectionString();
  return isLocalPostgresConnection(connectionString) ? value : JSON.stringify(value);
}

export interface BatchRow {
  id: string;
  created_at: string;
  coverage_days: number;
  status: string;
  label: string | null;
  sales_data: unknown;
  inventory_data: unknown;
  open_po_data: unknown;
  vendor_master_data: unknown;
  planning_settings: unknown;
  recommendations: unknown;
}

export interface PurchaseOrderRow {
  id: string;
  po_number: string;
  batch_id: string | null;
  vendor: string;
  warehouse: string;
  status: string;
  order_date: string | null;
  expected_delivery_date: string | null;
  currency: string;
  payment_terms: string | null;
  incoterms: string | null;
  ship_to: string | null;
  bill_to: string | null;
  notes: string | null;
  supplier_email: string | null;
  supplier_gstin: string | null;
  buyer_gstin: string | null;
  supplier_state: string | null;
  buyer_state: string | null;
  place_of_supply: string | null;
  lines: unknown;
  subtotal: string | number;
  freight: string | number;
  discount: string | number;
  tax: string | number;
  total: string | number;
  created_by: string;
  created_by_user_id: string | null;
  approved_by: string | null;
  approved_by_user_id: string | null;
  approved_at: string | null;
  issued_at: string | null;
  closed_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}
