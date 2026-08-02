import type { PurchaseOrderRow } from "./db";
import { canOverridePurchaseOrderSendReadiness } from "./po-access";
import { purchaseOrderLineValidationError, type PurchaseOrderLine } from "./purchase-orders";
import type { UserRole } from "./session";

export const SEND_READINESS_OVERRIDE_REASON_MAX = 1_000;

export type PurchaseOrderSendReadinessOverride = {
  missingFields: string[];
  reason: string;
};

export type PurchaseOrderSendReadinessOverrideAudit = PurchaseOrderSendReadinessOverride & {
  actor: { id: string; displayName: string; role: UserRole };
};

export type PurchaseOrderSendReadinessDecision =
  | { ok: true; override: PurchaseOrderSendReadinessOverride | null }
  | { ok: false; status: 400; error: string };

export function todayInIndia(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function isIsoCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

/**
 * PostgreSQL DATE values may be returned as `Date` objects or midnight ISO
 * timestamps depending on the driver. Preserve their calendar-date portion;
 * applying the server's local timezone would shift the date on some hosts.
 */
export function canonicalIsoCalendarDate(value: unknown): string | null {
  if (isIsoCalendarDate(value)) return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    const date = value.toISOString().slice(0, 10);
    return isIsoCalendarDate(date) ? date : null;
  }
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (!match || !Number.isFinite(Date.parse(value))) return null;
  return isIsoCalendarDate(match[1]) ? match[1] : null;
}

export function deliveryDateProblem(value: unknown, orderDate: unknown, today = todayInIndia()) {
  const deliveryDate = canonicalIsoCalendarDate(value);
  const poDate = canonicalIsoCalendarDate(orderDate);
  if (!deliveryDate) return "expected delivery date";
  if (poDate && deliveryDate < poDate) return "expected delivery date on or after the PO date";
  if (deliveryDate < today) return "expected delivery date that is not in the past";
  return null;
}

export function purchaseOrderSendMissing(order: PurchaseOrderRow, today = todayInIndia()): string[] {
  const lines = Array.isArray(order.lines) ? order.lines as PurchaseOrderLine[] : [];
  const missing: string[] = [];
  if (!order.buyer_gstin) missing.push("buyer GSTIN");
  if (!order.supplier_gstin) missing.push("supplier GSTIN");
  if (!order.ship_to) missing.push("ship-to address");
  if (!order.place_of_supply) missing.push("place of supply");
  const deliveryProblem = deliveryDateProblem(order.expected_delivery_date, order.order_date, today);
  if (deliveryProblem) missing.push(deliveryProblem);
  if (!lines.length) missing.push("at least one order line");
  else if (purchaseOrderLineValidationError(lines)) missing.push("valid order-line quantities, costs and commercial fields");
  if (lines.some(line => !line.hsnCode)) missing.push("HSN code on every line");
  if (lines.some(line => !Number.isFinite(Number(line.unitPrice)) || Number(line.unitPrice) <= 0)) {
    missing.push("valid unit cost on every line");
  }
  return missing;
}

export function joinRequiredDetails(values: string[]) {
  if (values.length < 2) return values[0] ?? "the required commercial details";
  return `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}

/**
 * Dispatch-readiness gaps remain hard blocks for every non-Admin role. An
 * Admin must make a separate, explicit and auditable exception decision; the
 * override never changes workflow status, recipient or provider safeguards.
 */
export function purchaseOrderSendReadinessDecision(
  role: UserRole,
  missingFields: string[],
  confirmed: unknown,
  reasonValue: unknown,
): PurchaseOrderSendReadinessDecision {
  if (!missingFields.length) return { ok: true, override: null };
  if (!canOverridePurchaseOrderSendReadiness(role)) {
    return { ok: false, status: 400, error: `This PO is not ready to send. Add ${joinRequiredDetails(missingFields)}.` };
  }
  if (confirmed !== true) {
    return { ok: false, status: 400, error: "Confirm the Admin dispatch-readiness override before continuing." };
  }
  const reason = String(reasonValue ?? "").trim().replace(/\s+/g, " ");
  const words = reason.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (reason.length < 10 || words.length < 2) {
    return { ok: false, status: 400, error: "Enter a meaningful Admin override reason of at least 10 characters and two words." };
  }
  if (reason.length > SEND_READINESS_OVERRIDE_REASON_MAX) {
    return { ok: false, status: 400, error: `Admin override reason must be ${SEND_READINESS_OVERRIDE_REASON_MAX.toLocaleString("en-IN")} characters or fewer.` };
  }
  return { ok: true, override: { missingFields: [...missingFields], reason } };
}

export function purchaseOrderSendReadinessOverrideAudit(
  override: PurchaseOrderSendReadinessOverride | null,
  actor: { id: string; displayName: string; role: UserRole },
): PurchaseOrderSendReadinessOverrideAudit | null {
  return override ? { ...override, actor: { ...actor } } : null;
}
