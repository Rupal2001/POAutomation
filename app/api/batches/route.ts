import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    await requireUser(req);
    const db = sql();
    const rows = await db`
      SELECT
        id,
        created_at,
        coverage_days,
        status,
        label,
        planning_settings->>'asOfDate' AS data_as_of,
        CASE WHEN COALESCE((planning_settings->>'automationRun')::boolean,false) THEN 'Scheduled/manual automation' ELSE 'Planner run' END AS trigger_type,
        planning_settings->>'eventName' AS event_name,
        jsonb_array_length(sales_data) AS sales_rows,
        CASE WHEN recommendations IS NULL THEN 0 ELSE jsonb_array_length(recommendations) END AS recommendation_rows,
        CASE WHEN recommendations IS NULL THEN 0
             ELSE (SELECT COUNT(DISTINCT r->>'vendor') FROM jsonb_array_elements(recommendations) r WHERE COALESCE((r->>'suggestedPoQty')::numeric, 0) > 0)
        END AS vendor_count,
        CASE WHEN recommendations IS NULL THEN 0 ELSE (SELECT COALESCE(SUM((r->>'suggestedPoQty')::numeric),0) FROM jsonb_array_elements(recommendations) r) END AS recommended_units,
        CASE WHEN recommendations IS NULL THEN 0 ELSE (SELECT COALESCE(SUM((r->>'estimatedValue')::numeric),0) FROM jsonb_array_elements(recommendations) r) END AS recommended_value,
        CASE WHEN recommendations IS NULL THEN NULL ELSE (SELECT CASE WHEN SUM(COALESCE((r->>'backtestActualUnits')::numeric,0)) > 0 THEN GREATEST(0,100-(SUM(COALESCE((r->>'backtestAbsoluteErrorUnits')::numeric,0))/SUM(COALESCE((r->>'backtestActualUnits')::numeric,0))*100)) ELSE NULL END FROM jsonb_array_elements(recommendations) r) END AS forecast_accuracy,
        CASE WHEN recommendations IS NULL THEN NULL ELSE (SELECT CASE WHEN SUM(COALESCE((r->>'backtestActualUnits')::numeric,0)) > 0 THEN SUM(COALESCE((r->>'backtestAbsoluteErrorUnits')::numeric,0))/SUM(COALESCE((r->>'backtestActualUnits')::numeric,0))*100 ELSE NULL END FROM jsonb_array_elements(recommendations) r) END AS forecast_wmape,
        CASE WHEN recommendations IS NULL THEN NULL ELSE (SELECT CASE WHEN SUM(COALESCE((r->>'backtestActualUnits')::numeric,0)) > 0 THEN SUM(COALESCE((r->>'backtestSignedErrorUnits')::numeric,0))/SUM(COALESCE((r->>'backtestActualUnits')::numeric,0))*100 ELSE NULL END FROM jsonb_array_elements(recommendations) r) END AS forecast_bias,
        CASE WHEN recommendations IS NULL THEN 0 ELSE (SELECT COALESCE(SUM((r->>'estimatedGmvAtRisk')::numeric),0) FROM jsonb_array_elements(recommendations) r WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(r->'exceptions','[]'::jsonb)) e WHERE e->>'severity'='critical')) END AS estimated_gmv_at_risk,
        CASE WHEN recommendations IS NULL THEN 0 ELSE (SELECT COUNT(*) FROM jsonb_array_elements(recommendations) r WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(r->'exceptions','[]'::jsonb)) e WHERE e->>'severity'='critical')) END AS critical_rows,
        (SELECT COUNT(*) FROM purchase_orders p WHERE p.batch_id=batches.id) AS po_count
      FROM batches
      ORDER BY created_at DESC
      LIMIT 100
    `;
    return NextResponse.json({ batches: rows });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error(err);
    return NextResponse.json({ error: "Unexpected error while listing batches." }, { status: 500 });
  }
}
