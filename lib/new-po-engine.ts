import { forecastDemand } from "./forecast";
import { calculateNewPoMethodology, NEW_PO_METHODOLOGY_VERSION, type NewPoCalculationInput } from "./new-po-methodology";
import type { EngineInput, PlanningException, Recommendation, SalesRow, VendorMasterRow } from "./po-engine";

export const UNASSIGNED_VENDOR = "Supplier mapping required";
export const NETWORK_WAREHOUSE = "ALL_MYNTRA";
const DAY = 86_400_000;

const clean = (value: unknown) => String(value ?? "").trim();
const styleOf = (row: { styleId?: string; sku?: string }) => clean(row.styleId) || clean(row.sku);
const NETWORK_MARKERS = new Set(["", "ALL", NETWORK_WAREHOUSE, "MAIN", "NETWORK", "MYNTRA_NETWORK"]);
const normalizedWarehouse = (value: unknown) => clean(value).toUpperCase().replace(/[\s-]+/g, "_");
const round = (value: number, places = 2) => {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + (days < 0 ? Math.floor(days) : Math.ceil(days)) * DAY).toISOString().slice(0, 10);

function completeStyleDetails(input: EngineInput) {
  const details = new Map<string, { styleId: string; model: string; mrpInr: number; nlcInr: number }>();
  for (const row of input.vendorMaster ?? []) {
    const styleId = styleOf(row);
    const model = clean(row.productName);
    const mrpInr = Number(row.mrpInr);
    const nlcInr = Number(row.unitPrice);
    if (!styleId || !model || !Number.isFinite(mrpInr) || mrpInr <= 0 || !Number.isFinite(nlcInr) || nlcInr <= 0) continue;
    if (!details.has(styleId)) details.set(styleId, { styleId, model, mrpInr, nlcInr });
  }
  return [...details.values()];
}

function toMethodologyInput(input: EngineInput): NewPoCalculationInput {
  return {
    sales: input.sales.map(row => ({
      salesDate: row.date,
      styleId: styleOf(row),
      quantity: row.unitsSold,
      brand: row.brand,
      articleType: row.articleType,
      masterCategory: row.category,
    })),
    inventory: input.inventory.map(row => ({
      styleId: styleOf(row),
      inventoryUnits: row.currentInventory,
      brand: row.brand,
      articleType: row.articleType,
      warehouseName: row.warehouse,
    })),
    openPos: input.openPos.map(row => ({
      styleId: styleOf(row),
      pendingQuantity: row.openPoQty,
      estimatedShipmentDate: row.expectedDate,
      vendorName: row.vendor,
      poStatus: row.status,
      brand: row.brand,
      articleType: row.articleType,
      masterCategory: row.category,
      warehouseId: row.warehouse,
    })),
    styleDetails: completeStyleDetails(input),
  };
}

function vendorFor(styleId: string, input: EngineInput) {
  const valid = (value: unknown) => {
    const vendor = clean(value);
    return vendor && vendor !== UNASSIGNED_VENDOR ? vendor : "";
  };
  const master = (input.vendorMaster ?? []).find(row => styleOf(row) === styleId && valid(row.vendor));
  // A prior open PO or operational feed can name a historical supplier, but it
  // is not an authorization to raise a new order. Style-cover recommendations
  // nominate suppliers only from the immutable commercial master.
  return master ? valid(master.vendor) : "";
}

function ruleFor(styleId: string, vendor: string, rules: VendorMasterRow[]) {
  return rules.find(row => styleOf(row) === styleId && row.vendor === vendor)
    ?? rules.find(row => styleOf(row) === styleId)
    ?? rules.find(row => row.vendor === vendor && !row.styleId && !row.sku);
}

function planningWarehouseFor(styleId: string, input: EngineInput) {
  const salesWarehouses = input.sales
    .filter(row => styleOf(row) === styleId)
    .map(row => clean(row.warehouse));
  if (!salesWarehouses.length || salesWarehouses.some(warehouse => NETWORK_MARKERS.has(normalizedWarehouse(warehouse)))) {
    return NETWORK_WAREHOUSE;
  }
  const distinct = [...new Set(salesWarehouses)];
  return distinct.length === 1 ? distinct[0] : NETWORK_WAREHOUSE;
}

function metadataFor(styleId: string, input: EngineInput, rule?: VendorMasterRow) {
  const rows = [...input.sales, ...input.inventory, ...input.openPos].filter(row => styleOf(row) === styleId);
  const pick = <K extends keyof (typeof rows)[number]>(field: K) => rows.find(row => row[field] !== undefined && row[field] !== null)?.[field];
  return {
    category: rule?.category ?? pick("category"),
    brand: rule?.brand ?? pick("brand"),
    styleId,
    size: rule?.size ?? pick("size"),
    productName: rule?.productName ?? pick("productName"),
    articleType: rule?.articleType ?? pick("articleType"),
    gender: rule?.gender ?? pick("gender"),
    colour: rule?.colour ?? pick("colour"),
    mrpInr: rule?.mrpInr ?? pick("mrpInr"),
    sellingPriceInr: rule?.sellingPriceInr ?? pick("sellingPriceInr"),
    lifecycleStage: rule?.lifecycleStage ?? pick("lifecycleStage"),
    availabilityStatus: rule?.availabilityStatus ?? pick("availabilityStatus"),
    launchDate: rule?.launchDate ?? pick("launchDate"),
    endOfLifeDate: rule?.endOfLifeDate ?? pick("endOfLifeDate"),
    marketplaceSeller: rule?.marketplaceSeller ?? pick("marketplaceSeller"),
    sourceUrl: rule?.sourceUrl ?? pick("sourceUrl"),
    priceCapturedOn: rule?.priceCapturedOn ?? pick("priceCapturedOn"),
    catalogueDataProvenance: rule?.catalogueDataProvenance ?? pick("catalogueDataProvenance"),
    commercialDataProvenance: rule?.commercialDataProvenance ?? pick("commercialDataProvenance"),
  };
}

export function generateStyleCoverRecommendations(input: EngineInput): Recommendation[] {
  const coverDays = input.coverageDays;
  const dohThreshold = input.settings?.dohThreshold ?? 80;
  const calculation = calculateNewPoMethodology(toMethodologyInput(input), { coverDays, dohThreshold });
  const asOf = input.asOfDate
    ?? input.sales.map(row => row.date).filter(Boolean).sort().at(-1)
    ?? new Date().toISOString().slice(0, 10);
  const rules = input.vendorMaster ?? [];

  return calculation.rows.map(row => {
    const vendor = vendorFor(row.styleId, input);
    const rule = ruleFor(row.styleId, vendor, rules);
    const metadata = metadataFor(row.styleId, input, rule);
    const styleSales = input.sales.filter(sale => styleOf(sale) === row.styleId);
    const forecast = forecastDemand(
      styleSales as SalesRow[],
      input.settings?.forecastMethod ?? "auto",
      input.settings?.lookbackDays ?? input.lookbackDays,
      input.settings?.plannedPromotionUpliftPct ?? 0,
      input.settings?.returnRecoveryRate ?? 0.8,
      asOf,
    );
    const leadTimeDays = rule?.leadTimeDays ?? input.settings?.defaultLeadTimeDays ?? 14;
    const projectedStockoutDate = row.dailyRunRate > 0 ? addDays(asOf, row.daysOnHand ?? 0) : null;
    const ruleUnitPrice = Number(rule?.unitPrice);
    const unitPrice = row.nlcInr ?? (Number.isFinite(ruleUnitPrice) && ruleUnitPrice > 0 ? ruleUnitPrice : null);
    const sellingPrice = Number(metadata.sellingPriceInr ?? metadata.mrpInr);
    const exceptions: PlanningException[] = [];
    if (!row.eligible) exceptions.push({ code: "ABOVE_DOH_THRESHOLD", severity: "info", message: `DOH is ${row.daysOnHand === null ? "NA" : round(row.daysOnHand, 1)}; only styles below ${dohThreshold} days enter the PO review queue.` });
    if (row.poQtyAsk < 0) exceptions.push({ code: "SUPPLY_COVERS_TARGET", severity: "info", message: `The signed methodology ask is ${row.poQtyAsk} units because stock and open POs already exceed the ${coverDays}-day target.` });
    if (row.qualityFlags.includes("MISSING_INVENTORY")) exceptions.push({ code: "MISSING_INVENTORY", severity: "critical", message: "No inventory row matched this sold style. The formula keeps Excel-compatible zero for audit, but ordering is blocked until zero stock is explicitly confirmed." });
    if (row.qualityFlags.includes("MISSING_STYLE_METADATA")) exceptions.push({ code: "MISSING_STYLE_METADATA", severity: "critical", message: "Model, MRP or NLC is missing from the style master. Complete it before creating a PO." });
    if (row.qualityFlags.includes("NEGATIVE_SALES")) exceptions.push({ code: "INVALID_NEGATIVE_SALES", severity: "critical", message: "Sell-out aggregates to a negative quantity. Correct the source data before creating a PO." });
    if (row.qualityFlags.includes("NEGATIVE_INVENTORY")) exceptions.push({ code: "INVALID_NEGATIVE_INVENTORY", severity: "critical", message: "Current inventory aggregates to a negative quantity. Correct or separately classify backorders before creating a PO." });
    if (row.qualityFlags.includes("NEGATIVE_OPEN_PO")) exceptions.push({ code: "INVALID_NEGATIVE_OPEN_PO", severity: "critical", message: "Pending open-PO quantity aggregates below zero. Correct cancelled or reversed lines before creating a PO." });
    if (row.qualityFlags.includes("ZERO_DRR")) exceptions.push({ code: "ZERO_DRR", severity: "info", message: "DRR is zero, so DOH is NA and this style is excluded from the PO review queue." });
    if (!vendor) exceptions.push({ code: "MISSING_VENDOR", severity: "critical", message: "No supplier is mapped to this style. An admin must assign one before a PO can be created." });
    if (unitPrice === null) exceptions.push({ code: "MISSING_PRICE", severity: "critical", message: "NLC is missing, so the PO value cannot be calculated." });
    if (forecast.accuracy !== null && forecast.accuracy < 0.65) exceptions.push({ code: "LOW_FORECAST_ACCURACY", severity: "warning", message: `Forecast backtest accuracy is ${Math.round(forecast.accuracy * 100)}%. This does not alter the documented DRR formula, but warrants review.` });

    const suggestedPoQty = row.isActionable ? row.actionablePoQty : 0;
    const stockoutExposureDays = row.dailyRunRate > 0 ? Math.max(0, Math.ceil(leadTimeDays - (row.daysOnHand ?? 0))) : 0;
    const estimatedLostSalesUnits = stockoutExposureDays * row.dailyRunRate;
    const estimatedGmvAtRisk = Number.isFinite(sellingPrice) ? sellingPrice * estimatedLostSalesUnits : null;
    return {
      marketplace: "Myntra" as const,
      vendor: vendor || UNASSIGNED_VENDOR,
      sku: row.styleId,
      warehouse: planningWarehouseFor(row.styleId, input),
      supplierSku: rule?.supplierSku,
      ...metadata,
      forecastMethod: forecast.model,
      forecastModelLabel: forecast.modelLabel,
      forecastSelectionStrategy: forecast.selectionStrategy,
      forecastContributors: forecast.contributors,
      forecastAccuracy: forecast.accuracy === null ? null : round(forecast.accuracy * 100, 1),
      forecastWmape: forecast.wmape === null ? null : round(forecast.wmape * 100, 1),
      forecastBias: forecast.bias === null ? null : round(forecast.bias * 100, 1),
      forecastLowerBound: round(forecast.lowerBound),
      forecastUpperBound: round(forecast.upperBound),
      forecastDailyRate: round(forecast.dailyRate, 4),
      forecastQuality: forecast.quality,
      forecastConfidenceScore: forecast.confidenceScore,
      forecastQualityReasons: forecast.qualityReasons,
      backtestDays: forecast.backtestDays,
      backtestActualUnits: round(forecast.backtestActualUnits),
      backtestForecastUnits: round(forecast.backtestForecastUnits),
      backtestAbsoluteErrorUnits: round(forecast.backtestAbsoluteErrorUnits),
      backtestSignedErrorUnits: round(forecast.backtestSignedErrorUnits),
      returnRate: round(forecast.returnRate * 100, 1),
      cancellationRate: round(forecast.cancellationRate * 100, 1),
      historicalPromotionUplift: round(forecast.observedPromotionUplift * 100, 1),
      plannedPromotionUplift: round(forecast.plannedPromotionUplift * 100, 1),
      promotionAdjustedDays: forecast.promotionAdjustedDays,
      stockoutDaysInHistory: forecast.stockoutDays,
      dataLatencyDays: forecast.dataLatencyDays,
      dailyRunRate: round(row.dailyRunRate, 4),
      demandVariability: round(forecast.deviation),
      forecastErrorRmse: round(forecast.forecastErrorRmse),
      currentInventory: row.currentInventory,
      reservedQty: 0,
      backorderQty: 0,
      openPoQty: row.openPoQuantity,
      lateOpenPoQty: 0,
      overdueOpenPoQty: 0,
      inventoryPosition: row.currentInventory + row.openPoQuantity,
      leadTimeDays,
      reviewPeriodDays: coverDays,
      safetyStock: 0,
      requiredStock: round(row.dailyRunRate * coverDays, 2),
      daysOnHand: row.daysOnHand === null ? null : round(row.daysOnHand, 2),
      projectedStockoutDate,
      reorderByDate: projectedStockoutDate ? addDays(projectedStockoutDate, -leadTimeDays) : null,
      expectedDeliveryDate: addDays(asOf, leadTimeDays),
      rawPoQty: Math.max(0, row.poQtyAsk),
      suggestedPoQty,
      unitPrice,
      currency: "INR",
      estimatedValue: unitPrice === null ? null : round(unitPrice * suggestedPoQty),
      estimatedLostSalesUnits: round(estimatedLostSalesUnits),
      stockoutExposureDays,
      estimatedGmvAtRisk: estimatedGmvAtRisk === null ? null : round(estimatedGmvAtRisk),
      estimatedGmvAtRiskLower: estimatedGmvAtRisk === null ? null : round(estimatedGmvAtRisk),
      estimatedGmvAtRiskUpper: estimatedGmvAtRisk === null ? null : round(estimatedGmvAtRisk),
      currentInventoryInvestment: unitPrice === null ? null : round(unitPrice * row.currentInventory),
      plannedInventoryInvestment: unitPrice === null ? null : round(unitPrice * (row.currentInventory + row.openPoQuantity + suggestedPoQty)),
      excessInventoryUnits: Math.max(0, row.currentInventory + row.openPoQuantity - row.dailyRunRate * coverDays),
      excessInventoryValue: unitPrice === null ? null : round(unitPrice * Math.max(0, row.currentInventory + row.openPoQuantity - row.dailyRunRate * coverDays)),
      explanation: `${row.sumOfSales} sales units ÷ ${calculation.summary.distinctSalesDays} unique selling days = ${round(row.dailyRunRate, 4)} DRR. ${round(row.dailyRunRate, 4)} × ${coverDays} cover days − ${row.currentInventory} inventory − ${row.openPoQuantity} open PO = ${round(row.rawPoQtyAsk, 4)}, rounded Excel-style to ${row.poQtyAsk}. ${row.eligible ? `DOH ${round(row.daysOnHand ?? 0, 2)} is below ${dohThreshold}.` : `The style is excluded because DOH is not below ${dohThreshold}.`}`,
      exceptions,
      calculationMethod: "style_drr_cover_v1" as const,
      methodologyVersion: NEW_PO_METHODOLOGY_VERSION,
      uniqueOrderDays: calculation.summary.distinctSalesDays,
      totalSalesUnits: row.sumOfSales,
      poCoverDays: coverDays,
      dohThreshold,
      dohEligible: row.eligible,
      signedPoQtyAsk: row.poQtyAsk,
    };
  });
}
