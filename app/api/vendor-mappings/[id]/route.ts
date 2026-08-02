import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { dbJson, sql } from "@/lib/db";
import { mappingFromDb, normalizeVendorMappingInput, publicVendorMapping, vendorMappingKey, vendorMappingStatus } from "@/lib/vendor-mappings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request, ["admin", "planner"]);
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const expectedRevision = body.expectedRevision;
    if (expectedRevision === undefined || expectedRevision === null) {
      return NextResponse.json({ error: "Reload this mapping before changing it; its edit version is missing.", code: "VENDOR_MAPPING_REVISION_REQUIRED" }, { status: 428 });
    }
    if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision > 2_147_483_646) {
      return NextResponse.json({ error: "Reload this mapping before changing it; its edit version is invalid.", code: "INVALID_VENDOR_MAPPING_REVISION" }, { status: 400 });
    }
    const db = sql();
    const [currentRow] = await db`SELECT * FROM supplier_style_mappings WHERE id=${id}`;
    if (!currentRow) return NextResponse.json({ error: "Supplier mapping not found." }, { status: 404 });
    if (Number(currentRow.revision) !== expectedRevision) return staleMapping();
    const current = mappingFromDb(currentRow);
    const input = normalizeVendorMappingInput({
      styleId: body.styleId ?? current.styleId,
      productName: body.productName === undefined ? current.productName : body.productName,
      brand: body.brand === undefined ? current.brand : body.brand,
      category: body.category === undefined ? current.category : body.category,
      articleType: body.articleType === undefined ? current.articleType : body.articleType,
      vendor: body.vendor === undefined ? current.vendor : body.vendor,
      supplierEmail: body.supplierEmail === undefined ? current.supplierEmail : body.supplierEmail,
      supplierSku: body.supplierSku === undefined ? current.supplierSku : body.supplierSku,
      nlc: body.nlc === undefined ? current.nlc : body.nlc,
      hsnCode: body.hsnCode === undefined ? current.hsnCode : body.hsnCode,
      gstRate: body.gstRate === undefined ? current.gstRate : body.gstRate,
      supplierGstin: body.supplierGstin === undefined ? current.supplierGstin : body.supplierGstin,
      supplierState: body.supplierState === undefined ? current.supplierState : body.supplierState,
      leadTimeDays: body.leadTimeDays === undefined ? current.leadTimeDays : body.leadTimeDays,
      paymentTerms: body.paymentTerms === undefined ? current.paymentTerms : body.paymentTerms,
      incoterms: body.incoterms === undefined ? current.incoterms : body.incoterms,
      moq: body.moq === undefined ? current.moq : body.moq,
      packSize: body.packSize === undefined ? current.packSize : body.packSize,
    });
    const changedFields = Object.keys(body).filter(key => key !== "expectedRevision");
    const rows = await db`WITH updated AS (
        UPDATE supplier_style_mappings SET
          mapping_key=${vendorMappingKey(input.styleId,input.vendor)},style_id=${input.styleId},product_name=${input.productName},
          brand=${input.brand},category=${input.category},article_type=${input.articleType},vendor=${input.vendor},
          supplier_email=${input.supplierEmail},supplier_sku=${input.supplierSku},nlc_inr=${input.nlc},hsn_code=${input.hsnCode},
          gst_rate=${input.gstRate},supplier_gstin=${input.supplierGstin},supplier_state=${input.supplierState},
          lead_time_days=${input.leadTimeDays},payment_terms=${input.paymentTerms},incoterms=${input.incoterms},
          moq=${input.moq},pack_size=${input.packSize},mapping_status=${vendorMappingStatus(input)},source='manual',revision=revision+1,
          updated_by_user_id=${user.id},updated_at=now()
        WHERE id=${id} AND revision=${expectedRevision}
        RETURNING *
      ), audited AS (
        INSERT INTO integration_runs (integration,direction,status,reference,details)
        SELECT 'supplier_mapping_master','internal','completed',id,
          ${dbJson({ action: "updated", actorId: user.id, actor: user.displayName, priorRevision: expectedRevision, changedFields })}::jsonb
        FROM updated
      )
      SELECT * FROM updated`;
    if (!rows.length) return staleMapping();
    return NextResponse.json({ mapping: publicVendorMapping(rows[0]) });
  } catch (error: any) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error?.code === "23505") return NextResponse.json({ error: "This style and supplier mapping already exists." }, { status: 409 });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "The mapping request is not valid JSON." }, { status: 400 });
    if (error instanceof Error && /^(Style ID|Vendor|Supplier|Product|Brand|Category|Article|NLC|HSN|GST|Lead|Payment|Incoterms|MOQ|Pack)/.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error(error);
    return NextResponse.json({ error: "Could not update the supplier mapping." }, { status: 500 });
  }
}

function staleMapping() {
  return NextResponse.json({
    error: "This mapping changed after you opened it. Reload the latest version before saving again.",
    code: "STALE_VENDOR_MAPPING_REVISION",
  }, { status: 409 });
}
