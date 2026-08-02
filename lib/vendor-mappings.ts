import { createHash, randomUUID } from "node:crypto";
import { dbJson } from "./db";
import type { NewPoStyleDetailRow } from "./new-po-methodology";
import type { VendorMasterRow } from "./po-engine";

export const VENDOR_MAPPING_IMPORT_LIMIT = 50_000;
export const VENDOR_MAPPING_FILE_LIMIT_BYTES = 15_000_000;

const PLACEHOLDER_VENDORS = new Set([
  "", "supplier mapping required", "unassigned", "unknown", "n/a", "na", "not assigned", "not mapped",
]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export interface VendorMappingInput {
  styleId: string;
  productName: string | null;
  brand: string | null;
  category: string | null;
  articleType: string | null;
  vendor: string | null;
  supplierEmail: string | null;
  supplierSku: string | null;
  nlc: number | null;
  hsnCode: string | null;
  gstRate: number | null;
  supplierGstin: string | null;
  supplierState: string | null;
  leadTimeDays: number | null;
  paymentTerms: string | null;
  incoterms: string | null;
  moq: number | null;
  packSize: number | null;
}

export interface VendorMappingRecord extends VendorMappingInput {
  id: string;
  mappingKey: string;
  source: string;
  revision: number;
  createdAt: string | Date;
  updatedAt: string | Date;
}

type MappingDbRow = Record<string, unknown>;

function optionalText(value: unknown, maximum: number, label: string) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > maximum) throw new Error(`${label} must be ${maximum} characters or fewer.`);
  return text;
}

function optionalNumber(value: unknown, label: string, options: { minimum: number; maximum: number; integer?: boolean; strictlyPositive?: boolean }) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const number = typeof value === "number" ? value : Number(String(value).replace(/,/g, "").replace(/₹/g, "").trim());
  if (!Number.isFinite(number) || (options.integer && !Number.isSafeInteger(number))) {
    throw new Error(`${label} must be ${options.integer ? "a whole number" : "numeric"}.`);
  }
  if ((options.strictlyPositive && number <= 0) || number < options.minimum || number > options.maximum) {
    throw new Error(`${label} must be ${options.strictlyPositive ? "above 0" : `between ${options.minimum} and ${options.maximum}`}${options.strictlyPositive ? ` and no more than ${options.maximum}` : ""}.`);
  }
  return number;
}

export function normalizeVendor(value: unknown) {
  const vendor = optionalText(value, 200, "Vendor");
  return vendor && !PLACEHOLDER_VENDORS.has(vendor.toLocaleLowerCase("en-IN")) ? vendor : null;
}

export function vendorMappingKey(styleId: string, vendor: string | null) {
  return `${styleId.trim().toLocaleLowerCase("en-IN")}::::${(vendor ?? "").trim().toLocaleLowerCase("en-IN")}`;
}

/** Validates and canonicalizes API/import input before it reaches PostgreSQL. */
export function normalizeVendorMappingInput(value: Record<string, unknown>): VendorMappingInput {
  const styleId = optionalText(value.styleId ?? value.style_id, 100, "Style ID");
  if (!styleId) throw new Error("Style ID is required.");
  const vendor = normalizeVendor(value.vendor ?? value.vendorName);
  const supplierEmail = optionalText(value.supplierEmail ?? value.contactEmail, 254, "Supplier email")?.toLocaleLowerCase("en-IN") ?? null;
  if (supplierEmail && !EMAIL_PATTERN.test(supplierEmail)) throw new Error("Supplier email is not valid.");
  const hsnCode = optionalText(value.hsnCode, 8, "HSN code");
  if (hsnCode && !/^\d{4,8}$/.test(hsnCode)) throw new Error("HSN code must contain 4–8 digits.");
  const supplierGstin = optionalText(value.supplierGstin ?? value.gstin, 15, "Supplier GSTIN")?.toUpperCase() ?? null;
  if (supplierGstin && !GSTIN_PATTERN.test(supplierGstin)) throw new Error("Supplier GSTIN must use the valid 15-character Indian format.");
  return {
    styleId,
    productName: optionalText(value.productName, 500, "Product name"),
    brand: optionalText(value.brand, 200, "Brand"),
    category: optionalText(value.category, 200, "Category"),
    articleType: optionalText(value.articleType, 200, "Article type"),
    vendor,
    supplierEmail,
    supplierSku: optionalText(value.supplierSku, 200, "Supplier SKU"),
    nlc: optionalNumber(value.nlc ?? value.nlcInr ?? value.unitPrice, "NLC", { minimum: 0, maximum: 1_000_000_000, strictlyPositive: true }),
    hsnCode,
    gstRate: optionalNumber(value.gstRate, "GST rate", { minimum: 0, maximum: 100 }),
    supplierGstin,
    supplierState: optionalText(value.supplierState, 100, "Supplier state"),
    leadTimeDays: optionalNumber(value.leadTimeDays, "Lead time", { minimum: 0, maximum: 3_650, integer: true }),
    paymentTerms: optionalText(value.paymentTerms, 300, "Payment terms"),
    incoterms: optionalText(value.incoterms, 100, "Incoterms"),
    moq: optionalNumber(value.moq, "MOQ", { minimum: 0, maximum: 1_000_000_000, integer: true, strictlyPositive: true }),
    packSize: optionalNumber(value.packSize, "Pack size", { minimum: 0, maximum: 1_000_000_000, integer: true, strictlyPositive: true }),
  };
}

export function vendorMappingIssues(mapping: VendorMappingInput) {
  if (!mapping.vendor) return ["Assign a real supplier."];
  const issues: string[] = [];
  if (mapping.nlc === null) issues.push("Add a positive INR NLC.");
  if (!mapping.supplierSku) issues.push("Add the supplier SKU.");
  if (!mapping.supplierEmail) issues.push("Add a supplier email.");
  if (!mapping.hsnCode) issues.push("Add a 4–8 digit HSN code.");
  if (mapping.gstRate === null) issues.push("Add the GST rate.");
  if (!mapping.supplierGstin) issues.push("Add the supplier GSTIN.");
  if (!mapping.supplierState) issues.push("Add the supplier state.");
  if (mapping.leadTimeDays === null) issues.push("Add lead time days.");
  if (mapping.moq === null) issues.push("Add MOQ.");
  if (mapping.packSize === null) issues.push("Add pack size.");
  return issues;
}

export function vendorMappingStatus(mapping: VendorMappingInput): "mapped" | "incomplete" | "unmapped" {
  if (!mapping.vendor) return "unmapped";
  return vendorMappingIssues(mapping).length ? "incomplete" : "mapped";
}

export function mappingFromDb(row: MappingDbRow): VendorMappingRecord {
  return {
    id: String(row.id),
    mappingKey: String(row.mapping_key),
    styleId: String(row.style_id),
    productName: row.product_name ? String(row.product_name) : null,
    brand: row.brand ? String(row.brand) : null,
    category: row.category ? String(row.category) : null,
    articleType: row.article_type ? String(row.article_type) : null,
    vendor: row.vendor ? String(row.vendor) : null,
    supplierEmail: row.supplier_email ? String(row.supplier_email) : null,
    supplierSku: row.supplier_sku ? String(row.supplier_sku) : null,
    nlc: row.nlc_inr === null || row.nlc_inr === undefined ? null : Number(row.nlc_inr),
    hsnCode: row.hsn_code ? String(row.hsn_code) : null,
    gstRate: row.gst_rate === null || row.gst_rate === undefined ? null : Number(row.gst_rate),
    supplierGstin: row.supplier_gstin ? String(row.supplier_gstin) : null,
    supplierState: row.supplier_state ? String(row.supplier_state) : null,
    leadTimeDays: row.lead_time_days === null || row.lead_time_days === undefined ? null : Number(row.lead_time_days),
    paymentTerms: row.payment_terms ? String(row.payment_terms) : null,
    incoterms: row.incoterms ? String(row.incoterms) : null,
    moq: row.moq === null || row.moq === undefined ? null : Number(row.moq),
    packSize: row.pack_size === null || row.pack_size === undefined ? null : Number(row.pack_size),
    source: String(row.source ?? "manual"),
    revision: Number(row.revision),
    createdAt: row.created_at as string | Date,
    updatedAt: row.updated_at as string | Date,
  };
}

export function publicVendorMapping(row: MappingDbRow | VendorMappingRecord) {
  const mapping = "styleId" in row ? row as VendorMappingRecord : mappingFromDb(row as MappingDbRow);
  const issues = vendorMappingIssues(mapping);
  return {
    id: mapping.id,
    styleId: mapping.styleId,
    productName: mapping.productName,
    brand: mapping.brand,
    category: mapping.category,
    articleType: mapping.articleType,
    vendor: mapping.vendor,
    supplierEmail: mapping.supplierEmail,
    supplierSku: mapping.supplierSku,
    nlc: mapping.nlc,
    hsnCode: mapping.hsnCode,
    gstRate: mapping.gstRate,
    supplierGstin: mapping.supplierGstin,
    supplierState: mapping.supplierState,
    leadTimeDays: mapping.leadTimeDays,
    paymentTerms: mapping.paymentTerms,
    incoterms: mapping.incoterms,
    moq: mapping.moq,
    packSize: mapping.packSize,
    status: vendorMappingStatus(mapping),
    readiness: { ready: issues.length === 0, issues },
    issues,
    revision: mapping.revision,
    source: mapping.source,
    createdAt: mapping.createdAt,
    updatedAt: mapping.updatedAt,
  };
}

export function insertableVendorMapping(input: VendorMappingInput, source = "manual") {
  return {
    id: randomUUID(),
    mappingKey: vendorMappingKey(input.styleId, input.vendor),
    ...input,
    source,
  };
}

export async function loadVendorMappingsForStyles(db: any, styleIds: string[]) {
  const unique = [...new Set(styleIds.map(value => String(value).trim()).filter(Boolean))];
  if (!unique.length) return [] as VendorMappingRecord[];
  const rows = await db`SELECT * FROM supplier_style_mappings
    WHERE style_id IN (SELECT jsonb_array_elements_text(${dbJson(unique)}::jsonb))
    ORDER BY style_id,vendor NULLS FIRST`;
  return rows.map(mappingFromDb) as VendorMappingRecord[];
}

/** Commercial master rows override the corresponding uploaded rule at snapshot creation time. */
export function mergeVendorMasterMappings(
  base: VendorMasterRow[],
  mappings: VendorMappingRecord[],
  options: { includeMultipleSupplierCandidates?: boolean } = {},
) {
  const result = base.map(row => ({ ...row }));
  const candidatesByStyle = new Map<string, VendorMappingRecord[]>();
  for (const mapping of mappings.filter(row => row.vendor)) {
    candidatesByStyle.set(mapping.styleId, [...(candidatesByStyle.get(mapping.styleId) ?? []), mapping]);
  }
  const baseVendorsByStyle = new Map<string, Set<string>>();
  for (const row of base) {
    const styleId = String(row.styleId || row.sku || "").trim();
    const vendor = normalizeVendor(row.vendor);
    if (!styleId || !vendor) continue;
    baseVendorsByStyle.set(styleId, new Set([...(baseVendorsByStyle.get(styleId) ?? []), vendor.toLocaleLowerCase("en-IN")]));
  }
  const applicableMappings = mappings.filter(mapping => {
    if (!mapping.vendor) return false;
    if (options.includeMultipleSupplierCandidates) return true;
    const explicitSourceVendors = baseVendorsByStyle.get(mapping.styleId);
    if (explicitSourceVendors?.size) return explicitSourceVendors.has(mapping.vendor.toLocaleLowerCase("en-IN"));
    return (candidatesByStyle.get(mapping.styleId)?.length ?? 0) === 1;
  });
  const mappedStyles = new Set(applicableMappings.map(row => row.styleId));
  for (let index = result.length - 1; index >= 0; index--) {
    const styleId = String(result[index].styleId || result[index].sku || "").trim();
    if (mappedStyles.has(styleId) && !normalizeVendor(result[index].vendor)) result.splice(index, 1);
  }
  for (const mapping of applicableMappings) {
    const index = result.findIndex(row =>
      String(row.styleId || row.sku || "").trim() === mapping.styleId
      && String(row.vendor || "").trim().toLocaleLowerCase("en-IN") === mapping.vendor!.toLocaleLowerCase("en-IN"),
    );
    const existing = index >= 0 ? result[index] : undefined;
    const styleFallback = base.find(row => String(row.styleId || row.sku || "").trim() === mapping.styleId);
    const inherited = existing ?? styleFallback;
    const merged: VendorMasterRow = {
      ...(inherited ?? {}),
      marketplace: "Myntra",
      styleId: mapping.styleId,
      sku: mapping.styleId,
      productName: mapping.productName ?? inherited?.productName,
      brand: mapping.brand ?? inherited?.brand,
      category: mapping.category ?? inherited?.category,
      articleType: mapping.articleType ?? inherited?.articleType,
      vendor: mapping.vendor!,
      contactEmail: mapping.supplierEmail ?? undefined,
      supplierSku: mapping.supplierSku ?? undefined,
      unitPrice: mapping.nlc ?? undefined,
      currency: "INR",
      hsnCode: mapping.hsnCode ?? undefined,
      gstRate: mapping.gstRate ?? undefined,
      gstin: mapping.supplierGstin ?? undefined,
      supplierState: mapping.supplierState ?? undefined,
      leadTimeDays: mapping.leadTimeDays ?? undefined,
      paymentTerms: mapping.paymentTerms ?? undefined,
      incoterms: mapping.incoterms ?? undefined,
      moq: mapping.moq ?? undefined,
      packSize: mapping.packSize ?? undefined,
      commercialDataProvenance: `StyleFlow supplier mapping master · revision ${mapping.revision}`,
    };
    if (index >= 0) result[index] = merged;
    else result.push(merged);
  }
  return result;
}

export function vendorMappingProvenance(mappings: VendorMappingRecord[]) {
  const versions = mappings
    .map(mapping => `${mapping.id}:${mapping.revision}`)
    .sort();
  return {
    source: "supplier_style_mappings",
    loadedMappings: versions.length,
    fingerprint: createHash("sha256").update(versions.join("|")).digest("hex"),
    appliedAt: new Date().toISOString(),
  };
}

/** Uses one unambiguous mapped supplier to enrich an uploaded style detail row. */
export function enrichStyleDetailsWithMappings(details: NewPoStyleDetailRow[], mappings: VendorMappingRecord[]) {
  const byStyle = new Map<string, VendorMappingRecord[]>();
  for (const mapping of mappings.filter(row => row.vendor)) {
    byStyle.set(mapping.styleId, [...(byStyle.get(mapping.styleId) ?? []), mapping]);
  }
  return details.map(detail => {
    const candidates = byStyle.get(detail.styleId) ?? [];
    const currentVendor = normalizeVendor(detail.vendorName);
    const chosen = currentVendor
      ? candidates.find(candidate => candidate.vendor!.toLocaleLowerCase("en-IN") === currentVendor.toLocaleLowerCase("en-IN"))
      : candidates.length === 1 ? candidates[0] : undefined;
    if (!chosen) return detail;
    return {
      ...detail,
      vendorName: chosen.vendor ?? detail.vendorName,
      contactEmail: chosen.supplierEmail ?? undefined,
      supplierSku: chosen.supplierSku ?? undefined,
      nlcInr: chosen.nlc ?? detail.nlcInr,
      hsnCode: chosen.hsnCode ?? undefined,
      gstRate: chosen.gstRate ?? undefined,
      supplierGstin: chosen.supplierGstin ?? undefined,
      supplierState: chosen.supplierState ?? undefined,
      leadTimeDays: chosen.leadTimeDays ?? undefined,
      paymentTerms: chosen.paymentTerms ?? undefined,
      incoterms: chosen.incoterms ?? undefined,
      moq: chosen.moq ?? undefined,
      packSize: chosen.packSize ?? undefined,
    };
  });
}
