import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { dbJson, sql } from "@/lib/db";
import { filterPlanningSnapshot, getLiveDataOptions, LIVE_CONNECTION_NAME, type LiveDataFilters, type PlanningSnapshot } from "@/lib/live-data";
import { NEW_PO_METHODOLOGY_VERSION } from "@/lib/new-po-methodology";
import { loadVendorMappingsForStyles, mergeVendorMasterMappings, normalizeVendor } from "@/lib/vendor-mappings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    await requireUser(req, ["admin", "planner"]);
    const body = await req.json() as Record<string, unknown>;
    const sourceBatchId = String(body.sourceBatchId ?? "").trim();
    if (!sourceBatchId) return NextResponse.json({ error: "Choose a connected snapshot first." }, { status: 400 });
    const coverageDays = Number(body.coverageDays ?? 45);
    const dohThreshold = Number(body.dohThreshold ?? 80);
    if (!Number.isInteger(coverageDays) || coverageDays < 1 || coverageDays > 365) {
      return NextResponse.json({ error: "PO cover days must be a whole number from 1 to 365." }, { status: 400 });
    }
    if (!Number.isFinite(dohThreshold) || dohThreshold <= 0 || dohThreshold > 730) {
      return NextResponse.json({ error: "DOH threshold must be above 0 and no more than 730 days." }, { status: 400 });
    }
    const label = String(body.label ?? "Connected Myntra PO plan").trim().slice(0, 160);
    const filters = normalizeFilters(body.filters);
    const db = sql();
    const [batch] = await db`
      SELECT * FROM batches
      WHERE id=${sourceBatchId}
        AND status <> 'archived'
        AND COALESCE(NULLIF(planning_settings->>'sourceBatchId',''), id) = id
        AND COALESCE(planning_settings->>'sourceType','') <> 'live_connection'
        AND lower(COALESCE(planning_settings->>'automationRun','false')) <> 'true'
      LIMIT 1
    `;
    if (!batch) return NextResponse.json({ error: "The root connected source snapshot no longer exists or is not an authoritative inbound snapshot." }, { status: 404 });
    const snapshot: PlanningSnapshot = {
      sales: Array.isArray(batch.sales_data) ? batch.sales_data : [],
      inventory: Array.isArray(batch.inventory_data) ? batch.inventory_data : [],
      openPos: Array.isArray(batch.open_po_data) ? batch.open_po_data : [],
      vendorMaster: Array.isArray(batch.vendor_master_data) ? batch.vendor_master_data : [],
    };
    const styleIds = [...snapshot.sales, ...snapshot.inventory, ...snapshot.openPos, ...snapshot.vendorMaster]
      .map(row => String(row.styleId || row.sku || "").trim()).filter(Boolean);
    snapshot.vendorMaster = mergeVendorMasterMappings(
      snapshot.vendorMaster,
      await loadVendorMappingsForStyles(db, styleIds),
      { includeMultipleSupplierCandidates: true },
    );
    const filtered = filterPlanningSnapshot(snapshot, filters);
    if (!filtered.sales.length) {
      return NextResponse.json({ error: "No sell-out rows match these selections. Broaden the period or product filters." }, { status: 400 });
    }
    const distinctDays = new Set(filtered.sales.map(row => row.date).filter(Boolean));
    if (!distinctDays.size) return NextResponse.json({ error: "The selected sell-out rows contain no valid selling dates." }, { status: 400 });
    const selectedStyleIds = new Set(filtered.sales.map(row => row.styleId || row.sku).filter(Boolean));
    const suppliersByStyle = new Map<string, Set<string>>();
    for (const row of filtered.vendorMaster) {
      const styleId = String(row.styleId || row.sku || "").trim();
      const vendor = normalizeVendor(row.vendor);
      if (!styleId || !selectedStyleIds.has(styleId) || !vendor) continue;
      suppliersByStyle.set(styleId, new Set([...(suppliersByStyle.get(styleId) ?? []), vendor]));
    }
    const ambiguousStyles = [...suppliersByStyle].filter(([, vendors]) => vendors.size > 1).map(([styleId]) => styleId);
    if (ambiguousStyles.length) {
      return NextResponse.json({
        error: `${ambiguousStyles.length} selected style(s) have more than one mapped supplier. Choose one supplier per style with the vendor filter before creating the plan.`,
        ambiguousStyleIds: ambiguousStyles.slice(0, 100),
      }, { status: 400 });
    }
    const options = getLiveDataOptions(filtered);
    const id = randomUUID();
    const prior = batch.planning_settings && typeof batch.planning_settings === "object" ? batch.planning_settings : {};
    const planningSettings = {
      ...prior,
      sourceType: "live_connection",
      connectionName: LIVE_CONNECTION_NAME,
      sourceBatchId,
      sourceCreatedAt: batch.created_at,
      filters,
      calculationMethod: "style_drr_cover_v1",
      methodologyVersion: NEW_PO_METHODOLOGY_VERSION,
      dohThreshold,
      uniqueOrderDays: distinctDays.size,
      // The calculation/forecast as-of date is the latest row actually present
      // after filtering, not a requested end date that may extend beyond data.
      asOfDate: options.dateMax,
      currency: "INR",
    };
    await db`
      INSERT INTO batches
        (id,coverage_days,status,label,sales_data,inventory_data,open_po_data,vendor_master_data,planning_settings)
      VALUES
        (${id},${coverageDays},'uploaded',${label || null},${dbJson(filtered.sales)}::jsonb,${dbJson(filtered.inventory)}::jsonb,
         ${dbJson(filtered.openPos)}::jsonb,${dbJson(filtered.vendorMaster)}::jsonb,${dbJson(planningSettings)}::jsonb)
    `;
    await db`
      INSERT INTO integration_runs (integration,direction,status,reference,details)
      VALUES ('styleflow_planning_warehouse','inbound','completed',${id},${dbJson({ sourceBatchId, filters, styles: selectedStyleIds.size, rows: { sales: filtered.sales.length, inventory: filtered.inventory.length, openPos: filtered.openPos.length, vendorMaster: filtered.vendorMaster.length } })}::jsonb)
    `;
    return NextResponse.json({
      batchId: id,
      sourceBatchId,
      summary: {
        styles: selectedStyleIds.size,
        uniqueOrderDays: distinctDays.size,
        salesRows: filtered.sales.length,
        inventoryRows: filtered.inventory.length,
        openPoRows: filtered.openPos.length,
        styleMasterRows: filtered.vendorMaster.length,
        dateFrom: options.dateMin,
        dateTo: options.dateMax,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof SyntaxError) return NextResponse.json({ error: "The live-plan request is not valid JSON." }, { status: 400 });
    if (error instanceof Error && /^(Start date|End date|Unknown )/.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error(error);
    return NextResponse.json({ error: "Could not create a plan from the connected snapshot." }, { status: 500 });
  }
}

function normalizeFilters(value: unknown): LiveDataFilters {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const array = (key: string) => Array.isArray(input[key])
    ? [...new Set((input[key] as unknown[]).map(item => String(item ?? "").trim()).filter(Boolean))].slice(0, 500)
    : [];
  return {
    brands: array("brands"), styleIds: array("styleIds"), vendors: array("vendors"), products: array("products"),
    categories: array("categories"), articleTypes: array("articleTypes"), warehouses: array("warehouses"),
    dateFrom: input.dateFrom ? String(input.dateFrom) : null,
    dateTo: input.dateTo ? String(input.dateTo) : null,
  };
}
