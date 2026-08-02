import { NextRequest, NextResponse } from "next/server";
import { dbJson, sql, PurchaseOrderRow } from "@/lib/db";
import { normalizePurchaseOrderLines, PurchaseOrderLine, purchaseOrderLineValidationError } from "@/lib/purchase-orders";
import { AuthError, requireUser } from "@/lib/auth";
import { canReceivePurchaseOrder } from "@/lib/po-access";
import { canonicalIsoCalendarDate, isIsoCalendarDate, todayInIndia } from "@/lib/po-readiness";
import { STALE_PO_REVISION, validateExpectedPoRevision } from "@/lib/po-revision";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const user = await requireUser(req);
    const body = await req.json() as {
      receipts?: { lineId: string; quantity: number }[];
      note?: string;
      receiptDate?: string;
      grn?: string;
      invoice?: string;
      expectedRevision?: unknown;
    };
    if (!canReceivePurchaseOrder(user.role)) {
      return NextResponse.json({ error: "Receiver access is required to record a delivery." }, { status: 403 });
    }
    const revisionValidation = validateExpectedPoRevision(body.expectedRevision);
    if (!revisionValidation.ok) {
      return NextResponse.json({ error: revisionValidation.message, code: revisionValidation.code }, { status: revisionValidation.status });
    }
    const expectedRevision = revisionValidation.value;
    if (!Array.isArray(body.receipts) || !body.receipts.length || body.receipts.length > 2_000) {
      return NextResponse.json({ error: "Enter between 1 and 2,000 received line quantities." }, { status: 400 });
    }
    const duplicateLine = body.receipts.find((receipt, index) => body.receipts!.findIndex(other => other.lineId === receipt.lineId) !== index);
    if (duplicateLine) return NextResponse.json({ error: "Each PO line can appear only once in a receipt." }, { status: 400 });
    const today = todayInIndia();
    const receiptDate = String(body.receiptDate || today).trim();
    if (!isIsoCalendarDate(receiptDate) || receiptDate > today) {
      return NextResponse.json({ error: "Receipt date must be a valid date no later than today." }, { status: 400 });
    }
    const note = String(body.note ?? "").trim();
    const grn = String(body.grn ?? "").trim();
    const invoice = String(body.invoice ?? "").trim();
    if (note.length > 4_000 || grn.length > 200 || invoice.length > 200) {
      return NextResponse.json({ error: "Receipt note, GRN or invoice reference is too long." }, { status: 400 });
    }
    const db = sql();
    const orders = await db`SELECT * FROM purchase_orders WHERE id=${id}` as PurchaseOrderRow[];
    if (!orders.length) return NextResponse.json({ error: "Purchase order not found." }, { status: 404 });
    const order = orders[0];
    if (order.revision !== expectedRevision) {
      return staleRevisionResponse("This PO changed after you opened the receipt form. Reload it before recording delivery.");
    }
    if (!['issued','partially_received'].includes(order.status)) return NextResponse.json({ error: "Only issued orders can be received." }, { status: 409 });
    const orderDate = canonicalIsoCalendarDate(order.order_date);
    if (orderDate && receiptDate < orderDate) {
      return NextResponse.json({ error: "Receipt date cannot be before the PO date." }, { status: 400 });
    }
    const lines = normalizePurchaseOrderLines(structuredClone(order.lines)) as PurchaseOrderLine[];
    const lineProblem = purchaseOrderLineValidationError(lines);
    if (lineProblem) return NextResponse.json({ error: `This PO has invalid line data and cannot be received: ${lineProblem}` }, { status: 409 });
    for (const receipt of body.receipts) {
      const line = lines.find((l) => l.lineId === receipt.lineId);
      if (!line || !Number.isSafeInteger(Number(receipt.quantity)) || Number(receipt.quantity) <= 0) {
        return NextResponse.json({ error: "Every received quantity must be a positive whole number for a valid PO line." }, { status: 400 });
      }
      const remaining = line.quantity - (line.receivedQty || 0);
      if (Number(receipt.quantity) > remaining) return NextResponse.json({ error: `You entered ${receipt.quantity} units for ${line.sku}, but only ${remaining} remain open. Correct the quantity before saving.` }, { status: 400 });
      line.receivedQty = (line.receivedQty || 0) + Number(receipt.quantity);
    }
    const complete = lines.every((l) => l.receivedQty >= l.quantity);
    const status = complete ? 'received' : 'partially_received';
    const receiptPayload = {
      receipts: body.receipts,
      status,
      receiptDate,
      grn: grn || null,
      invoice: invoice || null,
    };
    const updated = await db`WITH changed AS (
        UPDATE purchase_orders SET
          lines=${dbJson(lines)}::jsonb,status=${status},revision=revision+1,updated_at=now()
        WHERE id=${id} AND status=${order.status} AND revision=${expectedRevision}
        RETURNING id,revision
      ), audited AS (
        INSERT INTO po_events (purchase_order_id,event_type,actor,note,payload)
        SELECT id,'receipt',${user.displayName},${note || null},${dbJson(receiptPayload)}::jsonb FROM changed
      )
      SELECT id,revision FROM changed`;
    if (!updated.length) {
      return staleRevisionResponse("This PO was received or changed in another session. Reload before recording the delivery.");
    }
    return NextResponse.json({ ok: true, status, lines, revision: updated[0].revision });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "The receipt request is not valid JSON." }, { status: 400 });
    console.error(error);
    return NextResponse.json({ error: "Could not record the receipt." }, { status: 500 });
  }
}

function staleRevisionResponse(message: string) {
  return NextResponse.json({ error: message, code: STALE_PO_REVISION }, { status: 409 });
}
