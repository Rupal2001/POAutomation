import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adaptNewPoDataset } from "./new-po-adapter";
import { parseNewPoBulkWorkbook, parseNewPoSourceFile } from "./new-po-import";
import { generateRecommendations } from "./po-engine";

const attachment = new URL("../sample-data/methodology/Noise_113.xlsx", import.meta.url);

describe("New PO engine integration", () => {
  it("uses the documented style DRR/cover calculation in recommendations", async () => {
    const file = readFileSync(attachment);
    const bundle = await parseNewPoBulkWorkbook(file, "Noise 113.xlsx");
    const dataset = adaptNewPoDataset(bundle.data, 45, 80);
    const rows = generateRecommendations({
      sales: dataset.sales,
      inventory: dataset.inventory,
      openPos: dataset.openPos,
      vendorMaster: dataset.vendorMaster,
      coverageDays: 45,
      asOfDate: dataset.asOfDate,
      settings: { calculationMethod: "style_drr_cover_v1", dohThreshold: 80, forecastMethod: "average" },
    });

    expect(rows).toHaveLength(121);
    expect(rows.filter(row => row.dohEligible)).toHaveLength(49);
    expect(rows.reduce((sum, row) => sum + row.suggestedPoQty, 0)).toBe(8517);
    expect(rows.find(row => row.styleId === "36627115")).toMatchObject({
      totalSalesUnits: 3265,
      uniqueOrderDays: 30,
      currentInventory: 461,
      signedPoQtyAsk: 4437,
      suggestedPoQty: 4437,
      productName: "Buds F1",
      mrpInr: 3499,
      unitPrice: 1065.18,
    });
    expect(rows.find(row => row.styleId === "41280678")).toMatchObject({ signedPoQtyAsk: -50, suggestedPoQty: 0 });
    expect(rows.find(row => row.styleId === "30049972")?.exceptions.map(exception => exception.code)).toContain("MISSING_STYLE_METADATA");
  });

  it("carries common supplier-commercial header aliases into PO-ready vendor rules", async () => {
    const parsed = await parseNewPoSourceFile({
      fileName: "commercial-style-master.csv",
      sourceType: "styleDetails",
      data: [
        "Style Code,Product Name,MRP INR,Unit Price,Supplier,Supplier Email,Vendor SKU,HSN/SAC Code,GST Rate (%),Vendor GSTIN,Vendor State,Lead Time (Days),Credit Terms,Inco Term,Minimum Order Qty,Case Pack",
        "36627115,Noise Buds F1,3499,1065.18,NEXXBASE MARKETING PVT LTD,buying@example.com,NOISE-36627115,85183000,18,29AACCN1234A1Z5,Karnataka,21,Net 30,DDP,100,20",
      ].join("\n"),
    });
    const styleDetails = parsed.data.styleDetails!;
    expect(styleDetails[0]).toMatchObject({
      styleId: "36627115",
      vendorName: "NEXXBASE MARKETING PVT LTD",
      contactEmail: "buying@example.com",
      supplierSku: "NOISE-36627115",
      hsnCode: "85183000",
      gstRate: 18,
      supplierGstin: "29AACCN1234A1Z5",
      supplierState: "Karnataka",
      leadTimeDays: 21,
      paymentTerms: "Net 30",
      incoterms: "DDP",
      moq: 100,
      packSize: 20,
    });

    const dataset = adaptNewPoDataset({
      sales: [{ salesDate: "2026-06-01", styleId: "36627115", quantity: 1, brand: "NOISE" }],
      inventory: [{ styleId: "36627115", inventoryUnits: 0 }],
      openPos: [],
      styleDetails,
    }, 45, 80);
    expect(dataset.vendorMaster[0]).toMatchObject({
      vendor: "NEXXBASE MARKETING PVT LTD",
      sku: "36627115",
      supplierSku: "NOISE-36627115",
      contactEmail: "buying@example.com",
      hsnCode: "85183000",
      gstRate: 18,
      gstin: "29AACCN1234A1Z5",
      supplierState: "Karnataka",
      leadTimeDays: 21,
      paymentTerms: "Net 30",
      incoterms: "DDP",
      moq: 100,
      packSize: 20,
      unitPrice: 1065.18,
      currency: "INR",
    });

    const [recommendation] = generateRecommendations({
      sales: dataset.sales,
      inventory: dataset.inventory,
      openPos: dataset.openPos,
      vendorMaster: dataset.vendorMaster,
      coverageDays: 45,
      asOfDate: dataset.asOfDate,
      settings: { calculationMethod: "style_drr_cover_v1", dohThreshold: 80, forecastMethod: "average" },
    });
    expect(recommendation).toMatchObject({
      suggestedPoQty: 45,
      leadTimeDays: 21,
      expectedDeliveryDate: "2026-06-22",
    });
  });

  it("does not nominate a prior open-PO supplier without a commercial mapping", () => {
    const dataset = adaptNewPoDataset({
      sales: [{ salesDate: "2026-06-01", styleId: "1", quantity: 10, brand: "NOISE" }],
      inventory: [{ styleId: "1", inventoryUnits: 0 }],
      openPos: [{ styleId: "1", pendingQuantity: 1, vendorName: "Historical Supplier" }],
      styleDetails: [{ styleId: "1", model: "Noise Test", mrpInr: 2_999, nlcInr: 1_000, fileName: "styles.csv", rowNumber: 2 }],
    }, 45, 80);
    const [recommendation] = generateRecommendations({
      ...dataset,
      coverageDays: 45,
      settings: { calculationMethod: "style_drr_cover_v1", dohThreshold: 80, forecastMethod: "average" },
    });
    expect(recommendation.vendor).toBe("Supplier mapping required");
    expect(recommendation.exceptions.map(exception => exception.code)).toContain("MISSING_VENDOR");
    expect(recommendation.catalogueDataProvenance).toContain("styles.csv · row 2");
  });

  it("treats zero INR MRP or NLC as missing commercial data", () => {
    const [recommendation] = generateRecommendations({
      sales: [{ date: "2026-06-01", sku: "1", styleId: "1", vendor: "Supplier A", unitsSold: 1 }],
      inventory: [{ sku: "1", styleId: "1", vendor: "Supplier A", currentInventory: 0 }],
      openPos: [],
      vendorMaster: [{ sku: "1", styleId: "1", vendor: "Supplier A", productName: "Test style", mrpInr: 1_000, unitPrice: 0, currency: "INR" }],
      coverageDays: 45,
      asOfDate: "2026-06-01",
      settings: { calculationMethod: "style_drr_cover_v1", dohThreshold: 80, forecastMethod: "average" },
    });
    expect(recommendation.unitPrice).toBeNull();
    expect(recommendation.exceptions.map(exception => exception.code)).toEqual(expect.arrayContaining(["MISSING_STYLE_METADATA", "MISSING_PRICE"]));
  });
});
