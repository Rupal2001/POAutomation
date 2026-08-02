import Papa from "papaparse";
import {
  CsvValidationError,
  parseInventoryCsv,
  parseOpenPoCsv,
  parseSalesCsv,
  parseVendorMasterCsv,
} from "./csv";
import {
  NEW_PO_IMPORT_VERSION,
  NEW_PO_MAX_ROWS,
  NEW_PO_MAX_UPLOAD_BYTES,
  NewPoImportError,
  type NewPoImportIssueCode,
  type NewPoImportReport,
  type NewPoSourceFile,
  type NewPoSourceType,
} from "./new-po-import";
import {
  sameNewPoStyleDetail,
  type NewPoCalculationInput,
  type NewPoStyleDetailRow,
} from "./new-po-methodology";

const SOURCE_TYPES: NewPoSourceType[] = ["sales", "inventory", "openPos", "styleDetails"];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const clean = (value: unknown) => String(value ?? "").trim();
const token = (value: unknown) => clean(value).toLowerCase().replace(/[\s_\-./]+/g, "");
const normalizedText = (value: unknown) => clean(value).toLocaleLowerCase("en-IN");

type LegacySalesRow = ReturnType<typeof parseSalesCsv>[number];
type LegacyInventoryRow = ReturnType<typeof parseInventoryCsv>[number];
type LegacyOpenPoRow = ReturnType<typeof parseOpenPoCsv>[number];
type LegacyVendorRow = ReturnType<typeof parseVendorMasterCsv>[number];

interface CompleteSourceFile extends NewPoSourceFile {
  sourceType: NewPoSourceType;
}

export interface LegacyOperationalCompatibilityReport {
  vendorWideRuleRows: number;
  styleSpecificRuleRows: number;
  generatedStyleDetailRows: number;
  variantSupplierSkuStyleIds: string[];
}

export type LegacyOperationalNewPoBundle = {
  data: NewPoCalculationInput;
  report: NewPoImportReport & { compatibility: LegacyOperationalCompatibilityReport };
};

function importError(
  code: NewPoImportIssueCode,
  message: string,
  fileName?: string,
  rowNumber?: number,
  columnName?: string,
) {
  return new NewPoImportError({ code, message, fileName, rowNumber, columnName });
}

function byteLength(data: NewPoSourceFile["data"]) {
  return typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
}

function decode(file: NewPoSourceFile) {
  if (byteLength(file.data) > NEW_PO_MAX_UPLOAD_BYTES) {
    throw importError("FILE_TOO_LARGE", `${file.fileName} exceeds the 15 MB upload limit.`, file.fileName);
  }
  try {
    if (typeof file.data === "string") return file.data.replace(/^\uFEFF/, "");
    const bytes = file.data instanceof ArrayBuffer ? new Uint8Array(file.data) : file.data;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    throw importError("CSV_PARSE_ERROR", `${file.fileName} is not valid UTF-8 text.`, file.fileName);
  }
}

function sourceMap(files: NewPoSourceFile[]) {
  const map = new Map<NewPoSourceType, CompleteSourceFile>();
  for (const file of files) {
    if (!file.sourceType) return null;
    if (map.has(file.sourceType)) return null;
    map.set(file.sourceType, file as CompleteSourceFile);
  }
  return SOURCE_TYPES.every(sourceType => map.has(sourceType)) ? map : null;
}

function headerPreview(file: NewPoSourceFile) {
  if (!/\.csv$/i.test(file.fileName)) return null;
  try {
    const result = Papa.parse<string[]>(decode(file), { skipEmptyLines: "greedy", preview: 30 });
    if (result.errors.length || !result.data.length) return null;
    const headers = result.data[0].map(token);
    return { headers: new Set(headers), headerIndexes: headers, rows: result.data.slice(1) };
  } catch {
    return null;
  }
}

function includesEvery(headers: Set<string>, required: string[]) {
  return required.every(header => headers.has(header));
}

/**
 * Detects the richer, SKU/warehouse-grained Myntra operational export shipped
 * in `sample-data/demo`. This is deliberately narrow: malformed methodology
 * style-detail files still go through the strict methodology parser and cannot
 * use vendor-wide blank rows to bypass its required Style ID checks.
 */
export function isMyntraOperationalCsvBundle(files: NewPoSourceFile[]) {
  const map = sourceMap(files);
  if (!map) return false;
  const previews = Object.fromEntries(SOURCE_TYPES.map(sourceType => [sourceType, headerPreview(map.get(sourceType)!)])) as
    Record<NewPoSourceType, ReturnType<typeof headerPreview>>;
  if (Object.values(previews).some(preview => !preview)) return false;
  const sales = previews.sales!;
  const inventory = previews.inventory!;
  const openPos = previews.openPos!;
  const styles = previews.styleDetails!;
  if (!includesEvery(sales.headers, ["date", "sku", "vendor", "unitssold", "styleid"])) return false;
  if (!includesEvery(inventory.headers, ["sku", "vendor", "currentinventory", "styleid"])) return false;
  if (!includesEvery(openPos.headers, ["sku", "vendor", "openpoqty", "styleid"])) return false;
  if (!includesEvery(styles.headers, ["vendor", "sku", "unitprice", "currency", "productname", "mrpinr"])) return false;
  // The operational supplier master has vendor-wide defaults with no SKU. A
  // true methodology style master must never accept that blank style identity.
  const skuColumn = styles.headerIndexes.indexOf("sku");
  return skuColumn >= 0 && styles.rows.some(row => !clean(row[skuColumn]));
}

function parsedOrImportError<T>(file: CompleteSourceFile, parser: (text: string) => T): T {
  try {
    return parser(decode(file));
  } catch (error) {
    if (!(error instanceof CsvValidationError)) throw error;
    const rowNumber = Number(error.message.match(/Row (\d+)/)?.[1]) || undefined;
    const code: NewPoImportIssueCode = /CSV parse error/i.test(error.message) ? "CSV_PARSE_ERROR"
      : /must be a number|cannot be negative|cannot exceed|decimal between/i.test(error.message) ? "INVALID_NUMBER"
        : /missing required column/i.test(error.message) ? "MISSING_COLUMN"
          : /is empty/i.test(error.message) ? "EMPTY_SOURCE" : "REQUIRED_VALUE";
    throw importError(code, `${file.fileName}: ${error.message}`, file.fileName, rowNumber);
  }
}

function requireSafeWhole(value: number, label: string, fileName: string, rowNumber: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw importError("INVALID_INTEGER", `${fileName} row ${rowNumber}: ${label} must be a non-negative whole number.`, fileName, rowNumber, label);
  }
  return value;
}

function requirePositive(value: number | undefined, label: string, fileName: string, rowNumber: number) {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    throw importError("INVALID_NUMBER", `${fileName} row ${rowNumber}: ${label} must be greater than zero.`, fileName, rowNumber, label);
  }
  return value;
}

function validateCommercial(detail: NewPoStyleDetailRow) {
  const context = [detail.fileName ?? "vendor master", detail.rowNumber ? `row ${detail.rowNumber}` : ""].filter(Boolean).join(" ");
  if (detail.contactEmail && (detail.contactEmail.length > 254 || !EMAIL_PATTERN.test(detail.contactEmail))) {
    throw importError("INVALID_EMAIL", `${context}: Supplier email is not valid.`, detail.fileName, detail.rowNumber, "contactEmail");
  }
  if (detail.hsnCode && !/^\d{4,8}$/.test(detail.hsnCode)) {
    throw importError("INVALID_HSN", `${context}: HSN code must contain 4–8 digits.`, detail.fileName, detail.rowNumber, "hsnCode");
  }
  if (detail.supplierGstin && !GSTIN_PATTERN.test(detail.supplierGstin)) {
    throw importError("INVALID_GSTIN", `${context}: Supplier GSTIN must use the valid 15-character Indian format.`, detail.fileName, detail.rowNumber, "supplierGstin");
  }
  if (detail.gstRate !== undefined && (!Number.isFinite(detail.gstRate) || detail.gstRate < 0 || detail.gstRate > 100)) {
    throw importError("INVALID_NUMBER", `${context}: GST rate must be between 0 and 100 percent.`, detail.fileName, detail.rowNumber, "gstRate");
  }
  for (const [label, value, allowZero] of [
    ["Lead time", detail.leadTimeDays, true],
    ["MOQ", detail.moq, false],
    ["Pack size", detail.packSize, false],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0))) {
      throw importError("INVALID_INTEGER", `${context}: ${label} must be ${allowZero ? "a non-negative" : "a positive"} whole number.`, detail.fileName, detail.rowNumber, label);
    }
  }
}

function rowIdentityFile(files: Map<NewPoSourceType, CompleteSourceFile>, sourceType: NewPoSourceType) {
  return files.get(sourceType)!.fileName;
}

function sameGenericCommercialRule(left: LegacyVendorRow, right: LegacyVendorRow) {
  const textFields: Array<keyof LegacyVendorRow> = [
    "contactEmail", "hsnCode", "gstin", "supplierState", "paymentTerms", "incoterms",
  ];
  const numberFields: Array<keyof LegacyVendorRow> = [
    "unitPrice", "gstRate", "leadTimeDays", "moq", "packSize",
  ];
  return textFields.every(field => normalizedText(left[field]) === normalizedText(right[field]))
    && numberFields.every(field => left[field] === right[field]);
}

function bestGenericRule(
  row: LegacyVendorRow,
  genericByVendor: Map<string, LegacyVendorRow[]>,
  rowNumbers: Map<LegacyVendorRow, number>,
  fileName: string,
) {
  const candidates = genericByVendor.get(normalizedText(row.vendor)) ?? [];
  const warehouse = normalizedText(row.warehouse);
  const exact = warehouse ? candidates.filter(candidate => normalizedText(candidate.warehouse) === warehouse) : [];
  const vendorWide = candidates.filter(candidate => !clean(candidate.warehouse));
  const applicable = exact.length ? exact : vendorWide;
  const selected = applicable[0];
  const conflict = selected && applicable.find(candidate => !sameGenericCommercialRule(selected, candidate));
  if (conflict) {
    throw importError(
      "CONFLICTING_STYLE_MASTER",
      `${fileName} rows ${rowNumbers.get(selected)} and ${rowNumbers.get(conflict)} contain conflicting vendor-wide defaults for ${row.vendor}.`,
      fileName,
      rowNumbers.get(conflict),
    );
  }
  return selected;
}

function firstDefined<T>(primary: T | undefined, fallback: T | undefined) {
  return primary ?? fallback;
}

function consistentCatalogueValue<T extends string | number>(
  rows: Array<LegacySalesRow | LegacyInventoryRow | LegacyOpenPoRow>,
  field: "productName" | "mrpInr",
  styleId: string,
  fileName: string,
  rowNumber: number,
) {
  const values = rows.map(row => row[field]).filter(value => value !== undefined && clean(value) !== "") as T[];
  const distinct = new Map(values.map(value => [typeof value === "string" ? normalizedText(value) : String(value), value]));
  if (distinct.size > 1) {
    throw importError("CONFLICTING_STYLE_MASTER", `${fileName} row ${rowNumber}: catalogue data conflicts for style ${styleId} (${field}).`, fileName, rowNumber, field);
  }
  return [...distinct.values()][0];
}

function validateGenericVendorRule(row: LegacyVendorRow, fileName: string, rowNumber: number) {
  if (row.unitPrice !== undefined) requirePositive(row.unitPrice, "Unit_Price (INR NLC)", fileName, rowNumber);
  const detail: NewPoStyleDetailRow = {
    fileName,
    rowNumber,
    styleId: "vendor-wide-default",
    model: "Vendor-wide default",
    mrpInr: 1,
    nlcInr: row.unitPrice ?? 1,
    contactEmail: clean(row.contactEmail).toLowerCase() || undefined,
    hsnCode: clean(row.hsnCode) || undefined,
    gstRate: row.gstRate,
    supplierGstin: clean(row.gstin).toUpperCase() || undefined,
    supplierState: clean(row.supplierState) || undefined,
    leadTimeDays: row.leadTimeDays,
    paymentTerms: clean(row.paymentTerms) || undefined,
    incoterms: clean(row.incoterms) || undefined,
    moq: row.moq,
    packSize: row.packSize,
  };
  validateCommercial(detail);
}

/**
 * Converts legacy SKU/warehouse operational CSVs to the exact style-level New
 * PO input contract. Vendor-wide rows are used only as defaults for an
 * explicitly style-resolved vendor rule; they never become style details by
 * themselves and never invent a supplier nomination.
 */
export function parseMyntraOperationalCsvBundle(files: NewPoSourceFile[]): LegacyOperationalNewPoBundle {
  const mappedFiles = sourceMap(files);
  if (!mappedFiles || !isMyntraOperationalCsvBundle(files)) {
    throw importError("UNKNOWN_SOURCE", "The four files are not a supported Myntra operational CSV bundle.");
  }

  const salesFile = mappedFiles.get("sales")!;
  const inventoryFile = mappedFiles.get("inventory")!;
  const openPoFile = mappedFiles.get("openPos")!;
  const vendorFile = mappedFiles.get("styleDetails")!;
  const legacySales = parsedOrImportError(salesFile, parseSalesCsv);
  const legacyInventory = parsedOrImportError(inventoryFile, parseInventoryCsv);
  const legacyOpenPos = parsedOrImportError(openPoFile, parseOpenPoCsv);
  const legacyVendors = parsedOrImportError(vendorFile, parseVendorMasterCsv);
  const totalRows = legacySales.length + legacyInventory.length + legacyOpenPos.length + legacyVendors.length;
  if (totalRows > NEW_PO_MAX_ROWS) {
    throw importError("TOO_MANY_ROWS", "Combined source files exceed the 100,000-row limit.");
  }

  const skuToStyle = new Map<string, string>();
  const catalogueBySku = new Map<string, Array<LegacySalesRow | LegacyInventoryRow | LegacyOpenPoRow>>();
  const registerIdentity = (
    row: LegacySalesRow | LegacyInventoryRow | LegacyOpenPoRow,
    fileName: string,
    rowNumber: number,
  ) => {
    const sku = clean(row.sku);
    const styleId = clean(row.styleId);
    if (sku) catalogueBySku.set(sku, [...(catalogueBySku.get(sku) ?? []), row]);
    if (!sku || !styleId) return;
    const existing = skuToStyle.get(sku);
    if (existing && existing !== styleId) {
      throw importError("CONFLICTING_STYLE_MASTER", `${fileName} row ${rowNumber}: SKU ${sku} maps to both style ${existing} and ${styleId}.`, fileName, rowNumber, "Style_ID");
    }
    skuToStyle.set(sku, styleId);
  };
  legacySales.forEach((row, index) => registerIdentity(row, salesFile.fileName, index + 2));
  legacyInventory.forEach((row, index) => registerIdentity(row, inventoryFile.fileName, index + 2));
  legacyOpenPos.forEach((row, index) => registerIdentity(row, openPoFile.fileName, index + 2));

  const resolveStyle = (
    row: LegacySalesRow | LegacyInventoryRow | LegacyOpenPoRow,
    fileName: string,
    rowNumber: number,
  ) => {
    const styleId = clean(row.styleId) || skuToStyle.get(clean(row.sku));
    if (!styleId) {
      throw importError("REQUIRED_VALUE", `${fileName} row ${rowNumber}: Style_ID is required, or SKU must map unambiguously to a Style_ID in another source.`, fileName, rowNumber, "Style_ID");
    }
    return styleId;
  };

  const sales = legacySales.map((row, index) => ({
    fileName: salesFile.fileName,
    rowNumber: index + 2,
    salesDate: row.date,
    styleId: resolveStyle(row, salesFile.fileName, index + 2),
    quantity: requireSafeWhole(row.unitsSold, "Units_Sold", salesFile.fileName, index + 2),
    // These fields remain forecast evidence only. The exact style-cover
    // calculator deliberately reads `quantity` and ignores all four.
    returnsQty: row.returnsQty,
    cancellationsQty: row.cancellationsQty,
    isPromotion: row.isPromotion,
    inStock: row.inStock,
    brand: row.brand,
    articleType: row.articleType,
    masterCategory: row.category,
  }));
  const inventory = legacyInventory.map((row, index) => ({
    fileName: inventoryFile.fileName,
    rowNumber: index + 2,
    styleId: resolveStyle(row, inventoryFile.fileName, index + 2),
    inventoryUnits: requireSafeWhole(row.currentInventory, "Current_Inventory", inventoryFile.fileName, index + 2),
    brand: row.brand,
    articleType: row.articleType,
    warehouseName: row.warehouse,
  }));
  const openPos = legacyOpenPos.map((row, index) => ({
    fileName: openPoFile.fileName,
    rowNumber: index + 2,
    styleId: resolveStyle(row, openPoFile.fileName, index + 2),
    pendingQuantity: requireSafeWhole(row.openPoQty, "Open_PO_Qty", openPoFile.fileName, index + 2),
    estimatedShipmentDate: row.expectedDate,
    vendorName: row.vendor,
    poStatus: row.status,
    brand: row.brand,
    articleType: row.articleType,
    masterCategory: row.category,
    warehouseId: row.warehouse,
  }));

  const genericRows = legacyVendors.filter(row => !clean(row.sku) && !clean(row.styleId));
  const styleRows = legacyVendors.filter(row => clean(row.sku) || clean(row.styleId));
  const vendorRowNumbers = new Map(legacyVendors.map((row, index) => [row, index + 2]));
  const genericByVendor = new Map<string, LegacyVendorRow[]>();
  for (const row of genericRows) {
    validateGenericVendorRule(row, vendorFile.fileName, vendorRowNumbers.get(row)!);
    genericByVendor.set(normalizedText(row.vendor), [...(genericByVendor.get(normalizedText(row.vendor)) ?? []), row]);
  }

  const detailsByStyle = new Map<string, NewPoStyleDetailRow>();
  const supplierSkusByStyle = new Map<string, Set<string>>();
  for (const row of styleRows) {
    const rowNumber = vendorRowNumbers.get(row)!;
    const sku = clean(row.sku);
    const styleId = clean(row.styleId) || skuToStyle.get(sku);
    if (!styleId) {
      throw importError("REQUIRED_VALUE", `${vendorFile.fileName} row ${rowNumber}: SKU ${sku || "(blank)"} cannot be resolved to a Style_ID from the operational sources.`, vendorFile.fileName, rowNumber, "Style_ID");
    }
    const generic = bestGenericRule(row, genericByVendor, vendorRowNumbers, vendorFile.fileName);
    const catalogueRows = catalogueBySku.get(sku) ?? [];
    const model = clean(row.productName)
      || clean(consistentCatalogueValue<string>(catalogueRows, "productName", styleId, vendorFile.fileName, rowNumber));
    if (!model) {
      throw importError("REQUIRED_VALUE", `${vendorFile.fileName} row ${rowNumber}: Product_Name is required for style ${styleId}.`, vendorFile.fileName, rowNumber, "Product_Name");
    }
    const mrpInr = requirePositive(
      firstDefined(row.mrpInr, consistentCatalogueValue<number>(catalogueRows, "mrpInr", styleId, vendorFile.fileName, rowNumber)),
      "MRP_INR",
      vendorFile.fileName,
      rowNumber,
    );
    const nlcInr = requirePositive(firstDefined(row.unitPrice, generic?.unitPrice), "Unit_Price (INR NLC)", vendorFile.fileName, rowNumber);
    const supplierSku = clean(row.supplierSku) || undefined;
    if (supplierSku) supplierSkusByStyle.set(styleId, new Set([...(supplierSkusByStyle.get(styleId) ?? []), supplierSku]));
    const detail: NewPoStyleDetailRow = {
      fileName: vendorFile.fileName,
      rowNumber,
      styleId,
      model,
      mrpInr,
      nlcInr,
      vendorName: clean(row.vendor) || undefined,
      contactEmail: clean(firstDefined(row.contactEmail, generic?.contactEmail)).toLowerCase() || undefined,
      supplierSku,
      hsnCode: clean(firstDefined(row.hsnCode, generic?.hsnCode)) || undefined,
      gstRate: firstDefined(row.gstRate, generic?.gstRate),
      supplierGstin: clean(firstDefined(row.gstin, generic?.gstin)).toUpperCase() || undefined,
      supplierState: clean(firstDefined(row.supplierState, generic?.supplierState)) || undefined,
      leadTimeDays: firstDefined(row.leadTimeDays, generic?.leadTimeDays),
      paymentTerms: clean(firstDefined(row.paymentTerms, generic?.paymentTerms)) || undefined,
      incoterms: clean(firstDefined(row.incoterms, generic?.incoterms)) || undefined,
      moq: firstDefined(row.moq, generic?.moq),
      packSize: firstDefined(row.packSize, generic?.packSize),
    };
    validateCommercial(detail);
    const previous = detailsByStyle.get(styleId);
    if (previous && !sameNewPoStyleDetail({ ...previous, supplierSku: undefined }, { ...detail, supplierSku: undefined })) {
      throw importError("CONFLICTING_STYLE_MASTER", `${vendorFile.fileName} row ${rowNumber}: supplier or commercial values conflict for style ${styleId}.`, vendorFile.fileName, rowNumber);
    }
    if (!previous) detailsByStyle.set(styleId, detail);
  }

  const variantSupplierSkuStyleIds = [...supplierSkusByStyle]
    .filter(([, supplierSkus]) => supplierSkus.size > 1)
    .map(([styleId]) => styleId);
  for (const styleId of variantSupplierSkuStyleIds) {
    const detail = detailsByStyle.get(styleId)!;
    // The exact calculator is style-grained. A size-specific supplier SKU is
    // therefore not promoted to a misleading style-wide commercial identity.
    detailsByStyle.set(styleId, { ...detail, supplierSku: undefined });
  }
  const styleDetails = [...detailsByStyle.values()];
  if (!styleDetails.length) {
    throw importError("EMPTY_SOURCE", `${vendorFile.fileName} has no style-resolvable supplier rows.`, vendorFile.fileName);
  }

  const data: NewPoCalculationInput = { sales, inventory, openPos, styleDetails };
  const report: LegacyOperationalNewPoBundle["report"] = {
    importVersion: NEW_PO_IMPORT_VERSION,
    sourceFormat: "myntra_operational_csv",
    fileNames: SOURCE_TYPES.map(sourceType => rowIdentityFile(mappedFiles, sourceType)),
    sourceTypes: SOURCE_TYPES,
    rowCounts: {
      sales: legacySales.length,
      inventory: legacyInventory.length,
      openPos: legacyOpenPos.length,
      styleDetails: legacyVendors.length,
    },
    sheetNames: {},
    ignoredSheetNames: [],
    totalRows,
    compatibility: {
      vendorWideRuleRows: genericRows.length,
      styleSpecificRuleRows: styleRows.length,
      generatedStyleDetailRows: styleDetails.length,
      variantSupplierSkuStyleIds,
    },
  };
  return { data, report };
}
