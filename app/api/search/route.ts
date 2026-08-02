import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import type { Recommendation } from "@/lib/po-engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    await requireUser(req);
    const query = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 120);
    if (query.length < 2) return NextResponse.json({ query, results: [] });
    const db = sql();
    const like = `%${query}%`;
    const [orders, batches] = await Promise.all([
      db`SELECT id,po_number,vendor,warehouse,status,total,currency
         FROM purchase_orders
         WHERE po_number ILIKE ${like} OR vendor ILIKE ${like} OR warehouse ILIKE ${like}
         ORDER BY updated_at DESC LIMIT 5`,
      db`SELECT id,label,recommendations FROM batches WHERE status='generated' ORDER BY created_at DESC LIMIT 1`,
    ]);

    const batch = batches[0];
    const needle = query.toLocaleLowerCase("en-IN");
    const recommendations = ((batch?.recommendations ?? []) as Recommendation[])
      .filter(row => [row.sku, row.styleId, row.brand, row.category, row.vendor, row.warehouse, row.productName, row.colour]
        .some(value => String(value ?? "").toLocaleLowerCase("en-IN").includes(needle)))
      .slice(0, 7);

    const results = [
      ...orders.map((order: any) => ({
        type: "purchase_order",
        id: order.id,
        title: order.po_number,
        subtitle: `${order.vendor} · ${friendlyFc(order.warehouse)}`,
        meta: humanStatus(order.status),
        href: `/purchase-orders/${order.id}`,
      })),
      ...recommendations.map(row => ({
        type: "recommendation",
        id: `${row.warehouse}-${row.sku}`,
        title: row.productName || `${row.brand || "Myntra"} · ${row.styleId || row.sku}`,
        subtitle: `${row.sku} · ${friendlyFc(row.warehouse)}`,
        meta: row.suggestedPoQty > 0 ? `${row.suggestedPoQty.toLocaleString("en-IN")} units suggested` : "No order suggested",
        href: `/results/${batch.id}?q=${encodeURIComponent(row.sku)}`,
      })),
    ];

    return NextResponse.json({ query, results });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error(error);
    return NextResponse.json({ error: "Search is temporarily unavailable." }, { status: 500 });
  }
}

function friendlyFc(value: string) {
  return ({ BLR_FC: "Bengaluru FC", DEL_FC: "Delhi FC", MUM_FC: "Mumbai FC", KOL_FC: "Kolkata FC" } as Record<string, string>)[value] || value;
}

function humanStatus(value: string) {
  return ({ pending_approval: "Waiting for approval", issued: "Sent to supplier", partially_received: "Part received" } as Record<string, string>)[value] || value.replaceAll("_", " ");
}
