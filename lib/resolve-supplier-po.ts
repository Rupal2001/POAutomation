import { randomUUID } from "node:crypto";
import type { BatchRow } from "./db";
import { dbJson } from "./db";
import {
  executionQuantityProblem,
  operationalExpectedDeliveryDate,
  recommendationClaimKey,
} from "./create-pos";
import type { Recommendation, VendorMasterRow } from "./po-engine";
import { calculateTotals, roundMoney, type PurchaseOrderLine } from "./purchase-orders";
import {
  assertRecommendationCanBecomePo,
  isPlaceholderSupplier,
} from "./recommendation-review";
import { todayInIndia } from "./po-readiness";
import {
  insertableVendorMapping,
  mappingFromDb,
  normalizeVendorMappingInput,
  publicVendorMapping,
  vendorMappingIssues,
  vendorMappingKey,
  vendorMappingStatus,
  type VendorMappingInput,
  type VendorMappingRecord,
} from "./vendor-mappings";

export interface SupplierResolutionSelection {
  sku: string;
  styleId?: string;
  warehouse?: string;
  currentVendor?: string;
  vendor?: string;
  quantity?: number;
  overrideReason?: string;
  acknowledgeRisk?: boolean;
}

export interface SupplierResolutionRequest {
  batchId: string;
  selection: SupplierResolutionSelection;
  mapping: Record<string, unknown>;
  replaceNamedSupplier?: boolean;
}

export interface SupplierResolutionActor {
  id: string;
  displayName: string;
}

export class SupplierResolutionError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SupplierResolutionError";
  }
}

const clean = (value: unknown) => String(value ?? "").trim();
const sameText = (left: unknown, right: unknown) => clean(left).toLocaleLowerCase("en-IN") === clean(right).toLocaleLowerCase("en-IN");
const styleOf = (row: Pick<Recommendation, "styleId" | "sku">) => clean(row.styleId) || clean(row.sku);

function requiredSelectionText(value: unknown, label: string) {
  const text = clean(value);
  if (!text) throw new SupplierResolutionError(`${label} is required.`, 400, "INVALID_RECOMMENDATION_SELECTION");
  if (text.length > 200) throw new SupplierResolutionError(`${label} is too long.`, 400, "INVALID_RECOMMENDATION_SELECTION");
  return text;
}

/** Finds exactly one immutable recommendation; it never guesses across FCs/vendors. */
export function selectSupplierResolutionRecommendation(batch: BatchRow, selection: SupplierResolutionSelection) {
  const recommendations = Array.isArray(batch.recommendations) ? batch.recommendations as Recommendation[] : [];
  const sku = requiredSelectionText(selection.sku || selection.styleId, "Style ID");
  const requestedStyle = clean(selection.styleId);
  const requestedWarehouse = clean(selection.warehouse);
  const requestedVendor = clean(selection.currentVendor ?? selection.vendor);
  let matches = recommendations.filter(row => clean(row.sku) === sku || styleOf(row) === sku);
  if (requestedStyle) matches = matches.filter(row => styleOf(row) === requestedStyle);
  if (requestedWarehouse) matches = matches.filter(row => clean(row.warehouse) === requestedWarehouse);
  if (requestedVendor) matches = matches.filter(row => sameText(row.vendor, requestedVendor));
  if (!matches.length) {
    throw new SupplierResolutionError("The selected recommendation is not present in this generated plan. Reload the plan and try again.", 404, "RECOMMENDATION_NOT_FOUND");
  }
  if (matches.length > 1) {
    throw new SupplierResolutionError(
      "This style appears in more than one recommendation. Choose its exact fulfilment centre and current supplier.",
      409,
      "AMBIGUOUS_RECOMMENDATION",
      { candidates: matches.slice(0, 50).map(row => ({ sku: row.sku, styleId: styleOf(row), warehouse: row.warehouse, currentVendor: row.vendor })) },
    );
  }
  return matches[0];
}

function inputValue(raw: Record<string, unknown>, keys: string[], fallback: unknown) {
  for (const key of keys) if (raw[key] !== undefined) return raw[key];
  return fallback;
}

/** Canonicalizes staged supplier details while preserving omitted existing data. */
export function normalizeDraftSupplierMapping(
  raw: Record<string, unknown>,
  context: Pick<Recommendation, "styleId" | "sku" | "productName" | "brand" | "category" | "articleType">,
  current?: VendorMappingRecord,
) {
  const currency = clean(raw.currency);
  if (currency && currency.toUpperCase() !== "INR") {
    throw new SupplierResolutionError("Purchase-order unit cost must be entered in INR.", 422, "NON_INR_SUPPLIER_COST");
  }
  let normalized: VendorMappingInput;
  try {
    normalized = normalizeVendorMappingInput({
      styleId: styleOf(context),
      productName: context.productName ?? current?.productName,
      brand: context.brand ?? current?.brand,
      category: context.category ?? current?.category,
      articleType: context.articleType ?? current?.articleType,
      vendor: inputValue(raw, ["vendor", "supplierName"], current?.vendor),
      supplierEmail: inputValue(raw, ["supplierEmail", "email", "contactEmail"], current?.supplierEmail),
      supplierSku: inputValue(raw, ["supplierSku", "vendorCode"], current?.supplierSku),
      nlc: inputValue(raw, ["nlc", "unitCost", "nlcInr"], current?.nlc),
      hsnCode: inputValue(raw, ["hsnCode"], current?.hsnCode),
      gstRate: inputValue(raw, ["gstRate"], current?.gstRate),
      supplierGstin: inputValue(raw, ["supplierGstin", "gstin"], current?.supplierGstin),
      supplierState: inputValue(raw, ["supplierState", "state"], current?.supplierState),
      leadTimeDays: inputValue(raw, ["leadTimeDays"], current?.leadTimeDays),
      paymentTerms: inputValue(raw, ["paymentTerms"], current?.paymentTerms),
      incoterms: inputValue(raw, ["incoterms"], current?.incoterms),
      moq: inputValue(raw, ["moq"], current?.moq),
      packSize: inputValue(raw, ["packSize"], current?.packSize),
    });
  } catch (error) {
    throw new SupplierResolutionError(error instanceof Error ? error.message : "Supplier details are invalid.", 422, "INVALID_SUPPLIER_DETAILS");
  }
  const missing: string[] = [];
  if (!normalized.vendor) missing.push("supplier name");
  if (normalized.nlc === null) missing.push("positive INR NLC");
  if (missing.length) {
    throw new SupplierResolutionError(
      `Enter ${missing.join(" and ")} before creating the draft PO.`,
      422,
      "SUPPLIER_DETAILS_INCOMPLETE",
      { missing },
    );
  }
  return normalized as VendorMappingInput & { vendor: string; nlc: number };
}

const MAPPING_FIELDS: (keyof VendorMappingInput)[] = [
  "styleId", "productName", "brand", "category", "articleType", "vendor", "supplierEmail", "supplierSku", "nlc",
  "hsnCode", "gstRate", "supplierGstin", "supplierState", "leadTimeDays", "paymentTerms", "incoterms", "moq", "packSize",
];

export function supplierMappingChanged(current: VendorMappingRecord, next: VendorMappingInput) {
  return MAPPING_FIELDS.some(field => {
    const left = current[field];
    const right = next[field];
    if (typeof left === "number" || typeof right === "number") return Number(left) !== Number(right);
    return (left ?? null) !== (right ?? null);
  });
}

function candidatePayload(rows: VendorMappingRecord[]) {
  return rows.map(row => publicVendorMapping(row));
}

export async function getSupplierResolutionContext(db: any, batch: BatchRow, selection: SupplierResolutionSelection) {
  const recommendation = selectSupplierResolutionRecommendation(batch, selection);
  const styleId = styleOf(recommendation);
  const rows = await db`SELECT * FROM supplier_style_mappings WHERE style_id=${styleId} ORDER BY updated_at DESC,vendor NULLS FIRST`;
  const allMappings = rows.map(mappingFromDb) as VendorMappingRecord[];
  const editableBase = allMappings.find(mapping => !mapping.vendor) ?? null;
  const mappings = allMappings.filter(mapping => mapping.vendor);
  return {
    recommendation: {
      sku: recommendation.sku,
      styleId,
      warehouse: recommendation.warehouse,
      currentVendor: recommendation.vendor,
      productName: recommendation.productName ?? null,
      brand: recommendation.brand ?? null,
      suggestedPoQty: recommendation.suggestedPoQty,
      currentNlc: recommendation.unitPrice,
    },
    mappings: candidatePayload(mappings),
    editableBaseMapping: editableBase ? publicVendorMapping(editableBase) : null,
    requiresExplicitSelection: mappings.length > 1,
    canCreateNewSupplier: true,
    replacementNeedsConfirmation: !isPlaceholderSupplier(recommendation.vendor),
  };
}

function mappingOperation(
  candidates: VendorMappingRecord[],
  raw: Record<string, unknown>,
  recommendation: Recommendation,
) {
  const requestedId = clean(raw.mappingId);
  const createNew = raw.createNew === true;
  if (requestedId && createNew) {
    throw new SupplierResolutionError("Choose either an existing mapping or Create new supplier, not both.", 400, "INVALID_SUPPLIER_MAPPING_CHOICE");
  }
  if (createNew) {
    const input = normalizeDraftSupplierMapping(raw, recommendation);
    const inserted = insertableVendorMapping(input, "po_inline_resolution");
    const record: VendorMappingRecord = { ...inserted, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    return { operation: "create" as const, input, record, expectedRevision: 0 };
  }
  const namedCandidates = candidates.filter(candidate => candidate.vendor);
  if (!requestedId && namedCandidates.length > 1) {
    throw new SupplierResolutionError(
      "More than one supplier is mapped to this style. Select the exact supplier mapping before creating a PO.",
      409,
      "AMBIGUOUS_SUPPLIER_MAPPING",
      { candidates: candidatePayload(namedCandidates), editableBaseMapping: candidates.find(candidate => !candidate.vendor) ? publicVendorMapping(candidates.find(candidate => !candidate.vendor)!) : null },
    );
  }
  if (!requestedId && candidates.length > 0) {
    throw new SupplierResolutionError(
      "A governed supplier mapping already exists for this style. Select its current revision before creating the PO.",
      409,
      "SUPPLIER_MAPPING_SELECTION_REQUIRED",
      { candidates: candidatePayload(namedCandidates), editableBaseMapping: candidates.find(candidate => !candidate.vendor) ? publicVendorMapping(candidates.find(candidate => !candidate.vendor)!) : null },
    );
  }
  if (!requestedId) {
    const input = normalizeDraftSupplierMapping(raw, recommendation);
    const inserted = insertableVendorMapping(input, "po_inline_resolution");
    const record: VendorMappingRecord = { ...inserted, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    return { operation: "create" as const, input, record, expectedRevision: 0 };
  }
  const current = candidates.find(candidate => candidate.id === requestedId);
  if (!current) {
    throw new SupplierResolutionError("The selected supplier mapping does not belong to this style. Reload its current mappings.", 409, "SUPPLIER_MAPPING_NOT_APPLICABLE", { candidates: candidatePayload(candidates) });
  }
  const expectedRevision = raw.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1) {
    throw new SupplierResolutionError("Select the current supplier mapping revision before creating the PO.", 409, "SUPPLIER_MAPPING_REVISION_REQUIRED", { mapping: publicVendorMapping(current) });
  }
  if (Number(expectedRevision) !== current.revision) {
    throw new SupplierResolutionError("This supplier mapping changed after you opened it. Reload it before creating the PO.", 409, "STALE_VENDOR_MAPPING_REVISION", { mapping: publicVendorMapping(current) });
  }
  const input = normalizeDraftSupplierMapping(raw, recommendation, current);
  if (current.vendor && !sameText(current.vendor, input.vendor)) {
    throw new SupplierResolutionError(
      "A named supplier mapping cannot be renamed during PO creation. Choose Create new supplier instead.",
      409,
      "CREATE_NEW_SUPPLIER_REQUIRED",
      { mapping: publicVendorMapping(current) },
    );
  }
  const changed = supplierMappingChanged(current, input);
  const revision = changed ? current.revision + 1 : current.revision;
  const record: VendorMappingRecord = {
    ...current,
    ...input,
    mappingKey: vendorMappingKey(input.styleId, input.vendor),
    revision,
    source: changed ? "po_inline_resolution" : current.source,
    updatedAt: changed ? new Date().toISOString() : current.updatedAt,
  };
  return { operation: changed ? "update" as const : "reuse" as const, input, record, expectedRevision: current.revision };
}

function overlaidRecommendation(source: Recommendation, mapping: VendorMappingRecord) {
  // The methodology importer groups model, MRP and NLC under one style-detail
  // quality flag. Inline NLC resolves that flag only when the immutable plan
  // already proves the other two catalogue fields; it must never manufacture
  // missing product identity or MRP.
  const catalogueMetadataIsComplete = Boolean(clean(source.productName))
    && Number.isFinite(Number(source.mrpInr))
    && Number(source.mrpInr) > 0;
  const resolvedCodes = new Set([
    "MISSING_VENDOR",
    "MISSING_PRICE",
    ...(catalogueMetadataIsComplete ? ["MISSING_STYLE_METADATA"] : []),
  ]);
  const exceptions = (source.exceptions ?? []).filter(exception => !resolvedCodes.has(exception.code));
  const leadTimeDays = mapping.leadTimeDays ?? source.leadTimeDays;
  return {
    ...source,
    vendor: mapping.vendor!,
    supplierSku: mapping.supplierSku ?? source.supplierSku,
    unitPrice: mapping.nlc,
    currency: "INR",
    leadTimeDays,
    estimatedValue: roundMoney(Number(mapping.nlc) * source.suggestedPoQty),
    commercialDataProvenance: `StyleFlow supplier mapping master · ${mapping.id} · revision ${mapping.revision}`,
    exceptions,
  } satisfies Recommendation;
}

function overlaidRule(source: Recommendation, mapping: VendorMappingRecord): VendorMasterRow {
  return {
    marketplace: "Myntra",
    vendor: mapping.vendor!,
    sku: source.sku,
    styleId: styleOf(source),
    warehouse: source.warehouse,
    supplierSku: mapping.supplierSku ?? undefined,
    productName: source.productName,
    brand: source.brand,
    category: source.category,
    articleType: source.articleType,
    mrpInr: source.mrpInr,
    unitPrice: mapping.nlc!,
    currency: "INR",
    contactEmail: mapping.supplierEmail ?? undefined,
    hsnCode: mapping.hsnCode ?? undefined,
    gstRate: mapping.gstRate ?? undefined,
    gstin: mapping.supplierGstin ?? undefined,
    supplierState: mapping.supplierState ?? undefined,
    leadTimeDays: mapping.leadTimeDays ?? undefined,
    paymentTerms: mapping.paymentTerms ?? undefined,
    incoterms: mapping.incoterms ?? undefined,
    moq: mapping.moq ?? undefined,
    packSize: mapping.packSize ?? undefined,
    commercialDataProvenance: `StyleFlow supplier mapping master · ${mapping.id} · revision ${mapping.revision}`,
  };
}

function activeRecommendationDuplicate(orders: Record<string, unknown>[], batchId: string, warehouse: string, sku: string) {
  return orders.some(order => clean(order.batch_id) === batchId
    && clean(order.warehouse) === warehouse
    && Array.isArray(order.lines)
    && (order.lines as Record<string, unknown>[]).some(line => clean(line.sku) === sku));
}

export async function resolveSupplierAndCreateDraft(
  db: any,
  batch: BatchRow,
  request: SupplierResolutionRequest,
  actor: SupplierResolutionActor,
) {
  if (batch.status !== "generated") {
    throw new SupplierResolutionError("Only a completed, generated planning run can create purchase orders.", 409, "PLAN_NOT_GENERATED");
  }
  const source = selectSupplierResolutionRecommendation(batch, request.selection);
  const styleId = styleOf(source);
  const mappingRows = await db`SELECT * FROM supplier_style_mappings WHERE style_id=${styleId} ORDER BY updated_at DESC,vendor NULLS FIRST`;
  const candidates = mappingRows.map(mappingFromDb) as VendorMappingRecord[];
  const choice = mappingOperation(candidates, request.mapping, source);
  const mapping = choice.record;

  const sourceVendorIsNamed = !isPlaceholderSupplier(source.vendor);
  if (sourceVendorIsNamed && !sameText(source.vendor, mapping.vendor) && request.replaceNamedSupplier !== true) {
    throw new SupplierResolutionError(
      `This plan names ${source.vendor}. Confirm that you intend to replace it with ${mapping.vendor}.`,
      409,
      "SUPPLIER_REPLACEMENT_CONFIRMATION_REQUIRED",
      { currentVendor: source.vendor, replacementVendor: mapping.vendor },
    );
  }

  const row = overlaidRecommendation(source, mapping);
  const rule = overlaidRule(source, mapping);
  try {
    // Mapping exceptions are resolved by the governed overlay. Inventory,
    // methodology eligibility, positive ask and source-data blocks remain hard.
    assertRecommendationCanBecomePo(row, [rule]);
  } catch (error) {
    throw new SupplierResolutionError(error instanceof Error ? error.message : "This recommendation is not PO-ready.", 409, "RECOMMENDATION_NOT_PO_READY");
  }

  const quantity = Number(request.selection.quantity ?? source.suggestedPoQty);
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 1_000_000_000) {
    throw new SupplierResolutionError("Enter a positive whole-unit PO quantity within the allowed range.", 422, "INVALID_PO_QUANTITY");
  }
  const quantityProblem = executionQuantityProblem(quantity, rule);
  if (quantityProblem) throw new SupplierResolutionError(quantityProblem, 422, "SUPPLIER_QUANTITY_RULE_FAILED");
  const overrideReason = clean(request.selection.overrideReason);
  if (overrideReason.length > 1_000) throw new SupplierResolutionError("The quantity explanation is too long.", 422, "INVALID_OVERRIDE_REASON");
  if (quantity !== source.suggestedPoQty && !overrideReason) {
    throw new SupplierResolutionError("Explain why the quantity differs from the system recommendation.", 422, "OVERRIDE_REASON_REQUIRED");
  }
  if (row.exceptions.some(exception => exception.severity === "critical") && !request.selection.acknowledgeRisk) {
    throw new SupplierResolutionError("Review and acknowledge the remaining urgent risk before creating this draft.", 422, "RISK_ACKNOWLEDGEMENT_REQUIRED");
  }

  const claimKey = recommendationClaimKey(batch.id, row);
  const [claims, priorOrders] = await Promise.all([
    db`SELECT claim_key FROM po_recommendation_claims WHERE claim_key=${claimKey} LIMIT 1`,
    db`SELECT batch_id,warehouse,lines FROM purchase_orders WHERE batch_id=${batch.id}`,
  ]);
  if (claims.length || activeRecommendationDuplicate(priorOrders, batch.id, row.warehouse, row.sku)) {
    throw new SupplierResolutionError("This recommendation was already converted to a purchase order. Open the PO queue instead.", 409, "RECOMMENDATION_ALREADY_CONVERTED");
  }

  const orderDate = todayInIndia();
  const id = randomUUID();
  const poNumber = `MYN-PO-${orderDate.replaceAll("-", "")}-${id.slice(0, 6).toUpperCase()}`;
  const expectedDeliveryDate = operationalExpectedDeliveryDate(row, orderDate);
  const line: PurchaseOrderLine = {
    lineId: randomUUID(),
    sku: row.sku,
    supplierSku: mapping.supplierSku ?? undefined,
    description: [row.brand, row.productName, row.category, `Style ${styleId}`, row.size && `Size ${row.size}`].filter(Boolean).join(" · "),
    quantity,
    receivedQty: 0,
    unitPrice: roundMoney(mapping.nlc!),
    currency: "INR",
    expectedDeliveryDate,
    hsnCode: mapping.hsnCode ?? undefined,
    gstRate: mapping.gstRate ?? 0,
    moq: mapping.moq ?? undefined,
    packSize: mapping.packSize ?? undefined,
    supplierMappingId: mapping.id,
    supplierMappingRevision: mapping.revision,
    sourceRecommendation: {
      dailyRunRate: source.dailyRunRate,
      safetyStock: source.safetyStock,
      inventoryPosition: source.inventoryPosition,
      explanation: source.explanation,
    },
    overrideReason: quantity !== source.suggestedPoQty ? overrideReason : undefined,
  };
  const tax = roundMoney(quantity * line.unitPrice * Number(line.gstRate ?? 0) / 100);
  const totals = calculateTotals([line], 0, 0, tax);
  const mappingAudit = {
    action: choice.operation,
    mappingId: mapping.id,
    mappingRevision: mapping.revision,
    mappingStatus: vendorMappingStatus(mapping),
    sourceBatchId: batch.id,
    sourceStyleId: styleId,
    sourceWarehouse: source.warehouse,
    sourceVendor: source.vendor,
    selectedVendor: mapping.vendor,
    sourceNlcInr: Number.isFinite(Number(source.unitPrice)) ? Number(source.unitPrice) : null,
    selectedNlcInr: mapping.nlc,
    costDeltaInr: Number.isFinite(Number(source.unitPrice)) ? roundMoney(mapping.nlc! - Number(source.unitPrice)) : null,
    actorId: actor.id,
    actor: actor.displayName,
  };
  const operation = choice.operation;
  const expectedRevision = choice.expectedRevision;
  const input = choice.input;
  let result;
  try {
    result = await db`WITH updated_mapping AS (
        UPDATE supplier_style_mappings SET
          mapping_key=${mapping.mappingKey},style_id=${input.styleId},product_name=${input.productName},brand=${input.brand},
          category=${input.category},article_type=${input.articleType},vendor=${input.vendor},supplier_email=${input.supplierEmail},
          supplier_sku=${input.supplierSku},nlc_inr=${input.nlc},hsn_code=${input.hsnCode},gst_rate=${input.gstRate},
          supplier_gstin=${input.supplierGstin},supplier_state=${input.supplierState},lead_time_days=${input.leadTimeDays},
          payment_terms=${input.paymentTerms},incoterms=${input.incoterms},moq=${input.moq},pack_size=${input.packSize},
          mapping_status=${vendorMappingStatus(input)},source='po_inline_resolution',revision=revision+1,
          updated_by_user_id=${actor.id},updated_at=now()
        WHERE ${operation}='update' AND id=${mapping.id} AND revision=${expectedRevision}
        RETURNING *
      ), created_mapping AS (
        INSERT INTO supplier_style_mappings
          (id,mapping_key,style_id,product_name,brand,category,article_type,vendor,supplier_email,supplier_sku,nlc_inr,hsn_code,gst_rate,supplier_gstin,supplier_state,lead_time_days,payment_terms,incoterms,moq,pack_size,mapping_status,source,created_by_user_id,updated_by_user_id)
        SELECT ${mapping.id},${mapping.mappingKey},${input.styleId},${input.productName},${input.brand},${input.category},${input.articleType},${input.vendor},${input.supplierEmail},${input.supplierSku},${input.nlc},${input.hsnCode},${input.gstRate},${input.supplierGstin},${input.supplierState},${input.leadTimeDays},${input.paymentTerms},${input.incoterms},${input.moq},${input.packSize},${vendorMappingStatus(input)},'po_inline_resolution',${actor.id},${actor.id}
        WHERE ${operation}='create'
        ON CONFLICT DO NOTHING
        RETURNING *
      ), reused_mapping AS (
        SELECT * FROM supplier_style_mappings
        WHERE ${operation}='reuse' AND id=${mapping.id} AND revision=${expectedRevision}
        FOR UPDATE
      ), chosen_mapping AS (
        SELECT * FROM updated_mapping UNION ALL SELECT * FROM created_mapping UNION ALL SELECT * FROM reused_mapping
      ), created_po AS (
        INSERT INTO purchase_orders
          (id,po_number,batch_id,vendor,warehouse,status,order_date,expected_delivery_date,currency,payment_terms,incoterms,supplier_email,supplier_gstin,supplier_state,place_of_supply,lines,subtotal,tax,total,created_by,created_by_user_id)
        SELECT ${id},${poNumber},${batch.id},vendor,${row.warehouse},'draft',${orderDate},${expectedDeliveryDate},'INR',payment_terms,incoterms,supplier_email,supplier_gstin,supplier_state,supplier_state,${dbJson([line])}::jsonb,${totals.subtotal},${tax},${totals.total},${actor.displayName},${actor.id}
        FROM chosen_mapping
        RETURNING *
      ), claimed AS (
        INSERT INTO po_recommendation_claims (claim_key,batch_id,purchase_order_id)
        SELECT ${claimKey},${batch.id},id FROM created_po
        RETURNING claim_key
      ), po_audit AS (
        INSERT INTO po_events (purchase_order_id,event_type,actor,payload)
        SELECT id,'created',${actor.displayName},${dbJson({ batchId: batch.id, lineCount: 1, supplierResolution: mappingAudit })}::jsonb FROM created_po
      ), integration_audit AS (
        INSERT INTO integration_runs (integration,direction,status,reference,details)
        SELECT 'supplier_mapping_po_resolution','internal','completed',id,${dbJson(mappingAudit)}::jsonb FROM created_po
      )
      SELECT id,po_number,status,total,(SELECT revision FROM chosen_mapping LIMIT 1)::int AS mapping_revision,
        (SELECT created_at FROM chosen_mapping LIMIT 1) AS mapping_created_at,
        (SELECT updated_at FROM chosen_mapping LIMIT 1) AS mapping_updated_at,
        (SELECT COUNT(*) FROM claimed)::int AS claim_count
      FROM created_po`;
  } catch (error: any) {
    if (error?.code === "23505" && String(error?.constraint ?? "").includes("po_recommendation_claims")) {
      throw new SupplierResolutionError("This recommendation was converted by another session. Open the PO queue instead.", 409, "RECOMMENDATION_ALREADY_CONVERTED");
    }
    if (error?.code === "23505") {
      throw new SupplierResolutionError("Another supplier mapping now uses these style and supplier details. Reload the current mappings.", 409, "SUPPLIER_MAPPING_CONFLICT");
    }
    throw error;
  }
  if (!result.length) {
    const code = operation === "create" ? "SUPPLIER_MAPPING_CONFLICT" : "STALE_VENDOR_MAPPING_REVISION";
    const message = operation === "create"
      ? "A supplier mapping was created by another session. Reload the current mappings."
      : "This supplier mapping changed while the PO was being created. Reload it and try again.";
    throw new SupplierResolutionError(message, 409, code);
  }
  const saved = result[0];
  const responseMapping: VendorMappingRecord = {
    ...mapping,
    revision: Number(saved.mapping_revision),
    createdAt: saved.mapping_created_at,
    updatedAt: saved.mapping_updated_at,
  };
  const missing = vendorMappingIssues(responseMapping);
  return {
    purchaseOrder: {
      id: String(saved.id),
      poNumber: String(saved.po_number),
      status: String(saved.status),
      total: Number(saved.total),
      currency: "INR" as const,
    },
    mapping: publicVendorMapping(responseMapping),
    dispatchReadiness: { ready: missing.length === 0, missing },
    message: missing.length
      ? "Draft PO created. Complete the remaining supplier dispatch details before approval and email."
      : "Supplier mapping saved and draft PO created.",
  };
}
