import { describe, expect, it } from "vitest";
import { generateRecommendations } from "./po-engine";
import { readFileSync } from "node:fs";
import { parseInventoryCsv, parseOpenPoCsv, parseSalesCsv, parseVendorMasterCsv } from "./csv";

const days = (count: number, units: number) => Array.from({ length: count }, (_, i) => ({
  date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10), sku: "SKU-1", vendor: "Acme", warehouse: "NORTH", unitsSold: units,
}));

describe("generateRecommendations", () => {
  it("plans across lead time, review period, safety stock and inventory position", () => {
    const [row] = generateRecommendations({ sales: days(30, 10), inventory: [{ sku: "SKU-1", vendor: "Acme", warehouse: "NORTH", currentInventory: 100, reservedQty: 10, backorderQty: 5 }], openPos: [{ sku: "SKU-1", vendor: "Acme", warehouse: "NORTH", openPoQty: 20, expectedDate: "2026-02-05" }], vendorMaster: [{ vendor: "Acme", sku: "SKU-1", leadTimeDays: 10, reviewPeriodDays: 20, safetyStock: 25, packSize: 10, unitPrice: 2 }], coverageDays: 20, asOfDate: "2026-01-30" });
    expect(row.inventoryPosition).toBe(105);
    expect(row.requiredStock).toBe(325);
    expect(row.suggestedPoQty).toBe(220);
    expect(row.estimatedValue).toBe(440);
  });

  it("does not count supply arriving after the planning horizon", () => {
    const [row] = generateRecommendations({ sales: days(10, 5), inventory: [{ sku: "SKU-1", vendor: "Acme", warehouse: "NORTH", currentInventory: 0 }], openPos: [{ sku: "SKU-1", vendor: "Acme", warehouse: "NORTH", openPoQty: 500, expectedDate: "2026-12-01" }], vendorMaster: [{ vendor: "Acme", leadTimeDays: 5, reviewPeriodDays: 5, safetyStock: 0 }], coverageDays: 5, asOfDate: "2026-01-10" });
    expect(row.openPoQty).toBe(0);
    expect(row.lateOpenPoQty).toBe(500);
    expect(row.suggestedPoQty).toBe(50);
    expect(row.exceptions.some(e => e.code === "LATE_SUPPLY")).toBe(true);
  });

  it("does not treat an overdue, unreceived PO as available inventory", () => {
    const [row] = generateRecommendations({ sales: days(30, 5), inventory: [{ sku: "SKU-1", vendor: "Acme", warehouse: "NORTH", currentInventory: 0 }], openPos: [{ sku: "SKU-1", vendor: "Acme", warehouse: "NORTH", openPoQty: 500, expectedDate: "2026-01-20", status: "issued" }], vendorMaster: [{ vendor: "Acme", leadTimeDays: 5, reviewPeriodDays: 5, safetyStock: 0 }], coverageDays: 5, asOfDate: "2026-01-30" });
    expect(row.openPoQty).toBe(0);
    expect(row.overdueOpenPoQty).toBe(500);
    expect(row.suggestedPoQty).toBe(50);
    expect(row.exceptions.some(exception => exception.code === "OVERDUE_SUPPLY")).toBe(true);
  });

  it("keeps warehouses separate", () => {
    const rows = generateRecommendations({ sales: [...days(2, 5), ...days(2, 5).map(r => ({ ...r, warehouse: "SOUTH" }))], inventory: [{ sku: "SKU-1", vendor: "Acme", warehouse: "NORTH", currentInventory: 100 }, { sku: "SKU-1", vendor: "Acme", warehouse: "SOUTH", currentInventory: 0 }], openPos: [], coverageDays: 5, settings: { defaultLeadTimeDays: 0, defaultReviewPeriodDays: 5 }, asOfDate: "2026-01-02" });
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.warehouse === "NORTH")?.suggestedPoQty).toBe(0);
    expect(rows.find(r => r.warehouse === "SOUTH")?.suggestedPoQty).toBeGreaterThan(0);
  });

  it("propagates commerce attributes and quantifies pre-receipt GMV exposure", () => {
    const sales = days(70, 10).map(row => ({
      ...row, productName: "Women Floral Dress", articleType: "Dresses", gender: "Women", colour: "Pink",
      mrpInr: 2499, sellingPriceInr: 1000, lifecycleStage: "Core", availabilityStatus: "Active",
      marketplaceSeller: "Public Seller", sourceUrl: "https://www.myntra.com/dresses/example/123/buy",
      priceCapturedOn: "2026-08-01", catalogueDataProvenance: "Public listing snapshot",
      commercialDataProvenance: "Synthetic planning assumption",
    }));
    const [row] = generateRecommendations({
      sales,
      inventory: [{ sku: "SKU-1", vendor: "Acme", warehouse: "NORTH", currentInventory: 0 }],
      openPos: [], vendorMaster: [{ vendor: "Acme", sku: "SKU-1", leadTimeDays: 10, reviewPeriodDays: 0, safetyStock: 0, unitPrice: 400 }],
      coverageDays: 10, asOfDate: "2026-03-11",
    });
    expect(row).toMatchObject({
      productName: "Women Floral Dress", articleType: "Dresses", gender: "Women", colour: "Pink",
      mrpInr: 2499, sellingPriceInr: 1000, unitPrice: 400, marketplaceSeller: "Public Seller",
      sourceUrl: "https://www.myntra.com/dresses/example/123/buy", priceCapturedOn: "2026-08-01",
      catalogueDataProvenance: "Public listing snapshot", commercialDataProvenance: "Synthetic planning assumption",
    });
    expect(row.sellingPriceInr).not.toBe(row.unitPrice);
    expect(row.stockoutExposureDays).toBe(9);
    expect(row.estimatedLostSalesUnits).toBe(90);
    expect(row.estimatedGmvAtRisk).toBe(90_000);
    expect(row.currentInventoryInvestment).toBe(0);
    expect(row.plannedInventoryInvestment).toBe(40_000);
  });

  it("reduces GMV exposure when confirmed inbound closes an interim shortage", () => {
    const sales = days(70, 10).map(row => ({ ...row, sellingPriceInr: 1000 }));
    const [row] = generateRecommendations({
      sales, inventory: [{ sku: "SKU-1", vendor: "Acme", warehouse: "NORTH", currentInventory: 0 }],
      openPos: [{ sku: "SKU-1", vendor: "Acme", warehouse: "NORTH", openPoQty: 100, expectedDate: "2026-03-13", status: "confirmed" }],
      vendorMaster: [{ vendor: "Acme", leadTimeDays: 5, reviewPeriodDays: 5, safetyStock: 0, unitPrice: 400 }],
      coverageDays: 5, asOfDate: "2026-03-11",
    });
    expect(row.stockoutExposureDays).toBe(1);
    expect(row.estimatedLostSalesUnits).toBe(10);
    expect(row.estimatedGmvAtRisk).toBe(10_000);
  });

  it("surfaces excess inventory at cost against the complete target", () => {
    const [row] = generateRecommendations({
      sales: days(70, 10), inventory: [{ sku: "SKU-1", vendor: "Acme", warehouse: "NORTH", currentInventory: 250 }],
      openPos: [], vendorMaster: [{ vendor: "Acme", leadTimeDays: 5, reviewPeriodDays: 5, safetyStock: 0, unitPrice: 400 }],
      coverageDays: 5, asOfDate: "2026-03-11",
    });
    expect(row.requiredStock).toBe(100);
    expect(row.excessInventoryUnits).toBe(150);
    expect(row.excessInventoryValue).toBe(60_000);
    expect(row.exceptions.some(exception => exception.code === "EXCESS_INVENTORY")).toBe(true);
  });

  it("blocks replenishment for an end-of-life article even when demand creates a need", () => {
    const sales = days(70, 10).map(row => ({ ...row, lifecycleStage: "End of Life", endOfLifeDate: "2026-03-01" }));
    const [row] = generateRecommendations({
      sales, inventory: [{ sku: "SKU-1", vendor: "Acme", warehouse: "NORTH", currentInventory: 0 }], openPos: [],
      vendorMaster: [{ vendor: "Acme", leadTimeDays: 5, reviewPeriodDays: 5, safetyStock: 0, unitPrice: 400 }],
      coverageDays: 5, asOfDate: "2026-03-11",
    });
    expect(row.rawPoQty).toBeGreaterThan(0);
    expect(row.suggestedPoQty).toBe(0);
    expect(row.exceptions.some(exception => exception.code === "LIFECYCLE_BUY_BLOCKED")).toBe(true);
  });

  it("exposes additive forecast diagnostics on every recommendation", () => {
    const [row] = generateRecommendations({
      sales: days(98, 10), inventory: [{ sku: "SKU-1", vendor: "Acme", warehouse: "NORTH", currentInventory: 20 }],
      openPos: [], coverageDays: 5, settings: { forecastMethod: "auto" }, asOfDate: "2026-04-08",
    });
    expect(row.backtestActualUnits).toBeGreaterThan(0);
    expect(row.backtestAbsoluteErrorUnits).toBeGreaterThanOrEqual(0);
    expect(row.forecastConfidenceScore).toBeGreaterThan(0);
    expect(["champion", "ensemble"]).toContain(row.forecastSelectionStrategy);
  });

  it("runs the complete synthetic Myntra portfolio with auditable risk and lifecycle outcomes", () => {
    const sample = (name: string) => readFileSync(new URL(`../sample-data/demo/${name}`, import.meta.url), "utf8");
    const rows = generateRecommendations({
      sales: parseSalesCsv(sample("historical_sales.csv")),
      inventory: parseInventoryCsv(sample("current_inventory.csv")),
      openPos: parseOpenPoCsv(sample("open_purchase_orders.csv")),
      vendorMaster: parseVendorMasterCsv(sample("vendor_master.csv")),
      coverageDays: 14,
      settings: { forecastMethod: "auto", lookbackDays: 180 },
      asOfDate: "2026-08-01",
    });
    expect(rows).toHaveLength(38);
    expect(rows.every(row => row.currency === "INR" && row.marketplace === "Myntra")).toBe(true);
    expect(rows.every(row => row.sourceUrl?.startsWith("https://www.myntra.com/") && row.priceCapturedOn === "2026-08-01")).toBe(true);
    expect(rows.every(row => row.marketplaceSeller && row.catalogueDataProvenance && row.commercialDataProvenance)).toBe(true);
    expect(rows.every(row => row.unitPrice !== row.sellingPriceInr)).toBe(true);
    expect(rows.some(row => (row.estimatedGmvAtRisk ?? 0) > 0)).toBe(true);
    expect(rows.some(row => (row.excessInventoryValue ?? 0) > 0)).toBe(true);
    const launch = rows.find(row => row.lifecycleStage === "Launch");
    expect(launch?.forecastQuality).toBe("low");
    expect(launch?.exceptions.some(exception => exception.code === "NEW_LAUNCH")).toBe(true);
    const exit = rows.find(row => row.lifecycleStage === "End of Life");
    expect(exit?.suggestedPoQty).toBe(0);
    expect(exit?.exceptions.some(exception => exception.code === "LIFECYCLE_BUY_BLOCKED")).toBe(true);
    const actual = rows.reduce((sum, row) => sum + row.backtestActualUnits, 0);
    const absoluteError = rows.reduce((sum, row) => sum + row.backtestAbsoluteErrorUnits, 0);
    expect(actual).toBeGreaterThan(0);
    expect(absoluteError / actual).toBeGreaterThanOrEqual(0);
    expect(absoluteError / actual).toBeLessThan(1);
  });
});
