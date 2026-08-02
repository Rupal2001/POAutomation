import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  calculateNewPoMethodology,
  excelRoundRatio,
  type NewPoCalculationInput,
} from "./new-po-methodology";
import {
  NEW_PO_MAX_UPLOAD_BYTES,
  NewPoImportError,
  combineNewPoSourceImports,
  normalizeYyyyMmDd,
  parseNewPoBulkWorkbook,
  parseNewPoSourceFile,
} from "./new-po-import";

const style = (styleId: string, model = `Model ${styleId}`) => ({
  styleId, model, mrpInr: 2_999, nlcInr: 1_000,
});

function smallInput(): NewPoCalculationInput {
  return {
    sales: [
      { salesDate: "2026-06-01", styleId: "A", quantity: 1 },
      { salesDate: "2026-06-02", styleId: "B", quantity: 2 },
      // Repeated source rows are legitimate and must be summed, not deduplicated.
      { salesDate: "2026-06-02", styleId: "B", quantity: 2 },
      { salesDate: "2026-06-01", styleId: "MISSING", quantity: 1 },
    ],
    inventory: [
      { styleId: "A", inventoryUnits: 1 },
      { styleId: "B", inventoryUnits: 2 },
      { styleId: "B", inventoryUnits: 3 },
      { styleId: "INVENTORY_ONLY", inventoryUnits: 9 },
    ],
    openPos: [
      { styleId: "B", pendingQuantity: 1 },
      { styleId: "B", pendingQuantity: 2 },
      { styleId: "OPEN_ONLY", pendingQuantity: 5 },
    ],
    styleDetails: [style("A"), style("B"), style("MASTER_ONLY")],
  };
}

describe("New PO methodology calculator", () => {
  it("uses the global distinct-day denominator and preserves repeated rows", () => {
    const result = calculateNewPoMethodology(smallInput(), { coverDays: 1, dohThreshold: 80 });
    expect(result.summary).toMatchObject({ distinctSalesDays: 2, styleCount: 3, salesUnits: 6, inventoryUnits: 15, openPoUnits: 8 });
    expect(result.rows.map(row => row.styleId)).toEqual(["A", "B", "MISSING"]);

    const a = result.rows.find(row => row.styleId === "A")!;
    expect(a.dailyRunRate).toBe(0.5); // A sold on one day, but denominator remains two global days.
    expect(a.rawPoQtyAsk).toBe(-0.5);
    expect(a.poQtyAsk).toBe(-1);
    expect(a.actionablePoQty).toBe(0);

    const b = result.rows.find(row => row.styleId === "B")!;
    expect(b.sumOfSales).toBe(4);
    expect(b.currentInventory).toBe(5);
    expect(b.openPoQuantity).toBe(3);
  });

  it("reports missing and orphaned data without changing the sales-led style universe", () => {
    const result = calculateNewPoMethodology(smallInput());
    expect(result.dataQuality).toMatchObject({
      missingInventoryStyleIds: ["MISSING"],
      missingStyleMetadataStyleIds: ["MISSING"],
      inventoryOnlyStyleIds: ["INVENTORY_ONLY"],
      openPoOnlyStyleIds: ["OPEN_ONLY"],
      styleMasterOnlyStyleIds: ["MASTER_ONLY"],
    });
    const missing = result.rows.find(row => row.styleId === "MISSING")!;
    expect(missing).toMatchObject({ currentInventory: 0, openPoQuantity: 0, model: null, mrpInr: null, nlcInr: null });
    expect(missing.qualityFlags).toEqual(expect.arrayContaining(["MISSING_INVENTORY", "MISSING_OPEN_PO", "MISSING_STYLE_METADATA"]));
  });

  it("implements Excel half-away-from-zero rounding exactly", () => {
    expect(excelRoundRatio(183, 2)).toBe(92);
    expect(excelRoundRatio(-99, 2)).toBe(-50);
    expect(excelRoundRatio(-1, 2)).toBe(-1);
    expect(excelRoundRatio(20, 3)).toBe(7);
  });

  it("marks zero DRR as NA-equivalent and excludes it from DOH eligibility", () => {
    const input: NewPoCalculationInput = {
      sales: [
        { salesDate: "2026-06-01", styleId: "ZERO", quantity: 0 },
        { salesDate: "2026-06-02", styleId: "OTHER", quantity: 1 },
      ],
      inventory: [{ styleId: "ZERO", inventoryUnits: 10 }, { styleId: "OTHER", inventoryUnits: 0 }],
      openPos: [],
      styleDetails: [style("ZERO"), style("OTHER")],
    };
    const result = calculateNewPoMethodology(input);
    expect(result.rows.find(row => row.styleId === "ZERO")).toMatchObject({
      dailyRunRate: 0, daysOnHand: null, eligible: false, poQtyAsk: -10,
    });
    expect(result.dataQuality.zeroDrrStyleIds).toEqual(["ZERO"]);
  });

  it("rejects conflicting style-master records", () => {
    const input = smallInput();
    input.styleDetails.push({ ...style("A"), model: "Different model" });
    expect(() => calculateNewPoMethodology(input)).toThrow(/conflicting records for style A/);
  });

  it("rejects commercially conflicting duplicates even when model and prices match", () => {
    const input = smallInput();
    input.styleDetails[0] = { ...input.styleDetails[0], vendorName: "Supplier A", contactEmail: "a@example.com" };
    input.styleDetails.push({ ...input.styleDetails[0], vendorName: "Supplier B", contactEmail: "b@example.com" });
    expect(() => calculateNewPoMethodology(input)).toThrow(/conflicting records for style A/);
  });
});

describe("New PO source importer", () => {
  it("normalizes YYYYMMDD dates and rejects impossible dates", () => {
    expect(normalizeYyyyMmDd(20260601, "date")).toBe("2026-06-01");
    expect(normalizeYyyyMmDd("2026-06-30", "date")).toBe("2026-06-30");
    expect(() => normalizeYyyyMmDd(20260231, "date")).toThrow(/valid calendar date/);
  });

  it("combines four separate CSV sources and retains all repeated rows", async () => {
    const parts = await Promise.all([
      parseNewPoSourceFile({
        fileName: "sell-out.csv", sourceType: "sales",
        data: "order_Month,style_id,qty,brand\n20260601,0001,1,NOISE\n20260601,0001,2,NOISE\n20260602,0002,2,NOISE\n",
      }),
      parseNewPoSourceFile({
        fileName: "inventory.csv", sourceType: "inventory",
        data: "style_id,inv_units_q1,warehouse_id\n0001,1,36\n0001,2,81\n0002,0,36\n",
      }),
      parseNewPoSourceFile({
        fileName: "open-po.csv", sourceType: "openPos",
        data: "style_id,pending_qty,vendor_name,estimated_shipment_date\n0001,1,NEXXBASE,20260907\n0001,2,NEXXBASE,20260907\n0002,0,NEXXBASE,20260907\n",
      }),
      parseNewPoSourceFile({
        fileName: "styles.csv", sourceType: "styleDetails",
        data: "Style Id,Model,MRP,NLC\n0001,Noise One,2999,1000.25\n0002,Noise Two,3999,2000\n",
      }),
    ]);
    const combined = combineNewPoSourceImports(parts);
    expect(combined.report).toMatchObject({ totalRows: 11, rowCounts: { sales: 3, inventory: 3, openPos: 3, styleDetails: 2 } });
    expect(combined.data.sales).toHaveLength(3);
    expect(combined.data.sales[0]).toMatchObject({ salesDate: "2026-06-01", styleId: "0001" });
    expect(combined.data.openPos[0].estimatedShipmentDate).toBe("2026-09-07");
    const result = calculateNewPoMethodology(combined.data);
    expect(result.rows.find(row => row.styleId === "0001")).toMatchObject({ sumOfSales: 3, currentInventory: 3, openPoQuantity: 3 });
  });

  it("detects malformed numeric cells and conflicting CSV style masters", async () => {
    await expect(parseNewPoSourceFile({
      fileName: "bad-inventory.csv", sourceType: "inventory", data: "style_id,inv_units_q1\n1,not-a-number\n",
    })).rejects.toMatchObject({ issues: [expect.objectContaining({ code: "INVALID_NUMBER", rowNumber: 2 })] });
    await expect(parseNewPoSourceFile({
      fileName: "bad-master.csv", sourceType: "styleDetails",
      data: "Style Id,Model,MRP,NLC\n1,Model A,2999,1000\n1,Model B,2999,1000\n",
    })).rejects.toMatchObject({ issues: [expect.objectContaining({ code: "CONFLICTING_STYLE_MASTER", rowNumber: 3 })] });
  });

  it("validates optional style-level tax and supplier ordering fields", async () => {
    await expect(parseNewPoSourceFile({
      fileName: "bad-gst.csv", sourceType: "styleDetails",
      data: "Style Id,Model,MRP,NLC,GST_Rate\n1,Model A,2999,1000,101\n",
    })).rejects.toMatchObject({ issues: [expect.objectContaining({ code: "INVALID_NUMBER", columnName: "gstRate", rowNumber: 2 })] });
    await expect(parseNewPoSourceFile({
      fileName: "bad-lead-time.csv", sourceType: "styleDetails",
      data: "Style Id,Model,MRP,NLC,Lead_Time_Days\n1,Model A,2999,1000,2.5\n",
    })).rejects.toMatchObject({ issues: [expect.objectContaining({ code: "INVALID_INTEGER", rowNumber: 2 })] });
    await expect(parseNewPoSourceFile({
      fileName: "bad-pack.csv", sourceType: "styleDetails",
      data: "Style Id,Model,MRP,NLC,Pack_Size\n1,Model A,2999,1000,-1\n",
    })).rejects.toMatchObject({ issues: [expect.objectContaining({ code: "INVALID_NUMBER", columnName: "packSize", rowNumber: 2 })] });
    await expect(parseNewPoSourceFile({
      fileName: "zero-pack.csv", sourceType: "styleDetails",
      data: "Style Id,Model,MRP,NLC,Pack_Size\n1,Model A,2999,1000,0\n",
    })).rejects.toMatchObject({ issues: [expect.objectContaining({ code: "INVALID_NUMBER", columnName: "packSize", rowNumber: 2 })] });
    await expect(parseNewPoSourceFile({
      fileName: "bad-commercial.csv", sourceType: "styleDetails",
      data: "Style Id,Model,MRP,NLC,Supplier Email,HSN,Vendor GSTIN\n1,Model A,2999,1000,not-an-email,ABC,29BAD\n",
    })).rejects.toMatchObject({ issues: [expect.objectContaining({ code: "INVALID_EMAIL", columnName: "contactEmail", rowNumber: 2 })] });
    await expect(parseNewPoSourceFile({
      fileName: "bad-mrp.csv", sourceType: "styleDetails",
      data: "Style Id,Model,MRP,NLC\n1,Model A,0,1000\n",
    })).rejects.toMatchObject({ issues: [expect.objectContaining({ code: "INVALID_NUMBER", columnName: "mrpInr", rowNumber: 2 })] });
  });

  it("detects missing required columns and enforces the upload-size guard", async () => {
    await expect(parseNewPoSourceFile({
      fileName: "bad-sales.csv", sourceType: "sales", data: "order_Month,style_id\n20260601,1\n",
    })).rejects.toMatchObject({ issues: [expect.objectContaining({ code: "MISSING_COLUMN", columnName: "quantity" })] });
    await expect(parseNewPoSourceFile({
      fileName: "too-large.csv", sourceType: "sales", data: new Uint8Array(NEW_PO_MAX_UPLOAD_BYTES + 1),
    })).rejects.toBeInstanceOf(NewPoImportError);
  });

  it("supports a separately uploaded XLSX whose sheet name is arbitrary", async () => {
    const workbook = new ExcelJS.Workbook();
    const notes = workbook.addWorksheet("Export notes");
    notes.addRow(["Generated by ERP", "Do not edit"]);
    const worksheet = workbook.addWorksheet("Export 1");
    worksheet.addRow(["order_Month", "style_id", "qty"]);
    worksheet.addRow([20260601, 12345678, 2]);
    const bytes = await workbook.xlsx.writeBuffer();
    const parsed = await parseNewPoSourceFile({ fileName: "sales.xlsx", data: bytes as ArrayBuffer, sourceType: "sales" });
    expect(parsed.data.sales).toEqual([expect.objectContaining({ salesDate: "2026-06-01", styleId: "12345678", quantity: 2 })]);
    expect(parsed.report.ignoredSheetNames).toEqual(["Export notes"]);
  });

  it("reports every missing source tab in an incomplete bulk workbook", async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("NOISE headphones Sell out");
    worksheet.addRow(["order_Month", "style_id", "qty"]);
    worksheet.addRow([20260601, 12345678, 2]);
    const bytes = await workbook.xlsx.writeBuffer();
    await expect(parseNewPoBulkWorkbook(bytes as ArrayBuffer, "incomplete.xlsx")).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "MISSING_SOURCE", message: expect.stringContaining("current inventory") }),
        expect.objectContaining({ code: "MISSING_SOURCE", message: expect.stringContaining("open PO") }),
        expect.objectContaining({ code: "MISSING_SOURCE", message: expect.stringContaining("style details") }),
      ]),
    });
  });

  it("accepts a header-only Open PO source", async () => {
    const parsed = await parseNewPoSourceFile({
      fileName: "open-po.csv", sourceType: "openPos", data: "style_id,pending_qty,vendor_name\n",
    });
    expect(parsed.data.openPos).toEqual([]);
  });
});

const attachmentPath = new URL("../sample-data/methodology/Noise_113.xlsx", import.meta.url);

describe("Noise 113 attachment regression", () => {
  it("matches the documented methodology invariants", async () => {
    const imported = await parseNewPoBulkWorkbook(readFileSync(attachmentPath), "Noise 113.xlsx");
    expect(imported.report).toMatchObject({
      totalRows: 4_767,
      rowCounts: { sales: 2_525, openPos: 82, inventory: 2_051, styleDetails: 109 },
    });
    const result = calculateNewPoMethodology(imported.data);
    expect(result.summary).toMatchObject({
      distinctSalesDays: 30,
      salesDateStart: "2026-06-01",
      salesDateEnd: "2026-06-30",
      styleCount: 121,
      eligibleStyleCount: 49,
      positiveAskStyleCount: 24,
      negativeAskStyleCount: 97,
      actionableStyleCount: 24,
      signedPoAskUnits: -10_618,
      actionablePoUnits: 8_517,
      salesUnits: 11_286,
      inventoryUnits: 23_132,
      openPoUnits: 4_680,
    });

    expect(result.rows.find(row => row.styleId === "36627115")).toMatchObject({ poQtyAsk: 4_437, actionablePoQty: 4_437 });
    expect(result.rows.find(row => row.styleId === "30953258")).toMatchObject({ poQtyAsk: 92, model: "Buds Nero", nlcInr: 799 });
    expect(result.rows.find(row => row.styleId === "31744535")).toMatchObject({ openPoQuantity: 80, poQtyAsk: 11 });
    expect(result.rows.find(row => row.styleId === "41280678")).toMatchObject({ openPoQuantity: 160, poQtyAsk: -50, actionablePoQty: 0 });
    expect(result.rows.find(row => row.styleId === "23197358")).toMatchObject({
      currentInventory: 0, openPoQuantity: 0, poQtyAsk: 2, model: null, mrpInr: null, nlcInr: null,
    });
    expect(result.dataQuality.missingStyleMetadataStyleIds).toHaveLength(25);
  });
});
