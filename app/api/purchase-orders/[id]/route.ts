import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { dbJson, sql, PurchaseOrderRow } from "@/lib/db";
import { parseEmailList } from "@/lib/email";
import {
  canEditPurchaseOrder,
  canEmailPurchaseOrder,
  canApproveOwnPurchaseOrder,
  canReceivePurchaseOrder,
  canTransitionPurchaseOrder,
  needsSeniorApproval,
} from "@/lib/po-access";
import { PO_STATUSES, PurchaseOrderLine, calculateTotals, canTransition, nonNegativeMoney, normalizePurchaseOrderLines, preservePurchaseOrderLineControls, purchaseOrderLineValidationError, roundMoney } from "@/lib/purchase-orders";
import { deliveryDateProblem, purchaseOrderSendMissing, purchaseOrderSendReadinessDecision, purchaseOrderSendReadinessOverrideAudit, todayInIndia } from "@/lib/po-readiness";
import { STALE_PO_REVISION, validateExpectedPoRevision } from "@/lib/po-revision";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const user = await requireUser(request);
    const db = sql();
    const orders = await db`SELECT * FROM purchase_orders WHERE id = ${id}` as PurchaseOrderRow[];
    if (!orders.length) return NextResponse.json({ error: "Purchase order not found." }, { status: 404 });
    const events = await db`SELECT * FROM po_events WHERE purchase_order_id = ${id} ORDER BY created_at DESC`;
    const order = orders[0];
    return NextResponse.json({
      purchaseOrder: order,
      events,
      currentUser: { id: user.id, displayName: user.displayName, username: user.username, role: user.role },
      permissions: {
        canEdit: order.status === "draft" && canEditPurchaseOrder(user.role),
        canEmail: order.status === "approved" && canEmailPurchaseOrder(user.role),
        canReceive: ["issued", "partially_received"].includes(order.status) && canReceivePurchaseOrder(user.role),
        transitions: PO_STATUSES.filter(target =>
          canTransition(order.status, target) && canTransitionPurchaseOrder(user.role, order.status, target)
        ),
      },
    });
  } catch (error) {
    return authOrServerError(error, "Could not load the purchase order.");
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const user = await requireUser(request);
    const body = await request.json() as Record<string, any>;
    const revisionValidation = validateExpectedPoRevision(body.expectedRevision);
    if (!revisionValidation.ok) {
      return NextResponse.json({ error: revisionValidation.message, code: revisionValidation.code }, { status: revisionValidation.status });
    }
    const expectedRevision = revisionValidation.value;
    const db = sql();
    const orders = await db`SELECT * FROM purchase_orders WHERE id = ${id}` as PurchaseOrderRow[];
    if (!orders.length) return NextResponse.json({ error: "Purchase order not found." }, { status: 404 });
    const order = orders[0];
    const actor = user.displayName;
    if (order.revision !== expectedRevision) {
      return staleRevisionResponse("This PO changed after you opened it. Keep your unsaved work visible and reload the latest version before trying again.");
    }

    if (body.action) {
      const target = String(body.action);
      if (!PO_STATUSES.includes(target as any) || !canTransition(order.status, target)) {
        return NextResponse.json({ error: `Cannot move ${order.status} to ${target}.` }, { status: 409 });
      }
      if (!canTransitionPurchaseOrder(user.role, order.status, target)) {
        return NextResponse.json({ error: "Your role cannot perform this purchase-order action." }, { status: 403 });
      }
      const note = String(body.note ?? "").trim();
      if (["cancelled", "draft", "issued"].includes(target) && !note) {
        return NextResponse.json({
          error: target === "issued"
            ? "Describe how and when the PO was sent outside StyleFlow."
            : "A reason is required for cancellation or reopening.",
        }, { status: 400 });
      }
      let selfApproval = false;
      if (target === "approved") {
        selfApproval = order.created_by_user_id
          ? order.created_by_user_id === user.id
          : order.created_by === user.displayName;
        if (selfApproval && !canApproveOwnPurchaseOrder(user.role)) {
          return NextResponse.json({ error: "The person who created this PO cannot approve it. Ask a separate approver." }, { status: 403 });
        }
        const [rule] = await db`SELECT approval_threshold FROM automation_rules WHERE id='default'`;
        if (Number(order.total) >= Number(rule?.approval_threshold ?? 250000) && needsSeniorApproval(user.role)) {
          return NextResponse.json({ error: "This PO is above the senior-approval threshold and needs a senior approver." }, { status: 403 });
        }
      }
      let readinessOverride: { missingFields: string[]; reason: string } | null = null;
      if (target === "issued") {
        const missing = purchaseOrderSendMissing(order);
        const decision = purchaseOrderSendReadinessDecision(
          user.role,
          missing,
          body.sendReadinessOverride,
          body.sendReadinessOverrideReason,
        );
        if (!decision.ok) return NextResponse.json({ error: decision.error }, { status: decision.status });
        readinessOverride = decision.override;
      }
      const approvedBy = target === "approved" ? actor : target === "draft" ? null : order.approved_by;
      const approvedByUserId = target === "approved" ? user.id : target === "draft" ? null : order.approved_by_user_id;
      const readinessOverrideAudit = purchaseOrderSendReadinessOverrideAudit(
        readinessOverride,
        { id: user.id, displayName: user.displayName, role: user.role },
      );
      const eventPayload = target === "issued"
        ? { channel: "external", ...(readinessOverrideAudit ? { sendReadinessOverride: readinessOverrideAudit } : {}) }
        : target === "approved"
          ? { selfApproval }
          : {};
      const transitioned = await db`WITH changed AS (
          UPDATE purchase_orders AS po SET
            status=${target},
            approved_by=${approvedBy},
            approved_by_user_id=${approvedByUserId},
            approved_at=CASE WHEN ${target}='approved' THEN now() WHEN ${target}='draft' THEN NULL ELSE approved_at END,
            issued_at=CASE WHEN ${target}='issued' THEN now() ELSE issued_at END,
            closed_at=CASE WHEN ${target}='closed' THEN now() ELSE closed_at END,
            revision=po.revision+1,
            updated_at=now()
          WHERE po.id=${id}
            AND po.status=${order.status}
            AND po.revision=${expectedRevision}
            AND NOT EXISTS (
              SELECT 1 FROM email_deliveries delivery
              WHERE delivery.purchase_order_id=po.id
                AND delivery.action='send'
                AND delivery.status IN ('processing','uncertain')
            )
          RETURNING po.id,po.revision
        ), audited AS (
          INSERT INTO po_events (purchase_order_id,event_type,actor,note,payload)
          SELECT id,${target},${actor},${note || null},${dbJson(eventPayload)}::jsonb FROM changed
        )
        SELECT id,revision FROM changed`;
      if (!transitioned.length) {
        return staleRevisionResponse("This PO changed in another session or a supplier email is currently being delivered. Reload before trying again.");
      }
      return NextResponse.json({ ok: true, status: target, revision: transitioned[0].revision });
    }

    if (!canEditPurchaseOrder(user.role)) {
      return NextResponse.json({ error: "Planner access is required to edit a purchase order." }, { status: 403 });
    }
    if (order.status !== "draft") {
      return NextResponse.json({ error: "Only draft purchase orders can be edited." }, { status: 409 });
    }
    const normalizedLines = normalizePurchaseOrderLines(body.lines ?? order.lines) as PurchaseOrderLine[];
    const lines = preservePurchaseOrderLineControls(normalizedLines, order.lines);
    const lineProblem = purchaseOrderLineValidationError(lines);
    if (lineProblem) return NextResponse.json({ error: lineProblem }, { status: 400 });
    let supplierEmail = order.supplier_email;
    if (body.supplierEmail !== undefined) {
      try {
        const emails = parseEmailList(body.supplierEmail, 1);
        supplierEmail = emails[0] ?? null;
      } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : "Enter a valid supplier email." }, { status: 400 });
      }
    }
    let freight: number;
    let discount: number;
    try {
      freight = nonNegativeMoney(body.freight ?? order.freight ?? 0, "Freight");
      discount = nonNegativeMoney(body.discount ?? order.discount ?? 0, "Discount");
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Check the INR adjustments." }, { status: 400 });
    }
    const subtotalBeforeAdjustments = lines.reduce((sum, line) => sum + Number(line.quantity) * Number(line.unitPrice), 0);
    if (discount > subtotalBeforeAdjustments + freight) {
      return NextResponse.json({ error: "Discount cannot exceed the merchandise subtotal plus freight." }, { status: 400 });
    }
    const tax = roundMoney(lines.reduce((sum, line) => sum + Number(line.quantity) * Number(line.unitPrice) * Number(line.gstRate ?? 0) / 100, 0));
    const totals = calculateTotals(lines, freight, discount, tax);
    const expectedDeliveryDate = String(body.expectedDeliveryDate ?? order.expected_delivery_date ?? "").trim();
    const dateProblem = deliveryDateProblem(expectedDeliveryDate, order.order_date, todayInIndia());
    if (dateProblem) return NextResponse.json({ error: `Add an ${dateProblem}.` }, { status: 400 });
    const textFields = [
      ["Payment terms", body.paymentTerms ?? order.payment_terms, 300],
      ["Incoterms", body.incoterms ?? order.incoterms, 100],
      ["Ship-to address", body.shipTo ?? order.ship_to, 2_000],
      ["Bill-to address", body.billTo ?? order.bill_to, 2_000],
      ["Notes", body.notes ?? order.notes, 4_000],
      ["Supplier state", body.supplierState ?? order.supplier_state, 100],
      ["Buyer state", body.buyerState ?? order.buyer_state, 100],
      ["Place of supply", body.placeOfSupply ?? order.place_of_supply, 200],
    ] as const;
    const oversized = textFields.find(([, value, maximum]) => String(value ?? "").length > maximum);
    if (oversized) return NextResponse.json({ error: `${oversized[0]} is too long.` }, { status: 400 });
    const supplierGstin = String(body.supplierGstin ?? order.supplier_gstin ?? "").trim().toUpperCase();
    const buyerGstin = String(body.buyerGstin ?? order.buyer_gstin ?? "").trim().toUpperCase();
    const invalidGstin = [supplierGstin, buyerGstin].find(value => value && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(value));
    if (invalidGstin) return NextResponse.json({ error: "GSTIN must use the valid 15-character Indian format." }, { status: 400 });
    const updated = await db`WITH changed AS (
        UPDATE purchase_orders SET
          lines=${dbJson(lines)}::jsonb,
          expected_delivery_date=${expectedDeliveryDate},
          payment_terms=${body.paymentTerms ?? order.payment_terms},
          incoterms=${body.incoterms ?? order.incoterms},
          ship_to=${body.shipTo ?? order.ship_to},
          bill_to=${body.billTo ?? order.bill_to},
          notes=${body.notes ?? order.notes},
          supplier_email=${supplierEmail},
          supplier_gstin=${supplierGstin || null},
          buyer_gstin=${buyerGstin || null},
          supplier_state=${body.supplierState ?? order.supplier_state},
          buyer_state=${body.buyerState ?? order.buyer_state},
          place_of_supply=${body.placeOfSupply ?? order.place_of_supply},
          freight=${freight}, discount=${discount}, tax=${tax}, subtotal=${totals.subtotal}, total=${totals.total},
          revision=revision+1, updated_at=now()
        WHERE id=${id} AND status='draft' AND revision=${expectedRevision}
        RETURNING id,revision
      ), audited AS (
        INSERT INTO po_events (purchase_order_id,event_type,actor,note,payload)
        SELECT id,'edited',${actor},${String(body.note ?? "").trim() || null},${dbJson({ total: totals.total })}::jsonb FROM changed
      )
      SELECT id,revision FROM changed`;
    if (!updated.length) {
      return staleRevisionResponse("This draft changed in another session. Keep your unsaved work visible and reload before saving again.");
    }
    return NextResponse.json({ ok: true, totals, revision: updated[0].revision });
  } catch (error) {
    return authOrServerError(error, "Could not update the purchase order.");
  }
}

function staleRevisionResponse(message: string) {
  return NextResponse.json({ error: message, code: STALE_PO_REVISION }, { status: 409 });
}

function authOrServerError(error: unknown, fallback: string) {
  if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof SyntaxError) return NextResponse.json({ error: "The purchase-order request is not valid JSON." }, { status: 400 });
  console.error(error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}
