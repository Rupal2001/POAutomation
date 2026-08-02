import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import type { Recommendation } from "@/lib/po-engine";
import type { VendorMasterRow } from "@/lib/po-engine";
import { hasApplicableSupplierMaster, isStyleCoverRecommendation, purchaseOrderBlockReason } from "@/lib/recommendation-review";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    await requireUser(req);
    const db = sql();
    const [summaryRows, statusRows, recent, suppliers, latestRows, automationRows] = await Promise.all([
      db`SELECT
        (SELECT COUNT(*) FROM batches WHERE status <> 'archived') AS planning_runs,
        (SELECT COUNT(*) FROM purchase_orders WHERE status NOT IN ('closed','cancelled','received')) AS open_orders,
        (SELECT COALESCE(SUM(total),0) FROM purchase_orders WHERE status IN ('draft','pending_approval')) AS awaiting_value,
        (SELECT COUNT(*) FROM purchase_orders WHERE status IN ('draft','pending_approval')) AS awaiting_decision,
        (SELECT COALESCE(SUM(total),0) FROM purchase_orders WHERE status IN ('approved','issued','partially_received')) AS committed_value,
        (SELECT COUNT(*) FROM purchase_orders WHERE status IN ('approved','issued','partially_received')) AS committed_orders,
        (SELECT COUNT(*) FROM purchase_orders WHERE status = 'pending_approval') AS awaiting_approval,
        (SELECT COUNT(*) FROM purchase_orders WHERE status IN ('issued','partially_received') AND expected_delivery_date < CURRENT_DATE) AS overdue_orders,
        (SELECT COALESCE(SUM(total),0) FROM purchase_orders WHERE status IN ('issued','partially_received') AND expected_delivery_date < CURRENT_DATE) AS overdue_value`,
      db`SELECT status,COUNT(*)::int AS count,COALESCE(SUM(total),0) AS value FROM purchase_orders GROUP BY status ORDER BY status`,
      db`SELECT id,po_number,vendor,warehouse,status,expected_delivery_date,total,currency,created_at,lines FROM purchase_orders ORDER BY updated_at DESC LIMIT 8`,
      db`SELECT vendor,COUNT(*)::int AS order_count,COALESCE(SUM(total),0) AS spend,
        COUNT(*) FILTER (WHERE expected_delivery_date < CURRENT_DATE AND status IN ('issued','partially_received'))::int AS late_orders
        FROM purchase_orders GROUP BY vendor ORDER BY spend DESC LIMIT 8`,
      db`SELECT id,label,created_at,coverage_days,recommendations,planning_settings,sales_data,inventory_data,open_po_data,vendor_master_data
         FROM batches WHERE status='generated' ORDER BY created_at DESC LIMIT 2`,
      db`SELECT * FROM automation_rules WHERE id='default'`,
    ]);

    const latest = latestRows[0];
    const previous = latestRows[1];
    const planning = latest ? buildPlanning(latest, previous) : null;

    return NextResponse.json({
      summary: summaryRows[0],
      byStatus: statusRows,
      recentOrders: recent,
      suppliers,
      automation: automationRows[0],
      planning,
    });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error(error);
    return NextResponse.json({ error: "Could not load the inventory overview." }, { status: 500 });
  }
}

function buildPlanning(latest: any, previous?: any) {
  const rows = (latest.recommendations ?? []) as (Recommendation & Record<string, any>)[];
  const previousRows = (previous?.recommendations ?? []) as (Recommendation & Record<string, any>)[];
  const coverageDays = Number(latest.coverage_days || 28);
  const settings = latest.planning_settings ?? {};
  const sales = latest.sales_data ?? [];
  const inventory = latest.inventory_data ?? [];
  const openPos = latest.open_po_data ?? [];
  const vendorMaster = (latest.vendor_master_data ?? []) as VendorMasterRow[];
  const dataAsOf = settings.asOfDate || sales.map((row: any) => row.date).filter(Boolean).sort().at(-1) || latest.created_at;

  const proposedUnits = sum(rows, row => row.suggestedPoQty);
  const proposedValue = sum(rows, row => row.estimatedValue || 0);
  const previousValue = sum(previousRows, row => row.estimatedValue || 0);
  const previousRisk = previousRows.filter(isCritical).length;
  const criticalRows = rows.filter(isCritical);
  const readyRows = rows.filter(row => operationallyReady(row, vendorMaster));
  const estimatedGmvAtRisk = sum(criticalRows, row => Number(row.estimatedGmvAtRisk ?? estimateGmvRisk(row, dataAsOf)));
  const inventoryInvestment = sum(rows, row => Number(row.currentInventoryInvestment ?? (Math.max(0, Number(row.currentInventory || 0) - Number(row.reservedQty || 0)) * Number(row.unitPrice || 0))));
  const excessInvestment = sum(rows, row => Number(row.excessInventoryValue ?? 0));

  const weighted = weightedForecastMetrics(rows);
  const categoryMap = new Map<string, any>();
  const fcMap = new Map<string, any>();
  const supplierMap = new Map<string, any>();
  for (const row of rows) {
    const category = row.category || "Unclassified";
    const categoryItem = categoryMap.get(category) ?? { category, styles: new Set<string>(), lines: 0, units: 0, value: 0, risk: 0, gmvRisk: 0, accuracies: [] as { value: number; weight: number }[] };
    categoryItem.styles.add(row.styleId || row.sku); categoryItem.lines++; categoryItem.units += row.suggestedPoQty; categoryItem.value += row.estimatedValue || 0;
    if (isCritical(row)) { categoryItem.risk++; categoryItem.gmvRisk += Number(row.estimatedGmvAtRisk ?? estimateGmvRisk(row, dataAsOf)); }
    if (typeof row.forecastAccuracy === "number") categoryItem.accuracies.push({ value: row.forecastAccuracy, weight: Math.max(1, row.dailyRunRate || 0) });
    categoryMap.set(category, categoryItem);

    const fcItem = fcMap.get(row.warehouse) ?? { warehouse: row.warehouse, lines: 0, units: 0, value: 0, risk: 0 };
    fcItem.lines++; fcItem.units += row.suggestedPoQty; fcItem.value += row.estimatedValue || 0; if (isCritical(row)) fcItem.risk++; fcMap.set(row.warehouse, fcItem);

    const supplierItem = supplierMap.get(row.vendor) ?? { vendor: row.vendor, lines: 0, units: 0, value: 0, risk: 0 };
    supplierItem.lines++; supplierItem.units += row.suggestedPoQty; supplierItem.value += row.estimatedValue || 0; if (isCritical(row)) supplierItem.risk++; supplierMap.set(row.vendor, supplierItem);
  }

  const categories = [...categoryMap.values()].map(item => ({
    ...item,
    styles: item.styles.size,
    accuracy: weightedMean(item.accuracies),
    spendShare: proposedValue ? item.value / proposedValue * 100 : 0,
  })).sort((a, b) => b.value - a.value);

  const exceptionCounts = new Map<string, { code: string; count: number; impact: number; earliestDate: string | null }>();
  for (const row of rows) for (const exception of row.exceptions ?? []) {
    const item = exceptionCounts.get(exception.code) ?? { code: exception.code, count: 0, impact: 0, earliestDate: null };
    item.count++; item.impact += exception.code === "STOCKOUT_BEFORE_RECEIPT" ? Number(row.estimatedGmvAtRisk ?? estimateGmvRisk(row, dataAsOf)) : Number(row.estimatedValue || 0);
    if (row.projectedStockoutDate && (!item.earliestDate || row.projectedStockoutDate < item.earliestDate)) item.earliestDate = row.projectedStockoutDate;
    exceptionCounts.set(exception.code, item);
  }

  const items = rows.map(row => ({
    vendor: row.vendor, sku: row.sku, warehouse: row.warehouse, brand: row.brand, category: row.category,
    styleId: row.styleId, productName: row.productName, colour: row.colour, size: row.size, lifecycleStage: row.lifecycleStage,
    suggestedPoQty: row.suggestedPoQty, estimatedValue: row.estimatedValue, unitPrice: row.unitPrice,
    currentInventory: row.currentInventory, reservedQty: row.reservedQty, backorderQty: row.backorderQty,
    openPoQty: row.openPoQty, daysOnHand: row.daysOnHand, dailyRunRate: row.dailyRunRate,
    forecastAccuracy: row.forecastAccuracy, forecastQuality: row.forecastQuality,
    projectedStockoutDate: row.projectedStockoutDate, expectedDeliveryDate: row.expectedDeliveryDate,
    estimatedGmvAtRisk: row.estimatedGmvAtRisk ?? estimateGmvRisk(row, dataAsOf), exceptions: row.exceptions,
    poReady: operationallyReady(row, vendorMaster),
  }));

  return {
    id: latest.id,
    label: latest.label,
    createdAt: latest.created_at,
    dataAsOf,
    coverageDays,
    proposedUnits,
    proposedValue,
    totalLines: rows.length,
    totalStyles: new Set(rows.map(row => row.styleId || row.sku)).size,
    atRiskLines: criticalRows.length,
    atRiskStyles: new Set(criticalRows.map(row => row.styleId || row.sku)).size,
    readyLines: readyRows.length,
    readyValue: sum(readyRows, row => row.estimatedValue || 0),
    estimatedGmvAtRisk,
    inventoryInvestment,
    excessInvestment,
    forecastAccuracy: weighted.accuracy,
    forecastWmape: weighted.wmape,
    forecastBias: weighted.bias,
    dataQuality: { salesRows: sales.length, inventoryRows: inventory.length, openPoRows: openPos.length, supplierRows: vendorMaster.length, priceCoverage: rows.length ? rows.filter(row => row.unitPrice !== null).length / rows.length * 100 : 0 },
    change: previous ? { value: proposedValue - previousValue, risk: criticalRows.length - previousRisk, previousId: previous.id } : null,
    categories,
    fulfilmentCentres: [...fcMap.values()].sort((a, b) => b.risk - a.risk || b.value - a.value),
    planningSuppliers: [...supplierMap.values()].sort((a, b) => b.risk - a.risk || b.value - a.value),
    exceptions: [...exceptionCounts.values()].sort((a, b) => b.impact - a.impact || b.count - a.count),
    items,
  };
}

function weightedForecastMetrics(rows: (Recommendation & Record<string, any>)[]) {
  const withDiagnostics = rows.filter(row => Number.isFinite(Number(row.backtestActualUnits)) && Number(row.backtestActualUnits) > 0 && Number.isFinite(Number(row.backtestAbsoluteErrorUnits)));
  if (withDiagnostics.length) {
    const actual = sum(withDiagnostics, row => Number(row.backtestActualUnits));
    const absolute = sum(withDiagnostics, row => Number(row.backtestAbsoluteErrorUnits));
    const signed = sum(withDiagnostics, row => Number(row.backtestSignedErrorUnits || 0));
    const wmape = actual ? absolute / actual * 100 : null;
    return { wmape, accuracy: wmape === null ? null : Math.max(0, 100 - wmape), bias: actual ? signed / actual * 100 : null };
  }
  const evaluated = rows.filter(row => typeof row.forecastWmape === "number");
  const wmape = weightedMean(evaluated.map(row => ({ value: row.forecastWmape!, weight: Math.max(1, row.dailyRunRate || 0) })));
  const bias = weightedMean(evaluated.filter(row => typeof row.forecastBias === "number").map(row => ({ value: row.forecastBias!, weight: Math.max(1, row.dailyRunRate || 0) })));
  return { wmape, accuracy: wmape === null ? null : Math.max(0, 100 - wmape), bias };
}

function estimateGmvRisk(row: Recommendation & Record<string, any>, asOfDate: string) {
  if (!row.projectedStockoutDate || !row.expectedDeliveryDate || !row.sellingPriceInr || !row.dailyRunRate) return 0;
  const stockout = Date.parse(`${row.projectedStockoutDate}T00:00:00Z`);
  const receipt = Date.parse(`${row.expectedDeliveryDate}T00:00:00Z`);
  const asOf = Date.parse(`${asOfDate}T00:00:00Z`);
  if (![stockout, receipt, asOf].every(Number.isFinite) || receipt <= stockout) return 0;
  return Math.max(0, Math.ceil((receipt - Math.max(stockout, asOf)) / 86_400_000)) * Number(row.dailyRunRate) * Number(row.sellingPriceInr);
}

function isCritical(row: Recommendation) { return row.exceptions?.some(exception => exception.severity === "critical") ?? false; }
function operationallyReady(row: Recommendation, vendorMaster: VendorMasterRow[]) {
  const baseReady = row.suggestedPoQty > 0
    && !purchaseOrderBlockReason(row)
    && hasApplicableSupplierMaster(row, vendorMaster)
    && !isCritical(row);
  if (!baseReady) return false;
  // Forecast confidence controls automation only for the legacy forecast
  // engine. Exact-methodology rows are operationally ready when their formula
  // gate and master-data controls pass; forecast remains supporting evidence.
  return isStyleCoverRecommendation(row)
    || (row.forecastQuality !== "low" && (row.forecastAccuracy === null || row.forecastAccuracy >= 70));
}
function sum<T>(rows: T[], value: (row: T) => number) { return rows.reduce((total, row) => total + Number(value(row) || 0), 0); }
function weightedMean(values: { value: number; weight: number }[]) { const weight = sum(values, item => item.weight); return weight ? sum(values, item => item.value * item.weight) / weight : null; }
