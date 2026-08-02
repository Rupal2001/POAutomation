import ExcelJS from "exceljs";
import { Recommendation } from "./po-engine";

export async function buildVendorWorkbook(
  vendor: string,
  rows: Recommendation[],
  coverageDays: number,
  runDate: string
): Promise<ExcelJS.Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "StyleFlow planning";
  wb.created = new Date();

  const ws = wb.addWorksheet("Planning Recommendations");

  ws.mergeCells("A1:J1");
  const titleCell = ws.getCell("A1");
  titleCell.value = safeSpreadsheetText(`Planning recommendations — ${vendor}`);
  titleCell.font = { size: 14, bold: true, color: { argb: "FF1B1F23" } };

  ws.getCell("A2").value = `PO Date: ${runDate}`;
  ws.getCell("A2").font = { italic: true };
  ws.getCell("A3").value = `Coverage Target: ${coverageDays} days`;
  ws.getCell("A3").font = { italic: true };

  const headerRowIdx = 5;
  const headers = [
    "SKU",
    "Warehouse",
    "Daily Run Rate",
    "Inventory Position",
    "Safety Stock",
    "Stockout Date",
    "Expected Delivery",
    "Order Qty",
    "Unit Price (INR)",
    "Estimated Value (INR)",
  ];
  const headerRow = ws.getRow(headerRowIdx);
  headers.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2B3A55" } };
    cell.alignment = { horizontal: "center" };
    cell.border = thinBorder();
  });

  let r = headerRowIdx + 1;
  for (const row of rows) {
    const values = [
      safeSpreadsheetText(row.sku),
      safeSpreadsheetText(row.warehouse),
      row.dailyRunRate,
      row.inventoryPosition,
      row.safetyStock,
      row.projectedStockoutDate ?? "",
      row.expectedDeliveryDate,
      row.suggestedPoQty,
      row.unitPrice ?? "",
      row.estimatedValue ?? "",
    ];
    values.forEach((v, i) => {
      const cell = ws.getRow(r).getCell(i + 1);
      cell.value = v as any;
      cell.border = thinBorder();
    });
    r += 1;
  }

  ws.getCell(`A${r}`).value = "TOTAL";
  ws.getCell(`A${r}`).font = { bold: true };
  ws.getCell(`H${r}`).value = { formula: `SUM(H${headerRowIdx + 1}:H${r - 1})` } as any;
  ws.getCell(`H${r}`).font = { bold: true };
  ws.getCell(`J${r}`).value = { formula: `SUM(J${headerRowIdx + 1}:J${r - 1})` } as any;
  ws.getCell(`J${r}`).font = { bold: true };

  ws.columns = [
    { width: 18 },
    { width: 18 },
    { width: 16 }, { width: 18 }, { width: 14 }, { width: 16 },
    { width: 18 }, { width: 12 }, { width: 12 }, { width: 16 },
  ];

  return wb.xlsx.writeBuffer();
}

function thinBorder(): Partial<ExcelJS.Borders> {
  const side: Partial<ExcelJS.Border> = { style: "thin", color: { argb: "FFE4E1D8" } };
  return { top: side, left: side, right: side, bottom: side };
}

export function buildMasterCsv(rows: Recommendation[]): string {
  const headers = [
    "Marketplace",
    "Category",
    "Brand",
    "Style_ID",
    "Product_Name",
    "Size",
    "Marketplace_Seller",
    "MRP_INR",
    "Observed_Selling_Price_INR",
    "Price_Captured_On",
    "Myntra_Product_URL",
    "Catalogue_Data_Provenance",
    "Commercial_Data_Provenance",
    "Vendor",
    "SKU",
    "Warehouse",
    "Daily_Run_Rate",
    "Current_Inventory",
    "Reserved_Qty",
    "Backorder_Qty",
    "Open_PO_Qty",
    "Late_Open_PO_Qty",
    "Inventory_Position",
    "Lead_Time_Days",
    "Safety_Stock",
    "Required_Stock",
    "Days_on_Hand",
    "Projected_Stockout_Date",
    "Reorder_By_Date",
    "Expected_Delivery_Date",
    "Suggested_PO_Qty",
    "Unit_Price",
    "Currency",
    "Estimated_Value",
    "Exceptions",
  ];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      [
        "Myntra",
        csvEscape(r.category ?? ""),
        csvEscape(r.brand ?? ""),
        csvEscape(r.styleId ?? ""),
        csvEscape(r.productName ?? ""),
        csvEscape(r.size ?? ""),
        csvEscape(r.marketplaceSeller ?? ""),
        r.mrpInr ?? "",
        r.sellingPriceInr ?? "",
        r.priceCapturedOn ?? "",
        csvEscape(r.sourceUrl ?? ""),
        csvEscape(r.catalogueDataProvenance ?? ""),
        csvEscape(r.commercialDataProvenance ?? ""),
        csvEscape(r.vendor),
        csvEscape(r.sku),
        csvEscape(r.warehouse ?? "MAIN"),
        r.dailyRunRate,
        r.currentInventory,
        r.reservedQty,
        r.backorderQty,
        r.openPoQty,
        r.lateOpenPoQty,
        r.inventoryPosition,
        r.leadTimeDays,
        r.safetyStock,
        r.requiredStock,
        r.daysOnHand ?? "",
        r.projectedStockoutDate ?? "",
        r.reorderByDate ?? "",
        r.expectedDeliveryDate ?? "",
        r.suggestedPoQty,
        r.unitPrice ?? "",
        "INR",
        r.estimatedValue ?? "",
        csvEscape((r.exceptions ?? []).map((e) => e.code).join("|")),
      ].join(",")
    );
  }
  return lines.join("\n");
}

function csvEscape(v: string): string {
  const safe = safeSpreadsheetText(v);
  if (safe.includes(",") || safe.includes('"') || safe.includes("\n")) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

/** Prevents CSV/XLSX cells sourced from uploads from becoming formulas. */
export function safeSpreadsheetText(value: unknown) {
  const text = String(value ?? "");
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}
