import type { Recommendation, VendorMasterRow } from "./po-engine";

export const NON_OVERRIDABLE_PO_EXCEPTION_CODES = [
  "MISSING_STYLE_METADATA",
  "MISSING_INVENTORY",
  "MISSING_VENDOR",
  "MISSING_PRICE",
  "INVALID_NEGATIVE_SALES",
  "INVALID_NEGATIVE_INVENTORY",
  "INVALID_NEGATIVE_OPEN_PO",
] as const;

const PLACEHOLDER_SUPPLIER_NAMES = new Set([
  "",
  "supplier mapping required",
  "unassigned",
  "unknown",
  "n/a",
  "na",
  "not assigned",
  "not mapped",
]);

const clean = (value: unknown) => String(value ?? "").trim();
const normalized = (value: unknown) => clean(value).toLocaleLowerCase("en-IN");

export interface StyleCoverAudit {
  totalSalesUnits: number;
  uniqueOrderDays: number;
  dailyRunRate: number;
  coverDays: number;
  targetStockUnits: number;
  currentInventory: number;
  openPoQuantity: number;
  signedPoQtyAsk: number;
  actionablePoQty: number;
  daysOnHand: number | null;
  dohThreshold: number;
  eligible: boolean;
}

export function isStyleCoverRecommendation(row: Recommendation) {
  return row.calculationMethod === "style_drr_cover_v1";
}

/** Values that are explanatory placeholders, never legal supplier identities. */
export function isPlaceholderSupplier(value: unknown) {
  return PLACEHOLDER_SUPPLIER_NAMES.has(normalized(value));
}

export function nonOverridablePoException(row: Recommendation) {
  return row.exceptions.find(exception =>
    (NON_OVERRIDABLE_PO_EXCEPTION_CODES as readonly string[]).includes(exception.code),
  ) ?? null;
}

export function purchaseOrderBlockReason(row: Recommendation) {
  const exception = nonOverridablePoException(row);
  if (exception) return exception;
  if (isStyleCoverRecommendation(row) && row.dohEligible !== true) {
    return {
      code: "METHODOLOGY_DOH_INELIGIBLE",
      severity: "critical" as const,
      message: "This style is not below the methodology DOH gate, so it cannot be converted into a PO.",
    };
  }
  if (isStyleCoverRecommendation(row) && (
    !Number.isFinite(Number(row.signedPoQtyAsk))
    || Number(row.signedPoQtyAsk) <= 0
    || !Number.isFinite(Number(row.suggestedPoQty))
    || Number(row.suggestedPoQty) <= 0
  )) {
    return {
      code: "METHODOLOGY_NO_POSITIVE_ASK",
      severity: "critical" as const,
      message: "The approved methodology produced no positive actionable PO ask for this style.",
    };
  }
  if (isStyleCoverRecommendation(row) && (
    !clean(row.productName)
    || row.mrpInr === null
    || row.mrpInr === undefined
    || !Number.isFinite(Number(row.mrpInr))
    || Number(row.mrpInr) <= 0
  )) {
    return {
      code: "MISSING_STYLE_METADATA",
      severity: "critical" as const,
      message: "The style master must contain a model or product name and a valid MRP.",
    };
  }
  if (isPlaceholderSupplier(row.vendor)) {
    return {
      code: "MISSING_VENDOR",
      severity: "critical" as const,
      message: "No real supplier is mapped to this style.",
    };
  }
  if (row.unitPrice === null || !Number.isFinite(Number(row.unitPrice)) || Number(row.unitPrice) <= 0) {
    return {
      code: "MISSING_PRICE",
      severity: "critical" as const,
      message: "A valid INR NLC or unit cost is required before a PO can be created.",
    };
  }
  return null;
}

/**
 * Returns the supplier/cost blocker that the governed inline PO flow may fix.
 * The methodology emits MISSING_STYLE_METADATA when model, MRP or NLC is absent;
 * if model and MRP are already valid, the inline mapping may safely supply NLC.
 * Inventory and malformed source-data exceptions always remain hard blockers.
 */
export function supplierResolutionBlockReason(row: Recommendation, supplierMasterMapped = true) {
  if (!Number.isFinite(Number(row.suggestedPoQty)) || Number(row.suggestedPoQty) <= 0) return null;
  const hardSourceIssue = row.exceptions.some(exception => [
    "MISSING_INVENTORY",
    "INVALID_NEGATIVE_SALES",
    "INVALID_NEGATIVE_INVENTORY",
    "INVALID_NEGATIVE_OPEN_PO",
  ].includes(exception.code));
  if (hardSourceIssue) return null;
  if (isStyleCoverRecommendation(row) && (
    row.dohEligible !== true
    || !Number.isFinite(Number(row.signedPoQtyAsk))
    || Number(row.signedPoQtyAsk) <= 0
  )) return null;
  const catalogueReady = Boolean(clean(row.productName))
    && Number.isFinite(Number(row.mrpInr))
    && Number(row.mrpInr) > 0;
  if (!catalogueReady) return null;
  const supplierMissing = isPlaceholderSupplier(row.vendor)
    || !supplierMasterMapped
    || row.exceptions.some(exception => exception.code === "MISSING_VENDOR");
  if (supplierMissing) return {
    code: "MISSING_VENDOR",
    severity: "critical" as const,
    message: "Confirm a real supplier and positive INR NLC to create this draft PO.",
  };
  const priceMissing = row.unitPrice === null
    || !Number.isFinite(Number(row.unitPrice))
    || Number(row.unitPrice) <= 0
    || row.exceptions.some(exception => exception.code === "MISSING_PRICE" || exception.code === "MISSING_STYLE_METADATA");
  if (priceMissing) return {
    code: "MISSING_PRICE",
    severity: "critical" as const,
    message: "Confirm a positive INR NLC to create this draft PO.",
  };
  return null;
}

/**
 * A recommendation can only become a PO when its supplier has an applicable
 * row in the immutable supplier master saved with the planning batch.
 */
export function hasApplicableSupplierMaster(row: Recommendation, vendorMaster: VendorMasterRow[]) {
  if (isPlaceholderSupplier(row.vendor)) return false;
  const vendor = normalized(row.vendor);
  const styleId = clean(row.styleId || row.sku);
  const sku = clean(row.sku);
  const warehouse = clean(row.warehouse);
  return vendorMaster.some(rule => {
    if (normalized(rule.vendor) !== vendor) return false;
    const ruleSku = clean(rule.sku);
    const ruleStyle = clean(rule.styleId);
    const productMatches = (!ruleSku && !ruleStyle)
      || ruleSku === sku
      || ruleSku === styleId
      || ruleStyle === styleId;
    const warehouseMatches = !clean(rule.warehouse) || clean(rule.warehouse) === warehouse;
    return productMatches && warehouseMatches;
  });
}

export function assertRecommendationCanBecomePo(row: Recommendation, vendorMaster: VendorMasterRow[]) {
  const block = purchaseOrderBlockReason(row);
  if (block) throw new Error(`${block.message} Style ${row.styleId || row.sku} cannot be added to a draft PO.`);
  if (!hasApplicableSupplierMaster(row, vendorMaster)) {
    throw new Error(`Supplier ${row.vendor} is not mapped to style ${row.styleId || row.sku} in this planning batch. Complete the supplier master before creating a PO.`);
  }
}

export function styleCoverAudit(row: Recommendation): StyleCoverAudit | null {
  if (!isStyleCoverRecommendation(row)) return null;
  const totalSalesUnits = Number(row.totalSalesUnits ?? 0);
  const uniqueOrderDays = Number(row.uniqueOrderDays ?? 0);
  const dailyRunRate = uniqueOrderDays > 0
    ? totalSalesUnits / uniqueOrderDays
    : Number(row.dailyRunRate ?? 0);
  const coverDays = Number(row.poCoverDays ?? row.reviewPeriodDays ?? 0);
  const signedPoQtyAsk = Number(row.signedPoQtyAsk ?? row.rawPoQty ?? 0);
  const eligible = row.dohEligible === true;
  return {
    totalSalesUnits,
    uniqueOrderDays,
    dailyRunRate,
    coverDays,
    targetStockUnits: dailyRunRate * coverDays,
    currentInventory: Number(row.currentInventory ?? 0),
    openPoQuantity: Number(row.openPoQty ?? 0),
    signedPoQtyAsk,
    actionablePoQty: eligible ? Math.max(0, signedPoQtyAsk) : 0,
    daysOnHand: row.daysOnHand === null ? null : Number(row.daysOnHand),
    dohThreshold: Number(row.dohThreshold ?? 80),
    eligible,
  };
}
