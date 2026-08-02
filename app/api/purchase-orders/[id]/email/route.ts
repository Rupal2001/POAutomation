import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { dbJson, sql, type PurchaseOrderRow } from "@/lib/db";
import {
  deliverEmail,
  emailDeliveryFailureStatus,
  emailDeliveryRequiresDispatchReadiness,
  emailPreviewMatchesLiveSend,
  emailProviderStatus,
  parseEmailList,
  purchaseOrderEmailAttachments,
  renderPurchaseOrderEmail,
  renderPurchaseOrderEmailPreviewHtml,
  type EmailDeliveryStatus,
} from "@/lib/email";
import { canEmailPurchaseOrder, canOverridePurchaseOrderSendReadiness } from "@/lib/po-access";
import { purchaseOrderSendMissing, purchaseOrderSendReadinessDecision, purchaseOrderSendReadinessOverrideAudit, type PurchaseOrderSendReadinessOverrideAudit } from "@/lib/po-readiness";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type EmailAction = "preview" | "send";
type EmailDeliveryRow = {
  id: string;
  purchase_order_id: string;
  idempotency_key: string;
  action: EmailAction;
  provider: "preview" | "resend";
  status: EmailDeliveryStatus;
  to_addresses: string[];
  cc_addresses: string[];
  from_address: string;
  reply_to: string | null;
  subject: string;
  buyer_message: string | null;
  provider_message_id: string | null;
  error_message: string | null;
  created_by_user_id: string | null;
  created_by: string;
  created_at: string;
  completed_at: string | null;
};

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const user = await requireUser(request);
    const db = sql();
    const orders = await db`SELECT * FROM purchase_orders WHERE id=${id}` as PurchaseOrderRow[];
    if (!orders.length) return NextResponse.json({ error: "Purchase order not found." }, { status: 404 });
    const order = orders[0];
    const deliveries = await db`SELECT * FROM email_deliveries WHERE purchase_order_id=${id} ORDER BY created_at DESC LIMIT 50` as EmailDeliveryRow[];
    const missing = purchaseOrderSendMissing(order);
    const provider = emailProviderStatus();
    const requiresDispatchReadiness = emailDeliveryRequiresDispatchReadiness(provider);
    const canOverrideReadiness = requiresDispatchReadiness && canOverridePurchaseOrderSendReadiness(user.role) && order.status === "approved" && missing.length > 0;
    return NextResponse.json({
      deliveries: deliveries.map(publicDelivery),
      provider,
      defaults: {
        to: order.supplier_email ? [order.supplier_email] : [],
        cc: [],
        subject: defaultSubject(order),
        buyerMessage: `Please confirm receipt of ${order.po_number} and the expected delivery date.`,
      },
      permissions: {
        canCompose: canEmailPurchaseOrder(user.role),
        canSend: canEmailPurchaseOrder(user.role) && order.status === "approved" && (!requiresDispatchReadiness || missing.length === 0 || canOverrideReadiness),
        canOverrideReadiness,
      },
      readiness: { ready: missing.length === 0, missing },
    });
  } catch (error) {
    return authOrServerError(error, "Could not load supplier-email history.");
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const user = await requireUser(request);
    if (!canEmailPurchaseOrder(user.role)) {
      return NextResponse.json({ error: "Planner access is required to prepare or send a supplier email." }, { status: 403 });
    }
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action ?? "") as EmailAction;
    if (action !== "preview" && action !== "send") {
      return NextResponse.json({ error: "Choose preview or send." }, { status: 400 });
    }
    const idempotencyKey = String(body.idempotencyKey ?? "").trim();
    if (!/^[A-Za-z0-9._:/-]{8,200}$/.test(idempotencyKey)) {
      return NextResponse.json({ error: "A valid idempotency key is required for this email action." }, { status: 400 });
    }

    const db = sql();
    const orders = await db`SELECT * FROM purchase_orders WHERE id=${id}` as PurchaseOrderRow[];
    if (!orders.length) return NextResponse.json({ error: "Purchase order not found." }, { status: 404 });
    const order = orders[0];

    const existing = await db`SELECT * FROM email_deliveries WHERE idempotency_key=${idempotencyKey} LIMIT 1` as EmailDeliveryRow[];
    if (existing.length) {
      const delivery = await recoverStaleProcessingDelivery(db, existing[0]);
      if (delivery.purchase_order_id !== id || delivery.action !== action) {
        return NextResponse.json({ error: "That email action key was already used for a different request." }, { status: 409 });
      }
      if (delivery.status === "failed") {
        return NextResponse.json({
          error: `The earlier delivery attempt failed: ${delivery.error_message || "email provider request failed"}`,
          delivery: publicDelivery(delivery),
          alreadyProcessed: true,
        }, { status: 502 });
      }
      if (delivery.status === "sent" && order.status === "approved") {
        await db`UPDATE purchase_orders SET
          status='issued',issued_at=COALESCE(issued_at,now()),revision=revision+1,updated_at=now()
          WHERE id=${id} AND status='approved'`;
      }
      const [currentOrder] = await db`SELECT status FROM purchase_orders WHERE id=${id}`;
      const replayStatus = String(currentOrder?.status ?? order.status);
      const rendered = renderPurchaseOrderEmail(order, delivery.buyer_message ?? "");
      return NextResponse.json({
        delivery: publicDelivery(delivery),
        alreadyProcessed: true,
        delivered: delivery.status === "sent",
        reconciliationRequired: delivery.status === "uncertain",
        purchaseOrderStatus: replayStatus,
        message: delivery.status === "sent"
          ? replayStatus === "issued"
            ? "This email action was already accepted by the provider; the PO is marked as sent."
            : `The provider previously accepted this email, but the PO is ${replayStatus}. An administrator must reconcile the audit record before another send.`
          : delivery.status === "uncertain"
            ? "The provider response could not be confirmed. Do not retry until an administrator reconciles this delivery."
            : delivery.status === "processing"
              ? "This supplier email is already being delivered."
              : "Preview mode is active. Nothing was emailed and the PO remains approved.",
        preview: emailPreview(delivery.subject, delivery.to_addresses, delivery.cc_addresses, rendered),
      });
    }

    if (action === "send" && order.status !== "approved") {
      return NextResponse.json({ error: "Only an approved PO can be emailed to a supplier." }, { status: 409 });
    }
    const missing = purchaseOrderSendMissing(order);
    const provider = emailProviderStatus();
    const isLiveSupplierSend = action === "send" && emailDeliveryRequiresDispatchReadiness(provider);
    let readinessOverrideAudit: PurchaseOrderSendReadinessOverrideAudit | null = null;
    if (isLiveSupplierSend) {
      const decision = purchaseOrderSendReadinessDecision(
        user.role,
        missing,
        body.sendReadinessOverride,
        body.sendReadinessOverrideReason,
      );
      if (!decision.ok) return NextResponse.json({ error: decision.error }, { status: decision.status });
      if (decision.override) {
        readinessOverrideAudit = purchaseOrderSendReadinessOverrideAudit(
          decision.override,
          { id: user.id, displayName: user.displayName, role: user.role },
        );
      }
    }

    let to: string[];
    let cc: string[];
    try {
      to = parseEmailList(body.to ?? order.supplier_email ?? "");
      cc = parseEmailList(body.cc ?? "");
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Check the email recipients." }, { status: 400 });
    }
    if (!to.length) return NextResponse.json({ error: "Add at least one supplier recipient." }, { status: 400 });
    const toSet = new Set(to);
    cc = cc.filter(address => !toSet.has(address));
    const subject = String(body.subject ?? defaultSubject(order)).trim();
    if (!subject || subject.length > 200 || /[\r\n\0]/.test(subject)) {
      return NextResponse.json({ error: "Email subject must be between 1 and 200 characters." }, { status: 400 });
    }
    const buyerMessage = String(body.buyerMessage ?? "").trim();
    if (buyerMessage.length > 4_000) {
      return NextResponse.json({ error: "Buyer message must be no more than 4,000 characters." }, { status: 400 });
    }

    if (isLiveSupplierSend) {
      const previewDeliveryId = String(body.previewDeliveryId ?? "").trim();
      const previewRequired = () => NextResponse.json({
        error: "Generate a fresh preview of these exact recipients and message before sending the PO to the supplier.",
      }, { status: 409 });
      if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(previewDeliveryId)) return previewRequired();
      const previews = await db`SELECT * FROM email_deliveries WHERE id=${previewDeliveryId} LIMIT 1` as EmailDeliveryRow[];
      const preview = previews[0];
      const previewMatches = emailPreviewMatchesLiveSend(preview ? {
        purchaseOrderId: preview.purchase_order_id,
        action: preview.action,
        status: preview.status,
        to: preview.to_addresses,
        cc: preview.cc_addresses,
        subject: preview.subject,
        buyerMessage: preview.buyer_message,
        createdByUserId: preview.created_by_user_id,
        createdAt: preview.created_at,
      } : null, {
        purchaseOrderId: id,
        to,
        cc,
        subject,
        buyerMessage,
        createdByUserId: user.id,
        purchaseOrderUpdatedAt: order.updated_at,
      });
      if (!previewMatches) return previewRequired();
    }

    const rendered = renderPurchaseOrderEmail(order, buyerMessage);
    const deliveryId = randomUUID();
    const common = {
      id: deliveryId,
      purchaseOrderId: id,
      idempotencyKey,
      action,
      provider: provider.provider,
      to,
      cc,
      from: provider.from,
      replyTo: provider.replyTo,
      subject,
      buyerMessage,
      userId: user.id,
      actor: user.displayName,
      readinessOverride: readinessOverrideAudit,
    };

    if (action === "preview") {
      await insertDelivery(db, common, "preview");
      await db`INSERT INTO po_events (purchase_order_id,event_type,actor,note,payload)
        VALUES (${id},'email_previewed',${user.displayName},NULL,${dbJson({ to, cc, subject, provider: provider.provider })}::jsonb)`;
      const [delivery] = await db`SELECT * FROM email_deliveries WHERE id=${deliveryId}` as EmailDeliveryRow[];
      return NextResponse.json({
        delivery: publicDelivery(delivery),
        preview: emailPreview(subject, to, cc, rendered),
      }, { status: 201 });
    }

    if (!provider.configured) {
      return NextResponse.json({ error: "Supplier email is not configured. Ask an administrator to check the email environment variables." }, { status: 503 });
    }

    try {
      await insertDelivery(db, common, "processing");
    } catch (error: any) {
      if (error?.code !== "23505") throw error;
      const active = await db`SELECT * FROM email_deliveries
        WHERE purchase_order_id=${id} AND action='send' AND status IN ('processing','uncertain','sent')
        ORDER BY created_at DESC LIMIT 1` as EmailDeliveryRow[];
      if (active.length) {
        const activeDelivery = await recoverStaleProcessingDelivery(db, active[0]);
        if (activeDelivery.idempotency_key === idempotencyKey) {
          return NextResponse.json({
            delivery: publicDelivery(activeDelivery),
            alreadyProcessed: true,
            delivered: activeDelivery.status === "sent",
            reconciliationRequired: activeDelivery.status === "uncertain",
            purchaseOrderStatus: activeDelivery.status === "sent" ? "issued" : order.status,
            message: activeDelivery.status === "sent"
              ? "This email action was already completed."
              : activeDelivery.status === "uncertain"
                ? "The provider response could not be confirmed. Do not retry until an administrator reconciles this delivery."
                : "This supplier email is already being delivered.",
          }, { status: activeDelivery.status === "processing" ? 202 : activeDelivery.status === "uncertain" ? 409 : 200 });
        }
        return NextResponse.json({
          error: activeDelivery.status === "sent"
            ? "This PO has already been emailed to the supplier."
            : activeDelivery.status === "uncertain"
              ? "This PO has an unresolved supplier-email delivery. Ask an administrator to reconcile it before retrying."
              : "A supplier email for this PO is already being delivered.",
          delivery: publicDelivery(activeDelivery),
        }, { status: 409 });
      }
      throw error;
    }

    // Creating the delivery claim first makes subsequent workflow transitions
    // fail closed. This second, conditional check catches a cancellation or
    // reopen that won the race immediately before the claim was inserted.
    const orderClaim = await db`UPDATE purchase_orders SET updated_at=updated_at
      WHERE id=${id} AND status='approved'
      RETURNING id`;
    if (!orderClaim.length) {
      const message = "The PO changed before delivery started. Refresh and review its current status.";
      await db`UPDATE email_deliveries SET status='failed',error_message=${message},completed_at=now()
        WHERE id=${deliveryId} AND status='processing'`;
      return NextResponse.json({ error: message }, { status: 409 });
    }

    let result;
    try {
      result = await deliverEmail({
        to, cc, from: provider.from, replyTo: provider.replyTo ?? undefined, subject,
        html: rendered.html, text: rendered.text, attachments: purchaseOrderEmailAttachments(),
      }, idempotencyKey);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1_000) : "Email provider request failed.";
      const failureStatus = emailDeliveryFailureStatus(error);
      const uncertain = failureStatus === "uncertain";
      const claimUpdated = await db`WITH changed AS (
          UPDATE email_deliveries SET
            status=${failureStatus},error_message=${message},completed_at=${uncertain ? null : new Date()}
          WHERE id=${deliveryId} AND status='processing'
          RETURNING id,purchase_order_id
        ), audited AS (
          INSERT INTO po_events (purchase_order_id,event_type,actor,note,payload)
          SELECT purchase_order_id,${uncertain ? "email_status_unknown" : "email_failed"},${user.displayName},${message},
            ${dbJson({ deliveryId, to, cc, subject, provider: provider.provider, uncertain, ...(readinessOverrideAudit ? { sendReadinessOverride: readinessOverrideAudit } : {}) })}::jsonb
          FROM changed
        )
        SELECT id FROM changed`;
      if (!claimUpdated.length) {
        return NextResponse.json({
          error: "The email delivery claim changed while the provider request was running. Do not retry until an administrator reviews it.",
          reconciliationRequired: true,
        }, { status: 409 });
      }
      return NextResponse.json({
        error: uncertain
          ? `Delivery could not be confirmed. Do not retry: ${message}`
          : `The supplier email was not sent: ${message}`,
        reconciliationRequired: uncertain,
      }, { status: 502 });
    }

    // Only the request that still owns the processing claim may record the
    // provider result. An administrator cannot release an in-flight claim, and
    // a stale worker cannot overwrite a separately reconciled outcome.
    const recordedStatus: "preview" | "sent" = result.status === "sent" && !provider.forceToEnabled
      ? "sent"
      : "preview";
    let purchaseOrderStatus = order.status;
    let reconciliationRequired = false;
    try {
      if (recordedStatus === "sent") {
        const recorded = await db`WITH delivery_recorded AS (
            UPDATE email_deliveries SET
              provider=${result.provider},status='sent',provider_message_id=${result.providerMessageId},completed_at=now()
            WHERE id=${deliveryId} AND status='processing'
            RETURNING id,purchase_order_id
          ), transitioned AS (
            UPDATE purchase_orders SET status='issued',issued_at=now(),revision=revision+1,updated_at=now()
            WHERE id=${id} AND status='approved' AND EXISTS (SELECT 1 FROM delivery_recorded)
            RETURNING id,status
          ), audited AS (
            INSERT INTO po_events (purchase_order_id,event_type,actor,note,payload)
            SELECT purchase_order_id,'email_sent',${user.displayName},${buyerMessage || null},
              ${dbJson({ deliveryId, to, cc, subject, provider: result.provider, providerMessageId: result.providerMessageId, ...(readinessOverrideAudit ? { sendReadinessOverride: readinessOverrideAudit } : {}) })}::jsonb
                || jsonb_build_object('statusTransitioned',EXISTS (SELECT 1 FROM transitioned))
            FROM delivery_recorded
          )
          SELECT id,EXISTS (SELECT 1 FROM transitioned) AS status_transitioned FROM delivery_recorded`;
        if (!recorded.length) {
          return NextResponse.json({
            error: "The provider responded, but the delivery claim changed before its result could be recorded. Do not retry until an administrator reviews it.",
            reconciliationRequired: true,
          }, { status: 409 });
        }
        const transitioned = Boolean(recorded[0].status_transitioned);
        purchaseOrderStatus = transitioned ? "issued" : String((await db`SELECT status FROM purchase_orders WHERE id=${id}`)[0]?.status ?? order.status);
        reconciliationRequired = !transitioned;
      } else {
        const previewNote = provider.forceToEnabled
          ? "Test message delivered to EMAIL_FORCE_TO; the supplier was not contacted."
          : "Send requested while email delivery was in preview mode.";
        const recorded = await db`WITH delivery_recorded AS (
            UPDATE email_deliveries SET
              provider=${result.provider},status='preview',provider_message_id=${result.providerMessageId},completed_at=now()
            WHERE id=${deliveryId} AND status='processing'
            RETURNING id,purchase_order_id
          ), audited AS (
            INSERT INTO po_events (purchase_order_id,event_type,actor,note,payload)
            SELECT purchase_order_id,'email_previewed',${user.displayName},${previewNote},
              ${dbJson({ deliveryId, to, cc, subject, forceToEnabled: provider.forceToEnabled, providerMessageId: result.providerMessageId, ...(readinessOverrideAudit ? { sendReadinessOverride: readinessOverrideAudit } : {}) })}::jsonb
            FROM delivery_recorded
          )
          SELECT id FROM delivery_recorded`;
        if (!recorded.length) return NextResponse.json({ error: "The delivery claim changed before preview mode could be recorded." }, { status: 409 });
      }
    } catch (recordingError) {
      console.error("Email provider result could not be committed:", recordingError);
      const uncertain = recordedStatus === "sent";
      const message = uncertain
        ? "The provider accepted the request, but StyleFlow could not commit the result. Do not retry until an administrator reconciles it."
        : "StyleFlow could not record the safe preview result; the supplier was not contacted.";
      await db`WITH changed AS (
          UPDATE email_deliveries SET status=${uncertain ? "uncertain" : "failed"},error_message=${message},completed_at=${uncertain ? null : new Date()}
          WHERE id=${deliveryId} AND status='processing' RETURNING purchase_order_id
        ), audited AS (
          INSERT INTO po_events (purchase_order_id,event_type,actor,note,payload)
          SELECT purchase_order_id,${uncertain ? "email_status_unknown" : "email_failed"},${user.displayName},${message},
            ${dbJson({ deliveryId, provider: result.provider, providerMessageId: result.providerMessageId, ...(readinessOverrideAudit ? { sendReadinessOverride: readinessOverrideAudit } : {}) })}::jsonb FROM changed
        ) SELECT purchase_order_id FROM changed`.catch(() => undefined);
      return NextResponse.json({ error: message, reconciliationRequired: uncertain }, { status: 502 });
    }
    const [delivery] = await db`SELECT * FROM email_deliveries WHERE id=${deliveryId}` as EmailDeliveryRow[];
    return NextResponse.json({
      delivery: publicDelivery(delivery),
      delivered: recordedStatus === "sent",
      purchaseOrderStatus,
      reconciliationRequired,
      preview: emailPreview(subject, to, cc, rendered),
      message: recordedStatus === "sent"
        ? reconciliationRequired
          ? `The email provider accepted the PO, but its workflow status is ${purchaseOrderStatus}. Do not resend; ask an administrator to reconcile it.`
          : "The email provider accepted the approved PO for supplier delivery and StyleFlow marked it as sent."
        : provider.forceToEnabled && result.status === "sent"
          ? "The test email was redirected by EMAIL_FORCE_TO. The supplier was not contacted and the PO remains approved."
          : "Preview mode is active. Nothing was emailed and the PO remains approved.",
    });
  } catch (error) {
    return authOrServerError(error, "Could not prepare the supplier email.");
  }
}

async function recoverStaleProcessingDelivery(db: any, delivery: EmailDeliveryRow): Promise<EmailDeliveryRow> {
  if (delivery.status !== "processing") return delivery;
  const createdAt = new Date(delivery.created_at).getTime();
  if (!Number.isFinite(createdAt) || createdAt > Date.now() - 120_000) return delivery;
  const message = "The email worker did not commit a result within two minutes. Provider status must be reconciled before retrying.";
  const rows = await db`WITH changed AS (
      UPDATE email_deliveries SET status='uncertain',error_message=${message},completed_at=NULL
      WHERE id=${delivery.id} AND status='processing' AND created_at < now()-interval '2 minutes'
      RETURNING *
    ), audited AS (
      INSERT INTO po_events (purchase_order_id,event_type,actor,note,payload)
      SELECT purchase_order_id,'email_status_unknown','StyleFlow email recovery',${message},
        ${dbJson({ deliveryId: delivery.id, recovery: "stale_processing_claim" })}::jsonb FROM changed
    )
    SELECT * FROM changed` as EmailDeliveryRow[];
  return rows[0] ?? delivery;
}

async function insertDelivery(db: any, values: {
  id: string;
  purchaseOrderId: string;
  idempotencyKey: string;
  action: EmailAction;
  provider: "preview" | "resend";
  to: string[];
  cc: string[];
  from: string;
  replyTo: string | null;
  subject: string;
  buyerMessage: string;
  userId: string;
  actor: string;
  readinessOverride: PurchaseOrderSendReadinessOverrideAudit | null;
}, status: "processing" | "preview") {
  await db`WITH inserted AS (
      INSERT INTO email_deliveries
        (id,purchase_order_id,idempotency_key,action,provider,status,to_addresses,cc_addresses,from_address,reply_to,subject,buyer_message,created_by_user_id,created_by,completed_at)
      VALUES (${values.id},${values.purchaseOrderId},${values.idempotencyKey},${values.action},${values.provider},${status},${dbJson(values.to)}::jsonb,${dbJson(values.cc)}::jsonb,${values.from},${values.replyTo},${values.subject},${values.buyerMessage || null},${values.userId},${values.actor},${status === "preview" ? new Date() : null})
      RETURNING purchase_order_id
    ), override_audited AS (
      INSERT INTO po_events (purchase_order_id,event_type,actor,note,payload)
      SELECT purchase_order_id,'send_readiness_overridden',${values.actor},${values.readinessOverride?.reason ?? null},
        ${dbJson({ channel: "email", deliveryId: values.id, ...(values.readinessOverride ?? {}) })}::jsonb
      FROM inserted WHERE ${Boolean(values.readinessOverride)}
    )
    SELECT purchase_order_id FROM inserted`;
}

function publicDelivery(row: EmailDeliveryRow) {
  return {
    id: row.id,
    action: row.action,
    provider: row.provider,
    status: row.status,
    to: row.to_addresses,
    cc: row.cc_addresses,
    from: row.from_address,
    subject: row.subject,
    providerMessageId: row.provider_message_id,
    error: row.error_message,
    createdBy: row.created_by,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function emailPreview(subject: string, to: string[], cc: string[], rendered: { html: string; text: string }) {
  return { subject, to, cc, html: renderPurchaseOrderEmailPreviewHtml(rendered.html), text: rendered.text };
}

function defaultSubject(order: PurchaseOrderRow) {
  return `Myntra purchase order ${order.po_number} · ${order.vendor}`;
}

function authOrServerError(error: unknown, fallback: string) {
  if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof SyntaxError) return NextResponse.json({ error: "The supplier-email request is not valid JSON." }, { status: 400 });
  console.error(error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}
