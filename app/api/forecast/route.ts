import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import type { Recommendation } from "@/lib/po-engine";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await requireUser(req);
    const [batch] = await sql()`SELECT id,label,created_at,recommendations,planning_settings FROM batches WHERE status='generated' ORDER BY created_at DESC LIMIT 1`;
    if (!batch) return NextResponse.json({ batch: null, rows: [], summary: null });
    const rows = (batch.recommendations ?? []) as (Recommendation & Record<string, any>)[];
    const evaluated = rows.filter(row => row.backtestActualUnits > 0);
    const actual = sum(evaluated, row => row.backtestActualUnits);
    const absoluteError = sum(evaluated, row => row.backtestAbsoluteErrorUnits);
    const signedError = sum(evaluated, row => row.backtestSignedErrorUnits);
    const wmape = actual ? absoluteError / actual * 100 : null;
    const bias = actual ? signedError / actual * 100 : null;
    const modelMap = new Map<string, number>();
    const categoryMap = new Map<string, { category: string; actual: number; absolute: number; signed: number; rows: number }>();
    const fcMap = new Map<string, { warehouse: string; actual: number; absolute: number; signed: number; rows: number }>();

    for (const row of rows) {
      const model = row.forecastModelLabel || row.forecastMethod;
      modelMap.set(model, (modelMap.get(model) ?? 0) + 1);
      const category = row.category || "Unclassified";
      const categoryItem = categoryMap.get(category) ?? { category, actual: 0, absolute: 0, signed: 0, rows: 0 };
      categoryItem.actual += row.backtestActualUnits || 0; categoryItem.absolute += row.backtestAbsoluteErrorUnits || 0; categoryItem.signed += row.backtestSignedErrorUnits || 0; categoryItem.rows++; categoryMap.set(category, categoryItem);
      const fcItem = fcMap.get(row.warehouse) ?? { warehouse: row.warehouse, actual: 0, absolute: 0, signed: 0, rows: 0 };
      fcItem.actual += row.backtestActualUnits || 0; fcItem.absolute += row.backtestAbsoluteErrorUnits || 0; fcItem.signed += row.backtestSignedErrorUnits || 0; fcItem.rows++; fcMap.set(row.warehouse, fcItem);
    }

    const safe = rows.filter(row => row.suggestedPoQty > 0 && row.unitPrice !== null && row.forecastQuality === "high" && !row.exceptions.some(exception => exception.severity === "critical" || ["LOW_FORECAST_ACCURACY", "MISSING_PRICE", "HIGH_RETURNS"].includes(exception.code)));
    const scoreBand = (minimum: number, maximum = Infinity) => rows.filter(row => row.forecastAccuracy !== null && row.forecastAccuracy >= minimum && row.forecastAccuracy < maximum).length;
    const decorate = (item: { actual: number; absolute: number; signed: number }) => ({ ...item, wmape: item.actual ? item.absolute / item.actual * 100 : null, accuracy: item.actual ? Math.max(0, 100 - item.absolute / item.actual * 100) : null, bias: item.actual ? item.signed / item.actual * 100 : null });

    return NextResponse.json({
      batch: { id: batch.id, label: batch.label, createdAt: batch.created_at, dataAsOf: batch.planning_settings?.asOfDate ?? null, settings: batch.planning_settings },
      rows,
      summary: {
        accuracy: wmape === null ? null : Math.max(0, 100 - wmape),
        wmape,
        bias,
        evaluatedRows: evaluated.length,
        readyForAutomation: safe.length,
        dataGradeA: rows.filter(row => row.forecastQuality === "high").length,
        dataGradeB: rows.filter(row => row.forecastQuality === "medium").length,
        dataGradeC: rows.filter(row => row.forecastQuality === "low").length,
        stockoutCorrectedDays: sum(rows, row => row.stockoutDaysInHistory || 0),
        dataLatencyDays: Math.max(0, ...rows.map(row => row.dataLatencyDays || 0)),
        promotionAdjustedDays: sum(rows, row => row.promotionAdjustedDays || 0),
        models: [...modelMap.entries()].map(([model, count]) => ({ model, count, share: rows.length ? count / rows.length * 100 : 0 })).sort((a, b) => b.count - a.count),
        bands: [{ label: "80% and above", count: scoreBand(80) }, { label: "70–79%", count: scoreBand(70,80) }, { label: "Below 70%", count: scoreBand(0,70) }],
        categories: [...categoryMap.values()].map(decorate).sort((a, b) => (a.wmape ?? Infinity) - (b.wmape ?? Infinity)),
        fulfilmentCentres: [...fcMap.values()].map(decorate).sort((a, b) => (a.wmape ?? Infinity) - (b.wmape ?? Infinity)),
      },
    });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error(error);
    return NextResponse.json({ error: "Could not load forecast diagnostics." }, { status: 500 });
  }
}

function sum<T>(rows: T[], value: (row: T) => number) { return rows.reduce((total, row) => total + Number(value(row) || 0), 0); }
