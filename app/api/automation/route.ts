import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

type JsonRow = Record<string, unknown>;
type SourceStatus = "ready" | "attention" | "missing";

export async function GET(req: NextRequest) {
  try {
    await requireUser(req);
    const db = sql();
    const [rules, batches] = await Promise.all([
      db`SELECT * FROM automation_rules WHERE id='default'`,
      db`SELECT id,label,created_at,status,sales_data,inventory_data,open_po_data,vendor_master_data,planning_settings
        FROM batches
        WHERE status <> 'archived'
          AND COALESCE(NULLIF(planning_settings->>'sourceBatchId',''),id)=id
          AND COALESCE(planning_settings->>'sourceType','') <> 'live_connection'
          AND lower(COALESCE(planning_settings->>'automationRun','false')) <> 'true'
        ORDER BY created_at DESC
        LIMIT 1`,
    ]);
    const rule = rules[0] ?? null;
    const batch = batches[0] ?? null;
    const schedulerConnected = process.env.AUTOMATION_SCHEDULER_CONNECTED === "true";
    const environment = process.env.VERCEL ? "deployment" : "local";

    if (!batch) {
      return NextResponse.json({
        rule,
        latestBatch: null,
        sources: emptySources(),
        safety: {
          canRun: false,
          canAutoDraft: false,
          blockingReasons: ["Upload a data snapshot before running planning."],
        },
        scheduler: { connected: schedulerConnected, environment },
      });
    }

    const sales = asRows(batch.sales_data);
    const inventory = asRows(batch.inventory_data);
    const openPos = asRows(batch.open_po_data);
    const vendorMaster = asRows(batch.vendor_master_data);
    const planningSettings = asObject(batch.planning_settings);
    const latestSalesDate = latestDate(sales.map(row => row.date));
    const dataAsOf = validDate(planningSettings.asOfDate) ?? latestSalesDate;
    const ageDays = dataAsOf ? dateDifferenceDays(todayInIndia(), dataAsOf) : null;
    const sourcePositions = uniqueKeys(sales, ["sku", "warehouse"]);
    const inventoryPositions = uniqueKeys(inventory, ["sku", "warehouse"]);
    const inventoryCoverage = sourcePositions.size
      ? percentage(intersectionSize(sourcePositions, inventoryPositions), sourcePositions.size)
      : 0;
    const sourceVendors = uniqueValues([...sales, ...inventory], "vendor");
    const pricedVendors = new Set(
      vendorMaster
        .filter(row => positiveNumber(row.unitPrice))
        .map(row => String(row.vendor ?? "").trim())
        .filter(Boolean)
    );
    const priceCoverage = sourceVendors.size
      ? percentage(intersectionSize(sourceVendors, pricedVendors), sourceVendors.size)
      : 0;

    const salesFreshness = freshness(ageDays);
    const salesStatus: SourceStatus = !sales.length
      ? "missing"
      : salesFreshness.status;
    const inventoryStatus: SourceStatus = !inventory.length
      ? "missing"
      : inventoryCoverage < 90 ? "attention" : "ready";
    const openPoStatus: SourceStatus = Array.isArray(batch.open_po_data) ? "ready" : "missing";
    const vendorStatus: SourceStatus = !vendorMaster.length
      ? "missing"
      : priceCoverage < 100 ? "attention" : "ready";

    const sources = [
      {
        key: "sales",
        label: "Orders, returns & cancellations",
        status: salesStatus,
        rows: sales.length,
        detail: sales.length
          ? `${sales.length.toLocaleString("en-IN")} daily SKU rows · latest ${dateLabel(latestSalesDate)}`
          : "No sales history is available.",
        freshness: sales.length ? salesFreshness.label : "Required",
        blocking: !sales.length,
      },
      {
        key: "inventory",
        label: "Sellable inventory by fulfilment centre",
        status: inventoryStatus,
        rows: inventory.length,
        detail: inventory.length
          ? `${inventoryPositions.size.toLocaleString("en-IN")} SKU/FC positions · ${Math.round(inventoryCoverage)}% of sold positions covered`
          : "No inventory snapshot is available.",
        freshness: dataAsOf ? `Snapshot used through ${dateLabel(dataAsOf)}` : "Date unavailable",
        blocking: !inventory.length,
      },
      {
        key: "openPos",
        label: "Open POs & inbound supply",
        status: openPoStatus,
        rows: openPos.length,
        detail: openPos.length
          ? `${openPos.length.toLocaleString("en-IN")} inbound lines are included in available supply.`
          : "0 open lines is valid; planning assumes no inbound supply.",
        freshness: "Included in this snapshot",
        blocking: openPoStatus === "missing",
      },
      {
        key: "vendorMaster",
        label: "Style & supplier commercial master",
        status: vendorStatus,
        rows: vendorMaster.length,
        detail: vendorMaster.length
          ? `${sourceVendors.size.toLocaleString("en-IN")} source vendors · ${Math.round(priceCoverage)}% have INR cost coverage`
          : "Missing prices and supplier rules block automatic draft creation.",
        freshness: vendorMaster.length ? "Commercial rules included" : "Required for safe drafts",
        blocking: false,
      },
    ];

    const blockingReasons: string[] = [];
    if (!sales.length) blockingReasons.push("Sales history is missing.");
    if (!inventory.length) blockingReasons.push("The current inventory snapshot is missing.");
    if (openPoStatus === "missing") blockingReasons.push("The inbound supply source is missing.");
    if (ageDays !== null && ageDays > 7) blockingReasons.push(`The planning date is ${ageDays} days old.`);
    if (ageDays !== null && ageDays < 0) blockingReasons.push("The planning date is in the future.");

    return NextResponse.json({
      rule,
      latestBatch: {
        id: batch.id,
        label: batch.label,
        status: batch.status,
        createdAt: batch.created_at,
        dataAsOf,
        ageDays,
      },
      sources,
      safety: {
        canRun: blockingReasons.length === 0,
        canAutoDraft: blockingReasons.length === 0 && vendorMaster.length > 0 && priceCoverage === 100,
        blockingReasons,
      },
      scheduler: { connected: schedulerConnected, environment },
    });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "The automation-settings request is not valid JSON." }, { status: 400 });
    console.error(error);
    return NextResponse.json({ error: "Could not load automation settings and source health." }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    await requireUser(req, ["admin"]);
    const body = await req.json() as Record<string, unknown>;
    const cadence = String(body.cadence ?? "daily");
    const hour = Number(body.runHourIst ?? 6);
    const threshold = Number(body.approvalThreshold ?? 250000);
    const uplift = Number(body.promotionUpliftPct ?? 0);
    const eventName = body.eventName ? String(body.eventName).trim() : "";
    if (!['daily', 'weekly', 'manual'].includes(cadence)) {
      return NextResponse.json({ error: "Choose manual, daily or weekly planning." }, { status: 400 });
    }
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      return NextResponse.json({ error: "Run hour must be a whole hour from 0 to 23 IST." }, { status: 400 });
    }
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1_000_000_000) {
      return NextResponse.json({ error: "Approval threshold must be between ₹0 and ₹100 crore." }, { status: 400 });
    }
    if (!Number.isFinite(uplift) || uplift < 0 || uplift > 500) {
      return NextResponse.json({ error: "Event uplift must be between 0% and 500%." }, { status: 400 });
    }
    if (uplift > 0 && !eventName) {
      return NextResponse.json({ error: "Name the fashion event before applying an event uplift." }, { status: 400 });
    }
    if (eventName.length > 120) {
      return NextResponse.json({ error: "Event name must be 120 characters or fewer." }, { status: 400 });
    }

    const enabled = cadence !== "manual" && body.enabled === true;
    const db = sql();
    const [rule] = await db`UPDATE automation_rules
      SET enabled=${enabled}, cadence=${cadence}, run_hour_ist=${hour},
          auto_create_drafts=${body.autoCreateDrafts === true}, approval_threshold=${threshold},
          event_name=${eventName || null}, promotion_uplift_pct=${uplift}, updated_at=now()
      WHERE id='default'
      RETURNING *`;
    return NextResponse.json({ rule });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error(error);
    return NextResponse.json({ error: "Could not save automation settings." }, { status: 500 });
  }
}

function asRows(value: unknown): JsonRow[] {
  return Array.isArray(value) ? value.filter(row => row && typeof row === "object") as JsonRow[] : [];
}

function asObject(value: unknown): JsonRow {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRow : {};
}

function positiveNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function validDate(value: unknown) {
  const text = typeof value === "string" ? value : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) ? text : null;
}

function latestDate(values: unknown[]) {
  return values.map(validDate).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
}

function todayInIndia() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function dateDifferenceDays(later: string, earlier: string) {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
}

function dateLabel(value: string | null) {
  if (!value) return "date unavailable";
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(`${value}T12:00:00+05:30`));
}

function freshness(ageDays: number | null): { status: SourceStatus; label: string } {
  if (ageDays === null) return { status: "attention", label: "Planning date unavailable" };
  if (ageDays < 0) return { status: "attention", label: "Planning date is in the future" };
  if (ageDays <= 2) return { status: "ready", label: ageDays === 0 ? "Current to today" : `${ageDays} day${ageDays === 1 ? "" : "s"} old` };
  if (ageDays <= 7) return { status: "attention", label: `${ageDays} days old · review freshness` };
  return { status: "attention", label: `${ageDays} days old · stale` };
}

function uniqueKeys(rows: JsonRow[], fields: string[]) {
  return new Set(rows.map(row => fields.map(field => String(row[field] ?? "").trim()).join("::::")).filter(key => !key.startsWith("::::")));
}

function uniqueValues(rows: JsonRow[], field: string) {
  return new Set(rows.map(row => String(row[field] ?? "").trim()).filter(Boolean));
}

function intersectionSize<T>(left: Set<T>, right: Set<T>) {
  let matches = 0;
  for (const value of left) if (right.has(value)) matches += 1;
  return matches;
}

function percentage(part: number, whole: number) {
  return whole ? part / whole * 100 : 0;
}

function emptySources() {
  return [
    ["sales", "Orders, returns & cancellations", "Required for forecasting"],
    ["inventory", "Sellable inventory by fulfilment centre", "Required for replenishment"],
    ["openPos", "Open POs & inbound supply", "Required to prevent over-ordering"],
    ["vendorMaster", "Style & supplier commercial master", "Required for safe PO drafts"],
  ].map(([key, label, detail]) => ({ key, label, detail, status: "missing", rows: 0, freshness: "Not uploaded", blocking: key !== "vendorMaster" }));
}
