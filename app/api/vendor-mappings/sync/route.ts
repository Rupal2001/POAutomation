import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { dbJson, sql } from "@/lib/db";
import {
  insertableVendorMapping,
  normalizeVendor,
  normalizeVendorMappingInput,
  vendorMappingStatus,
  type VendorMappingInput,
} from "@/lib/vendor-mappings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request, ["admin", "planner"]);
    const text = await request.text();
    const body = text ? JSON.parse(text) as Record<string, unknown> : {};
    const requestedBatchId = String(body.batchId ?? "").trim();
    const db = sql();
    const batches = requestedBatchId
      ? await db`SELECT * FROM batches WHERE id=${requestedBatchId} AND status <> 'archived' LIMIT 1`
      : await db`SELECT * FROM batches WHERE status IN ('uploaded','generated') ORDER BY created_at DESC LIMIT 1`;
    const batch = batches[0];
    if (!batch) return NextResponse.json({ error: requestedBatchId ? "The selected plan was not found." : "Create or upload a plan before bringing styles into the mapping master." }, { status: 404 });

    const discovered = discoverMappings(batch);
    if (!discovered.length) return NextResponse.json({ error: "The selected plan contains no style rows to map." }, { status: 409 });
    const source = `plan_sync:${batch.id}`;
    const incoming = discovered.map(mapping => ({
      ...insertableVendorMapping(mapping, source),
      mappingStatus: vendorMappingStatus(mapping),
    }));
    const payload = incoming.map(row => ({
      id: row.id, mapping_key: row.mappingKey, style_id: row.styleId, product_name: row.productName,
      brand: row.brand, category: row.category, article_type: row.articleType, vendor: row.vendor,
      supplier_email: row.supplierEmail, supplier_sku: row.supplierSku, nlc_inr: row.nlc,
      hsn_code: row.hsnCode, gst_rate: row.gstRate, supplier_gstin: row.supplierGstin,
      supplier_state: row.supplierState, lead_time_days: row.leadTimeDays,
      payment_terms: row.paymentTerms, incoterms: row.incoterms, moq: row.moq,
      pack_size: row.packSize, mapping_status: row.mappingStatus, source,
    }));
    const audit = {
      action: "sync_missing_from_plan",
      actorId: user.id,
      actor: user.displayName,
      sourceBatchId: String(batch.id),
      discovered: incoming.length,
      noOverwrite: true,
    };
    const inserted = await db`WITH incoming AS (
        SELECT * FROM jsonb_to_recordset(${dbJson(payload)}::jsonb) AS value(
          id text,mapping_key text,style_id text,product_name text,brand text,category text,article_type text,
          vendor text,supplier_email text,supplier_sku text,nlc_inr numeric,hsn_code text,gst_rate numeric,
          supplier_gstin text,supplier_state text,lead_time_days integer,payment_terms text,incoterms text,
          moq integer,pack_size integer,mapping_status text,source text
        )
      ), added AS (
        INSERT INTO supplier_style_mappings
          (id,mapping_key,style_id,product_name,brand,category,article_type,vendor,supplier_email,supplier_sku,nlc_inr,hsn_code,gst_rate,supplier_gstin,supplier_state,lead_time_days,payment_terms,incoterms,moq,pack_size,mapping_status,source,created_by_user_id,updated_by_user_id)
        SELECT id,mapping_key,style_id,product_name,brand,category,article_type,vendor,supplier_email,supplier_sku,nlc_inr,hsn_code,gst_rate,supplier_gstin,supplier_state,lead_time_days,payment_terms,incoterms,moq,pack_size,mapping_status,source,${user.id},${user.id}
        FROM incoming
        ON CONFLICT (mapping_key) DO NOTHING
        RETURNING id,mapping_key
      ), audited AS (
        INSERT INTO integration_runs (integration,direction,status,reference,details)
        VALUES ('supplier_mapping_master','internal','completed',${String(batch.id)},${dbJson(audit)}::jsonb)
      )
      SELECT id,mapping_key FROM added`;
    return NextResponse.json({
      ok: true,
      batch: { id: String(batch.id), label: batch.label ? String(batch.label) : "Planning run", status: String(batch.status) },
      summary: { discovered: incoming.length, inserted: inserted.length, alreadyPresent: incoming.length - inserted.length },
      noOverwrite: true,
      message: inserted.length
        ? `${inserted.length.toLocaleString("en-IN")} missing style/supplier mapping row(s) were brought in. Existing mappings were not changed.`
        : "Every style/supplier row from this plan is already in the mapping master; nothing was overwritten.",
    }, { status: inserted.length ? 201 : 200 });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "The mapping sync request is not valid JSON." }, { status: 400 });
    console.error(error);
    return NextResponse.json({ error: "Could not bring plan styles into the mapping master. No existing mapping was changed." }, { status: 500 });
  }
}

function discoverMappings(batch: Record<string, unknown>) {
  const vendorRows = Array.isArray(batch.vendor_master_data) ? batch.vendor_master_data as Record<string, unknown>[] : [];
  const recommendations = Array.isArray(batch.recommendations) ? batch.recommendations as Record<string, unknown>[] : [];
  const sales = Array.isArray(batch.sales_data) ? batch.sales_data as Record<string, unknown>[] : [];
  const byKey = new Map<string, VendorMappingInput>();
  const realSupplierStyles = new Set(vendorRows.filter(row => normalizeVendor(row.vendor)).map(styleOf).filter(Boolean));

  const add = (row: Record<string, unknown>, sourcePriority: "master" | "fallback") => {
    const styleId = styleOf(row);
    if (!styleId) return;
    let vendor = normalizeVendor(row.vendor);
    if (!vendor && sourcePriority === "fallback" && realSupplierStyles.has(styleId)) return;
    const sanitized = sanitizeSnapshotRow(row, styleId, vendor);
    const key = `${styleId.toLocaleLowerCase("en-IN")}::::${(vendor ?? "").toLocaleLowerCase("en-IN")}`;
    const prior = byKey.get(key);
    byKey.set(key, prior ? mergeMissing(prior, sanitized) : sanitized);
  };
  for (const row of vendorRows) add(row, "master");
  for (const row of recommendations) add(row, "fallback");
  for (const row of sales) add(row, "fallback");
  return [...byKey.values()];
}

function styleOf(row: Record<string, unknown>) {
  return String(row.styleId || row.sku || "").trim().slice(0, 100);
}

function text(value: unknown, maximum: number) {
  const clean = String(value ?? "").trim();
  return clean ? clean.slice(0, maximum) : null;
}

function number(value: unknown, minimum: number, maximum: number, integer = false) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum && (!integer || Number.isSafeInteger(parsed)) ? parsed : null;
}

function sanitizeSnapshotRow(row: Record<string, unknown>, styleId: string, vendor: string | null) {
  const email = text(row.contactEmail ?? row.supplierEmail, 254);
  const hsnCode = text(row.hsnCode, 8);
  const gstin = text(row.gstin ?? row.supplierGstin, 15)?.toUpperCase() ?? null;
  return normalizeVendorMappingInput({
    styleId,
    productName: text(row.productName, 500),
    brand: text(row.brand, 200),
    category: text(row.category, 200),
    articleType: text(row.articleType, 200),
    vendor,
    supplierEmail: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
    supplierSku: text(row.supplierSku, 200),
    nlc: number(row.unitPrice ?? row.nlc, Number.MIN_VALUE, 1_000_000_000),
    hsnCode: hsnCode && /^\d{4,8}$/.test(hsnCode) ? hsnCode : null,
    gstRate: number(row.gstRate, 0, 100),
    supplierGstin: gstin && /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin) ? gstin : null,
    supplierState: text(row.supplierState, 100),
    leadTimeDays: number(row.leadTimeDays, 0, 3_650, true),
    paymentTerms: text(row.paymentTerms, 300),
    incoterms: text(row.incoterms, 100),
    moq: number(row.moq, 1, 1_000_000_000, true),
    packSize: number(row.packSize, 1, 1_000_000_000, true),
  });
}

function mergeMissing(primary: VendorMappingInput, fallback: VendorMappingInput): VendorMappingInput {
  return Object.fromEntries(Object.entries(primary).map(([key, value]) => [key, value ?? fallback[key as keyof VendorMappingInput]])) as unknown as VendorMappingInput;
}
