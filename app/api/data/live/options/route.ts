import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { getLiveDataOptions, LIVE_CONNECTION_NAME, type PlanningSnapshot } from "@/lib/live-data";
import { loadVendorMappingsForStyles, mergeVendorMasterMappings } from "@/lib/vendor-mappings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    await requireUser(req);
    const db = sql();
    const [batch] = await db`
      SELECT id,label,created_at,status,sales_data,inventory_data,open_po_data,vendor_master_data,planning_settings
      FROM batches
      WHERE status <> 'archived'
        AND COALESCE(NULLIF(planning_settings->>'sourceBatchId',''), id) = id
        AND COALESCE(planning_settings->>'sourceType','') <> 'live_connection'
        AND lower(COALESCE(planning_settings->>'automationRun','false')) <> 'true'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (!batch) {
      return NextResponse.json({
        connection: { name: LIVE_CONNECTION_NAME, status: "empty" },
        error: "Upload and calculate one source snapshot before using the live planning connection.",
      }, { status: 404 });
    }
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
    const options = getLiveDataOptions(snapshot);
    const settings = batch.planning_settings && typeof batch.planning_settings === "object" ? batch.planning_settings : {};
    return NextResponse.json({
      connection: {
        name: LIVE_CONNECTION_NAME,
        type: "PostgreSQL snapshot",
        status: "ready",
        sourceBatchId: batch.id,
        sourceLabel: batch.label,
        sourceCreatedAt: batch.created_at,
        dataAsOf: settings.asOfDate ?? options.dateMax,
      },
      counts: {
        salesRows: snapshot.sales.length,
        inventoryRows: snapshot.inventory.length,
        openPoRows: snapshot.openPos.length,
        styleMasterRows: snapshot.vendorMaster.length,
      },
      options,
      semantics: {
        date: "The selected period filters sell-out history and defines the style universe.",
        vendor: "The selected supplier nominates commercial master rows; all pending supply for selected styles remains included to prevent double-buying.",
        warehouse: options.warehouses.length
          ? "Warehouse selections scope demand, inventory and open-PO positions because this source has fulfilment-centre grain in sell-out."
          : "Warehouse filtering is unavailable because sell-out is network-level. All inventory and pending supply is retained so partial supply cannot create an inflated order.",
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(error);
    return NextResponse.json({ error: "Could not inspect the connected planning snapshot." }, { status: 500 });
  }
}
