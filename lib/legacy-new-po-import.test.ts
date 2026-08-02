import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adaptNewPoDataset } from "./new-po-adapter";
import { isMyntraOperationalCsvBundle, parseMyntraOperationalCsvBundle } from "./legacy-new-po-import";
import type { NewPoSourceFile, NewPoSourceType } from "./new-po-import";
import { generateRecommendations } from "./po-engine";

const demoDirectory = new URL("../sample-data/demo/", import.meta.url);

function demoSources(): Array<NewPoSourceFile & { sourceType: NewPoSourceType }> {
  return [
    ["sales", "historical_sales.csv"],
    ["inventory", "current_inventory.csv"],
    ["openPos", "open_purchase_orders.csv"],
    ["styleDetails", "vendor_master.csv"],
  ].map(([sourceType, fileName]) => ({
    sourceType: sourceType as NewPoSourceType,
    fileName,
    data: readFileSync(new URL(fileName, demoDirectory)),
  }));
}

describe("Myntra operational CSV compatibility", () => {
  it("runs the four documented demo files through the exact style-cover methodology", () => {
    const sources = demoSources();
    expect(isMyntraOperationalCsvBundle(sources)).toBe(true);

    const imported = parseMyntraOperationalCsvBundle(sources);
    expect(imported.report).toMatchObject({
      sourceFormat: "myntra_operational_csv",
      totalRows: 7_547,
      rowCounts: { sales: 7_428, inventory: 38, openPos: 20, styleDetails: 61 },
      compatibility: {
        vendorWideRuleRows: 23,
        styleSpecificRuleRows: 38,
        generatedStyleDetailRows: 27,
        variantSupplierSkuStyleIds: ["7139482", "32016912", "34530975"],
      },
    });
    expect(imported.data.styleDetails).toHaveLength(27);
    expect(imported.data.styleDetails.every(row => row.fileName === "vendor_master.csv" && Boolean(row.rowNumber))).toBe(true);
    expect(imported.data.styleDetails.find(row => row.styleId === "7139482")?.supplierSku).toBeUndefined();
    expect(imported.data.sales[0]).toMatchObject({
      quantity: 45,
      returnsQty: 3,
      cancellationsQty: 1,
      isPromotion: false,
      inStock: true,
    });
    expect(imported.data.sales.some(row => row.isPromotion === true)).toBe(true);
    expect(imported.data.sales.some(row => row.inStock === false)).toBe(true);

    const dataset = adaptNewPoDataset(imported.data, 45, 80);
    const recommendations = generateRecommendations({
      sales: dataset.sales,
      inventory: dataset.inventory,
      openPos: dataset.openPos,
      vendorMaster: dataset.vendorMaster,
      coverageDays: 45,
      asOfDate: dataset.asOfDate,
      settings: { calculationMethod: "style_drr_cover_v1", dohThreshold: 80, forecastMethod: "average" },
    });

    expect(dataset.calculationPreview.summary).toEqual({
      distinctSalesDays: 210,
      salesDateStart: "2026-01-03",
      salesDateEnd: "2026-07-31",
      styleCount: 27,
      eligibleStyleCount: 27,
      excludedStyleCount: 0,
      positiveAskStyleCount: 19,
      negativeAskStyleCount: 8,
      zeroAskStyleCount: 0,
      actionableStyleCount: 19,
      signedPoAskUnits: 10_957,
      actionablePoUnits: 11_747,
      actionablePoValueInr: 3_851_046,
      salesUnits: 136_958,
      inventoryUnits: 10_038,
      openPoUnits: 8_352,
    });
    expect(recommendations).toHaveLength(27);
    expect(recommendations.reduce((sum, row) => sum + row.suggestedPoQty, 0)).toBe(11_747);
    expect(dataset.vendorMaster.every(row => row.marketplace === "Myntra" && row.currency === "INR")).toBe(true);
    expect(dataset.sales[0]).toMatchObject({
      unitsSold: 45,
      returnsQty: 3,
      cancellationsQty: 1,
      isPromotion: false,
      inStock: true,
    });
    expect(recommendations.some(row => row.returnRate > 0)).toBe(true);
    expect(recommendations.some(row => row.cancellationRate > 0)).toBe(true);
    expect(recommendations.some(row => row.promotionAdjustedDays > 0)).toBe(true);
    expect(recommendations.some(row => row.stockoutDaysInHistory > 0)).toBe(true);
  });

  it("does not reinterpret a malformed strict style-details file as a vendor-wide operational master", () => {
    const sources = demoSources();
    sources[3] = {
      sourceType: "styleDetails",
      fileName: "style_details.csv",
      data: "Style Id,Model,MRP,NLC\n,Missing identity,1000,500\n",
    };
    expect(isMyntraOperationalCsvBundle(sources)).toBe(false);
  });

  it("validates vendor-wide defaults even though they are not style-detail rows", () => {
    const sources = demoSources();
    sources[3] = {
      ...sources[3],
      data: String(sources[3].data).replace("garg@supplier-demo.example", "not-an-email"),
    };
    expect(() => parseMyntraOperationalCsvBundle(sources)).toThrow(/Supplier email is not valid/);
  });
});
