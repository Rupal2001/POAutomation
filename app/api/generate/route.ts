import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { AuthError, requireUser } from "@/lib/auth";
import { dbJson, sql, BatchRow } from "@/lib/db";
import { NewPoCalculationError } from "@/lib/new-po-methodology";
import { generateRecommendations, type PlanningSettings } from "@/lib/po-engine";
import { loadVendorMappingsForStyles, mergeVendorMasterMappings, vendorMappingProvenance } from "@/lib/vendor-mappings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    await requireUser(req, ["admin", "planner"]);
    const body = await req.json();
    const { batchId, coverageDays, settings } = body as {
      batchId?: string;
      coverageDays?: number;
      settings?: Partial<PlanningSettings> & { asOfDate?: string };
    };

    if (!batchId) {
      return NextResponse.json({ error: "batchId is required." }, { status: 400 });
    }

    const db = sql();
    const rows = (await db`SELECT * FROM batches WHERE id = ${batchId}`) as BatchRow[];
    if (rows.length === 0) {
      return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    }
    const batch = rows[0];
    if (batch.status === "archived") {
      return NextResponse.json({ error: "Archived planning runs cannot be recalculated. Restore or recreate the source snapshot first." }, { status: 409 });
    }

    if (coverageDays !== undefined && (!Number.isInteger(coverageDays) || coverageDays < 1 || coverageDays > 365)) {
      return NextResponse.json({ error: "PO cover days must be a whole number from 1 to 365." }, { status: 400 });
    }
    const effectiveCoverageDays = coverageDays ?? batch.coverage_days;

    const priorSettings = (batch.planning_settings as Partial<PlanningSettings> & Record<string, unknown>) ?? {};
    const requestedSettings = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
    // A saved methodology snapshot is an auditable calculation contract. A
    // client may run a different cover-days scenario, but cannot switch the
    // formula, threshold, denominator, source provenance, or planning date.
    const basePlanningSettings = priorSettings.calculationMethod === "style_drr_cover_v1"
      ? {
          ...priorSettings,
          sourceBatchId: priorSettings.sourceBatchId ?? batch.id,
        }
      : {
          ...priorSettings,
          ...requestedSettings,
          sourceBatchId: priorSettings.sourceBatchId ?? batch.id,
        } as Partial<PlanningSettings> & Record<string, unknown> & { asOfDate?: string };
    const styleIds = [
      ...(Array.isArray(batch.sales_data) ? batch.sales_data : []),
      ...(Array.isArray(batch.inventory_data) ? batch.inventory_data : []),
      ...(Array.isArray(batch.open_po_data) ? batch.open_po_data : []),
      ...(Array.isArray(batch.vendor_master_data) ? batch.vendor_master_data : []),
    ].map((row: any) => String(row.styleId || row.sku || "").trim()).filter(Boolean);
    const mappings = await loadVendorMappingsForStyles(db, styleIds);
    const effectiveVendorMaster = mergeVendorMasterMappings(
      Array.isArray(batch.vendor_master_data) ? batch.vendor_master_data as any : [],
      mappings,
    );
    const planningSettings = {
      ...basePlanningSettings,
      supplierMappingMaster: vendorMappingProvenance(mappings),
    } as Partial<PlanningSettings> & Record<string, unknown> & { asOfDate?: string };
    const recommendations = generateRecommendations({
      sales: batch.sales_data as any,
      inventory: batch.inventory_data as any,
      openPos: batch.open_po_data as any,
      vendorMaster: effectiveVendorMaster,
      coverageDays: effectiveCoverageDays,
      settings: planningSettings,
      asOfDate: typeof planningSettings.asOfDate === "string" ? planningSettings.asOfDate : undefined,
    });

    let resultBatchId = batchId;
    // Generated runs are immutable audit records. Every scenario re-run gets a
    // new batch even if a caller omits the UI's historical createVersion flag.
    if (batch.status === "generated") {
      resultBatchId = randomUUID();
      const versionLabel = `${batch.label || "Planning run"} · Re-run`;
      await db`INSERT INTO batches
        (id,coverage_days,status,label,sales_data,inventory_data,open_po_data,vendor_master_data,planning_settings,recommendations)
        VALUES (${resultBatchId},${effectiveCoverageDays},'generated',${versionLabel},${dbJson(batch.sales_data)}::jsonb,${dbJson(batch.inventory_data)}::jsonb,${dbJson(batch.open_po_data)}::jsonb,${dbJson(effectiveVendorMaster)}::jsonb,${dbJson(planningSettings)}::jsonb,${dbJson(recommendations)}::jsonb)`;
    } else {
      await db`
        UPDATE batches
        SET recommendations = ${dbJson(recommendations)}::jsonb,
            planning_settings = ${dbJson(planningSettings)}::jsonb,
            vendor_master_data = ${dbJson(effectiveVendorMaster)}::jsonb,
            coverage_days = ${effectiveCoverageDays},
            status = 'generated'
        WHERE id = ${batchId}
      `;
    }

    if (mappings.length) {
      await db`INSERT INTO integration_runs (integration,direction,status,reference,details)
        VALUES ('supplier_mapping_application','internal','completed',${resultBatchId},${dbJson({
          sourceBatchId: batch.id,
          resultBatchId,
          mappingMaster: planningSettings.supplierMappingMaster,
        })}::jsonb)`;
    }

    return NextResponse.json({ batchId: resultBatchId, coverageDays: effectiveCoverageDays, recommendations, versioned: resultBatchId !== batchId });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "The generation request is not valid JSON." }, { status: 400 });
    }
    if (err instanceof NewPoCalculationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error(err);
    return NextResponse.json({ error: "Unexpected error while generating recommendations." }, { status: 500 });
  }
}
