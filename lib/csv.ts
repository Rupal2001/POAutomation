import Papa from "papaparse";

export class CsvValidationError extends Error {}

function parseCsv(text: string): { rows: Record<string, string>[]; fields: string[] } {
  if (text.length > 15_000_000) throw new CsvValidationError("CSV exceeds the 15 MB upload limit.");
  const result = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true, transformHeader: header => header.trim() });
  if (result.errors.length) throw new CsvValidationError(`CSV parse error at row ${result.errors[0].row}: ${result.errors[0].message}`);
  if (result.data.length > 100_000) throw new CsvValidationError("CSV exceeds the 100,000-row limit.");
  return { rows: result.data, fields: result.meta.fields ?? [] };
}

function requireColumns(rows: Record<string, string>[], required: string[], label: string, fields: string[] = [], allowEmpty = false) {
  if (!rows.length && !allowEmpty) throw new CsvValidationError(`${label} is empty.`);
  const availableColumns = rows.length ? Object.keys(rows[0]) : fields;
  const missing = required.filter(column => !availableColumns.includes(column));
  if (missing.length) throw new CsvValidationError(`${label} is missing required column(s): ${missing.join(", ")}`);
}

function requiredText(value: string | undefined, field: string, row: number) {
  const clean = value?.trim();
  if (!clean) throw new CsvValidationError(`Row ${row}: ${field} is required.`);
  return clean;
}

function numberValue(value: string | undefined, field: string, row: number, optional = false) {
  if ((value === undefined || value.trim() === "") && optional) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new CsvValidationError(`Row ${row}: ${field} must be a number.`);
  return number;
}

function nonNegativeNumber(value: string | undefined, field: string, row: number, optional = false) {
  const number = numberValue(value, field, row, optional);
  if (number !== undefined && number < 0) throw new CsvValidationError(`Row ${row}: ${field} cannot be negative.`);
  return number;
}

const optionalText = (value?: string) => value?.trim() || undefined;
const optionalBool = (value?: string) => {
  if (!value?.trim()) return undefined;
  return !["0", "false", "no", "n"].includes(value.trim().toLowerCase());
};

const isValidIsoDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date)
  && !Number.isNaN(Date.parse(`${date}T00:00:00Z`))
  && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;

function optionalDate(value: string | undefined, field: string, row: number) {
  const date = optionalText(value);
  if (date && !isValidIsoDate(date)) {
    throw new CsvValidationError(`Row ${row}: ${field} must be a valid YYYY-MM-DD date.`);
  }
  return date;
}

function validateMyntra(value: string | undefined, row: number) {
  const marketplace = optionalText(value);
  if (marketplace && marketplace.toLowerCase() !== "myntra") throw new CsvValidationError(`Row ${row}: Marketplace must be Myntra.`);
  return marketplace ?? "Myntra";
}

function productFields(record: Record<string, string>, row: number) {
  const mrpInr = nonNegativeNumber(record.MRP_INR, "MRP_INR", row, true);
  const sellingPriceInr = nonNegativeNumber(record.Selling_Price_INR ?? record.Typical_Selling_Price_INR, "Selling_Price_INR", row, true);
  const launchDate = optionalDate(record.Launch_Date, "Launch_Date", row);
  const endOfLifeDate = optionalDate(record.End_Of_Life_Date, "End_Of_Life_Date", row);
  const priceCapturedOn = optionalDate(record.Price_Captured_On, "Price_Captured_On", row);
  if (mrpInr !== undefined && sellingPriceInr !== undefined && sellingPriceInr > mrpInr) throw new CsvValidationError(`Row ${row}: Selling_Price_INR cannot exceed MRP_INR.`);
  if (launchDate && endOfLifeDate && endOfLifeDate < launchDate) throw new CsvValidationError(`Row ${row}: End_Of_Life_Date cannot be before Launch_Date.`);
  return {
    category: optionalText(record.Category), brand: optionalText(record.Brand), styleId: optionalText(record.Style_ID),
    size: optionalText(record.Size), productName: optionalText(record.Product_Name), articleType: optionalText(record.Article_Type),
    gender: optionalText(record.Gender), colour: optionalText(record.Colour),
    mrpInr, sellingPriceInr,
    lifecycleStage: optionalText(record.Lifecycle_Stage), availabilityStatus: optionalText(record.Availability_Status),
    launchDate, endOfLifeDate,
    marketplaceSeller: optionalText(record.Marketplace_Seller), sourceUrl: optionalText(record.Myntra_Product_URL),
    priceCapturedOn, catalogueDataProvenance: optionalText(record.Catalogue_Data_Provenance),
    commercialDataProvenance: optionalText(record.Commercial_Data_Provenance),
  };
}

export function parseSalesCsv(text: string) {
  const { rows } = parseCsv(text); requireColumns(rows, ["Date", "SKU", "Vendor", "Units_Sold"], "historical_sales.csv");
  return rows.map((record, index) => {
    const row = index + 2;
    const date = requiredText(record.Date, "Date", row);
    if (!isValidIsoDate(date)) throw new CsvValidationError(`Row ${row}: Date must be a valid YYYY-MM-DD date.`);
    const unitsSold = nonNegativeNumber(record.Units_Sold, "Units_Sold", row)!;
    const returnsQty = nonNegativeNumber(record.Returns_Qty, "Returns_Qty", row, true);
    const cancellationsQty = nonNegativeNumber(record.Cancellations_Qty, "Cancellations_Qty", row, true);
    const discountPct = nonNegativeNumber(record.Discount_Pct, "Discount_Pct", row, true);
    if ((cancellationsQty ?? 0) > unitsSold) throw new CsvValidationError(`Row ${row}: Cancellations_Qty cannot exceed Units_Sold.`);
    if ((returnsQty ?? 0) > unitsSold - (cancellationsQty ?? 0)) throw new CsvValidationError(`Row ${row}: Returns_Qty cannot exceed fulfilled units.`);
    if (discountPct !== undefined && discountPct > 100) throw new CsvValidationError(`Row ${row}: Discount_Pct cannot exceed 100.`);
    return {
      date, sku: requiredText(record.SKU, "SKU", row), vendor: requiredText(record.Vendor, "Vendor", row),
      warehouse: optionalText(record.Warehouse), unitsSold, returnsQty, cancellationsQty,
      isPromotion: optionalBool(record.Is_Promotion), discountPct,
      inStock: optionalBool(record.In_Stock), marketplace: validateMyntra(record.Marketplace, row), ...productFields(record, row),
    };
  });
}

export function parseInventoryCsv(text: string) {
  const { rows } = parseCsv(text); requireColumns(rows, ["SKU", "Vendor", "Current_Inventory"], "current_inventory.csv");
  return rows.map((record, index) => {
    const row = index + 2;
    return {
      sku: requiredText(record.SKU, "SKU", row), vendor: requiredText(record.Vendor, "Vendor", row), warehouse: optionalText(record.Warehouse),
      snapshotDate: optionalDate(record.Snapshot_Date, "Snapshot_Date", row),
      currentInventory: nonNegativeNumber(record.Current_Inventory, "Current_Inventory", row)!,
      reservedQty: nonNegativeNumber(record.Reserved_Qty, "Reserved_Qty", row, true),
      backorderQty: nonNegativeNumber(record.Backorder_Qty, "Backorder_Qty", row, true),
      marketplace: validateMyntra(record.Marketplace, row), ...productFields(record, row),
    };
  });
}

export function parseOpenPoCsv(text: string) {
  const { rows, fields } = parseCsv(text);
  requireColumns(rows, ["SKU", "Vendor", "Open_PO_Qty"], "open_purchase_orders.csv", fields, true);
  return rows.map((record, index) => {
    const row = index + 2;
    const currency = optionalText(record.Currency)?.toUpperCase();
    if (currency && currency !== "INR") throw new CsvValidationError(`Row ${row}: Currency must be INR.`);
    return {
      sku: requiredText(record.SKU, "SKU", row), vendor: requiredText(record.Vendor, "Vendor", row), warehouse: optionalText(record.Warehouse),
      openPoQty: nonNegativeNumber(record.Open_PO_Qty, "Open_PO_Qty", row)!, expectedDate: optionalDate(record.Expected_Date, "Expected_Date", row),
      poNumber: optionalText(record.PO_Number), status: optionalText(record.Status), marketplace: validateMyntra(record.Marketplace, row),
      currency: currency ?? "INR", ...productFields(record, row),
    };
  });
}

export function parseVendorMasterCsv(text: string) {
  const { rows } = parseCsv(text); requireColumns(rows, ["Vendor"], "vendor_master.csv");
  return rows.map((record, index) => {
    const row = index + 2;
    const currency = optionalText(record.Currency)?.toUpperCase();
    if (currency && currency !== "INR") throw new CsvValidationError(`Row ${row}: Currency must be INR.`);
    const serviceLevel = nonNegativeNumber(record.Service_Level, "Service_Level", row, true);
    const gstRate = nonNegativeNumber(record.GST_Rate, "GST_Rate", row, true);
    if (serviceLevel !== undefined && serviceLevel > 1) throw new CsvValidationError(`Row ${row}: Service_Level must be a decimal between 0 and 1.`);
    if (gstRate !== undefined && gstRate > 100) throw new CsvValidationError(`Row ${row}: GST_Rate cannot exceed 100.`);
    return {
      vendor: requiredText(record.Vendor, "Vendor", row), sku: optionalText(record.SKU), warehouse: optionalText(record.Warehouse),
      supplierSku: optionalText(record.Supplier_SKU), moq: nonNegativeNumber(record.MOQ, "MOQ", row, true),
      packSize: nonNegativeNumber(record.Pack_Size, "Pack_Size", row, true), maxOrderQty: nonNegativeNumber(record.Max_Order_Qty, "Max_Order_Qty", row, true),
      leadTimeDays: nonNegativeNumber(record.Lead_Time_Days, "Lead_Time_Days", row, true),
      reviewPeriodDays: nonNegativeNumber(record.Review_Period_Days, "Review_Period_Days", row, true),
      safetyStock: nonNegativeNumber(record.Safety_Stock, "Safety_Stock", row, true), serviceLevel,
      unitPrice: nonNegativeNumber(record.Unit_Price, "Unit_Price", row, true), currency: currency ?? "INR",
      minimumOrderValue: nonNegativeNumber(record.Minimum_Order_Value, "Minimum_Order_Value", row, true),
      freightFreeThreshold: nonNegativeNumber(record.Freight_Free_Threshold, "Freight_Free_Threshold", row, true),
      paymentTerms: optionalText(record.Payment_Terms), incoterms: optionalText(record.Incoterms), contactEmail: optionalText(record.Contact_Email),
      gstin: optionalText(record.GSTIN), supplierState: optionalText(record.Supplier_State), hsnCode: optionalText(record.HSN_Code),
      gstRate, marketplace: validateMyntra(record.Marketplace, row),
      ...productFields(record, row),
    };
  });
}
