import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { dbJson, sql } from "@/lib/db";
import { parseVendorMappingFile, VendorMappingFileError } from "@/lib/vendor-mapping-files";
import { insertableVendorMapping, vendorMappingStatus } from "@/lib/vendor-mappings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request, ["admin", "planner"]);
    const form = await request.formData();
    const files = form.getAll("file").filter((value): value is File => value instanceof File && Boolean(value.name));
    if (files.length !== 1) return NextResponse.json({ error: "Choose exactly one CSV or XLSX mapping file." }, { status: 400 });
    const file = files[0];
    const parsed = await parseVendorMappingFile(await file.arrayBuffer(), file.name);
    const source = `import:${file.name}`.slice(0, 100);
    const incoming = parsed.rows.map(row => ({
      ...insertableVendorMapping(row, source),
      mappingStatus: vendorMappingStatus(row),
    }));
    const keys = incoming.map(row => row.mappingKey);
    const db = sql();
    const existingRows = await db`SELECT mapping_key FROM supplier_style_mappings
      WHERE mapping_key IN (SELECT jsonb_array_elements_text(${dbJson(keys)}::jsonb))`;
    const existing = new Set(existingRows.map((row: { mapping_key: string }) => row.mapping_key));
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
      action: "bulk_upsert",
      actorId: user.id,
      actor: user.displayName,
      fileName: file.name,
      report: parsed.report,
    };
    const changed = await db`WITH incoming AS (
        SELECT * FROM jsonb_to_recordset(${dbJson(payload)}::jsonb) AS value(
          id text,mapping_key text,style_id text,product_name text,brand text,category text,article_type text,
          vendor text,supplier_email text,supplier_sku text,nlc_inr numeric,hsn_code text,gst_rate numeric,
          supplier_gstin text,supplier_state text,lead_time_days integer,payment_terms text,incoterms text,
          moq integer,pack_size integer,mapping_status text,source text
        )
      ), upserted AS (
        INSERT INTO supplier_style_mappings
          (id,mapping_key,style_id,product_name,brand,category,article_type,vendor,supplier_email,supplier_sku,nlc_inr,hsn_code,gst_rate,supplier_gstin,supplier_state,lead_time_days,payment_terms,incoterms,moq,pack_size,mapping_status,source,created_by_user_id,updated_by_user_id)
        SELECT id,mapping_key,style_id,product_name,brand,category,article_type,vendor,supplier_email,supplier_sku,nlc_inr,hsn_code,gst_rate,supplier_gstin,supplier_state,lead_time_days,payment_terms,incoterms,moq,pack_size,mapping_status,source,${user.id},${user.id}
        FROM incoming
        ON CONFLICT (mapping_key) DO UPDATE SET
          style_id=EXCLUDED.style_id,product_name=EXCLUDED.product_name,brand=EXCLUDED.brand,category=EXCLUDED.category,
          article_type=EXCLUDED.article_type,vendor=EXCLUDED.vendor,supplier_email=EXCLUDED.supplier_email,
          supplier_sku=EXCLUDED.supplier_sku,nlc_inr=EXCLUDED.nlc_inr,hsn_code=EXCLUDED.hsn_code,
          gst_rate=EXCLUDED.gst_rate,supplier_gstin=EXCLUDED.supplier_gstin,supplier_state=EXCLUDED.supplier_state,
          lead_time_days=EXCLUDED.lead_time_days,payment_terms=EXCLUDED.payment_terms,incoterms=EXCLUDED.incoterms,
          moq=EXCLUDED.moq,pack_size=EXCLUDED.pack_size,mapping_status=EXCLUDED.mapping_status,source=EXCLUDED.source,
          revision=supplier_style_mappings.revision+1,updated_by_user_id=${user.id},updated_at=now()
        RETURNING id,mapping_key
      ), audited AS (
        INSERT INTO integration_runs (integration,direction,status,reference,details)
        SELECT 'supplier_mapping_master','inbound','completed',${file.name},${dbJson(audit)}::jsonb
        WHERE EXISTS (SELECT 1 FROM upserted)
      )
      SELECT id,mapping_key FROM upserted`;
    const created = keys.filter(key => !existing.has(key)).length;
    return NextResponse.json({
      ok: true,
      summary: {
        inputRows: parsed.report.inputRows,
        acceptedRows: changed.length,
        created,
        updated: changed.length - created,
        duplicateRowsCollapsed: parsed.report.duplicateRowsCollapsed,
      },
      report: parsed.report,
    }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof VendorMappingFileError) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error(error);
    return NextResponse.json({ error: "Could not import the supplier mapping file. No partial import was committed." }, { status: 500 });
  }
}
