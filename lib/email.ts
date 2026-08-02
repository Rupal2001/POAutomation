import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PurchaseOrderRow } from "./db";
import type { PurchaseOrderLine } from "./purchase-orders";
import { canonicalIsoCalendarDate } from "./po-readiness";

export type EmailProvider = "preview" | "resend";
export type EmailDeliveryStatus = "processing" | "uncertain" | "preview" | "sent" | "failed";

export interface EmailAttachment {
  content: string;
  filename: string;
  contentId?: string;
  contentType?: string;
}

export interface OutboundEmail {
  to: string[];
  cc?: string[];
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
}

export interface EmailDeliveryResult {
  provider: EmailProvider;
  status: "preview" | "sent";
  providerMessageId: string | null;
}

export interface EmailPreviewAuthorizationRecord {
  purchaseOrderId: string;
  action: string;
  status: EmailDeliveryStatus;
  to: string[];
  cc: string[];
  subject: string;
  buyerMessage: string | null;
  createdByUserId: string | null;
  createdAt: string | Date;
}

export interface LiveEmailSendRequest {
  purchaseOrderId: string;
  to: string[];
  cc: string[];
  subject: string;
  buyerMessage: string;
  createdByUserId: string;
  purchaseOrderUpdatedAt: string | Date;
}

export class EmailDeliveryUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailDeliveryUncertainError";
  }
}

export function emailDeliveryFailureStatus(error: unknown): "uncertain" | "failed" {
  return error instanceof EmailDeliveryUncertainError ? "uncertain" : "failed";
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PURCHASE_ORDER_BRAND_CID = "styleflow-myntra-mark";
const PURCHASE_ORDER_BRAND_FILENAME = "myntra-mark.png";
let purchaseOrderBrandBase64: string | null = null;

export function emailProviderStatus() {
  const provider = normalizedProvider();
  const configured = provider === "preview" || Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
  return {
    provider,
    configured,
    mode: provider === "preview" ? "Local preview — nothing leaves StyleFlow" : "Resend email delivery",
    from: process.env.EMAIL_FROM || "StyleFlow PO Desk <po@localhost>",
    replyTo: process.env.EMAIL_REPLY_TO || null,
    forceToEnabled: provider === "resend" && Boolean(process.env.EMAIL_FORCE_TO?.trim()),
  };
}

/**
 * Commercial send-readiness is required only when the supplier can actually
 * be contacted. Local preview and EMAIL_FORCE_TO test delivery leave the PO
 * approved and therefore must not block a safe test send.
 */
export function emailDeliveryRequiresDispatchReadiness(provider: { provider: EmailProvider; forceToEnabled: boolean }) {
  return provider.provider === "resend" && !provider.forceToEnabled;
}

/**
 * A real supplier delivery is authorised only by the exact preview that the
 * same user generated after the PO last changed. The route loads the record by
 * the opaque previewDeliveryId; this pure comparison keeps every field in the
 * server-side contract explicit and testable.
 */
export function emailPreviewMatchesLiveSend(
  preview: EmailPreviewAuthorizationRecord | null | undefined,
  request: LiveEmailSendRequest,
) {
  if (!preview || preview.action !== "preview" || preview.status !== "preview") return false;
  if (preview.purchaseOrderId !== request.purchaseOrderId || preview.createdByUserId !== request.createdByUserId) return false;
  if (preview.subject !== request.subject || (preview.buyerMessage ?? "") !== request.buyerMessage) return false;
  if (!sameEmailList(preview.to, request.to) || !sameEmailList(preview.cc, request.cc)) return false;
  const previewCreatedAt = new Date(preview.createdAt).getTime();
  const purchaseOrderUpdatedAt = new Date(request.purchaseOrderUpdatedAt).getTime();
  return Number.isFinite(previewCreatedAt)
    && Number.isFinite(purchaseOrderUpdatedAt)
    && previewCreatedAt >= purchaseOrderUpdatedAt;
}

function sameEmailList(left: string[], right: string[]) {
  return left.length === right.length && left.every((address, index) => address === right[index]);
}

export function parseEmailList(value: unknown, maximum = 20) {
  const source = Array.isArray(value) ? value : String(value ?? "").split(/[;,]/);
  const emails = [...new Set(source.map(item => String(item).trim().toLowerCase()).filter(Boolean))];
  if (emails.length > maximum) throw new Error(`Use no more than ${maximum} email addresses.`);
  const invalid = emails.filter(email => !EMAIL_PATTERN.test(email));
  if (invalid.length) throw new Error(`Invalid email address: ${invalid.join(", ")}`);
  return emails;
}

export function purchaseOrderEmailAttachments(): EmailAttachment[] {
  return [{
    content: readPurchaseOrderBrandBase64(),
    filename: PURCHASE_ORDER_BRAND_FILENAME,
    contentId: PURCHASE_ORDER_BRAND_CID,
    contentType: "image/png",
  }];
}

/** The browser preview cannot resolve email CIDs, so inline only this trusted local asset. */
export function renderPurchaseOrderEmailPreviewHtml(html: string) {
  return html.replaceAll(
    `cid:${PURCHASE_ORDER_BRAND_CID}`,
    `data:image/png;base64,${readPurchaseOrderBrandBase64()}`,
  );
}

function readPurchaseOrderBrandBase64() {
  purchaseOrderBrandBase64 ??= readFileSync(
    join(process.cwd(), "public", "brand", PURCHASE_ORDER_BRAND_FILENAME),
  ).toString("base64");
  return purchaseOrderBrandBase64;
}

export async function deliverEmail(message: OutboundEmail, idempotencyKey: string): Promise<EmailDeliveryResult> {
  const provider = normalizedProvider();
  if (provider === "preview") return { provider, status: "preview", providerMessageId: null };
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !process.env.EMAIL_FROM?.trim()) {
    throw new Error("Resend delivery needs both RESEND_API_KEY and a verified EMAIL_FROM sender.");
  }
  if (!message.to.length) throw new Error("Add at least one supplier recipient.");
  const forceTo = parseEmailList(process.env.EMAIL_FORCE_TO || "");
  const to = forceTo.length ? forceTo : message.to;
  const cc = forceTo.length ? [] : (message.cc ?? []);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey.slice(0, 256),
      },
      body: JSON.stringify({
        from: message.from,
        to,
        cc: cc.length ? cc : undefined,
        reply_to: message.replyTo || undefined,
        subject: forceTo.length ? `[TEST → ${message.to.join(", ")}] ${message.subject}` : message.subject,
        html: message.html,
        text: message.text,
        attachments: message.attachments?.map(attachment => ({
          content: attachment.content,
          filename: attachment.filename,
          content_id: attachment.contentId,
          content_type: attachment.contentType,
        })),
        tags: [{ name: "workflow", value: "purchase_order" }],
      }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new EmailDeliveryUncertainError("Email provider timed out after 15 seconds; delivery status is unknown and must be reconciled before retrying.");
    }
    throw new EmailDeliveryUncertainError(`The email provider connection ended before confirmation; delivery status is unknown and must be reconciled before retrying.${error instanceof Error ? ` ${error.message}` : ""}`);
  } finally {
    clearTimeout(timeout);
  }
  let body: { id?: string; message?: string; error?: { message?: string } } = {};
  let responseBodyReadable = true;
  try {
    body = await response.json() as typeof body;
  } catch {
    responseBodyReadable = false;
  }
  if (response.ok && (!responseBodyReadable || !body.id)) {
    throw new EmailDeliveryUncertainError("The email provider returned success without a verifiable message ID; delivery status is unknown and must be reconciled before retrying.");
  }
  if (!response.ok) {
    const message = body.message || body.error?.message || `Email provider returned HTTP ${response.status}.`;
    // A server error, timeout, rate-limit edge or idempotency conflict can be
    // returned after a provider accepted work but before its result was stable.
    if (response.status >= 500 || [408, 409, 429].includes(response.status)) {
      throw new EmailDeliveryUncertainError(`${message} Delivery status is unknown and must be reconciled before retrying.`);
    }
    throw new Error(message);
  }
  return { provider, status: "sent", providerMessageId: body.id ?? null };
}

export function renderPurchaseOrderEmail(order: PurchaseOrderRow, buyerMessage = "") {
  const lines = Array.isArray(order.lines) ? order.lines as PurchaseOrderLine[] : [];
  const totalUnits = lines.reduce((sum, line) => sum + Number(line.quantity || 0), 0);
  const safeMessage = escapeHtml(buyerMessage.trim());
  const lineRows = lines.map(line => {
    const taxable = Number(line.quantity) * Number(line.unitPrice);
    const gstRate = Number(line.gstRate ?? 0);
    const gst = taxable * gstRate / 100;
    return `<tr>
    <td style="padding:10px;border-bottom:1px solid #e5e7eb">${escapeHtml(line.description || line.sku)}<br><small style="color:#667085">${escapeHtml(line.sku)}</small></td>
    <td style="padding:10px;border-bottom:1px solid #e5e7eb">${escapeHtml(line.hsnCode || "—")}</td>
    <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right">${formatNumber(line.quantity)}</td>
    <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right">${formatINR(line.unitPrice)}</td>
    <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right">${formatNumber(gstRate)}%</td>
    <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right">${formatINR(taxable + gst)}</td>
  </tr>`;
  }).join("");
  const commercialRows = [
    ["PO date", formatEmailCalendarDate(order.order_date)],
    ["Expected delivery", formatEmailCalendarDate(order.expected_delivery_date)],
    ["Deliver to", order.ship_to || order.warehouse],
    ["Bill to", order.bill_to || "Not provided"],
    ["Payment terms", order.payment_terms || "Not provided"],
    ["Incoterms", order.incoterms || "Not provided"],
    ["Place of supply", order.place_of_supply || "Not provided"],
    ["Supplier GSTIN", order.supplier_gstin || "Not provided"],
    ["Buyer GSTIN", order.buyer_gstin || "Not provided"],
    ["Currency", "INR"],
  ].map(([label, value]) => `<tr><td style="padding:6px 0;color:#667085;vertical-align:top">${escapeHtml(label)}</td><td style="padding:6px 0 6px 20px;text-align:right;font-weight:700;white-space:pre-line">${escapeHtml(value)}</td></tr>`).join("");
  const totalsRows = [
    ["Merchandise subtotal", order.subtotal],
    ["Freight", order.freight],
    ["Discount", -Number(order.discount || 0)],
    ["GST / tax", order.tax],
  ].map(([label, value]) => `<tr><td style="padding:4px 12px;color:#667085">${escapeHtml(label)}</td><td style="padding:4px 0;text-align:right">${formatINR(value)}</td></tr>`).join("");
  const html = `<!doctype html><html><body style="margin:0;background:#f7f3f5;color:#202124;font-family:Arial,sans-serif">
    <div style="max-width:760px;margin:0 auto;padding:32px 20px">
      <div style="background:#fff;border:1px solid #e7e2dc;border-radius:16px;overflow:hidden">
        <div style="padding:22px 28px 20px;background:#fff6f9;border-bottom:3px solid #f04b83">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0"><tbody><tr>
            <td width="94" valign="middle" style="width:94px;vertical-align:middle;line-height:0">
              <img src="cid:${PURCHASE_ORDER_BRAND_CID}" width="87" height="66" alt="Myntra" style="display:block;width:87px;height:66px;border:0;outline:none;text-decoration:none">
            </td>
            <td valign="middle" style="padding-left:16px;vertical-align:middle">
              <div style="font-size:23px;line-height:1.1;font-weight:800;color:#80133d">StyleFlow</div>
              <div style="margin-top:5px;font-size:12px;line-height:1.3;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#c51d53">Myntra Buying Operations</div>
              <div style="margin-top:4px;font-size:12px;line-height:1.4;color:#705d67">Approved purchase order workflow</div>
            </td>
          </tr></tbody></table>
          <div style="margin-top:18px;padding-top:16px;border-top:1px solid #eadde3;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#8e6679">Purchase order</div>
          <h1 style="margin:5px 0 0;font-size:24px;line-height:1.25;color:#2f1b27">${escapeHtml(order.po_number)}</h1>
        </div>
        <div style="padding:28px">
          <p>Hello ${escapeHtml(order.vendor)},</p>
          ${safeMessage ? `<p style="white-space:pre-line">${safeMessage}</p>` : "<p>Please review the approved purchase order below.</p>"}
          <table style="width:100%;border-collapse:collapse;margin:24px 0"><tbody>${commercialRows}</tbody></table>
          <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb"><thead><tr style="background:#f8fafc"><th style="padding:10px;text-align:left">Article</th><th style="padding:10px;text-align:left">HSN</th><th style="padding:10px;text-align:right">Qty</th><th style="padding:10px;text-align:right">Unit cost</th><th style="padding:10px;text-align:right">GST</th><th style="padding:10px;text-align:right">Line value</th></tr></thead><tbody>${lineRows}</tbody></table>
          <div style="margin:20px 0 0;display:flex;justify-content:flex-end"><table style="border-collapse:collapse;min-width:320px"><tbody>${totalsRows}<tr><td style="padding:10px 12px 0;font-weight:700">Grand total · ${formatNumber(totalUnits)} units</td><td style="padding:10px 0 0;text-align:right;font-size:24px;font-weight:700">${formatINR(order.total)}</td></tr></tbody></table></div>
          ${order.notes ? `<p style="margin-top:24px;padding:14px;background:#f8fafc;border-radius:8px;white-space:pre-line"><strong>PO notes</strong><br>${escapeHtml(order.notes)}</p>` : ""}
          <p style="margin-top:28px;color:#667085;font-size:13px">Please reply to this email with confirmation or questions. This message was generated from StyleFlow's approved PO workflow.</p>
        </div>
      </div>
    </div>
  </body></html>`;
  const text = [
    "StyleFlow · Myntra Buying Operations",
    `Purchase order ${order.po_number}`,
    `Supplier: ${order.vendor}`,
    buyerMessage.trim(),
    `PO date: ${formatEmailCalendarDate(order.order_date)}`,
    `Expected delivery: ${formatEmailCalendarDate(order.expected_delivery_date)}`,
    `Deliver to: ${order.ship_to || order.warehouse}`,
    `Bill to: ${order.bill_to || "Not provided"}`,
    `Payment terms: ${order.payment_terms || "Not provided"}`,
    `Incoterms: ${order.incoterms || "Not provided"}`,
    `Place of supply: ${order.place_of_supply || "Not provided"}`,
    `Supplier GSTIN: ${order.supplier_gstin || "Not provided"}`,
    `Buyer GSTIN: ${order.buyer_gstin || "Not provided"}`,
    "",
    ...lines.map(line => {
      const taxable = Number(line.quantity) * Number(line.unitPrice);
      const gstRate = Number(line.gstRate ?? 0);
      return `${line.description || line.sku} (${line.sku}) · HSN ${line.hsnCode || "—"} — ${formatNumber(line.quantity)} × ${formatINR(line.unitPrice)} + ${formatNumber(gstRate)}% GST = ${formatINR(taxable * (1 + gstRate / 100))}`;
    }),
    "",
    `Merchandise subtotal: ${formatINR(order.subtotal)}`,
    `Freight: ${formatINR(order.freight)}`,
    `Discount: ${formatINR(-Number(order.discount || 0))}`,
    `GST / tax: ${formatINR(order.tax)}`,
    `Grand total: ${formatINR(order.total)} (${formatNumber(totalUnits)} units)`,
    order.notes ? `PO notes: ${order.notes}` : "",
  ].filter(Boolean).join("\n");
  return { html, text };
}

/**
 * PostgreSQL DATE values can arrive as a Date, a YYYY-MM-DD string, or a
 * midnight ISO timestamp. Format the preserved calendar component in UTC so
 * host timezone conversion can never move it to the prior/next day.
 */
export function formatEmailCalendarDate(value: unknown) {
  const calendarDate = canonicalIsoCalendarDate(value);
  if (!calendarDate) return "To be confirmed";
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${calendarDate}T00:00:00Z`));
}

function normalizedProvider(): EmailProvider {
  return String(process.env.EMAIL_PROVIDER || "preview").toLowerCase() === "resend" ? "resend" : "preview";
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function formatINR(value: unknown) {
  const number = Number(value ?? 0);
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number.isFinite(number) ? number : 0);
}

function formatNumber(value: unknown) {
  const number = Number(value ?? 0);
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(Number.isFinite(number) ? number : 0);
}
