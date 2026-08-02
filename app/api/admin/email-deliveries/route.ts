import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requireUser(request, ["admin"]);
    const rows = await sql()`SELECT
        delivery.id,
        delivery.purchase_order_id,
        delivery.provider,
        delivery.status,
        delivery.created_by,
        delivery.created_at,
        delivery.error_message,
        po.po_number,
        po.vendor,
        po.status AS purchase_order_status
      FROM email_deliveries delivery
      JOIN purchase_orders po ON po.id=delivery.purchase_order_id
      WHERE delivery.action='send'
        AND (delivery.status='uncertain' OR (delivery.status='processing' AND delivery.created_at < now()-interval '2 minutes'))
      ORDER BY delivery.created_at ASC
      LIMIT 100`;
    return NextResponse.json({
      deliveries: rows.map((row: Record<string, unknown>) => ({
        id: String(row.id),
        purchaseOrderId: String(row.purchase_order_id),
        poNumber: String(row.po_number),
        vendor: String(row.vendor),
        provider: String(row.provider),
        status: String(row.status),
        purchaseOrderStatus: String(row.purchase_order_status),
        createdBy: String(row.created_by),
        createdAt: row.created_at,
        problem: row.error_message
          ? String(row.error_message)
          : row.status === "processing"
            ? "The delivery worker did not commit a result within two minutes."
            : "The provider response could not be confirmed.",
      })),
    });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error(error);
    return NextResponse.json({ error: "Could not load email reconciliation items." }, { status: 500 });
  }
}
