/**
 * Versioned, deterministic implementation of `New_PO_Methodology.md`.
 *
 * This module deliberately has no database, HTTP, authentication, or UI
 * dependencies. Import adapters should normalize source data into these types;
 * callers can then calculate and audit the same result in every environment.
 */

export const NEW_PO_METHODOLOGY_VERSION = "new-po-methodology/2026-08-02-v1" as const;

export interface NewPoSourceReference {
  fileName?: string;
  sheetName?: string;
  rowNumber?: number;
}

export interface NewPoSalesRow extends NewPoSourceReference {
  salesDate: string;
  styleId: string;
  quantity: number;
  /** Optional operational evidence for forecasts; never used by the exact PO quantity formula. */
  returnsQty?: number;
  /** Optional operational evidence for forecasts; never used by the exact PO quantity formula. */
  cancellationsQty?: number;
  /** Optional operational evidence for forecasts; never used by the exact PO quantity formula. */
  isPromotion?: boolean;
  /** Optional operational evidence for forecasts; never used by the exact PO quantity formula. */
  inStock?: boolean;
  brand?: string;
  businessUnit?: string;
  articleType?: string;
  masterCategory?: string;
  poType?: string;
}

export interface NewPoInventoryRow extends NewPoSourceReference {
  styleId: string;
  inventoryUnits: number;
  brand?: string;
  businessUnit?: string;
  articleType?: string;
  itemStatus?: string;
  styleStatus?: string;
  warehouseId?: string;
  warehouseName?: string;
  inventoryAgeBucket?: string;
  inventoryValueInr?: number;
}

export interface NewPoOpenPoRow extends NewPoSourceReference {
  styleId: string;
  pendingQuantity: number;
  month?: string;
  estimatedShipmentDate?: string;
  vendorName?: string;
  poStatus?: string;
  brand?: string;
  businessUnit?: string;
  articleType?: string;
  masterCategory?: string;
  warehouseId?: string;
  pendingValueInr?: number;
}

export interface NewPoStyleDetailRow extends NewPoSourceReference {
  styleId: string;
  model: string;
  mrpInr: number;
  nlcInr: number;
  bauInr?: number;
  vendorName?: string;
  contactEmail?: string;
  supplierSku?: string;
  hsnCode?: string;
  gstRate?: number;
  supplierGstin?: string;
  supplierState?: string;
  leadTimeDays?: number;
  paymentTerms?: string;
  incoterms?: string;
  moq?: number;
  packSize?: number;
}

export interface NewPoCalculationInput {
  sales: NewPoSalesRow[];
  inventory: NewPoInventoryRow[];
  openPos: NewPoOpenPoRow[];
  styleDetails: NewPoStyleDetailRow[];
}

export interface NewPoCalculationParameters {
  coverDays?: number;
  dohThreshold?: number;
}

export type NewPoRowQualityFlag =
  | "MISSING_INVENTORY"
  | "MISSING_OPEN_PO"
  | "MISSING_STYLE_METADATA"
  | "ZERO_DRR"
  | "NEGATIVE_SALES"
  | "NEGATIVE_INVENTORY"
  | "NEGATIVE_OPEN_PO"
  | "NEGATIVE_PO_ASK";

export interface NewPoCalculationRow {
  styleId: string;
  sumOfSales: number;
  dailyRunRate: number;
  currentInventory: number;
  daysOnHand: number | null;
  eligible: boolean;
  openPoQuantity: number;
  rawPoQtyAsk: number;
  poQtyAsk: number;
  actionablePoQty: number;
  isActionable: boolean;
  model: string | null;
  mrpInr: number | null;
  nlcInr: number | null;
  actionablePoValueInr: number | null;
  qualityFlags: NewPoRowQualityFlag[];
}

export interface NewPoCalculationSummary {
  distinctSalesDays: number;
  salesDateStart: string;
  salesDateEnd: string;
  styleCount: number;
  eligibleStyleCount: number;
  excludedStyleCount: number;
  positiveAskStyleCount: number;
  negativeAskStyleCount: number;
  zeroAskStyleCount: number;
  actionableStyleCount: number;
  signedPoAskUnits: number;
  actionablePoUnits: number;
  actionablePoValueInr: number;
  salesUnits: number;
  inventoryUnits: number;
  openPoUnits: number;
}

export interface NewPoDataQuality {
  missingInventoryStyleIds: string[];
  missingOpenPoStyleIds: string[];
  missingStyleMetadataStyleIds: string[];
  inventoryOnlyStyleIds: string[];
  openPoOnlyStyleIds: string[];
  styleMasterOnlyStyleIds: string[];
  duplicateStyleMasterStyleIds: string[];
  zeroDrrStyleIds: string[];
  negativeSalesStyleIds: string[];
  negativeInventoryStyleIds: string[];
  negativeOpenPoStyleIds: string[];
}

export interface NewPoCalculationResult {
  methodologyVersion: typeof NEW_PO_METHODOLOGY_VERSION;
  parameters: Required<NewPoCalculationParameters>;
  summary: NewPoCalculationSummary;
  dataQuality: NewPoDataQuality;
  rows: NewPoCalculationRow[];
}

export class NewPoCalculationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NewPoCalculationError";
  }
}

function requireSafeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value)) {
    throw new NewPoCalculationError(`${label} must be a safe whole number.`);
  }
  return value;
}

function requireNonNegativeMoney(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new NewPoCalculationError(`${label} must be a non-negative number.`);
  }
  return value;
}

function requireStyleId(styleId: string, label: string) {
  const normalized = styleId?.trim();
  if (!normalized) throw new NewPoCalculationError(`${label} has a blank style ID.`);
  return normalized;
}

function checkedAdd(left: number, right: number, label: string) {
  return requireSafeInteger(left + right, label);
}

function addQuantity(map: Map<string, number>, styleId: string, quantity: number, label: string) {
  const integer = requireSafeInteger(quantity, label);
  map.set(styleId, checkedAdd(map.get(styleId) ?? 0, integer, `${label} aggregate`));
}

/** Excel ROUND(number, 0): nearest integer, with exact halves away from zero. */
export function excelRoundRatio(numerator: number, denominator: number) {
  requireSafeInteger(numerator, "Rounding numerator");
  if (!Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new NewPoCalculationError("Rounding denominator must be a positive safe whole number.");
  }
  const sign = numerator < 0 ? -1 : 1;
  const absolute = Math.abs(numerator);
  const whole = Math.floor(absolute / denominator);
  const remainder = absolute % denominator;
  return sign * (whole + (remainder * 2 >= denominator ? 1 : 0));
}

function roundInr(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function sameNewPoStyleDetail(left: NewPoStyleDetailRow, right: NewPoStyleDetailRow) {
  const normalizedText = (value: unknown) => String(value ?? "").trim().toLocaleLowerCase("en-IN");
  return normalizedText(left.model) === normalizedText(right.model)
    && left.mrpInr === right.mrpInr
    && left.nlcInr === right.nlcInr
    && left.bauInr === right.bauInr
    && normalizedText(left.vendorName) === normalizedText(right.vendorName)
    && normalizedText(left.contactEmail) === normalizedText(right.contactEmail)
    && normalizedText(left.supplierSku) === normalizedText(right.supplierSku)
    && normalizedText(left.hsnCode) === normalizedText(right.hsnCode)
    && left.gstRate === right.gstRate
    && normalizedText(left.supplierGstin) === normalizedText(right.supplierGstin)
    && normalizedText(left.supplierState) === normalizedText(right.supplierState)
    && left.leadTimeDays === right.leadTimeDays
    && normalizedText(left.paymentTerms) === normalizedText(right.paymentTerms)
    && normalizedText(left.incoterms) === normalizedText(right.incoterms)
    && left.moq === right.moq
    && left.packSize === right.packSize;
}

function difference(left: Set<string>, right: Set<string>) {
  return [...left].filter(styleId => !right.has(styleId));
}

function validateIsoDate(date: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new NewPoCalculationError(`${label} must be a normalized YYYY-MM-DD date.`);
  }
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) {
    throw new NewPoCalculationError(`${label} is not a valid calendar date.`);
  }
}

export function calculateNewPoMethodology(
  input: NewPoCalculationInput,
  parameters: NewPoCalculationParameters = {},
): NewPoCalculationResult {
  const coverDays = parameters.coverDays ?? 45;
  const dohThreshold = parameters.dohThreshold ?? 80;
  if (!Number.isSafeInteger(coverDays) || coverDays <= 0) {
    throw new NewPoCalculationError("PO cover days must be a positive whole number.");
  }
  if (!Number.isFinite(dohThreshold) || dohThreshold < 0) {
    throw new NewPoCalculationError("DOH threshold must be a non-negative number.");
  }
  if (!input.sales.length) throw new NewPoCalculationError("Sell-out data is empty.");

  // Map insertion order intentionally preserves Excel UNIQUE's first-seen order.
  const salesByStyle = new Map<string, number>();
  const distinctSalesDates = new Set<string>();
  for (const [index, row] of input.sales.entries()) {
    const styleId = requireStyleId(row.styleId, `Sell-out row ${row.rowNumber ?? index + 2}`);
    validateIsoDate(row.salesDate, `Sell-out row ${row.rowNumber ?? index + 2} sales date`);
    distinctSalesDates.add(row.salesDate);
    addQuantity(salesByStyle, styleId, row.quantity, `Sell-out row ${row.rowNumber ?? index + 2} quantity`);
  }
  if (!distinctSalesDates.size) throw new NewPoCalculationError("Sell-out data has no valid sales days.");

  const inventoryByStyle = new Map<string, number>();
  for (const [index, row] of input.inventory.entries()) {
    const styleId = requireStyleId(row.styleId, `Inventory row ${row.rowNumber ?? index + 2}`);
    addQuantity(inventoryByStyle, styleId, row.inventoryUnits, `Inventory row ${row.rowNumber ?? index + 2} units`);
  }

  const openPoByStyle = new Map<string, number>();
  for (const [index, row] of input.openPos.entries()) {
    const styleId = requireStyleId(row.styleId, `Open PO row ${row.rowNumber ?? index + 2}`);
    addQuantity(openPoByStyle, styleId, row.pendingQuantity, `Open PO row ${row.rowNumber ?? index + 2} pending quantity`);
  }

  const styleDetailsByStyle = new Map<string, NewPoStyleDetailRow>();
  const duplicateStyleMasterStyleIds = new Set<string>();
  for (const [index, row] of input.styleDetails.entries()) {
    const styleId = requireStyleId(row.styleId, `Style detail row ${row.rowNumber ?? index + 2}`);
    const model = row.model?.trim();
    if (!model) throw new NewPoCalculationError(`Style detail row ${row.rowNumber ?? index + 2} has a blank model.`);
    requireNonNegativeMoney(row.mrpInr, `Style ${styleId} MRP`);
    requireNonNegativeMoney(row.nlcInr, `Style ${styleId} NLC`);
    if (row.bauInr !== undefined) requireNonNegativeMoney(row.bauInr, `Style ${styleId} BAU`);
    const normalized = { ...row, styleId, model };
    const existing = styleDetailsByStyle.get(styleId);
    if (existing && !sameNewPoStyleDetail(existing, normalized)) {
      throw new NewPoCalculationError(`Style master contains conflicting records for style ${styleId}.`);
    }
    if (existing) duplicateStyleMasterStyleIds.add(styleId);
    else styleDetailsByStyle.set(styleId, normalized);
  }

  const salesStyleIds = new Set(salesByStyle.keys());
  const inventoryStyleIds = new Set(inventoryByStyle.keys());
  const openPoStyleIds = new Set(openPoByStyle.keys());
  const styleMasterIds = new Set(styleDetailsByStyle.keys());
  const missingInventoryStyleIds = difference(salesStyleIds, inventoryStyleIds);
  const missingOpenPoStyleIds = difference(salesStyleIds, openPoStyleIds);
  const missingStyleMetadataStyleIds = difference(salesStyleIds, styleMasterIds);
  const negativeSalesStyleIds = [...salesByStyle].filter(([, quantity]) => quantity < 0).map(([styleId]) => styleId);
  const negativeInventoryStyleIds = [...inventoryByStyle].filter(([, quantity]) => quantity < 0).map(([styleId]) => styleId);
  const negativeOpenPoStyleIds = [...openPoByStyle].filter(([, quantity]) => quantity < 0).map(([styleId]) => styleId);
  const zeroDrrStyleIds: string[] = [];
  const salesDays = distinctSalesDates.size;

  const rows = [...salesByStyle].map(([styleId, sumOfSales]): NewPoCalculationRow => {
    const currentInventory = inventoryByStyle.get(styleId) ?? 0;
    const openPoQuantity = openPoByStyle.get(styleId) ?? 0;
    const dailyRunRate = sumOfSales / salesDays;
    const daysOnHand = dailyRunRate === 0 ? null : currentInventory / dailyRunRate;
    if (daysOnHand === null) zeroDrrStyleIds.push(styleId);

    const salesTargetNumerator = requireSafeInteger(sumOfSales * coverDays, `Style ${styleId} target numerator`);
    const supplyUnits = checkedAdd(currentInventory, openPoQuantity, `Style ${styleId} supply units`);
    const supplyNumerator = requireSafeInteger(supplyUnits * salesDays, `Style ${styleId} supply numerator`);
    const rawAskNumerator = requireSafeInteger(salesTargetNumerator - supplyNumerator, `Style ${styleId} PO ask numerator`);
    const rawPoQtyAsk = rawAskNumerator / salesDays;
    const poQtyAsk = excelRoundRatio(rawAskNumerator, salesDays);
    const actionablePoQty = Math.max(0, poQtyAsk);
    const eligible = daysOnHand !== null && daysOnHand < dohThreshold;
    const metadata = styleDetailsByStyle.get(styleId);
    const qualityFlags: NewPoRowQualityFlag[] = [];
    if (!inventoryStyleIds.has(styleId)) qualityFlags.push("MISSING_INVENTORY");
    if (!openPoStyleIds.has(styleId)) qualityFlags.push("MISSING_OPEN_PO");
    if (!metadata) qualityFlags.push("MISSING_STYLE_METADATA");
    if (daysOnHand === null) qualityFlags.push("ZERO_DRR");
    if (sumOfSales < 0) qualityFlags.push("NEGATIVE_SALES");
    if (currentInventory < 0) qualityFlags.push("NEGATIVE_INVENTORY");
    if (openPoQuantity < 0) qualityFlags.push("NEGATIVE_OPEN_PO");
    if (poQtyAsk < 0) qualityFlags.push("NEGATIVE_PO_ASK");

    return {
      styleId,
      sumOfSales,
      dailyRunRate,
      currentInventory,
      daysOnHand,
      eligible,
      openPoQuantity,
      rawPoQtyAsk,
      poQtyAsk,
      actionablePoQty,
      isActionable: eligible && actionablePoQty > 0,
      model: metadata?.model ?? null,
      mrpInr: metadata?.mrpInr ?? null,
      nlcInr: metadata?.nlcInr ?? null,
      actionablePoValueInr: metadata ? roundInr(actionablePoQty * metadata.nlcInr) : null,
      qualityFlags,
    };
  });

  const sortedDates = [...distinctSalesDates].sort();
  const actionableRows = rows.filter(row => row.isActionable);
  const positiveAskStyleCount = rows.filter(row => row.poQtyAsk > 0).length;
  const negativeAskStyleCount = rows.filter(row => row.poQtyAsk < 0).length;
  const summary: NewPoCalculationSummary = {
    distinctSalesDays: salesDays,
    salesDateStart: sortedDates[0],
    salesDateEnd: sortedDates.at(-1)!,
    styleCount: rows.length,
    eligibleStyleCount: rows.filter(row => row.eligible).length,
    excludedStyleCount: rows.filter(row => !row.eligible).length,
    positiveAskStyleCount,
    negativeAskStyleCount,
    zeroAskStyleCount: rows.length - positiveAskStyleCount - negativeAskStyleCount,
    actionableStyleCount: actionableRows.length,
    signedPoAskUnits: rows.reduce((sum, row) => checkedAdd(sum, row.poQtyAsk, "Signed PO ask total"), 0),
    actionablePoUnits: actionableRows.reduce((sum, row) => checkedAdd(sum, row.actionablePoQty, "Actionable PO total"), 0),
    actionablePoValueInr: roundInr(actionableRows.reduce((sum, row) => sum + (row.actionablePoValueInr ?? 0), 0)),
    salesUnits: [...salesByStyle.values()].reduce((sum, quantity) => checkedAdd(sum, quantity, "Sales total"), 0),
    inventoryUnits: [...inventoryByStyle.values()].reduce((sum, quantity) => checkedAdd(sum, quantity, "Inventory total"), 0),
    openPoUnits: [...openPoByStyle.values()].reduce((sum, quantity) => checkedAdd(sum, quantity, "Open PO total"), 0),
  };

  return {
    methodologyVersion: NEW_PO_METHODOLOGY_VERSION,
    parameters: { coverDays, dohThreshold },
    summary,
    dataQuality: {
      missingInventoryStyleIds,
      missingOpenPoStyleIds,
      missingStyleMetadataStyleIds,
      inventoryOnlyStyleIds: difference(inventoryStyleIds, salesStyleIds),
      openPoOnlyStyleIds: difference(openPoStyleIds, salesStyleIds),
      styleMasterOnlyStyleIds: difference(styleMasterIds, salesStyleIds),
      duplicateStyleMasterStyleIds: [...duplicateStyleMasterStyleIds],
      zeroDrrStyleIds,
      negativeSalesStyleIds,
      negativeInventoryStyleIds,
      negativeOpenPoStyleIds,
    },
    rows,
  };
}
