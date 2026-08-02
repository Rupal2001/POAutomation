import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { dbJson, sql } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const administrator = await requireUser(request, ["admin"]);
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action ?? "");
    const note = String(body.note ?? "").trim();
    if (!['confirm_sent', 'release_retry'].includes(action)) {
      return NextResponse.json({ error: "Choose whether the provider accepted the email or confirmed it was not sent." }, { status: 400 });
    }
    if (note.length < 10 || note.length > 1_000) {
      return NextResponse.json({ error: "Add a 10–1,000 character reconciliation note with the provider evidence checked." }, { status: 400 });
    }
    const db = sql();
    const [delivery] = await db`SELECT delivery.*,po.status AS po_status,po.po_number
      FROM email_deliveries delivery
      JOIN purchase_orders po ON po.id=delivery.purchase_order_id
      WHERE delivery.id=${id} AND delivery.action='send'
      LIMIT 1`;
    if (!delivery) return NextResponse.json({ error: "Email delivery record not found." }, { status: 404 });
    const staleProcessing = delivery.status === "processing"
      && new Date(delivery.created_at).getTime() <= Date.now() - 120_000;
    if (delivery.status !== "uncertain" && !staleProcessing) {
      return NextResponse.json({ error: "This email record has already been reconciled." }, { status: 409 });
    }

    const status = action === "confirm_sent" ? "sent" : "failed";
    const resultingPoStatus = action === "confirm_sent" && delivery.po_status === "approved" ? "issued" : String(delivery.po_status);
    const updated = await db`WITH reconciled AS (
        UPDATE email_deliveries SET
          status=${status},
          error_message=${action === "confirm_sent" ? null : `Administrator verified no provider acceptance: ${note}`},
          completed_at=now()
        WHERE id=${id}
          AND (status='uncertain' OR (status='processing' AND created_at < now()-interval '2 minutes'))
        RETURNING purchase_order_id
      ), transitioned AS (
        UPDATE purchase_orders SET
          status='issued',issued_at=COALESCE(issued_at,now()),revision=revision+1,updated_at=now()
        WHERE id=${delivery.purchase_order_id} AND status='approved'
          AND ${action}='confirm_sent' AND EXISTS (SELECT 1 FROM reconciled)
        RETURNING status
      ), audited AS (
        INSERT INTO po_events (purchase_order_id,event_type,actor,note,payload)
        SELECT purchase_order_id,${action === "confirm_sent" ? "email_reconciled_sent" : "email_released_retry"},
          ${administrator.displayName},${note},${dbJson({ deliveryId: id, priorPoStatus: delivery.po_status, resultingPoStatus })}::jsonb
        FROM reconciled
      )
      SELECT purchase_order_id,(SELECT status FROM transitioned LIMIT 1) AS transitioned_status FROM reconciled`;
    if (!updated.length) return NextResponse.json({ error: "Another administrator already reconciled this record." }, { status: 409 });

    const purchaseOrderStatus = String(updated[0].transitioned_status ?? delivery.po_status);
    return NextResponse.json({
      ok: true,
      deliveryStatus: status,
      purchaseOrderStatus,
      message: action === "confirm_sent"
        ? `Provider acceptance was confirmed for ${delivery.po_number}.`
        : `The uncertain claim was released for ${delivery.po_number}; a new send may now be prepared.`,
    });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "The reconciliation request is not valid JSON." }, { status: 400 });
    console.error(error);
    return NextResponse.json({ error: "Could not reconcile the email delivery." }, { status: 500 });
  }
}
