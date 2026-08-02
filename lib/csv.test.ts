import { describe, expect, it } from "vitest";
import { CsvValidationError, parseInventoryCsv, parseOpenPoCsv, parseSalesCsv, parseVendorMasterCsv } from "./csv";

describe("CSV validation", () => {
  it("accepts extended planning fields", () => {
    const [row] = parseVendorMasterCsv("Vendor,SKU,Lead_Time_Days,Safety_Stock,Unit_Price,Currency\nAcme India,A1,12,20,450,INR");
    expect(row).toMatchObject({ vendor: "Acme India", sku: "A1", leadTimeDays: 12, safetyStock: 20, unitPrice: 450, currency: "INR" });
  });
  it("rejects malformed numbers instead of silently changing them to zero", () => {
    expect(() => parseInventoryCsv("SKU,Vendor,Current_Inventory\nA1,Acme,unknown")).toThrow(CsvValidationError);
  });
  it("parses and validates the inventory snapshot date", () => {
    const [row] = parseInventoryCsv("SKU,Vendor,Current_Inventory,Snapshot_Date\nA1,Acme,12,2026-08-01");
    expect(row.snapshotDate).toBe("2026-08-01");
    expect(() => parseInventoryCsv("SKU,Vendor,Current_Inventory,Snapshot_Date\nA1,Acme,12,2026-02-31")).toThrow(/Snapshot_Date/);
  });
  it("rejects invalid dates", () => {
    expect(() => parseSalesCsv("Date,SKU,Vendor,Units_Sold\nnot-a-date,A1,Acme,3")).toThrow(/YYYY-MM-DD/);
    expect(() => parseSalesCsv("Date,SKU,Vendor,Units_Sold\n2026-02-31,A1,Acme,3")).toThrow(/YYYY-MM-DD/);
  });
  it("rejects non-INR supplier costs", () => {
    expect(() => parseVendorMasterCsv("Vendor,Unit_Price,Currency\nForeign Supplier,10,USD")).toThrow(/Currency must be INR/);
  });
  it("parses the richer Myntra commerce and lifecycle attributes", () => {
    const csv = [
      "Date,SKU,Vendor,Units_Sold,Marketplace,Product_Name,Article_Type,Gender,Colour,MRP_INR,Selling_Price_INR,Lifecycle_Stage,Availability_Status,Launch_Date,End_Of_Life_Date",
      "2026-07-31,A1,Acme India,12,Myntra,Floral Dress,Dresses,Women,Pink,2499,1299,Launch,Active,2026-07-01,",
    ].join("\n");
    const [row] = parseSalesCsv(csv);
    expect(row).toMatchObject({ marketplace: "Myntra", productName: "Floral Dress", articleType: "Dresses", gender: "Women", colour: "Pink", mrpInr: 2499, sellingPriceInr: 1299, lifecycleStage: "Launch", availabilityStatus: "Active", launchDate: "2026-07-01" });
  });
  it("parses public catalogue provenance without treating selling price as procurement cost", () => {
    const csv = [
      "Vendor,SKU,Unit_Price,Currency,MRP_INR,Typical_Selling_Price_INR,Marketplace_Seller,Myntra_Product_URL,Price_Captured_On,Catalogue_Data_Provenance,Commercial_Data_Provenance",
      "Public Seller,A1,450,INR,2499,1299,Public Seller,https://www.myntra.com/example/123/buy,2026-08-01,Public Myntra product listing snapshot,Synthetic demo planning assumption",
    ].join("\n");
    const [row] = parseVendorMasterCsv(csv);
    expect(row).toMatchObject({
      unitPrice: 450,
      mrpInr: 2499,
      sellingPriceInr: 1299,
      marketplaceSeller: "Public Seller",
      sourceUrl: "https://www.myntra.com/example/123/buy",
      priceCapturedOn: "2026-08-01",
      catalogueDataProvenance: "Public Myntra product listing snapshot",
      commercialDataProvenance: "Synthetic demo planning assumption",
    });
    expect(row.unitPrice).not.toBe(row.sellingPriceInr);
  });
  it("rejects non-Myntra marketplace rows and negative quantities", () => {
    expect(() => parseSalesCsv("Date,SKU,Vendor,Units_Sold,Marketplace\n2026-01-01,A1,Acme,3,Other")).toThrow(/Marketplace must be Myntra/);
    expect(() => parseInventoryCsv("SKU,Vendor,Current_Inventory\nA1,Acme,-2")).toThrow(/cannot be negative/);
  });
  it("validates inbound dates and INR currency", () => {
    expect(() => parseOpenPoCsv("SKU,Vendor,Open_PO_Qty,Expected_Date\nA1,Acme,10,tomorrow")).toThrow(/YYYY-MM-DD/);
    expect(() => parseOpenPoCsv("SKU,Vendor,Open_PO_Qty,Currency\nA1,Acme,10,USD")).toThrow(/Currency must be INR/);
  });
  it("accepts a header-only inbound file when there are no open purchase orders", () => {
    expect(parseOpenPoCsv("SKU,Vendor,Open_PO_Qty,Expected_Date,Currency\n")).toEqual([]);
    expect(() => parseOpenPoCsv("SKU,Vendor\n")).toThrow(/Open_PO_Qty/);
  });
  it("rejects impossible commerce and lifecycle relationships", () => {
    expect(() => parseSalesCsv("Date,SKU,Vendor,Units_Sold,Returns_Qty,Cancellations_Qty\n2026-01-01,A1,Acme,10,8,4")).toThrow(/fulfilled units/);
    expect(() => parseInventoryCsv("SKU,Vendor,Current_Inventory,MRP_INR,Selling_Price_INR\nA1,Acme,2,999,1299")).toThrow(/cannot exceed MRP/);
    expect(() => parseVendorMasterCsv("Vendor,Launch_Date,End_Of_Life_Date\nAcme,2026-08-01,2026-07-01")).toThrow(/cannot be before/);
    expect(() => parseInventoryCsv("SKU,Vendor,Current_Inventory,Price_Captured_On\nA1,Acme,2,2026-02-31")).toThrow(/Price_Captured_On/);
  });
});
