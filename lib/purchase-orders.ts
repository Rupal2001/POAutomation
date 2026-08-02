import { Recommendation } from "./po-engine";

export const PO_STATUSES = ["draft", "pending_approval", "approved", "issued", "partially_received", "received", "closed", "cancelled"] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

export interface PurchaseOrderLine {
  lineId: string;
  sku: string;
  supplierSku?: string;
  description?: string;
  quantity: number;
  receivedQty: number;
  unitPrice: number;
  currency: string;
  expectedDeliveryDate?: string;
  sourceRecommendation?: Pick<Recommendation, "dailyRunRate" | "safetyStock" | "inventoryPosition" | "explanation">;
  overrideReason?: string;
  hsnCode?: string;
  gstRate?: number;
  /** Supplier execution controls captured when the recommendation becomes a PO. */
  moq?: number;
  packSize?: number;
  /** Immutable supplier-master provenance captured when this draft was made. */
  supplierMappingId?: string;
  supplierMappingRevision?: number;
}

function optionalTrimmed(value: unknown) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

/** Keeps only the PO-line contract and canonicalizes JSON scalar types. */
export function normalizePurchaseOrderLines(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(candidate => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
    const line = candidate as Record<string, unknown>;
    const source = line.sourceRecommendation && typeof line.sourceRecommendation === "object" && !Array.isArray(line.sourceRecommendation)
      ? line.sourceRecommendation as Record<string, unknown>
      : null;
    return {
      lineId: String(line.lineId ?? "").trim(),
      sku: String(line.sku ?? "").trim(),
      supplierSku: optionalTrimmed(line.supplierSku),
      description: optionalTrimmed(line.description),
      quantity: Number(line.quantity),
      receivedQty: Number(line.receivedQty ?? 0),
      unitPrice: roundMoney(Number(line.unitPrice)),
      currency: String(line.currency ?? "INR").trim().toUpperCase(),
      expectedDeliveryDate: optionalTrimmed(line.expectedDeliveryDate),
      hsnCode: optionalTrimmed(line.hsnCode),
      gstRate: Number(line.gstRate ?? 0),
      moq: line.moq === undefined || line.moq === null ? undefined : Number(line.moq),
      packSize: line.packSize === undefined || line.packSize === null ? undefined : Number(line.packSize),
      supplierMappingId: optionalTrimmed(line.supplierMappingId),
      supplierMappingRevision: line.supplierMappingRevision === undefined || line.supplierMappingRevision === null
        ? undefined
        : Number(line.supplierMappingRevision),
      overrideReason: optionalTrimmed(line.overrideReason),
      sourceRecommendation: source ? {
        dailyRunRate: Number(source.dailyRunRate ?? 0),
        safetyStock: Number(source.safetyStock ?? 0),
        inventoryPosition: Number(source.inventoryPosition ?? 0),
        explanation: String(source.explanation ?? ""),
      } : undefined,
    } satisfies PurchaseOrderLine;
  });
}

/**
 * The client may edit quantity and commercial values, but it must not remove or
 * weaken the supplier controls captured on the persisted PO line.
 */
export function preservePurchaseOrderLineControls(
  incoming: PurchaseOrderLine[],
  persistedValue: unknown,
) {
  const persisted = normalizePurchaseOrderLines(persistedValue);
  if (!Array.isArray(persisted)) return incoming;
  const controlsByLine = new Map((persisted as PurchaseOrderLine[]).map(line => [line.lineId, {
    moq: line.moq,
    packSize: line.packSize,
    supplierMappingId: line.supplierMappingId,
    supplierMappingRevision: line.supplierMappingRevision,
  }]));
  return incoming.map(line => {
    const controls = controlsByLine.get(line.lineId);
    return controls ? { ...line, ...controls } : line;
  });
}

function validIsoCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function purchaseOrderLineValidationError(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return "Add at least one purchase-order line.";
  if (value.length > 2_000) return "A purchase order cannot contain more than 2,000 lines.";
  const lineIds = new Set<string>();
  let merchandiseValue = 0;
  for (const [index, candidate] of value.entries()) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return `Line ${index + 1} is not valid.`;
    const line = candidate as Partial<PurchaseOrderLine>;
    const label = String(line.sku ?? "").trim() || `line ${index + 1}`;
    const lineId = String(line.lineId ?? "").trim();
    if (!lineId || !String(line.sku ?? "").trim()) return `Line ${index + 1} needs a line ID and SKU.`;
    if (lineIds.has(lineId)) return `Line ID ${lineId} appears more than once.`;
    lineIds.add(lineId);
    if (lineId.length > 100 || String(line.sku).length > 200 || String(line.supplierSku ?? "").length > 200
      || String(line.supplierMappingId ?? "").length > 100
      || String(line.description ?? "").length > 1_000 || String(line.overrideReason ?? "").length > 1_000) {
      return `${label} contains text above the allowed length.`;
    }
    if (!Number.isSafeInteger(Number(line.quantity)) || Number(line.quantity) <= 0 || Number(line.quantity) > 1_000_000_000) return `${label} needs a positive whole-unit quantity within the allowed range.`;
    if (!Number.isSafeInteger(Number(line.receivedQty ?? 0)) || Number(line.receivedQty ?? 0) < 0 || Number(line.receivedQty ?? 0) > Number(line.quantity)) {
      return `${label} has an invalid received quantity.`;
    }
    if (!Number.isFinite(Number(line.unitPrice)) || Number(line.unitPrice) <= 0 || Number(line.unitPrice) > 1_000_000_000) {
      return `${label} needs a valid positive INR unit cost.`;
    }
    if (String(line.currency ?? "INR").toUpperCase() !== "INR") return `${label} must use INR.`;
    const gstRate = Number(line.gstRate ?? 0);
    if (!Number.isFinite(gstRate) || gstRate < 0 || gstRate > 100) return `${label} has an invalid GST rate.`;
    const moq = line.moq;
    if (moq !== undefined && (!Number.isSafeInteger(Number(moq)) || Number(moq) <= 0 || Number(moq) > 1_000_000_000)) {
      return `${label} has an invalid persisted MOQ.`;
    }
    if (moq !== undefined && Number(line.quantity) < Number(moq)) {
      return `${label} must keep at least the mapped MOQ of ${Number(moq).toLocaleString("en-IN")} units.`;
    }
    const packSize = line.packSize;
    if (packSize !== undefined && (!Number.isSafeInteger(Number(packSize)) || Number(packSize) <= 0 || Number(packSize) > 1_000_000_000)) {
      return `${label} has an invalid persisted pack size.`;
    }
    if (packSize !== undefined && Number(line.quantity) % Number(packSize) !== 0) {
      return `${label} must remain a multiple of the mapped pack size of ${Number(packSize).toLocaleString("en-IN")} units.`;
    }
    if (line.supplierMappingRevision !== undefined
      && (!Number.isSafeInteger(Number(line.supplierMappingRevision)) || Number(line.supplierMappingRevision) < 1)) {
      return `${label} has an invalid supplier mapping revision.`;
    }
    if (line.hsnCode && !/^\d{4,8}$/.test(String(line.hsnCode).trim())) return `${label} needs a 4–8 digit HSN code.`;
    if (line.expectedDeliveryDate && !validIsoCalendarDate(line.expectedDeliveryDate)) return `${label} has an invalid expected-delivery date.`;
    if (line.sourceRecommendation) {
      const source = line.sourceRecommendation;
      if (![source.dailyRunRate, source.safetyStock, source.inventoryPosition].every(number => Number.isFinite(Number(number)))) {
        return `${label} has invalid source recommendation evidence.`;
      }
      if (String(source.explanation ?? "").length > 2_000) return `${label} has source recommendation evidence above the allowed length.`;
    }
    merchandiseValue += Number(line.quantity) * Number(line.unitPrice);
    if (!Number.isFinite(merchandiseValue) || merchandiseValue > 1_000_000_000_000_000) {
      return "The merchandise subtotal is above the supported INR amount.";
    }
  }
  return null;
}

export function nonNegativeMoney(value: unknown, label: string) {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000_000) {
    throw new Error(`${label} must be a non-negative INR amount.`);
  }
  return roundMoney(amount);
}

export function calculateTotals(lines: PurchaseOrderLine[], freight = 0, discount = 0, tax = 0) {
  const subtotal = roundMoney(lines.reduce((sum, line) => sum + Math.max(0, line.quantity) * Math.max(0, line.unitPrice), 0));
  const normalizedFreight = roundMoney(Math.max(0, freight));
  const normalizedDiscount = roundMoney(Math.max(0, discount));
  const normalizedTax = roundMoney(Math.max(0, tax));
  const total = Math.max(0, subtotal + normalizedFreight - normalizedDiscount + normalizedTax);
  return { subtotal, total: roundMoney(total) };
}

export function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

export function canTransition(from: string, to: string) {
  const transitions: Record<string, string[]> = {
    draft: ["pending_approval", "cancelled"],
    pending_approval: ["draft", "approved", "cancelled"],
    approved: ["issued", "draft", "cancelled"],
    issued: ["partially_received", "received", "cancelled"],
    partially_received: ["partially_received", "received"],
    received: ["closed"],
    closed: [], cancelled: [],
  };
  return transitions[from]?.includes(to) ?? false;
}

export function nextPoNumber(sequence: number, date = new Date()) {
  return `PO-${date.toISOString().slice(0, 10).replaceAll("-", "")}-${String(sequence).padStart(4, "0")}`;
}
