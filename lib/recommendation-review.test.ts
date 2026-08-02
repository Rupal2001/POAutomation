import { describe, expect, it } from "vitest";
import type { Recommendation } from "./po-engine";
import {
  assertRecommendationCanBecomePo,
  hasApplicableSupplierMaster,
  isPlaceholderSupplier,
  purchaseOrderBlockReason,
  supplierResolutionBlockReason,
  styleCoverAudit,
} from "./recommendation-review";

function recommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    marketplace: "Myntra", vendor: "Noise Supplier", sku: "36627115", styleId: "36627115", warehouse: "ALL_MYNTRA",
    productName: "Buds F1", mrpInr: 3499,
    forecastMethod: "average", forecastModelLabel: "Average", forecastSelectionStrategy: "fixed", forecastContributors: [],
    forecastAccuracy: null, forecastWmape: null, forecastBias: null, forecastLowerBound: 0, forecastUpperBound: 0,
    forecastQuality: "medium", forecastConfidenceScore: 50, forecastQualityReasons: [], backtestDays: 0,
    backtestActualUnits: 0, backtestForecastUnits: 0, backtestAbsoluteErrorUnits: 0, backtestSignedErrorUnits: 0,
    returnRate: 0, cancellationRate: 0, historicalPromotionUplift: 0, plannedPromotionUplift: 0,
    promotionAdjustedDays: 0, stockoutDaysInHistory: 0, dataLatencyDays: 0, dailyRunRate: 108.8333,
    demandVariability: 0, forecastErrorRmse: 0, currentInventory: 461, reservedQty: 0, backorderQty: 0,
    openPoQty: 0, lateOpenPoQty: 0, overdueOpenPoQty: 0, inventoryPosition: 461, leadTimeDays: 14,
    reviewPeriodDays: 45, safetyStock: 0, requiredStock: 4897.5, daysOnHand: 4.2343,
    projectedStockoutDate: null, reorderByDate: null, expectedDeliveryDate: "2026-08-16", rawPoQty: 4437,
    suggestedPoQty: 4437, unitPrice: 1065.18, currency: "INR", estimatedValue: 4_726_000,
    estimatedLostSalesUnits: 0, stockoutExposureDays: 0, estimatedGmvAtRisk: null, estimatedGmvAtRiskLower: null,
    estimatedGmvAtRiskUpper: null, currentInventoryInvestment: 0, plannedInventoryInvestment: 0,
    excessInventoryUnits: 0, excessInventoryValue: 0, explanation: "Documented formula", exceptions: [],
    calculationMethod: "style_drr_cover_v1", totalSalesUnits: 3265, uniqueOrderDays: 30, poCoverDays: 45,
    dohThreshold: 80, dohEligible: true, signedPoQtyAsk: 4437,
    ...overrides,
  };
}

describe("recommendation PO readiness", () => {
  it("treats explanatory supplier values as unmapped", () => {
    expect(isPlaceholderSupplier("Supplier mapping required")).toBe(true);
    expect(isPlaceholderSupplier(" Noise Supplier ")).toBe(false);
  });

  it("does not allow missing style metadata to be overridden", () => {
    const row = recommendation({ exceptions: [{ code: "MISSING_STYLE_METADATA", severity: "critical", message: "Complete style master." }] });
    expect(purchaseOrderBlockReason(row)?.code).toBe("MISSING_STYLE_METADATA");
    expect(() => assertRecommendationCanBecomePo(row, [{ vendor: "Noise Supplier", sku: "36627115" }])).toThrow(/style master/i);
  });

  it("defensively detects an incomplete methodology style master even without an exception", () => {
    const row = recommendation({ productName: undefined, mrpInr: 3499, exceptions: [] });
    expect(purchaseOrderBlockReason(row)?.code).toBe("MISSING_STYLE_METADATA");
  });

  it("allows the inline supplier flow to resolve an NLC-only style-metadata gap", () => {
    const row = recommendation({
      unitPrice: null,
      exceptions: [
        { code: "MISSING_STYLE_METADATA", severity: "critical", message: "Model, MRP or NLC missing." },
        { code: "MISSING_PRICE", severity: "critical", message: "Add NLC." },
      ],
    });
    expect(purchaseOrderBlockReason(row)?.code).toBe("MISSING_STYLE_METADATA");
    expect(supplierResolutionBlockReason(row)?.code).toBe("MISSING_PRICE");
  });

  it("keeps missing model, MRP and inventory outside the inline supplier flow", () => {
    const metadataException = [{ code: "MISSING_STYLE_METADATA", severity: "critical" as const, message: "Complete style master." }];
    expect(supplierResolutionBlockReason(recommendation({ productName: undefined, exceptions: metadataException }))).toBeNull();
    expect(supplierResolutionBlockReason(recommendation({ mrpInr: 0, exceptions: metadataException }))).toBeNull();
    expect(supplierResolutionBlockReason(recommendation({
      unitPrice: null,
      exceptions: [
        ...metadataException,
        { code: "MISSING_PRICE", severity: "critical", message: "Add NLC." },
        { code: "MISSING_INVENTORY", severity: "critical", message: "Confirm inventory." },
      ],
    }))).toBeNull();
  });

  it("requires an applicable supplier-master row", () => {
    const row = recommendation();
    expect(hasApplicableSupplierMaster(row, [{ vendor: "Another Supplier", sku: "36627115" }])).toBe(false);
    expect(() => assertRecommendationCanBecomePo(row, [])).toThrow(/not mapped/i);
    expect(() => assertRecommendationCanBecomePo(row, [{ vendor: "Noise Supplier", sku: "36627115" }])).not.toThrow();
  });

  it("never allows invalid negative methodology inputs to become a PO", () => {
    const row = recommendation({
      exceptions: [{ code: "INVALID_NEGATIVE_INVENTORY", severity: "critical", message: "Correct inventory." }],
    });
    expect(purchaseOrderBlockReason(row)?.code).toBe("INVALID_NEGATIVE_INVENTORY");
    expect(() => assertRecommendationCanBecomePo(row, [{ vendor: "Noise Supplier", sku: "36627115" }])).toThrow(/correct inventory/i);
  });

  it("never converts an assumed-zero missing inventory row into a PO", () => {
    const row = recommendation({
      exceptions: [{ code: "MISSING_INVENTORY", severity: "critical", message: "Confirm stock." }],
    });
    expect(purchaseOrderBlockReason(row)?.code).toBe("MISSING_INVENTORY");
    expect(() => assertRecommendationCanBecomePo(row, [{ vendor: "Noise Supplier", sku: "36627115" }])).toThrow(/confirm stock/i);
  });

  it("cannot override an ineligible or non-positive methodology decision into a PO", () => {
    expect(purchaseOrderBlockReason(recommendation({ dohEligible: false }))?.code).toBe("METHODOLOGY_DOH_INELIGIBLE");
    expect(purchaseOrderBlockReason(recommendation({ signedPoQtyAsk: 0, suggestedPoQty: 0 }))?.code).toBe("METHODOLOGY_NO_POSITIVE_ASK");
  });
});

describe("style-cover audit", () => {
  it("exposes the documented DRR, DOH and signed/actionable ask math", () => {
    expect(styleCoverAudit(recommendation())).toEqual({
      totalSalesUnits: 3265,
      uniqueOrderDays: 30,
      dailyRunRate: 3265 / 30,
      coverDays: 45,
      targetStockUnits: (3265 / 30) * 45,
      currentInventory: 461,
      openPoQuantity: 0,
      signedPoQtyAsk: 4437,
      actionablePoQty: 4437,
      daysOnHand: 4.2343,
      dohThreshold: 80,
      eligible: true,
    });
  });

  it("keeps a negative signed ask visible but makes the actionable ask zero", () => {
    const audit = styleCoverAudit(recommendation({ signedPoQtyAsk: -50, suggestedPoQty: 0 }));
    expect(audit?.signedPoQtyAsk).toBe(-50);
    expect(audit?.actionablePoQty).toBe(0);
  });

  it("keeps a positive signed ask visible but makes it non-actionable above the DOH gate", () => {
    const audit = styleCoverAudit(recommendation({ dohEligible: false, signedPoQtyAsk: 120, suggestedPoQty: 0 }));
    expect(audit?.signedPoQtyAsk).toBe(120);
    expect(audit?.eligible).toBe(false);
    expect(audit?.actionablePoQty).toBe(0);
  });
});
