import ExcelJS from "exceljs";
import Papa from "papaparse";
import {
  sameNewPoStyleDetail,
  type NewPoCalculationInput,
  type NewPoInventoryRow,
  type NewPoOpenPoRow,
  type NewPoSalesRow,
  type NewPoStyleDetailRow,
} from "./new-po-methodology";

export const NEW_PO_IMPORT_VERSION = "new-po-import/2026-08-02-v4" as const;
export const NEW_PO_MAX_UPLOAD_BYTES = 15_000_000;
export const NEW_PO_MAX_ROWS = 100_000;

export type NewPoSourceType = "sales" | "inventory" | "openPos" | "styleDetails";

type CanonicalField =
  | "salesDate" | "styleId" | "quantity"
  | "brand" | "businessUnit" | "articleType" | "masterCategory" | "poType"
  | "inventoryUnits" | "itemStatus" | "styleStatus" | "warehouseId" | "warehouseName"
  | "inventoryAgeBucket" | "inventoryValueInr"
  | "pendingQuantity" | "month" | "estimatedShipmentDate" | "vendorName" | "poStatus" | "pendingValueInr"
  | "model" | "mrpInr" | "nlcInr" | "bauInr" | "contactEmail" | "supplierSku"
  | "hsnCode" | "gstRate" | "supplierGstin" | "supplierState" | "leadTimeDays"
  | "paymentTerms" | "incoterms" | "moq" | "packSize";

interface SourceDefinition {
  label: string;
  sheetAliases: string[];
  required: CanonicalField[];
  columns: Partial<Record<CanonicalField, string[]>>;
}

/**
 * Explicit header dictionary used for both bulk sheets and separate CSV/XLSX
 * sources. Tokens are compared case-insensitively with spaces, `_`, and `-`
 * removed, so `Style Id`, `style_id`, and `STYLE-ID` are equivalent.
 */
export const NEW_PO_SOURCE_DEFINITIONS: Record<NewPoSourceType, SourceDefinition> = {
  sales: {
    label: "sell-out",
    sheetAliases: ["NOISE headphones Sell out", "Sell out", "Sell-out", "Historical sales", "Sales"],
    required: ["salesDate", "styleId", "quantity"],
    columns: {
      salesDate: ["order_Month", "order date", "sales_date", "date"],
      styleId: ["style_id", "Style Id", "style code", "style_code", "SKU"],
      quantity: ["qty", "quantity", "units_sold", "sales_qty", "sell_out_qty"],
      brand: ["brand"], businessUnit: ["business_unit"], articleType: ["article_type"],
      masterCategory: ["master_category", "category"], poType: ["po_type"],
    },
  },
  inventory: {
    label: "current inventory",
    sheetAliases: ["Current Inventory", "Inventory", "Stock on hand"],
    required: ["styleId", "inventoryUnits"],
    columns: {
      styleId: ["style_id", "Style Id", "style code", "style_code", "SKU"],
      inventoryUnits: ["inv_units_q1", "current_inventory", "inventory_units", "on_hand_qty", "stock_on_hand"],
      brand: ["brand"], businessUnit: ["business_unit"], articleType: ["article_type"],
      itemStatus: ["item_status"], styleStatus: ["style_status"], warehouseId: ["warehouse_id"],
      warehouseName: ["warehouse_name", "warehouse"], inventoryAgeBucket: ["Inv_age_bucket", "inventory_age_bucket"],
      inventoryValueInr: ["inv_value_q1", "inventory_value_inr", "inventory_value"],
    },
  },
  openPos: {
    label: "open PO",
    sheetAliases: ["Open PO", "Open POs", "Open purchase orders", "Purchase orders"],
    required: ["styleId", "pendingQuantity"],
    columns: {
      styleId: ["style_id", "Style Id", "style code", "style_code", "SKU"],
      pendingQuantity: ["pending_qty", "open_po_qty", "pending_quantity", "open_qty"],
      month: ["month", "po_month"], estimatedShipmentDate: ["estimated_shipment_date", "expected_date", "eta"],
      vendorName: ["vendor_name", "vendor", "supplier"], poStatus: ["po_status", "status"],
      brand: ["brand"], businessUnit: ["business_unit"], articleType: ["article_type"],
      masterCategory: ["master_category", "category"], warehouseId: ["warehouse_id"],
      pendingValueInr: ["pending_value", "pending_value_inr", "open_po_value_inr"],
    },
  },
  styleDetails: {
    label: "style details",
    sheetAliases: ["Style ID details", "Style details", "Style master", "Product master"],
    required: ["styleId", "model", "mrpInr", "nlcInr"],
    columns: {
      styleId: ["Style Id", "style_id", "style code", "style_code", "SKU"],
      model: ["Model", "product_name", "style_name"],
      mrpInr: ["MRP", "mrp_inr"], nlcInr: ["NLC", "nlc_inr", "unit_cost", "unit_price_inr", "unit_price"],
      bauInr: ["BAU", "bau_inr"],
      vendorName: ["vendor_name", "vendor", "supplier"],
      contactEmail: ["contact_email", "supplier_email", "email"],
      supplierSku: ["supplier_sku", "vendor_sku"],
      hsnCode: ["hsn_code", "HSN", "hsn_sac", "HSN/SAC Code"],
      gstRate: ["gst_rate", "gst_rate_pct", "gst_pct", "gst_percent", "GST %", "GST Rate (%)"],
      supplierGstin: ["supplier_gstin", "vendor_gstin", "GSTIN"],
      supplierState: ["supplier_state", "vendor_state", "state"],
      leadTimeDays: ["lead_time_days", "supplier_lead_time_days", "vendor_lead_time_days", "lead_time", "Lead Time (Days)"],
      paymentTerms: ["payment_terms", "payment_term", "credit_terms"],
      incoterms: ["incoterms", "incoterm", "inco_terms", "inco_term"],
      moq: ["MOQ", "minimum_order_quantity", "minimum_order_qty"],
      packSize: ["pack_size", "case_pack", "order_multiple", "pack_qty"],
    },
  },
};

export type NewPoImportIssueCode =
  | "FILE_TOO_LARGE" | "TOO_MANY_ROWS" | "UNSUPPORTED_FILE" | "INVALID_WORKBOOK" | "CSV_PARSE_ERROR"
  | "UNKNOWN_SOURCE" | "AMBIGUOUS_SOURCE" | "MISSING_SOURCE" | "DUPLICATE_SOURCE"
  | "MISSING_COLUMN" | "DUPLICATE_COLUMN" | "EMPTY_SOURCE" | "REQUIRED_VALUE"
  | "INVALID_NUMBER" | "INVALID_INTEGER" | "INVALID_DATE" | "INVALID_MONTH"
  | "INVALID_EMAIL" | "INVALID_HSN" | "INVALID_GSTIN" | "CONFLICTING_STYLE_MASTER";

export interface NewPoImportIssue {
  code: NewPoImportIssueCode;
  message: string;
  fileName?: string;
  sheetName?: string;
  rowNumber?: number;
  columnName?: string;
}

export class NewPoImportError extends Error {
  readonly issues: NewPoImportIssue[];

  constructor(issues: NewPoImportIssue | NewPoImportIssue[]) {
    const list = Array.isArray(issues) ? issues : [issues];
    super(list.map(issue => issue.message).join(" "));
    this.name = "NewPoImportError";
    this.issues = list;
  }
}

export interface NewPoImportReport {
  importVersion: typeof NEW_PO_IMPORT_VERSION;
  sourceFormat: "methodology" | "myntra_operational_csv";
  fileNames: string[];
  sourceTypes: NewPoSourceType[];
  rowCounts: Partial<Record<NewPoSourceType, number>>;
  sheetNames: Partial<Record<NewPoSourceType, string>>;
  ignoredSheetNames: string[];
  totalRows: number;
}

export interface NewPoImportBundle {
  data: Partial<NewPoCalculationInput>;
  report: NewPoImportReport;
}

export interface NewPoSourceFile {
  fileName: string;
  data: string | ArrayBuffer | Uint8Array;
  sourceType?: NewPoSourceType;
}

const SOURCE_TYPES: NewPoSourceType[] = ["sales", "inventory", "openPos", "styleDetails"];
const normalizeToken = (value: unknown) => String(value ?? "").trim().toLowerCase().replace(/[\s_\-./]+/g, "");
const normalizedSheetAliases = Object.fromEntries(SOURCE_TYPES.map(type => [
  type,
  new Set(NEW_PO_SOURCE_DEFINITIONS[type].sheetAliases.map(normalizeToken)),
])) as Record<NewPoSourceType, Set<string>>;

function issue(code: NewPoImportIssueCode, message: string, context: Partial<NewPoImportIssue> = {}): NewPoImportError {
  return new NewPoImportError({ code, message, ...context });
}

function byteLength(data: string | ArrayBuffer | Uint8Array) {
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
  return data instanceof ArrayBuffer ? data.byteLength : data.byteLength;
}

function guardFileSize(data: string | ArrayBuffer | Uint8Array, fileName: string) {
  if (byteLength(data) > NEW_PO_MAX_UPLOAD_BYTES) {
    throw issue("FILE_TOO_LARGE", `${fileName} exceeds the 15 MB upload limit.`, { fileName });
  }
}

function bytesOf(data: string | ArrayBuffer | Uint8Array) {
  if (typeof data === "string") return new TextEncoder().encode(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

function textOf(data: string | ArrayBuffer | Uint8Array) {
  return typeof data === "string" ? data : new TextDecoder("utf-8", { fatal: true }).decode(bytesOf(data));
}

function isExcelError(value: unknown): value is { error: string } {
  return Boolean(value && typeof value === "object" && "error" in value);
}

function unwrapCellValue(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value;
  if (typeof value !== "object") return value;
  if (isExcelError(value)) return value;
  if ("result" in value) return unwrapCellValue((value as { result?: unknown }).result);
  if ("richText" in value) {
    return (value as { richText: Array<{ text?: string }> }).richText.map(part => part.text ?? "").join("");
  }
  if ("text" in value) return String((value as { text?: unknown }).text ?? "");
  return value;
}

function displayValue(value: unknown) {
  const unwrapped = unwrapCellValue(value);
  if (isExcelError(unwrapped)) return unwrapped.error;
  if (unwrapped instanceof Date) return unwrapped.toISOString();
  return String(unwrapped ?? "");
}

function optionalText(value: unknown) {
  const unwrapped = unwrapCellValue(value);
  if (unwrapped === undefined || unwrapped === null || isExcelError(unwrapped)) return undefined;
  const text = String(unwrapped).trim();
  return text || undefined;
}

function isBlankValue(value: unknown) {
  const unwrapped = unwrapCellValue(value);
  return unwrapped === undefined || unwrapped === null
    || (!isExcelError(unwrapped) && typeof unwrapped === "string" && unwrapped.trim() === "");
}

function requiredText(value: unknown, field: string, context: Partial<NewPoImportIssue>) {
  const unwrapped = unwrapCellValue(value);
  if (isExcelError(unwrapped)) {
    throw issue("REQUIRED_VALUE", `${field} contains Excel error ${unwrapped.error}.`, { ...context, columnName: field });
  }
  const text = optionalText(unwrapped);
  if (!text) throw issue("REQUIRED_VALUE", `${field} is required.`, { ...context, columnName: field });
  return text;
}

function normalizeStyleId(value: unknown, context: Partial<NewPoImportIssue>) {
  const unwrapped = unwrapCellValue(value);
  if (isExcelError(unwrapped)) {
    throw issue("REQUIRED_VALUE", `Style ID contains Excel error ${unwrapped.error}.`, { ...context, columnName: "style_id" });
  }
  if (typeof unwrapped === "number") {
    if (!Number.isSafeInteger(unwrapped)) {
      throw issue("INVALID_INTEGER", "Style ID must be a safe whole number or text identifier.", { ...context, columnName: "style_id" });
    }
    return String(unwrapped);
  }
  const text = requiredText(unwrapped, "Style ID", context);
  return /^\d+\.0+$/.test(text) ? text.slice(0, text.indexOf(".")) : text;
}

function numericValue(value: unknown, field: string, context: Partial<NewPoImportIssue>, optional = false) {
  const unwrapped = unwrapCellValue(value);
  if ((unwrapped === undefined || unwrapped === null || String(unwrapped).trim() === "") && optional) return undefined;
  if (isExcelError(unwrapped)) {
    throw issue("INVALID_NUMBER", `${field} contains Excel error ${unwrapped.error}.`, { ...context, columnName: field });
  }
  let parsed: number;
  if (typeof unwrapped === "number") parsed = unwrapped;
  else {
    const clean = requiredText(unwrapped, field, context).replace(/^inr\s*/i, "").replace(/₹/g, "").replace(/,/g, "");
    if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(clean)) {
      throw issue("INVALID_NUMBER", `${field} must be numeric; received “${displayValue(unwrapped)}”.`, { ...context, columnName: field });
    }
    parsed = Number(clean);
  }
  if (!Number.isFinite(parsed)) {
    throw issue("INVALID_NUMBER", `${field} must be a finite number.`, { ...context, columnName: field });
  }
  return parsed;
}

function integerValue(value: unknown, field: string, context: Partial<NewPoImportIssue>) {
  const parsed = numericValue(value, field, context)!;
  if (!Number.isSafeInteger(parsed)) {
    throw issue("INVALID_INTEGER", `${field} must be a safe whole number.`, { ...context, columnName: field });
  }
  return parsed;
}

function validIsoDate(year: number, month: number, day: number) {
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Normalizes workbook YYYYMMDD numbers/strings (and real Excel dates) to ISO. */
export function normalizeYyyyMmDd(value: unknown, field: string, context: Partial<NewPoImportIssue> = {}) {
  const unwrapped = unwrapCellValue(value);
  if (unwrapped instanceof Date) return unwrapped.toISOString().slice(0, 10);
  if (isExcelError(unwrapped)) {
    throw issue("INVALID_DATE", `${field} contains Excel error ${unwrapped.error}.`, { ...context, columnName: field });
  }
  const raw = typeof unwrapped === "number" && Number.isSafeInteger(unwrapped)
    ? String(unwrapped)
    : requiredText(unwrapped, field, context);
  const digits = raw.match(/^([0-9]{4})-?([0-9]{2})-?([0-9]{2})$/);
  if (!digits) {
    throw issue("INVALID_DATE", `${field} must be a valid YYYYMMDD or YYYY-MM-DD date.`, { ...context, columnName: field });
  }
  const year = Number(digits[1]); const month = Number(digits[2]); const day = Number(digits[3]);
  if (!validIsoDate(year, month, day)) {
    throw issue("INVALID_DATE", `${field} is not a valid calendar date.`, { ...context, columnName: field });
  }
  return `${digits[1]}-${digits[2]}-${digits[3]}`;
}

function normalizeYyyyMm(value: unknown, field: string, context: Partial<NewPoImportIssue>) {
  const raw = requiredText(value, field, context);
  const digits = raw.match(/^([0-9]{4})-?([0-9]{2})$/);
  if (!digits || Number(digits[2]) < 1 || Number(digits[2]) > 12) {
    throw issue("INVALID_MONTH", `${field} must be a valid YYYYMM or YYYY-MM month.`, { ...context, columnName: field });
  }
  return `${digits[1]}-${digits[2]}`;
}

interface MatrixSource {
  fileName: string;
  sheetName?: string;
  rowCount: number;
  columnCount: number;
  valueAt: (row: number, column: number) => unknown;
}

interface HeaderMatch {
  sourceType: NewPoSourceType;
  headerRow: number;
  columns: Partial<Record<CanonicalField, number>>;
  missing: CanonicalField[];
  duplicates: CanonicalField[];
}

function matchHeader(source: MatrixSource, sourceType: NewPoSourceType, headerRow: number): HeaderMatch {
  const definition = NEW_PO_SOURCE_DEFINITIONS[sourceType];
  const headerPositions = new Map<string, number[]>();
  for (let column = 1; column <= source.columnCount; column++) {
    const token = normalizeToken(unwrapCellValue(source.valueAt(headerRow, column)));
    if (token) headerPositions.set(token, [...(headerPositions.get(token) ?? []), column]);
  }
  const columns: Partial<Record<CanonicalField, number>> = {};
  const duplicates: CanonicalField[] = [];
  // Alias order is precedence order. A canonical export may include both
  // Style_ID and SKU: Style_ID is the documented planning grain, while SKU is
  // only a backwards-compatible fallback and must not create an ambiguity.
  for (const [field, aliases] of Object.entries(definition.columns) as Array<[CanonicalField, string[]]>) {
    for (const alias of aliases) {
      const indexes = headerPositions.get(normalizeToken(alias)) ?? [];
      if (!indexes.length) continue;
      columns[field] = indexes[0];
      if (indexes.length > 1) duplicates.push(field);
      break;
    }
  }
  const missing = definition.required.filter(field => columns[field] === undefined);
  return { sourceType, headerRow, columns, missing, duplicates };
}

function bestHeaderMatch(source: MatrixSource, sourceType: NewPoSourceType) {
  const scanRows = Math.min(source.rowCount, 20);
  let best = matchHeader(source, sourceType, 1);
  for (let row = 2; row <= scanRows; row++) {
    const candidate = matchHeader(source, sourceType, row);
    if (candidate.missing.length < best.missing.length) best = candidate;
  }
  return best;
}

function inferSource(source: MatrixSource, expected?: NewPoSourceType): HeaderMatch {
  if (expected) return bestHeaderMatch(source, expected);
  const sheetToken = normalizeToken(source.sheetName);
  const namedMatches = SOURCE_TYPES.filter(type => normalizedSheetAliases[type].has(sheetToken));
  if (namedMatches.length === 1) return bestHeaderMatch(source, namedMatches[0]);
  const matches = SOURCE_TYPES.map(type => bestHeaderMatch(source, type)).filter(match => match.missing.length === 0);
  if (matches.length === 1) return matches[0];
  const context = { fileName: source.fileName, sheetName: source.sheetName };
  if (matches.length > 1) {
    throw issue("AMBIGUOUS_SOURCE", `${source.sheetName ?? source.fileName} matches more than one source type.`, context);
  }
  throw issue("UNKNOWN_SOURCE", `${source.sheetName ?? source.fileName} does not match a supported New PO source.`, context);
}

function validateHeader(source: MatrixSource, match: HeaderMatch) {
  const context = { fileName: source.fileName, sheetName: source.sheetName, rowNumber: match.headerRow };
  const issues: NewPoImportIssue[] = [];
  for (const field of match.missing) issues.push({
    code: "MISSING_COLUMN",
    message: `${NEW_PO_SOURCE_DEFINITIONS[match.sourceType].label} is missing required column ${field}.`,
    columnName: field,
    ...context,
  });
  for (const field of match.duplicates) issues.push({
    code: "DUPLICATE_COLUMN",
    message: `${NEW_PO_SOURCE_DEFINITIONS[match.sourceType].label} has more than one column matching ${field}.`,
    columnName: field,
    ...context,
  });
  if (issues.length) throw new NewPoImportError(issues);
}

function isBlankRow(source: MatrixSource, row: number) {
  for (let column = 1; column <= source.columnCount; column++) {
    if (optionalText(source.valueAt(row, column)) !== undefined || isExcelError(unwrapCellValue(source.valueAt(row, column)))) return false;
  }
  return true;
}

function optionalNumber(source: MatrixSource, row: number, match: HeaderMatch, field: CanonicalField, context: Partial<NewPoImportIssue>) {
  const column = match.columns[field];
  return column === undefined ? undefined : numericValue(source.valueAt(row, column), field, context, true);
}

function optionalNonNegativeNumber(source: MatrixSource, row: number, match: HeaderMatch, field: CanonicalField, label: string, context: Partial<NewPoImportIssue>) {
  const value = optionalNumber(source, row, match, field, context);
  if (value !== undefined && value < 0) {
    throw issue("INVALID_NUMBER", `${label} must be zero or greater.`, { ...context, columnName: field });
  }
  return value;
}

function requiredPositiveNumber(source: MatrixSource, row: number, match: HeaderMatch, field: CanonicalField, label: string, context: Partial<NewPoImportIssue>) {
  const value = numericValue(requiredCell(source, row, match, field), label, context)!;
  if (value <= 0) {
    throw issue("INVALID_NUMBER", `${label} must be greater than zero.`, { ...context, columnName: field });
  }
  return value;
}

function optionalNonNegativeInteger(
  source: MatrixSource,
  row: number,
  match: HeaderMatch,
  field: CanonicalField,
  label: string,
  context: Partial<NewPoImportIssue>,
) {
  const column = match.columns[field];
  if (column === undefined || isBlankValue(source.valueAt(row, column))) return undefined;
  const value = integerValue(source.valueAt(row, column), label, context);
  if (value < 0) {
    throw issue("INVALID_NUMBER", `${label} must be zero or greater.`, { ...context, columnName: field });
  }
  return value;
}

function optionalGstRate(source: MatrixSource, row: number, match: HeaderMatch, context: Partial<NewPoImportIssue>) {
  const value = optionalNumber(source, row, match, "gstRate", context);
  if (value !== undefined && (value < 0 || value > 100)) {
    throw issue("INVALID_NUMBER", "GST rate must be between 0 and 100 percent.", { ...context, columnName: "gstRate" });
  }
  return value;
}

function optionalPositiveInteger(
  source: MatrixSource,
  row: number,
  match: HeaderMatch,
  field: CanonicalField,
  label: string,
  context: Partial<NewPoImportIssue>,
) {
  const value = optionalNonNegativeInteger(source, row, match, field, label, context);
  if (value === 0) {
    throw issue("INVALID_NUMBER", `${label} must be greater than zero when supplied.`, { ...context, columnName: field });
  }
  return value;
}

function optionalEmail(source: MatrixSource, row: number, match: HeaderMatch, context: Partial<NewPoImportIssue>) {
  const value = optionalField(source, row, match, "contactEmail")?.toLowerCase();
  if (value && (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) {
    throw issue("INVALID_EMAIL", "Supplier email must be a valid work email address.", { ...context, columnName: "contactEmail" });
  }
  return value;
}

function optionalHsn(source: MatrixSource, row: number, match: HeaderMatch, context: Partial<NewPoImportIssue>) {
  const value = optionalField(source, row, match, "hsnCode");
  if (value && !/^\d{4,8}$/.test(value)) {
    throw issue("INVALID_HSN", "HSN code must contain 4–8 digits.", { ...context, columnName: "hsnCode" });
  }
  return value;
}

function optionalGstin(source: MatrixSource, row: number, match: HeaderMatch, context: Partial<NewPoImportIssue>) {
  const value = optionalField(source, row, match, "supplierGstin")?.toUpperCase();
  if (value && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(value)) {
    throw issue("INVALID_GSTIN", "Supplier GSTIN must use the valid 15-character Indian format.", { ...context, columnName: "supplierGstin" });
  }
  return value;
}

function optionalField(source: MatrixSource, row: number, match: HeaderMatch, field: CanonicalField) {
  const column = match.columns[field];
  return column === undefined ? undefined : optionalText(source.valueAt(row, column));
}

function requiredCell(source: MatrixSource, row: number, match: HeaderMatch, field: CanonicalField) {
  return source.valueAt(row, match.columns[field]!);
}

function parseMatrix(source: MatrixSource, expected?: NewPoSourceType) {
  const match = inferSource(source, expected);
  validateHeader(source, match);
  const dataRows = source.rowCount - match.headerRow;
  if (dataRows > NEW_PO_MAX_ROWS) {
    throw issue("TOO_MANY_ROWS", `${source.sheetName ?? source.fileName} exceeds the 100,000-row limit.`, {
      fileName: source.fileName, sheetName: source.sheetName,
    });
  }
  const parsed: Array<NewPoSalesRow | NewPoInventoryRow | NewPoOpenPoRow | NewPoStyleDetailRow> = [];
  for (let row = match.headerRow + 1; row <= source.rowCount; row++) {
    if (isBlankRow(source, row)) continue;
    const context = { fileName: source.fileName, sheetName: source.sheetName, rowNumber: row };
    const styleId = normalizeStyleId(requiredCell(source, row, match, "styleId"), context);
    if (match.sourceType === "sales") {
      parsed.push({
        fileName: source.fileName, sheetName: source.sheetName, rowNumber: row, styleId,
        salesDate: normalizeYyyyMmDd(requiredCell(source, row, match, "salesDate"), "order_Month", context),
        quantity: integerValue(requiredCell(source, row, match, "quantity"), "qty", context),
        brand: optionalField(source, row, match, "brand"), businessUnit: optionalField(source, row, match, "businessUnit"),
        articleType: optionalField(source, row, match, "articleType"), masterCategory: optionalField(source, row, match, "masterCategory"),
        poType: optionalField(source, row, match, "poType"),
      });
    } else if (match.sourceType === "inventory") {
      parsed.push({
        fileName: source.fileName, sheetName: source.sheetName, rowNumber: row, styleId,
        inventoryUnits: integerValue(requiredCell(source, row, match, "inventoryUnits"), "inv_units_q1", context),
        brand: optionalField(source, row, match, "brand"), businessUnit: optionalField(source, row, match, "businessUnit"),
        articleType: optionalField(source, row, match, "articleType"), itemStatus: optionalField(source, row, match, "itemStatus"),
        styleStatus: optionalField(source, row, match, "styleStatus"), warehouseId: optionalField(source, row, match, "warehouseId"),
        warehouseName: optionalField(source, row, match, "warehouseName"),
        inventoryAgeBucket: optionalField(source, row, match, "inventoryAgeBucket"),
        inventoryValueInr: optionalNonNegativeNumber(source, row, match, "inventoryValueInr", "Inventory value", context),
      });
    } else if (match.sourceType === "openPos") {
      const monthColumn = match.columns.month;
      const shipmentColumn = match.columns.estimatedShipmentDate;
      parsed.push({
        fileName: source.fileName, sheetName: source.sheetName, rowNumber: row, styleId,
        pendingQuantity: integerValue(requiredCell(source, row, match, "pendingQuantity"), "pending_qty", context),
        month: monthColumn === undefined || isBlankValue(source.valueAt(row, monthColumn))
          ? undefined : normalizeYyyyMm(source.valueAt(row, monthColumn), "month", context),
        estimatedShipmentDate: shipmentColumn === undefined || isBlankValue(source.valueAt(row, shipmentColumn))
          ? undefined : normalizeYyyyMmDd(source.valueAt(row, shipmentColumn), "estimated_shipment_date", context),
        vendorName: optionalField(source, row, match, "vendorName"), poStatus: optionalField(source, row, match, "poStatus"),
        brand: optionalField(source, row, match, "brand"), businessUnit: optionalField(source, row, match, "businessUnit"),
        articleType: optionalField(source, row, match, "articleType"), masterCategory: optionalField(source, row, match, "masterCategory"),
        warehouseId: optionalField(source, row, match, "warehouseId"),
        pendingValueInr: optionalNonNegativeNumber(source, row, match, "pendingValueInr", "Pending PO value", context),
      });
    } else {
      parsed.push({
        fileName: source.fileName, sheetName: source.sheetName, rowNumber: row, styleId,
        model: requiredText(requiredCell(source, row, match, "model"), "Model", context),
        mrpInr: requiredPositiveNumber(source, row, match, "mrpInr", "MRP", context),
        nlcInr: requiredPositiveNumber(source, row, match, "nlcInr", "NLC", context),
        bauInr: optionalNonNegativeNumber(source, row, match, "bauInr", "BAU", context),
        vendorName: optionalField(source, row, match, "vendorName"),
        contactEmail: optionalEmail(source, row, match, context),
        supplierSku: optionalField(source, row, match, "supplierSku"),
        hsnCode: optionalHsn(source, row, match, context),
        gstRate: optionalGstRate(source, row, match, context),
        supplierGstin: optionalGstin(source, row, match, context),
        supplierState: optionalField(source, row, match, "supplierState"),
        leadTimeDays: optionalNonNegativeInteger(source, row, match, "leadTimeDays", "Lead time days", context),
        paymentTerms: optionalField(source, row, match, "paymentTerms"),
        incoterms: optionalField(source, row, match, "incoterms"),
        moq: optionalPositiveInteger(source, row, match, "moq", "MOQ", context),
        packSize: optionalPositiveInteger(source, row, match, "packSize", "Pack size", context),
      });
    }
  }
  // A valid Open PO source may contain only a header when nothing is pending.
  if (!parsed.length && match.sourceType !== "openPos") {
    throw issue("EMPTY_SOURCE", `${NEW_PO_SOURCE_DEFINITIONS[match.sourceType].label} is empty.`, {
      fileName: source.fileName, sheetName: source.sheetName,
    });
  }
  return { sourceType: match.sourceType, rows: parsed };
}

function validateStyleMaster(rows: NewPoStyleDetailRow[], fileName?: string) {
  const seen = new Map<string, NewPoStyleDetailRow>();
  for (const row of rows) {
    const previous = seen.get(row.styleId);
    const equal = previous && sameNewPoStyleDetail(previous, row);
    if (previous && !equal) {
      throw issue("CONFLICTING_STYLE_MASTER", `Style master contains conflicting records for style ${row.styleId}.`, {
        fileName: row.fileName ?? fileName, sheetName: row.sheetName, rowNumber: row.rowNumber,
      });
    }
    if (!previous) seen.set(row.styleId, row);
  }
}

function makeBundle(
  fileName: string,
  parsed: Array<{ sourceType: NewPoSourceType; rows: Array<NewPoSalesRow | NewPoInventoryRow | NewPoOpenPoRow | NewPoStyleDetailRow> }>,
  sheetNames: Partial<Record<NewPoSourceType, string>> = {},
  ignoredSheetNames: string[] = [],
): NewPoImportBundle {
  const data: Partial<NewPoCalculationInput> = {};
  const rowCounts: Partial<Record<NewPoSourceType, number>> = {};
  for (const source of parsed) {
    if (data[source.sourceType] !== undefined) {
      throw issue("DUPLICATE_SOURCE", `${fileName} contains more than one ${NEW_PO_SOURCE_DEFINITIONS[source.sourceType].label} source.`, { fileName });
    }
    if (source.sourceType === "sales") data.sales = source.rows as NewPoSalesRow[];
    if (source.sourceType === "inventory") data.inventory = source.rows as NewPoInventoryRow[];
    if (source.sourceType === "openPos") data.openPos = source.rows as NewPoOpenPoRow[];
    if (source.sourceType === "styleDetails") {
      data.styleDetails = source.rows as NewPoStyleDetailRow[];
      validateStyleMaster(data.styleDetails, fileName);
    }
    rowCounts[source.sourceType] = source.rows.length;
  }
  const sourceTypes = parsed.map(source => source.sourceType);
  return {
    data,
    report: {
      importVersion: NEW_PO_IMPORT_VERSION,
      sourceFormat: "methodology",
      fileNames: [fileName], sourceTypes, rowCounts, sheetNames, ignoredSheetNames,
      totalRows: Object.values(rowCounts).reduce((sum, rows) => sum + (rows ?? 0), 0),
    },
  };
}

async function workbookSources(data: string | ArrayBuffer | Uint8Array, fileName: string, expected?: NewPoSourceType) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytesOf(data) as unknown as ExcelJS.Buffer);
  } catch (error) {
    throw issue("INVALID_WORKBOOK", `${fileName} is not a readable XLSX workbook: ${error instanceof Error ? error.message : "unknown error"}.`, { fileName });
  }
  let workbookRows = 0;
  for (const worksheet of workbook.worksheets) workbookRows += Math.max(0, worksheet.rowCount - 1);
  if (workbookRows > NEW_PO_MAX_ROWS) {
    throw issue("TOO_MANY_ROWS", `${fileName} exceeds the 100,000-row workbook limit.`, { fileName });
  }

  const matrices: MatrixSource[] = workbook.worksheets.map(worksheet => ({
    fileName,
    sheetName: worksheet.name,
    rowCount: worksheet.rowCount,
    columnCount: worksheet.columnCount,
    valueAt: (row, column) => worksheet.getCell(row, column).value,
  }));

  // A separately uploaded XLSX often contains a Notes or export-metadata tab.
  // Select its one complete source sheet by headers and retain the ignored tab
  // names for audit instead of failing merely because helper tabs exist.
  if (expected) {
    const ranked = matrices.map(matrix => ({ matrix, match: bestHeaderMatch(matrix, expected) }));
    const complete = ranked.filter(candidate => candidate.match.missing.length === 0);
    if (!complete.length) {
      const closest = ranked.sort((left, right) => left.match.missing.length - right.match.missing.length)[0];
      if (!closest) throw issue("UNKNOWN_SOURCE", `${fileName} contains no worksheets.`, { fileName });
      // Reuse the normal parser so the caller receives precise missing-column or
      // empty-source issues for the closest candidate.
      parseMatrix(closest.matrix, expected);
      throw issue("UNKNOWN_SOURCE", `${fileName} contains no supported ${NEW_PO_SOURCE_DEFINITIONS[expected].label} worksheet.`, { fileName });
    }
    const parsed = complete.map(candidate => parseMatrix(candidate.matrix, expected));
    const selectedNames = new Set(complete.map(candidate => candidate.matrix.sheetName));
    const ignoredSheetNames = matrices.map(matrix => matrix.sheetName).filter((name): name is string => Boolean(name) && !selectedNames.has(name));
    return makeBundle(fileName, parsed, { [expected]: complete[0].matrix.sheetName }, ignoredSheetNames);
  }

  const parsed: Array<ReturnType<typeof parseMatrix>> = [];
  const sheetNames: Partial<Record<NewPoSourceType, string>> = {};
  const ignoredSheetNames: string[] = [];
  for (const matrix of matrices) {
    try {
      const source = parseMatrix(matrix);
      parsed.push(source);
      sheetNames[source.sourceType] = matrix.sheetName;
    } catch (error) {
      const knownName = SOURCE_TYPES.some(type => normalizedSheetAliases[type].has(normalizeToken(matrix.sheetName)));
      if (error instanceof NewPoImportError && error.issues.every(entry => entry.code === "UNKNOWN_SOURCE") && !knownName) {
        if (matrix.sheetName) ignoredSheetNames.push(matrix.sheetName);
        continue;
      }
      throw error;
    }
  }
  if (!parsed.length) throw issue("UNKNOWN_SOURCE", `${fileName} contains no recognized New PO source sheets.`, { fileName });
  return makeBundle(fileName, parsed, sheetNames, ignoredSheetNames);
}

function csvSource(data: string | ArrayBuffer | Uint8Array, fileName: string, expected?: NewPoSourceType) {
  let text: string;
  try {
    text = textOf(data).replace(/^\uFEFF/, "");
  } catch {
    throw issue("CSV_PARSE_ERROR", `${fileName} is not valid UTF-8 text.`, { fileName });
  }
  const result = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
  if (result.errors.length) {
    const first = result.errors[0];
    throw issue("CSV_PARSE_ERROR", `${fileName} CSV parse error at row ${(first.row ?? 0) + 1}: ${first.message}`, {
      fileName, rowNumber: (first.row ?? 0) + 1,
    });
  }
  const matrixRows = result.data;
  if (matrixRows.length - 1 > NEW_PO_MAX_ROWS) {
    throw issue("TOO_MANY_ROWS", `${fileName} exceeds the 100,000-row limit.`, { fileName });
  }
  const matrix: MatrixSource = {
    fileName,
    rowCount: matrixRows.length,
    columnCount: matrixRows.reduce((maximum, row) => Math.max(maximum, row.length), 0),
    valueAt: (row, column) => matrixRows[row - 1]?.[column - 1],
  };
  const parsed = parseMatrix(matrix, expected);
  return makeBundle(fileName, [parsed]);
}

export async function parseNewPoSourceFile(file: NewPoSourceFile): Promise<NewPoImportBundle> {
  guardFileSize(file.data, file.fileName);
  const extension = file.fileName.toLowerCase().match(/\.([^.]+)$/)?.[1];
  if (extension === "csv") return csvSource(file.data, file.fileName, file.sourceType);
  if (extension === "xlsx" || extension === "xlsm") return workbookSources(file.data, file.fileName, file.sourceType);
  throw issue("UNSUPPORTED_FILE", `${file.fileName} must be a CSV or XLSX file.`, { fileName: file.fileName });
}

export async function parseNewPoBulkWorkbook(
  data: string | ArrayBuffer | Uint8Array,
  fileName = "New_PO_sources.xlsx",
): Promise<NewPoImportBundle & { data: NewPoCalculationInput }> {
  guardFileSize(data, fileName);
  const bundle = await workbookSources(data, fileName);
  const missing = SOURCE_TYPES.filter(type => bundle.data[type] === undefined);
  if (missing.length) {
    throw new NewPoImportError(missing.map(sourceType => ({
      code: "MISSING_SOURCE" as const,
      message: `${fileName} is missing the ${NEW_PO_SOURCE_DEFINITIONS[sourceType].label} source sheet.`,
      fileName,
    })));
  }
  return bundle as NewPoImportBundle & { data: NewPoCalculationInput };
}

/**
 * Combines one separately uploaded file per source into a complete calculation
 * input. Duplicate source uploads are rejected so a repeated file cannot double
 * count legitimate transaction/warehouse/PO rows.
 */
export function combineNewPoSourceImports(parts: NewPoImportBundle[]): NewPoImportBundle & { data: NewPoCalculationInput } {
  const data: Partial<NewPoCalculationInput> = {};
  const rowCounts: Partial<Record<NewPoSourceType, number>> = {};
  const sheetNames: Partial<Record<NewPoSourceType, string>> = {};
  const fileNames: string[] = [];
  const ignoredSheetNames: string[] = [];
  for (const part of parts) {
    fileNames.push(...part.report.fileNames);
    ignoredSheetNames.push(...part.report.ignoredSheetNames);
    for (const sourceType of part.report.sourceTypes) {
      if (data[sourceType] !== undefined) {
        throw issue("DUPLICATE_SOURCE", `More than one ${NEW_PO_SOURCE_DEFINITIONS[sourceType].label} file was supplied.`, {
          fileName: part.report.fileNames[0],
        });
      }
      (data as Record<NewPoSourceType, unknown>)[sourceType] = part.data[sourceType];
      rowCounts[sourceType] = part.report.rowCounts[sourceType];
      if (part.report.sheetNames[sourceType]) sheetNames[sourceType] = part.report.sheetNames[sourceType];
    }
  }
  const missing = SOURCE_TYPES.filter(type => data[type] === undefined);
  if (missing.length) {
    throw new NewPoImportError(missing.map(sourceType => ({
      code: "MISSING_SOURCE" as const,
      message: `Separate uploads are missing the ${NEW_PO_SOURCE_DEFINITIONS[sourceType].label} source.`,
    })));
  }
  const totalRows = Object.values(rowCounts).reduce((sum, rows) => sum + (rows ?? 0), 0);
  if (totalRows > NEW_PO_MAX_ROWS) {
    throw issue("TOO_MANY_ROWS", "Combined source files exceed the 100,000-row limit.");
  }
  validateStyleMaster(data.styleDetails!, fileNames.find(Boolean));
  return {
    data: data as NewPoCalculationInput,
    report: {
      importVersion: NEW_PO_IMPORT_VERSION,
      sourceFormat: "methodology",
      fileNames, sourceTypes: SOURCE_TYPES, rowCounts, sheetNames, ignoredSheetNames, totalRows,
    },
  };
}
