import { createHash, randomUUID } from "node:crypto";
import { BatchRow, dbJson } from "./db";
import type { Recommendation, VendorMasterRow } from "./po-engine";
import { PurchaseOrderLine, calculateTotals, roundMoney } from "./purchase-orders";
import { assertRecommendationCanBecomePo } from "./recommendation-review";
import { todayInIndia } from "./po-readiness";

export interface PoSelection {
  vendor: string;
  sku: string;
  warehouse?: string;
  quantity?: number;
  overrideReason?: string;
  acknowledgeRisk?: boolean;
}

export interface PoCreator {
  displayName: string;
  userId: string | null;
}

function addIsoDays(date: string, days: number) {
  const timestamp = Date.parse(`${date}T00:00:00Z`) + Math.max(0, Math.ceil(days)) * 86_400_000;
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function operationalExpectedDeliveryDate(
  recommendation: Pick<Recommendation, "expectedDeliveryDate" | "leadTimeDays">,
  orderDate = todayInIndia(),
) {
  const leadTime = Number.isFinite(Number(recommendation.leadTimeDays)) ? Number(recommendation.leadTimeDays) : 0;
  const minimum = addIsoDays(orderDate, leadTime);
  const suggested = String(recommendation.expectedDeliveryDate ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(suggested) && suggested > minimum ? suggested : minimum;
}

function ruleSpecificity(rule: VendorMasterRow) {
  return (rule.sku || rule.styleId ? 1 : 0) + (rule.warehouse ? 1 : 0);
}

export function effectiveVendorRule(
  row: Pick<Recommendation, "vendor" | "sku" | "styleId" | "warehouse">,
  vendorMaster: VendorMasterRow[],
) {
  const rules = vendorMaster
    .filter(rule => rule.vendor === row.vendor)
    .filter(rule => !rule.sku && !rule.styleId || rule.sku === row.sku || rule.sku === row.styleId || rule.styleId === row.styleId)
    .filter(rule => !rule.warehouse || rule.warehouse === row.warehouse)
    .sort((left, right) => ruleSpecificity(left) - ruleSpecificity(right));
  return Object.assign({} as VendorMasterRow, ...rules);
}

/** Execution controls do not change the signed/actionable methodology output. */
export function executionQuantityProblem(quantity: number, rule: Pick<VendorMasterRow, "moq" | "packSize">) {
  const moq = Number(rule.moq ?? 0);
  if (Number.isSafeInteger(moq) && moq > 0 && quantity < moq) {
    return `Order quantity must be at least the mapped MOQ of ${moq.toLocaleString("en-IN")} units.`;
  }
  const packSize = Number(rule.packSize ?? 0);
  if (Number.isSafeInteger(packSize) && packSize > 0 && quantity % packSize !== 0) {
    return `Order quantity must be a multiple of the mapped pack size of ${packSize.toLocaleString("en-IN")} units.`;
  }
  return null;
}

export function recommendationClaimKey(batchId: string, row: Pick<Recommendation, "warehouse" | "sku"> & { vendor?: string }) {
  // Supplier identity is deliberately excluded. A planner must not be able to
  // convert the same immutable demand recommendation twice merely by choosing
  // supplier B after an order was already raised with supplier A.
  const identity = `${batchId}::::${row.warehouse}::::${row.sku}`;
  return `recommendation:${createHash("sha256").update(identity).digest("hex")}`;
}

/** Matches the PostgreSQL jsonb_to_recordset column name exactly. */
export function recommendationClaimRecord(batchId: string, row: Pick<Recommendation, "warehouse" | "sku"> & { vendor?: string }) {
  return { claim_key: recommendationClaimKey(batchId, row) };
}

export async function createDraftPurchaseOrders(
  db: any,
  batch: BatchRow,
  selections: PoSelection[],
  creator: PoCreator | string = "Planner"
) {
  const createdBy = typeof creator === "string" ? creator : creator.displayName;
  const createdByUserId = typeof creator === "string" ? null : creator.userId;
  const orderDate = todayInIndia();
  const recommendations = (batch.recommendations ?? []) as Recommendation[];
  const vendorMaster = (batch.vendor_master_data ?? []) as VendorMasterRow[];
  if (!Array.isArray(selections) || !selections.length || selections.length > 2_000) {
    throw new Error("Select between 1 and 2,000 recommendation lines.");
  }
  const selectionKeys = new Set<string>();
  const selected = selections.map(selection => {
    const selectionKey = `${selection.vendor}::::${selection.warehouse || "MAIN"}::::${selection.sku}`;
    if (selectionKeys.has(selectionKey)) throw new Error(`Recommendation ${selection.sku} was selected more than once.`);
    selectionKeys.add(selectionKey);
    const row = recommendations.find(r => r.vendor === selection.vendor && r.sku === selection.sku && r.warehouse === (selection.warehouse || "MAIN"));
    if (!row) throw new Error(`Recommendation not found: ${String(selection.sku).slice(0, 200)}`);
    assertRecommendationCanBecomePo(row, vendorMaster);
    const selectedQty = Number(selection.quantity ?? row.suggestedPoQty);
    if (!Number.isSafeInteger(selectedQty) || selectedQty <= 0 || selectedQty > 1_000_000_000) throw new Error(`Enter a positive whole-unit quantity within the allowed range for ${selection.sku}.`);
    const rule = effectiveVendorRule(row, vendorMaster);
    const quantityProblem = executionQuantityProblem(selectedQty, rule);
    if (quantityProblem) throw new Error(`${quantityProblem} Adjust ${selection.sku} before creating its draft; the methodology recommendation remains unchanged.`);
    if (row.unitPrice === null || !Number.isFinite(Number(row.unitPrice)) || Number(row.unitPrice) <= 0) throw new Error(`Add a valid INR unit cost before creating a PO for ${selection.sku}.`);
    if (row.exceptions?.some(exception => exception.severity === "critical") && !selection.acknowledgeRisk) throw new Error(`Review and acknowledge the urgent risk for ${selection.sku} before creating its draft.`);
    if (String(selection.overrideReason ?? "").length > 1_000) throw new Error(`The quantity explanation for ${selection.sku} is too long.`);
    if (selectedQty !== row.suggestedPoQty && !selection.overrideReason?.trim()) throw new Error(`Explain why the quantity for ${selection.sku} differs from the system recommendation.`);
    return { ...row, selectedQty, overrideReason: selection.overrideReason?.trim() };
  }).filter(row => row.selectedQty > 0);
  if (!selected.length) throw new Error("Selected quantities must be above zero.");

  const claimKeys = selected.map(row => recommendationClaimKey(batch.id, row));
  const claimed = await db`SELECT claim_key FROM po_recommendation_claims
    WHERE claim_key IN (SELECT jsonb_array_elements_text(${dbJson(claimKeys)}::jsonb)) LIMIT 1`;
  if (claimed.length) throw new Error("One or more selected recommendations were already converted to a purchase order. Reload the plan and open the PO queue.");

  // A recommendation may be converted once while its earlier PO remains active.
  // This keeps retries and repeat clicks from silently double-ordering stock.
  const existingOrders = await db`SELECT batch_id,warehouse,lines FROM purchase_orders WHERE batch_id=${batch.id}`;
  const existingKeys = new Set<string>();
  for (const order of existingOrders) for (const line of (order.lines ?? [])) existingKeys.add(`${order.batch_id}::::${order.warehouse}::::${line.sku}`);
  const duplicate = selected.find(row => existingKeys.has(`${batch.id}::::${row.warehouse}::::${row.sku}`));
  if (duplicate) throw new Error(`A live purchase order already exists for ${duplicate.sku} from this planning run. Open the PO queue instead of creating a duplicate.`);

  const groups = new Map<string, typeof selected>();
  for (const row of selected) {
    const groupKey = `${row.vendor}::::${row.warehouse}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), row]);
  }
  const preparedOrders: {
    id: string; po_number: string; batch_id: string; vendor: string; warehouse: string;
    order_date: string; expected_delivery_date: string; currency: "INR";
    payment_terms: string | null; incoterms: string | null; supplier_email: string | null;
    supplier_gstin: string | null; supplier_state: string | null; place_of_supply: string | null;
    lines: PurchaseOrderLine[]; subtotal: number; tax: number; total: number;
    created_by: string; created_by_user_id: string | null; audit_payload: Record<string, unknown>;
  }[] = [];
  const preparedClaims: { claim_key: string; batch_id: string; purchase_order_id: string }[] = [];
  for (const rows of groups.values()) {
    const first = rows[0]; const id = randomUUID();
    const poNumber = `MYN-PO-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${id.slice(0, 6).toUpperCase()}`;
    const ruleFor = (row: typeof first) => effectiveVendorRule(row, vendorMaster);
    const lines: PurchaseOrderLine[] = rows.map(row => { const rule = ruleFor(row); return ({
      lineId: randomUUID(), sku: row.sku, supplierSku: row.supplierSku, description: [row.brand, row.productName, row.category, (row.styleId || row.sku) && `Style ${row.styleId || row.sku}`, row.size && `Size ${row.size}`].filter(Boolean).join(" · "),
      quantity: row.selectedQty, receivedQty: 0, unitPrice: roundMoney(row.unitPrice ?? 0), currency: "INR", expectedDeliveryDate: operationalExpectedDeliveryDate(row, orderDate), hsnCode: rule.hsnCode, gstRate: rule.gstRate ?? 0,
      moq: rule.moq, packSize: rule.packSize,
      sourceRecommendation: { dailyRunRate: row.dailyRunRate, safetyStock: row.safetyStock, inventoryPosition: row.inventoryPosition, explanation: row.explanation },
      overrideReason: row.selectedQty !== row.suggestedPoQty ? row.overrideReason : undefined,
    }); });
    const tax = roundMoney(lines.reduce((sum,line)=>sum + line.quantity * line.unitPrice * (line.gstRate ?? 0) / 100, 0));
    const totals = calculateTotals(lines, 0, 0, tax);
    const vm = ruleFor(first);
    const expectedDeliveryDate = lines.map(line => line.expectedDeliveryDate).filter((date): date is string => Boolean(date)).sort().at(-1) ?? orderDate;
    preparedOrders.push({
      id,
      po_number: poNumber,
      batch_id: batch.id,
      vendor: first.vendor,
      warehouse: first.warehouse,
      order_date: orderDate,
      expected_delivery_date: expectedDeliveryDate,
      currency: "INR",
      payment_terms: vm?.paymentTerms ?? null,
      incoterms: vm?.incoterms ?? null,
      supplier_email: vm?.contactEmail ?? null,
      supplier_gstin: vm?.gstin ?? null,
      supplier_state: vm?.supplierState ?? null,
      place_of_supply: vm?.supplierState ?? null,
      lines,
      subtotal: totals.subtotal,
      tax,
      total: totals.total,
      created_by: createdBy,
      created_by_user_id: createdByUserId,
      audit_payload: { batchId: batch.id, lineCount: lines.length },
    });
    preparedClaims.push(...rows.map(row => ({
      ...recommendationClaimRecord(batch.id, row),
      batch_id: batch.id,
      purchase_order_id: id,
    })));
  }

  // Every supplier/FC group from one user action is persisted by one SQL
  // statement. PostgreSQL rolls back all mapping-independent PO inserts,
  // claims and audits if any claim loses a concurrent primary-key race.
  try {
    const persisted = await db`WITH input_orders AS (
        SELECT * FROM jsonb_to_recordset(${dbJson(preparedOrders)}::jsonb) AS value(
          id text,po_number text,batch_id text,vendor text,warehouse text,order_date date,
          expected_delivery_date date,currency text,payment_terms text,incoterms text,
          supplier_email text,supplier_gstin text,supplier_state text,place_of_supply text,
          lines jsonb,subtotal numeric,tax numeric,total numeric,created_by text,
          created_by_user_id text,audit_payload jsonb
        )
      ), created AS (
        INSERT INTO purchase_orders
          (id,po_number,batch_id,vendor,warehouse,status,order_date,expected_delivery_date,currency,payment_terms,incoterms,supplier_email,supplier_gstin,supplier_state,place_of_supply,lines,subtotal,tax,total,created_by,created_by_user_id)
        SELECT id,po_number,batch_id,vendor,warehouse,'draft',order_date,expected_delivery_date,currency,
          payment_terms,incoterms,supplier_email,supplier_gstin,supplier_state,place_of_supply,lines,
          subtotal,tax,total,created_by,created_by_user_id
        FROM input_orders
        RETURNING id
      ), input_claims AS (
        SELECT * FROM jsonb_to_recordset(${dbJson(preparedClaims)}::jsonb)
          AS value(claim_key text,batch_id text,purchase_order_id text)
      ), claimed AS (
        INSERT INTO po_recommendation_claims (claim_key,batch_id,purchase_order_id)
        SELECT claim.claim_key,claim.batch_id,claim.purchase_order_id
        FROM input_claims claim
        JOIN created ON created.id=claim.purchase_order_id
        RETURNING claim_key
      ), audited AS (
        INSERT INTO po_events (purchase_order_id,event_type,actor,payload)
        SELECT created.id,'created',input_orders.created_by,input_orders.audit_payload
        FROM created JOIN input_orders ON input_orders.id=created.id
      )
      SELECT created.id,(SELECT COUNT(*) FROM claimed)::int AS claim_count FROM created`;
    if (persisted.length !== preparedOrders.length
      || Number(persisted[0]?.claim_count ?? 0) !== preparedClaims.length) {
      throw new Error("StyleFlow could not verify every requested PO group and recommendation claim.");
    }
  } catch (error: any) {
    if (error?.code === "23505" && String(error?.constraint ?? "").includes("po_recommendation_claims")) {
      throw new Error("A selected recommendation was converted by another session. Reload the plan and open the PO queue.");
    }
    throw error;
  }
  return preparedOrders.map(order => ({ id: order.id, poNumber: order.po_number, total: order.total }));
}
