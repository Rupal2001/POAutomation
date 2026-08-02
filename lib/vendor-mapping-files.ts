import ExcelJS from "exceljs";
import Papa from "papaparse";
import { safeSpreadsheetText } from "./export";
import {
  VENDOR_MAPPING_FILE_LIMIT_BYTES,
  VENDOR_MAPPING_IMPORT_LIMIT,
  normalizeVendorMappingInput,
  publicVendorMapping,
  vendorMappingKey,
  type VendorMappingInput,
  type VendorMappingRecord,
} from "./vendor-mappings";

export const VENDOR_MAPPING_IMPORT_VERSION = "vendor-mapping-import/2026-08-02-v1";

const COLUMNS = [
  ["styleId", "Style ID", ["styleid", "stylecode", "sku"]],
  ["productName", "Product Name", ["productname", "model", "stylename"]],
  ["brand", "Brand", ["brand"]],
  ["category", "Category", ["category", "mastercategory"]],
  ["articleType", "Article Type", ["articletype"]],
  ["vendor", "Vendor", ["vendor", "vendorname", "supplier", "suppliername"]],
  ["supplierEmail", "Supplier Email", ["supplieremail", "contactemail", "email"]],
  ["supplierSku", "Supplier SKU", ["suppliersku", "vendorsku"]],
  ["nlc", "NLC INR", ["nlc", "nlcinr", "unitprice", "unitpriceinr", "unitcost"]],
  ["hsnCode", "HSN Code", ["hsn", "hsncode", "hsnsac", "hsnsaccode"]],
  ["gstRate", "GST Rate", ["gstrate", "gstratepct", "gstpct", "gstpercent"]],
  ["supplierGstin", "Supplier GSTIN", ["suppliergstin", "vendorgstin", "gstin"]],
  ["supplierState", "Supplier State", ["supplierstate", "vendorstate", "state"]],
  ["leadTimeDays", "Lead Time Days", ["leadtimedays", "supplierleadtimedays", "leadtime"]],
  ["paymentTerms", "Payment Terms", ["paymentterms", "creditterms"]],
  ["incoterms", "Incoterms", ["incoterms", "incoterm", "incotermscode"]],
  ["moq", "MOQ", ["moq", "minimumorderquantity", "minimumorderqty"]],
  ["packSize", "Pack Size", ["packsize", "casepack", "ordermultiple", "packqty"]],
] as const;

type CanonicalField = typeof COLUMNS[number][0];
type ImportReport = {
  importVersion: typeof VENDOR_MAPPING_IMPORT_VERSION;
  fileName: string;
  sheetName: string | null;
  inputRows: number;
  acceptedRows: number;
  duplicateRowsCollapsed: number;
};

export class VendorMappingFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VendorMappingFileError";
  }
}

const normalizeHeader = (value: unknown) => String(value ?? "").trim().toLocaleLowerCase("en-IN").replace(/[\s_\-./()%]+/g, "");

function unwrappedCell(value: unknown): unknown {
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  if ("result" in value) return unwrappedCell((value as { result?: unknown }).result);
  if ("richText" in value) return (value as { richText: { text?: string }[] }).richText.map(part => part.text ?? "").join("");
  if ("text" in value) return String((value as { text?: unknown }).text ?? "");
  return value;
}

function matrixHeader(matrix: unknown[][]) {
  for (let rowIndex = 0; rowIndex < Math.min(matrix.length, 10); rowIndex++) {
    const positions = new Map<string, number[]>();
    matrix[rowIndex].forEach((value, index) => {
      const key = normalizeHeader(unwrappedCell(value));
      if (key) positions.set(key, [...(positions.get(key) ?? []), index]);
    });
    const indexes: Partial<Record<CanonicalField, number>> = {};
    const duplicateFields: string[] = [];
    for (const [field, label, aliases] of COLUMNS) {
      for (const alias of aliases) {
        const matches = positions.get(alias) ?? [];
        if (!matches.length) continue;
        indexes[field] = matches[0];
        if (matches.length > 1) duplicateFields.push(label);
        break;
      }
    }
    if (indexes.styleId !== undefined) {
      if (duplicateFields.length) throw new VendorMappingFileError(`The header contains duplicate mapping columns: ${duplicateFields.join(", ")}.`);
      return { rowIndex, indexes };
    }
  }
  throw new VendorMappingFileError("The file needs a Style ID column. Download the mapping template and keep its header names.");
}

function parseMatrix(matrix: unknown[][], fileName: string, sheetName: string | null) {
  const { rowIndex: headerIndex, indexes } = matrixHeader(matrix);
  const dataRows = matrix.slice(headerIndex + 1).filter(row => row.some(value => String(unwrappedCell(value) ?? "").trim()));
  if (!dataRows.length) throw new VendorMappingFileError("The mapping file has a header but no data rows.");
  if (dataRows.length > VENDOR_MAPPING_IMPORT_LIMIT) throw new VendorMappingFileError(`The mapping file exceeds the ${VENDOR_MAPPING_IMPORT_LIMIT.toLocaleString("en-IN")}-row limit.`);
  const unique = new Map<string, { mapping: VendorMappingInput; serialized: string; rowNumber: number }>();
  let duplicateRowsCollapsed = 0;
  for (const [offset, row] of dataRows.entries()) {
    const rowNumber = headerIndex + offset + 2;
    const raw: Record<string, unknown> = {};
    for (const [field] of COLUMNS) {
      const column = indexes[field];
      if (column !== undefined) raw[field] = unwrappedCell(row[column]);
    }
    let mapping: VendorMappingInput;
    try {
      mapping = normalizeVendorMappingInput(raw);
    } catch (error) {
      throw new VendorMappingFileError(`Row ${rowNumber}: ${error instanceof Error ? error.message : "The mapping is invalid."}`);
    }
    const key = vendorMappingKey(mapping.styleId, mapping.vendor);
    const serialized = JSON.stringify(mapping);
    const earlier = unique.get(key);
    if (earlier) {
      if (earlier.serialized !== serialized) {
        throw new VendorMappingFileError(`Rows ${earlier.rowNumber} and ${rowNumber} conflict for style ${mapping.styleId}${mapping.vendor ? ` and supplier ${mapping.vendor}` : ""}. Keep one authoritative row.`);
      }
      duplicateRowsCollapsed += 1;
      continue;
    }
    unique.set(key, { mapping, serialized, rowNumber });
  }
  const rows = [...unique.values()].map(entry => entry.mapping);
  return {
    rows,
    report: {
      importVersion: VENDOR_MAPPING_IMPORT_VERSION,
      fileName,
      sheetName,
      inputRows: dataRows.length,
      acceptedRows: rows.length,
      duplicateRowsCollapsed,
    } satisfies ImportReport,
  };
}

export async function parseVendorMappingFile(data: ArrayBuffer | Uint8Array, fileName: string) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (!bytes.byteLength) throw new VendorMappingFileError("Choose a non-empty CSV or XLSX mapping file.");
  if (bytes.byteLength > VENDOR_MAPPING_FILE_LIMIT_BYTES) throw new VendorMappingFileError("The mapping file exceeds the 15 MB limit.");
  const extension = fileName.toLocaleLowerCase("en-IN").match(/\.([^.]+)$/)?.[1];
  if (extension === "csv") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    } catch {
      throw new VendorMappingFileError("The CSV must use UTF-8 encoding.");
    }
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
    if (parsed.errors.length) throw new VendorMappingFileError(`CSV parse error at row ${(parsed.errors[0].row ?? 0) + 1}: ${parsed.errors[0].message}`);
    return parseMatrix(parsed.data, fileName, null);
  }
  if (extension === "xlsx" || extension === "xlsm") {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
    } catch {
      throw new VendorMappingFileError("The XLSX workbook could not be read.");
    }
    let lastError: Error | null = null;
    for (const worksheet of workbook.worksheets) {
      const matrix: unknown[][] = [];
      worksheet.eachRow({ includeEmpty: false }, row => {
        matrix.push(Array.isArray(row.values) ? row.values.slice(1) : []);
      });
      try {
        return parseMatrix(matrix, fileName, worksheet.name);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("Unsupported worksheet.");
        if (!/needs a Style ID column/.test(lastError.message)) throw lastError;
      }
    }
    throw new VendorMappingFileError(lastError?.message ?? "The workbook has no readable worksheets.");
  }
  throw new VendorMappingFileError("Supplier mappings must be uploaded as CSV or XLSX.");
}

const HEADERS = COLUMNS.map(([, label]) => label);

function exportValues(mapping: ReturnType<typeof publicVendorMapping>) {
  return [
    mapping.styleId, mapping.productName, mapping.brand, mapping.category, mapping.articleType,
    mapping.vendor, mapping.supplierEmail, mapping.supplierSku, mapping.nlc, mapping.hsnCode,
    mapping.gstRate, mapping.supplierGstin, mapping.supplierState, mapping.leadTimeDays,
    mapping.paymentTerms, mapping.incoterms, mapping.moq, mapping.packSize,
  ];
}

function csvCell(value: unknown) {
  const text = safeSpreadsheetText(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildVendorMappingCsv(rows: VendorMappingRecord[]) {
  return [HEADERS.map(csvCell).join(","), ...rows.map(row => exportValues(publicVendorMapping(row)).map(csvCell).join(","))].join("\r\n");
}

export async function buildVendorMappingWorkbook(rows: VendorMappingRecord[]) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "StyleFlow";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("Supplier mappings", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.addRow(HEADERS);
  for (const mapping of rows) sheet.addRow(exportValues(publicVendorMapping(mapping)).map(value => typeof value === "string" ? safeSpreadsheetText(value) : value));
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2B2730" } };
  sheet.autoFilter = { from: "A1", to: "R1" };
  sheet.columns.forEach((column, index) => { column.width = index === 1 ? 34 : Math.min(28, Math.max(12, HEADERS[index]?.length + 2 || 12)); });
  return workbook.xlsx.writeBuffer();
}
