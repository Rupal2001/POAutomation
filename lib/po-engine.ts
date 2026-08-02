/** Core, deterministic replenishment planning. No database or UI dependencies. */
import { forecastDemand, ForecastModel, ForecastResult } from "./forecast";
import { generateStyleCoverRecommendations } from "./new-po-engine";

export type ForecastMethod = ForecastModel;

export interface SalesRow {
  marketplace?: string;
  date: string;
  sku: string;
  vendor: string;
  warehouse?: string;
  unitsSold: number;
  returnsQty?: number;
  cancellationsQty?: number;
  isPromotion?: boolean;
  discountPct?: number;
  inStock?: boolean;
  category?: string;
  brand?: string;
  styleId?: string;
  size?: string;
  productName?: string;
  articleType?: string;
  gender?: string;
  colour?: string;
  mrpInr?: number;
  sellingPriceInr?: number;
  lifecycleStage?: string;
  availabilityStatus?: string;
  launchDate?: string;
  endOfLifeDate?: string;
  marketplaceSeller?: string;
  sourceUrl?: string;
  priceCapturedOn?: string;
  catalogueDataProvenance?: string;
  commercialDataProvenance?: string;
}

export interface InventoryRow {
  marketplace?: string;
  sku: string;
  vendor: string;
  warehouse?: string;
  snapshotDate?: string;
  currentInventory: number;
  reservedQty?: number;
  backorderQty?: number;
  category?: string;
  brand?: string;
  styleId?: string;
  size?: string;
  productName?: string;
  articleType?: string;
  gender?: string;
  colour?: string;
  mrpInr?: number;
  sellingPriceInr?: number;
  lifecycleStage?: string;
  availabilityStatus?: string;
  launchDate?: string;
  endOfLifeDate?: string;
  marketplaceSeller?: string;
  sourceUrl?: string;
  priceCapturedOn?: string;
  catalogueDataProvenance?: string;
  commercialDataProvenance?: string;
}

export interface OpenPoRow {
  marketplace?: string;
  sku: string;
  vendor: string;
  warehouse?: string;
  openPoQty: number;
  expectedDate?: string;
  poNumber?: string;
  status?: string;
  productName?: string;
  brand?: string;
  category?: string;
  styleId?: string;
  size?: string;
  articleType?: string;
  gender?: string;
  colour?: string;
  mrpInr?: number;
  sellingPriceInr?: number;
  lifecycleStage?: string;
  availabilityStatus?: string;
  launchDate?: string;
  endOfLifeDate?: string;
  marketplaceSeller?: string;
  sourceUrl?: string;
  priceCapturedOn?: string;
  catalogueDataProvenance?: string;
  commercialDataProvenance?: string;
}

export interface VendorMasterRow {
  marketplace?: string;
  vendor: string;
  sku?: string;
  warehouse?: string;
  supplierSku?: string;
  category?: string;
  brand?: string;
  styleId?: string;
  size?: string;
  moq?: number;
  packSize?: number;
  maxOrderQty?: number;
  leadTimeDays?: number;
  reviewPeriodDays?: number;
  safetyStock?: number;
  serviceLevel?: number;
  unitPrice?: number;
  currency?: string;
  minimumOrderValue?: number;
  freightFreeThreshold?: number;
  paymentTerms?: string;
  incoterms?: string;
  contactEmail?: string;
  gstin?: string;
  supplierState?: string;
  hsnCode?: string;
  gstRate?: number;
  productName?: string;
  articleType?: string;
  gender?: string;
  colour?: string;
  mrpInr?: number;
  sellingPriceInr?: number;
  lifecycleStage?: string;
  availabilityStatus?: string;
  launchDate?: string;
  endOfLifeDate?: string;
  marketplaceSeller?: string;
  sourceUrl?: string;
  priceCapturedOn?: string;
  catalogueDataProvenance?: string;
  commercialDataProvenance?: string;
}

export interface PlanningSettings {
  coverageDays: number;
  calculationMethod?: "style_drr_cover_v1" | "advanced_forecast_v1";
  methodologyVersion?: string;
  dohThreshold?: number;
  forecastMethod?: ForecastMethod;
  lookbackDays?: number | null;
  defaultLeadTimeDays?: number;
  defaultReviewPeriodDays?: number;
  defaultServiceLevel?: number;
  includeLateOpenPos?: boolean;
  plannedPromotionUpliftPct?: number;
  returnRecoveryRate?: number;
}

export type ExceptionSeverity = "critical" | "warning" | "info";

export interface PlanningException {
  code: string;
  severity: ExceptionSeverity;
  message: string;
}

export interface Recommendation {
  marketplace: "Myntra";
  vendor: string;
  sku: string;
  warehouse: string;
  supplierSku?: string;
  category?: string;
  brand?: string;
  styleId?: string;
  size?: string;
  productName?: string;
  articleType?: string;
  gender?: string;
  colour?: string;
  mrpInr?: number;
  sellingPriceInr?: number;
  lifecycleStage?: string;
  availabilityStatus?: string;
  launchDate?: string;
  endOfLifeDate?: string;
  marketplaceSeller?: string;
  sourceUrl?: string;
  priceCapturedOn?: string;
  catalogueDataProvenance?: string;
  commercialDataProvenance?: string;
  forecastMethod: ForecastMethod;
  forecastModelLabel: string;
  forecastSelectionStrategy: "fixed" | "champion" | "ensemble";
  forecastContributors: ForecastResult["contributors"];
  forecastAccuracy: number | null;
  forecastWmape: number | null;
  forecastBias: number | null;
  forecastLowerBound: number;
  forecastUpperBound: number;
  /** Model-derived rate shown as supporting forecast evidence. */
  forecastDailyRate?: number;
  forecastQuality: "high" | "medium" | "low";
  forecastConfidenceScore: number;
  forecastQualityReasons: string[];
  backtestDays: number;
  backtestActualUnits: number;
  backtestForecastUnits: number;
  backtestAbsoluteErrorUnits: number;
  backtestSignedErrorUnits: number;
  returnRate: number;
  cancellationRate: number;
  historicalPromotionUplift: number;
  plannedPromotionUplift: number;
  promotionAdjustedDays: number;
  stockoutDaysInHistory: number;
  dataLatencyDays: number;
  dailyRunRate: number;
  demandVariability: number;
  forecastErrorRmse: number;
  currentInventory: number;
  reservedQty: number;
  backorderQty: number;
  openPoQty: number;
  lateOpenPoQty: number;
  overdueOpenPoQty: number;
  inventoryPosition: number;
  leadTimeDays: number;
  reviewPeriodDays: number;
  safetyStock: number;
  requiredStock: number;
  daysOnHand: number | null;
  projectedStockoutDate: string | null;
  reorderByDate: string | null;
  expectedDeliveryDate: string;
  rawPoQty: number;
  suggestedPoQty: number;
  unitPrice: number | null;
  currency: string;
  estimatedValue: number | null;
  estimatedLostSalesUnits: number;
  stockoutExposureDays: number;
  estimatedGmvAtRisk: number | null;
  estimatedGmvAtRiskLower: number | null;
  estimatedGmvAtRiskUpper: number | null;
  currentInventoryInvestment: number | null;
  plannedInventoryInvestment: number | null;
  excessInventoryUnits: number;
  excessInventoryValue: number | null;
  explanation: string;
  exceptions: PlanningException[];
  calculationMethod?: "style_drr_cover_v1" | "advanced_forecast_v1";
  methodologyVersion?: string;
  uniqueOrderDays?: number;
  totalSalesUnits?: number;
  poCoverDays?: number;
  dohThreshold?: number;
  dohEligible?: boolean;
  signedPoQtyAsk?: number;
}

export interface EngineInput {
  sales: SalesRow[];
  inventory: InventoryRow[];
  openPos: OpenPoRow[];
  vendorMaster?: VendorMasterRow[];
  coverageDays: number;
  lookbackDays?: number | null;
  settings?: Partial<PlanningSettings>;
  asOfDate?: string;
}

const DAY = 86_400_000;
const warehouseOf = (v?: string) => v?.trim() || "MAIN";
const key = (warehouse: string, sku: string, vendor: string) => `${warehouse}::::${sku}::::${vendor}`;
const demandKey = (warehouse: string, sku: string) => `${warehouse}::::${sku}`;
const round = (n: number, places = 2) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function addDays(date: string, days: number) {
  return isoDay(Date.parse(`${date}T00:00:00Z`) + Math.max(0, Math.ceil(days)) * DAY);
}

function zScore(serviceLevel: number) {
  if (serviceLevel >= 0.99) return 2.326;
  if (serviceLevel >= 0.98) return 2.054;
  if (serviceLevel >= 0.95) return 1.645;
  if (serviceLevel >= 0.9) return 1.282;
  if (serviceLevel >= 0.85) return 1.036;
  return 0.842;
}

type DemandStats = ForecastResult;
type ProductMetadata = Pick<Recommendation,
  "category" | "brand" | "styleId" | "size" | "productName" | "articleType" | "gender" | "colour" |
  "mrpInr" | "sellingPriceInr" | "lifecycleStage" | "availabilityStatus" | "launchDate" | "endOfLifeDate" |
  "marketplaceSeller" | "sourceUrl" | "priceCapturedOn" | "catalogueDataProvenance" | "commercialDataProvenance"
>;

function computeDemandStats(
  sales: SalesRow[],
  method: ForecastMethod,
  lookbackDays?: number | null,
  plannedPromotionUpliftPct = 0,
  returnRecoveryRate = 0.8,
  asOfDate?: string,
): Map<string, DemandStats> {
  const grouped = new Map<string, SalesRow[]>();
  for (const row of sales) {
    const dateMs = Date.parse(`${row.date}T00:00:00Z`);
    if (!Number.isFinite(dateMs)) continue;
    const k = demandKey(warehouseOf(row.warehouse), row.sku);
    const list = grouped.get(k) ?? [];
    list.push(row);
    grouped.set(k, list);
  }

  const result = new Map<string, DemandStats>();
  for (const [k, entries] of grouped) {
    result.set(k, forecastDemand(entries, method, lookbackDays, plannedPromotionUpliftPct, returnRecoveryRate, asOfDate));
  }
  return result;
}

function ruleSpecificity(rule: VendorMasterRow, warehouse: string, sku: string) {
  if (rule.warehouse && warehouseOf(rule.warehouse) !== warehouse) return -1;
  if (rule.sku && rule.sku !== sku) return -1;
  return (rule.sku ? 2 : 0) + (rule.warehouse ? 1 : 0);
}

function findRule(rules: VendorMasterRow[], vendor: string, warehouse: string, sku: string) {
  const matching = rules
    .filter((r) => r.vendor === vendor)
    .map((r) => ({ r, score: ruleSpecificity(r, warehouse, sku) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score);
  if (!matching.length) return undefined;
  const merged: VendorMasterRow = { vendor };
  for (const { r } of matching) for (const [field, value] of Object.entries(r)) if (value !== undefined && value !== "") (merged as any)[field] = value;
  return merged;
}

function projectAvailability(asOf: string, horizonDays: number, startingStock: number, dailyDemand: number, incoming: OpenPoRow[], newReceiptLeadDays: number) {
  let stock = startingStock; let firstStockout: string | null = null; let exposureLostUnits = 0; let exposureShortageDays = 0;
  const receipts = new Map<string, number>();
  for (const po of incoming) if (po.expectedDate) receipts.set(po.expectedDate, (receipts.get(po.expectedDate) ?? 0) + po.openPoQty);
  for (let day = 1; day <= horizonDays; day++) {
    const date = addDays(asOf, day); stock += receipts.get(date) ?? 0;
    const shortfall = Math.max(0, dailyDemand - Math.max(0, stock));
    if (shortfall > 0 && firstStockout === null) firstStockout = date;
    // A newly raised PO is assumed available at the start of its delivery day.
    // Confirmed earlier receipts can therefore close an interim shortage.
    if (shortfall > 0 && day < newReceiptLeadDays) { exposureLostUnits += shortfall; exposureShortageDays++; }
    stock = Math.max(0, stock - dailyDemand);
  }
  return { firstStockout, exposureLostUnits, exposureShortageDays };
}

function applyOrderConstraints(qty: number, rule?: VendorMasterRow): number {
  if (qty <= 0) return 0;
  let out = qty;
  if (rule?.packSize && rule.packSize > 0) out = Math.ceil(out / rule.packSize) * rule.packSize;
  if (rule?.moq && rule.moq > 0 && out < rule.moq) out = rule.moq;
  if (rule?.maxOrderQty && rule.maxOrderQty > 0) out = Math.min(out, rule.maxOrderQty);
  return Math.round(out);
}

export function generateRecommendations(input: EngineInput): Recommendation[] {
  if ((input.settings?.calculationMethod ?? "advanced_forecast_v1") === "style_drr_cover_v1") {
    // Loaded lazily at module initialization through a same-package require would
    // break ESM builds. The implementation is imported at the bottom-level import
    // section instead; this branch keeps historical plan versions reproducible.
    return generateStyleCoverRecommendations(input);
  }
  const settings: PlanningSettings = {
    coverageDays: input.coverageDays,
    forecastMethod: input.settings?.forecastMethod ?? "average",
    lookbackDays: input.settings?.lookbackDays ?? input.lookbackDays,
    defaultLeadTimeDays: input.settings?.defaultLeadTimeDays ?? 14,
    defaultReviewPeriodDays: input.settings?.defaultReviewPeriodDays ?? input.coverageDays,
    defaultServiceLevel: input.settings?.defaultServiceLevel ?? 0.95,
    includeLateOpenPos: input.settings?.includeLateOpenPos ?? false,
    plannedPromotionUpliftPct: input.settings?.plannedPromotionUpliftPct ?? 0,
    returnRecoveryRate: input.settings?.returnRecoveryRate ?? 0.8,
  };
  const asOf = input.asOfDate ?? new Date().toISOString().slice(0, 10);
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  const method = settings.forecastMethod ?? "average";
  const demand = computeDemandStats(input.sales, method, settings.lookbackDays, settings.plannedPromotionUpliftPct, settings.returnRecoveryRate, asOf);

  const metadata = new Map<string, ProductMetadata>();
  for (const row of [...input.sales, ...input.inventory, ...input.openPos]) {
    const k = key(warehouseOf(row.warehouse), row.sku, row.vendor);
    const old = metadata.get(k) ?? {};
    metadata.set(k, {
      category: row.category ?? old.category, brand: row.brand ?? old.brand, styleId: row.styleId ?? old.styleId,
      size: row.size ?? old.size, productName: row.productName ?? old.productName, articleType: row.articleType ?? old.articleType,
      gender: row.gender ?? old.gender, colour: row.colour ?? old.colour, mrpInr: row.mrpInr ?? old.mrpInr,
      sellingPriceInr: row.sellingPriceInr ?? old.sellingPriceInr, lifecycleStage: row.lifecycleStage ?? old.lifecycleStage,
      availabilityStatus: row.availabilityStatus ?? old.availabilityStatus, launchDate: row.launchDate ?? old.launchDate,
      endOfLifeDate: row.endOfLifeDate ?? old.endOfLifeDate,
      marketplaceSeller: row.marketplaceSeller ?? old.marketplaceSeller, sourceUrl: row.sourceUrl ?? old.sourceUrl,
      priceCapturedOn: row.priceCapturedOn ?? old.priceCapturedOn,
      catalogueDataProvenance: row.catalogueDataProvenance ?? old.catalogueDataProvenance,
      commercialDataProvenance: row.commercialDataProvenance ?? old.commercialDataProvenance,
    });
  }

  const inventory = new Map<string, { onHand: number; reserved: number; backorders: number }>();
  for (const r of input.inventory) {
    const k = key(warehouseOf(r.warehouse), r.sku, r.vendor);
    const old = inventory.get(k) ?? { onHand: 0, reserved: 0, backorders: 0 };
    old.onHand += Number.isFinite(r.currentInventory) ? r.currentInventory : 0;
    old.reserved += Number.isFinite(r.reservedQty) ? r.reservedQty! : 0;
    old.backorders += Number.isFinite(r.backorderQty) ? r.backorderQty! : 0;
    inventory.set(k, old);
  }

  const incoming = new Map<string, OpenPoRow[]>();
  for (const r of input.openPos) {
    const k = key(warehouseOf(r.warehouse), r.sku, r.vendor);
    const list = incoming.get(k) ?? [];
    list.push(r);
    incoming.set(k, list);
  }

  const salesKeys = new Set(input.sales.map(row => key(warehouseOf(row.warehouse), row.sku, row.vendor)));
  const allKeys = new Set([...salesKeys, ...inventory.keys(), ...incoming.keys()]);
  const rows: Recommendation[] = [];
  for (const k of allKeys) {
    const [warehouse, sku, vendor] = k.split("::::");
    const stats = demand.get(demandKey(warehouse, sku)) ?? forecastDemand([], method);
    const baseMeta = metadata.get(k) ?? {};
    const inv = inventory.get(k) ?? { onHand: 0, reserved: 0, backorders: 0 };
    const rule = findRule(input.vendorMaster ?? [], vendor, warehouse, sku);
    const meta: ProductMetadata = {
      ...baseMeta,
      category: baseMeta.category ?? rule?.category,
      brand: baseMeta.brand ?? rule?.brand,
      styleId: baseMeta.styleId ?? rule?.styleId,
      size: baseMeta.size ?? rule?.size,
      productName: baseMeta.productName ?? rule?.productName,
      articleType: baseMeta.articleType ?? rule?.articleType,
      gender: baseMeta.gender ?? rule?.gender,
      colour: baseMeta.colour ?? rule?.colour,
      mrpInr: baseMeta.mrpInr ?? rule?.mrpInr,
      sellingPriceInr: baseMeta.sellingPriceInr ?? rule?.sellingPriceInr,
      lifecycleStage: baseMeta.lifecycleStage ?? rule?.lifecycleStage,
      availabilityStatus: baseMeta.availabilityStatus ?? rule?.availabilityStatus,
      launchDate: baseMeta.launchDate ?? rule?.launchDate,
      endOfLifeDate: baseMeta.endOfLifeDate ?? rule?.endOfLifeDate,
      marketplaceSeller: baseMeta.marketplaceSeller ?? rule?.marketplaceSeller,
      sourceUrl: baseMeta.sourceUrl ?? rule?.sourceUrl,
      priceCapturedOn: baseMeta.priceCapturedOn ?? rule?.priceCapturedOn,
      catalogueDataProvenance: baseMeta.catalogueDataProvenance ?? rule?.catalogueDataProvenance,
      commercialDataProvenance: baseMeta.commercialDataProvenance ?? rule?.commercialDataProvenance,
    };
    const leadTime = rule?.leadTimeDays ?? settings.defaultLeadTimeDays ?? 14;
    const reviewPeriod = rule?.reviewPeriodDays ?? settings.defaultReviewPeriodDays ?? settings.coverageDays;
    const horizonDate = addDays(asOf, leadTime + reviewPeriod);
    const horizonMs = Date.parse(`${horizonDate}T00:00:00Z`);
    let usableIncoming = 0;
    let lateIncoming = 0;
    let overdueIncoming = 0;
    const validIncoming: OpenPoRow[] = [];
    for (const po of incoming.get(k) ?? []) {
      const status = po.status?.toLowerCase();
      if (["cancelled", "canceled", "closed", "received"].includes(status ?? "")) continue;
      const expected = po.expectedDate ? Date.parse(`${po.expectedDate}T00:00:00Z`) : NaN;
      if (Number.isFinite(expected) && expected < asOfMs) overdueIncoming += po.openPoQty;
      else if (Number.isFinite(expected) && (expected <= horizonMs || settings.includeLateOpenPos)) { usableIncoming += po.openPoQty; validIncoming.push(po); }
      else lateIncoming += po.openPoQty;
    }
    const serviceLevel = rule?.serviceLevel ?? settings.defaultServiceLevel ?? 0.95;
    const safetyScale = stats.backtestDays >= 7 ? stats.forecastErrorRmse : stats.deviation;
    const calculatedSafety = zScore(serviceLevel) * safetyScale * Math.sqrt(Math.max(1, leadTime));
    const safetyStock = rule?.safetyStock ?? calculatedSafety;
    const inventoryPosition = inv.onHand - inv.reserved - inv.backorders + usableIncoming;
    const requiredStock = stats.dailyRate * (leadTime + reviewPeriod) + safetyStock;
    const rawQty = Math.max(0, requiredStock - inventoryPosition);
    let suggested = applyOrderConstraints(rawQty, rule);
    const netOnHand = Math.max(0, inv.onHand - inv.reserved - inv.backorders);
    const daysOnHand = stats.dailyRate > 0 ? netOnHand / stats.dailyRate : null;
    const projectionDays = Math.max(leadTime + reviewPeriod, settings.coverageDays * 2);
    const availabilityProjection = stats.dailyRate > 0
      ? projectAvailability(asOf, projectionDays, netOnHand, stats.dailyRate, validIncoming, leadTime)
      : { firstStockout: null, exposureLostUnits: 0, exposureShortageDays: 0 };
    const stockoutDate = availabilityProjection.firstStockout;
    const projectedStockoutDays = stockoutDate ? Math.max(0, Math.round((Date.parse(`${stockoutDate}T00:00:00Z`) - asOfMs) / DAY)) : null;
    const reorderIn = projectedStockoutDays === null ? null : Math.max(0, projectedStockoutDays - leadTime);
    const reorderBy = reorderIn === null ? null : addDays(asOf, reorderIn);
    const unitPrice = rule?.unitPrice ?? null;
    const expectedDeliveryDate = addDays(asOf, leadTime);
    const stockoutExposureDays = availabilityProjection.exposureShortageDays;
    const estimatedLostSalesUnits = availabilityProjection.exposureLostUnits;
    const lowerExposureUnits = stats.lowerBound > 0
      ? projectAvailability(asOf, Math.max(leadTime, 1), netOnHand, stats.lowerBound, validIncoming, leadTime).exposureLostUnits : 0;
    const upperExposureUnits = stats.upperBound > 0
      ? projectAvailability(asOf, Math.max(leadTime, 1), netOnHand, stats.upperBound, validIncoming, leadTime).exposureLostUnits : 0;
    const sellingPrice = meta.sellingPriceInr && meta.sellingPriceInr > 0 ? meta.sellingPriceInr : null;
    const estimatedGmvAtRisk = sellingPrice === null ? null : estimatedLostSalesUnits * sellingPrice;
    const estimatedGmvAtRiskLower = sellingPrice === null ? null : lowerExposureUnits * sellingPrice;
    const estimatedGmvAtRiskUpper = sellingPrice === null ? null : upperExposureUnits * sellingPrice;
    const excessInventoryUnits = Math.max(0, inventoryPosition - requiredStock);
    const currentInventoryInvestment = unitPrice === null ? null : Math.max(0, inv.onHand) * unitPrice;
    const excessInventoryValue = unitPrice === null ? null : excessInventoryUnits * unitPrice;
    const lifecycle = meta.lifecycleStage?.trim().toLowerCase() ?? "";
    const availability = meta.availabilityStatus?.trim().toLowerCase() ?? "";
    const endedByDate = meta.endOfLifeDate ? Date.parse(`${meta.endOfLifeDate}T00:00:00Z`) <= asOfMs : false;
    const lifecycleBlocksBuy = endedByDate || ["end of life", "end-of-life", "eol", "exit", "discontinued"].includes(lifecycle);
    const availabilityBlocksBuy = ["paused", "inactive", "blocked", "discontinued", "delisted"].includes(availability);
    if (lifecycleBlocksBuy || availabilityBlocksBuy) suggested = 0;
    const plannedInventoryInvestment = unitPrice === null ? null : (Math.max(0, inventoryPosition) + suggested) * unitPrice;
    const exceptions: PlanningException[] = [];
    if (stats.historyDays === 0) exceptions.push({ code: "NO_HISTORY", severity: "warning", message: "No valid demand history; quantity cannot be forecast reliably." });
    if (stats.accuracy !== null && stats.accuracy < 0.65) exceptions.push({ code: "LOW_FORECAST_ACCURACY", severity: "warning", message: `Backtest accuracy is ${Math.round(stats.accuracy * 100)}%; review the demand assumptions.` });
    if (stats.bias !== null && Math.abs(stats.bias) > 0.2) exceptions.push({ code: "FORECAST_BIAS", severity: "warning", message: `Backtest bias is ${Math.round(stats.bias * 100)}%; positive means over-forecasting and negative means under-forecasting.` });
    if (stats.quality === "low" && stats.historyDays > 0) exceptions.push({ code: "LOW_DATA_QUALITY", severity: "info", message: stats.qualityReasons[0] ?? "Forecast evidence is insufficient for unattended buying." });
    if (stats.returnRate > 0.3) exceptions.push({ code: "HIGH_RETURNS", severity: "warning", message: `${Math.round(stats.returnRate * 100)}% historical return rate is reducing net demand.` });
    if (stockoutExposureDays > 0) {
      const valueText = estimatedGmvAtRisk === null ? "selling price is missing" : `about ₹${Math.round(estimatedGmvAtRisk).toLocaleString("en-IN")} GMV is exposed`;
      exceptions.push({ code: "STOCKOUT_BEFORE_RECEIPT", severity: "critical", message: `Projected to lose sales on ${stockoutExposureDays} day(s) before replenishment; ${valueText}.` });
    }
    if (inv.backorders > 0) exceptions.push({ code: "BACKORDERS", severity: "critical", message: `${inv.backorders} units are backordered.` });
    if (overdueIncoming > 0) exceptions.push({ code: "OVERDUE_SUPPLY", severity: "critical", message: `${overdueIncoming} open PO units are past their expected date and are excluded until receipt is confirmed.` });
    if (lateIncoming > 0) exceptions.push({ code: "LATE_SUPPLY", severity: "warning", message: `${lateIncoming} incoming units arrive after the planning horizon.` });
    if (rule?.moq && suggested > rawQty * 1.5) exceptions.push({ code: "MOQ_OVERSTOCK", severity: "info", message: "MOQ or pack rounding materially increases the order." });
    if (excessInventoryUnits > Math.max(stats.dailyRate * reviewPeriod, rule?.packSize ?? 1)) exceptions.push({ code: "EXCESS_INVENTORY", severity: "info", message: `${Math.round(excessInventoryUnits)} units sit above the lead-time, review-period and safety-stock target.` });
    if (lifecycleBlocksBuy) exceptions.push({ code: "LIFECYCLE_BUY_BLOCKED", severity: "critical", message: "This article is at end of life, so the engine recommends no new purchase order." });
    if (availabilityBlocksBuy) exceptions.push({ code: "AVAILABILITY_BUY_BLOCKED", severity: "critical", message: `Availability is ${meta.availabilityStatus}; buying remains blocked until the catalogue status changes.` });
    if (lifecycle === "launch" && meta.launchDate) exceptions.push({ code: "NEW_LAUNCH", severity: "info", message: `Launched ${meta.launchDate}; use early demand as directional until a longer holdout is available.` });
    if (["markdown", "clearance"].includes(lifecycle)) exceptions.push({ code: "MARKDOWN_LIFECYCLE", severity: "warning", message: "This article is in markdown; validate exit inventory before adding supply." });
    if (!rule?.unitPrice) exceptions.push({ code: "MISSING_PRICE", severity: "info", message: "No unit price is configured." });

    const constrainedReason = !lifecycleBlocksBuy && !availabilityBlocksBuy && suggested !== Math.round(rawQty)
      ? ` Supplier MOQ/pack rules change that to ${suggested} units.` : "";
    const blockedReason = lifecycleBlocksBuy || availabilityBlocksBuy ? " Buying is blocked by the article lifecycle or availability status." : "";

    rows.push({
      marketplace: "Myntra", vendor, sku, warehouse, supplierSku: rule?.supplierSku, ...meta, forecastMethod: stats.model,
      forecastModelLabel: stats.modelLabel, forecastSelectionStrategy: stats.selectionStrategy, forecastContributors: stats.contributors,
      forecastAccuracy: stats.accuracy === null ? null : round(stats.accuracy * 100, 1),
      forecastWmape: stats.wmape === null ? null : round(stats.wmape * 100, 1), forecastBias: stats.bias === null ? null : round(stats.bias * 100, 1),
      forecastLowerBound: round(stats.lowerBound), forecastUpperBound: round(stats.upperBound), forecastDailyRate: round(stats.dailyRate), forecastQuality: stats.quality,
      forecastConfidenceScore: stats.confidenceScore, forecastQualityReasons: stats.qualityReasons,
      backtestDays: stats.backtestDays, backtestActualUnits: round(stats.backtestActualUnits),
      backtestForecastUnits: round(stats.backtestForecastUnits), backtestAbsoluteErrorUnits: round(stats.backtestAbsoluteErrorUnits),
      backtestSignedErrorUnits: round(stats.backtestSignedErrorUnits), returnRate: round(stats.returnRate * 100, 1),
      cancellationRate: round(stats.cancellationRate * 100, 1), historicalPromotionUplift: round(stats.observedPromotionUplift * 100, 1),
      plannedPromotionUplift: round(stats.plannedPromotionUplift * 100, 1), promotionAdjustedDays: stats.promotionAdjustedDays,
      stockoutDaysInHistory: stats.stockoutDays, dataLatencyDays: stats.dataLatencyDays,
      dailyRunRate: round(stats.dailyRate), demandVariability: round(stats.deviation), forecastErrorRmse: round(stats.forecastErrorRmse),
      currentInventory: round(inv.onHand), reservedQty: round(inv.reserved), backorderQty: round(inv.backorders),
      openPoQty: round(usableIncoming), lateOpenPoQty: round(lateIncoming), overdueOpenPoQty: round(overdueIncoming), inventoryPosition: round(inventoryPosition),
      leadTimeDays: leadTime, reviewPeriodDays: reviewPeriod, safetyStock: round(safetyStock),
      requiredStock: round(requiredStock, 1), daysOnHand: daysOnHand === null ? null : round(daysOnHand, 1),
      projectedStockoutDate: stockoutDate, reorderByDate: reorderBy, expectedDeliveryDate,
      rawPoQty: round(rawQty), suggestedPoQty: suggested, unitPrice, currency: "INR",
      estimatedValue: unitPrice === null ? null : round(unitPrice * suggested),
      estimatedLostSalesUnits: round(estimatedLostSalesUnits), stockoutExposureDays,
      estimatedGmvAtRisk: estimatedGmvAtRisk === null ? null : round(estimatedGmvAtRisk),
      estimatedGmvAtRiskLower: estimatedGmvAtRiskLower === null ? null : round(estimatedGmvAtRiskLower),
      estimatedGmvAtRiskUpper: estimatedGmvAtRiskUpper === null ? null : round(estimatedGmvAtRiskUpper),
      currentInventoryInvestment: currentInventoryInvestment === null ? null : round(currentInventoryInvestment),
      plannedInventoryInvestment: plannedInventoryInvestment === null ? null : round(plannedInventoryInvestment),
      excessInventoryUnits: round(excessInventoryUnits), excessInventoryValue: excessInventoryValue === null ? null : round(excessInventoryValue),
      explanation: `Plan for ${round(stats.dailyRate)} units/day over ${leadTime + reviewPeriod} days. The target is ${round(requiredStock)} units including safety stock, versus ${round(inventoryPosition)} sellable or confirmed inbound units; the unconstrained need is ${round(rawQty)}.${constrainedReason}${blockedReason}`,
      exceptions,
    });
  }
  return rows.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.warehouse.localeCompare(b.warehouse) || a.sku.localeCompare(b.sku));
}
