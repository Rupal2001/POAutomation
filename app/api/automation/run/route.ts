import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { createDraftPurchaseOrders, effectiveVendorRule, executionQuantityProblem } from "@/lib/create-pos";
import { BatchRow, dbJson, sql } from "@/lib/db";
import { NewPoCalculationError } from "@/lib/new-po-methodology";
import { generateRecommendations } from "@/lib/po-engine";
import { loadVendorMappingsForStyles, mergeVendorMasterMappings, vendorMappingProvenance } from "@/lib/vendor-mappings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const db = sql();
  let runBatchId: string | null = null;
  let runClaimed = false;
  try {
    const user = await requireUser(req, ["admin", "planner"]);
    const [configuredRule] = await db`SELECT * FROM automation_rules WHERE id='default'`;
    if (!configuredRule) return NextResponse.json({ error: "Automation controls are not initialised. Run npm run db:init first." }, { status: 503 });

    // Always restart from the latest authoritative inbound root. Derived live
    // plans and earlier automation outputs must never become recursive inputs.
    const batches = await db`SELECT * FROM batches
      WHERE status <> 'archived'
        AND COALESCE(NULLIF(planning_settings->>'sourceBatchId',''),id)=id
        AND COALESCE(planning_settings->>'sourceType','') <> 'live_connection'
        AND lower(COALESCE(planning_settings->>'automationRun','false')) <> 'true'
      ORDER BY created_at DESC LIMIT 1` as BatchRow[];
    if (!batches.length) return NextResponse.json({ error: "Upload source data before running automation." }, { status: 409 });
    const batch = batches[0];
    const sales = Array.isArray(batch.sales_data) ? batch.sales_data as Record<string, unknown>[] : [];
    const inventory = Array.isArray(batch.inventory_data) ? batch.inventory_data as Record<string, unknown>[] : [];
    const openPos = Array.isArray(batch.open_po_data) ? batch.open_po_data : null;
    if (!sales.length || !inventory.length || !openPos) {
      const missing = [!sales.length && "sales history", !inventory.length && "current inventory", !openPos && "open PO / inbound data"].filter(Boolean).join(", ");
      return NextResponse.json({ error: `Planning cannot run because ${missing} is missing.` }, { status: 409 });
    }
    const existingSettings = (batch.planning_settings as Record<string, unknown>) ?? {};
    const latestSalesDate = sales.map(row => typeof row.date === "string" ? row.date : "").filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort().at(-1);
    const asOfDate = typeof existingSettings.asOfDate === "string" ? existingSettings.asOfDate : latestSalesDate;
    if (asOfDate) {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
      const ageDays = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${asOfDate}T00:00:00Z`)) / 86_400_000);
      if (!Number.isFinite(ageDays)) return NextResponse.json({ error: "The source snapshot has an invalid planning date." }, { status: 409 });
      if (ageDays > 7) return NextResponse.json({ error: `This snapshot is ${ageDays} days old. Upload current data before running planning.` }, { status: 409 });
      if (ageDays < 0) return NextResponse.json({ error: "The snapshot planning date is in the future. Correct the source dates before running planning." }, { status: 409 });
    }

    // This database claim serializes manual/scheduled invocations. A stale
    // claim becomes recoverable after 30 minutes if a worker was interrupted.
    const [rule] = await db`UPDATE automation_rules SET
        last_run_at=now(),last_run_status='running',updated_at=now()
      WHERE id='default'
        AND (last_run_status IS DISTINCT FROM 'running' OR last_run_at < now()-interval '30 minutes')
      RETURNING *`;
    if (!rule) return NextResponse.json({ error: "A planning automation run is already in progress." }, { status: 409 });
    runClaimed = true;

    const styleIds = [...sales, ...inventory, ...(openPos as Record<string, unknown>[]), ...(Array.isArray(batch.vendor_master_data) ? batch.vendor_master_data as Record<string, unknown>[] : [])]
      .map(row => String(row.styleId || row.sku || "").trim()).filter(Boolean);
    const mappings = await loadVendorMappingsForStyles(db, styleIds);
    const vendorMaster = mergeVendorMasterMappings(
      Array.isArray(batch.vendor_master_data) ? batch.vendor_master_data as any : [],
      mappings,
    );
    const planningSettings: Record<string, unknown> = {
      ...existingSettings,
      forecastMethod: "auto",
      plannedPromotionUpliftPct: Number(rule.promotion_uplift_pct || 0),
      sourceBatchId: batch.id,
      automationRun: true,
      supplierMappingMaster: vendorMappingProvenance(mappings),
    };
    const recommendations = generateRecommendations({
      sales: batch.sales_data as any,
      inventory: batch.inventory_data as any,
      openPos: batch.open_po_data as any,
      vendorMaster,
      coverageDays: batch.coverage_days,
      settings: planningSettings as any,
      asOfDate,
    });
    runBatchId = randomUUID();
    const runLabel = `${rule.event_name || "Scheduled replenishment"} · ${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}`;
    await db`INSERT INTO batches (id,coverage_days,status,label,sales_data,inventory_data,open_po_data,vendor_master_data,planning_settings,recommendations)
      VALUES (${runBatchId},${batch.coverage_days},'processing',${runLabel},${dbJson(batch.sales_data)}::jsonb,${dbJson(batch.inventory_data)}::jsonb,${dbJson(batch.open_po_data)}::jsonb,${dbJson(vendorMaster)}::jsonb,${dbJson(planningSettings)}::jsonb,${dbJson(recommendations)}::jsonb)`;

    let created: { id: string; poNumber: string; total: number }[] = [];
    let draftMessage = "Draft creation disabled.";
    if (rule.auto_create_drafts) {
      const activeOrders = await db`SELECT vendor,warehouse,lines FROM purchase_orders WHERE status NOT IN ('cancelled','closed','received')`;
      const activeKeys = new Set<string>();
      for (const order of activeOrders) for (const line of (order.lines ?? [])) activeKeys.add(`${order.vendor}::::${order.warehouse}::::${line.sku}`);
      let constrainedLines = 0;
      const selections = recommendations.filter(recommendation => {
        const baseSafe = recommendation.suggestedPoQty > 0
          && recommendation.forecastQuality === "high"
          && recommendation.unitPrice !== null
          && !activeKeys.has(`${recommendation.vendor}::::${recommendation.warehouse}::::${recommendation.sku}`)
          && !recommendation.exceptions.some(exception => exception.severity === "critical" || ["LOW_FORECAST_ACCURACY", "MISSING_PRICE", "HIGH_RETURNS"].includes(exception.code));
        if (!baseSafe) return false;
        if (executionQuantityProblem(recommendation.suggestedPoQty, effectiveVendorRule(recommendation, vendorMaster))) {
          constrainedLines += 1;
          return false;
        }
        return true;
      }).map(recommendation => ({ vendor: recommendation.vendor, sku: recommendation.sku, warehouse: recommendation.warehouse }));
      if (selections.length) {
        created = await createDraftPurchaseOrders(db, { ...batch, id: runBatchId, recommendations, vendor_master_data: vendorMaster } as BatchRow, selections, {
          displayName: `${user.displayName} · planning automation`,
          userId: user.id,
        });
      }
      draftMessage = created.length
        ? `${created.length} safe draft PO(s) created.${constrainedLines ? ` ${constrainedLines} line(s) need a planner to adjust MOQ or pack size.` : ""}`
        : constrainedLines
          ? `${constrainedLines} otherwise-safe line(s) need a planner to adjust MOQ or pack size; no automatic draft was created.`
          : "No new safe recommendations qualified; existing live POs were not duplicated.";
    }

    await db`UPDATE batches SET status='generated' WHERE id=${runBatchId} AND status='processing'`;
    await db`UPDATE automation_rules SET last_run_at=now(),last_run_status='success',updated_at=now() WHERE id='default' AND last_run_status='running'`;
    await db`INSERT INTO integration_runs (integration,direction,status,reference,details)
      VALUES ('planning_automation','internal','success',${runBatchId},${dbJson({ recommendations: recommendations.length, drafts: created.length, sourceBatchId: batch.id, mappingMaster: planningSettings.supplierMappingMaster })}::jsonb)`;
    return NextResponse.json({ ok: true, batchId: runBatchId, recommendations: recommendations.length, created, message: draftMessage });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error(error);
    if (runBatchId) await db`UPDATE batches SET status='failed' WHERE id=${runBatchId} AND status='processing'`.catch(() => undefined);
    if (runClaimed) await db`UPDATE automation_rules SET last_run_at=now(),last_run_status='failed',updated_at=now() WHERE id='default' AND last_run_status='running'`.catch(() => undefined);
    await db`INSERT INTO integration_runs (integration,direction,status,reference,details)
      VALUES ('planning_automation','internal','failed',${runBatchId},${dbJson({ runBatchId, errorType: error instanceof Error ? error.name : "UnknownError" })}::jsonb)`.catch(() => undefined);
    if (error instanceof NewPoCalculationError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "Automation could not complete safely. Review the source and supplier controls, then retry." }, { status: 500 });
  }
}
