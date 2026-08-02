import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { dbJson, sql } from "@/lib/db";
import {
  insertableVendorMapping,
  mappingFromDb,
  normalizeVendorMappingInput,
  publicVendorMapping,
  vendorMappingStatus,
} from "@/lib/vendor-mappings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const query = request.nextUrl.searchParams;
    const q = String(query.get("q") ?? "").trim().slice(0, 100);
    const status = String(query.get("status") ?? "").trim();
    const brand = String(query.get("brand") ?? "").trim().slice(0, 200);
    const category = String(query.get("category") ?? "").trim().slice(0, 200);
    const vendor = String(query.get("vendor") ?? "").trim().slice(0, 200);
    if (status && !["mapped", "incomplete", "unmapped"].includes(status)) {
      return NextResponse.json({ error: "Choose mapped, incomplete or unmapped status." }, { status: 400 });
    }
    const page = positiveQueryInteger(query.get("page"), 1, 1_000_000);
    const limit = positiveQueryInteger(query.get("limit"), 50, 100);
    const offset = (page - 1) * limit;
    const like = `%${escapeLike(q)}%`;
    const db = sql();
    const [rows, countRows, summaryRows, brandRows, categoryRows, vendorRows, latestPlanRows] = await Promise.all([
      db`SELECT * FROM supplier_style_mappings
        WHERE (${q}='' OR style_id ILIKE ${like} ESCAPE '\\' OR COALESCE(product_name,'') ILIKE ${like} ESCAPE '\\'
          OR COALESCE(vendor,'') ILIKE ${like} ESCAPE '\\' OR COALESCE(supplier_sku,'') ILIKE ${like} ESCAPE '\\')
          AND (${brand}='' OR brand=${brand})
          AND (${category}='' OR category=${category})
          AND (${vendor}='' OR vendor=${vendor})
          AND (${status}='' OR mapping_status=${status})
        ORDER BY updated_at DESC,style_id ASC,vendor ASC NULLS FIRST
        LIMIT ${limit} OFFSET ${offset}`,
      db`SELECT COUNT(*)::int AS count FROM supplier_style_mappings
        WHERE (${q}='' OR style_id ILIKE ${like} ESCAPE '\\' OR COALESCE(product_name,'') ILIKE ${like} ESCAPE '\\'
          OR COALESCE(vendor,'') ILIKE ${like} ESCAPE '\\' OR COALESCE(supplier_sku,'') ILIKE ${like} ESCAPE '\\')
          AND (${brand}='' OR brand=${brand})
          AND (${category}='' OR category=${category})
          AND (${vendor}='' OR vendor=${vendor})
          AND (${status}='' OR mapping_status=${status})`,
      db`SELECT COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE mapping_status='mapped')::int AS mapped,
          COUNT(*) FILTER (WHERE mapping_status='incomplete')::int AS incomplete,
          COUNT(*) FILTER (WHERE mapping_status='unmapped')::int AS unmapped,
          COUNT(DISTINCT style_id)::int AS styles,
          COUNT(DISTINCT vendor) FILTER (WHERE vendor IS NOT NULL)::int AS vendors,
          MAX(updated_at) AS last_updated_at
        FROM supplier_style_mappings`,
      db`SELECT DISTINCT brand AS value FROM supplier_style_mappings WHERE brand IS NOT NULL ORDER BY brand LIMIT 500`,
      db`SELECT DISTINCT category AS value FROM supplier_style_mappings WHERE category IS NOT NULL ORDER BY category LIMIT 500`,
      db`SELECT DISTINCT vendor AS value FROM supplier_style_mappings WHERE vendor IS NOT NULL ORDER BY vendor LIMIT 500`,
      db`SELECT id,label,status,created_at FROM batches
        WHERE status IN ('uploaded','generated')
        ORDER BY created_at DESC LIMIT 1`,
    ]);
    const total = Number(countRows[0]?.count ?? 0);
    const summary = summaryRows[0] ?? {};
    return NextResponse.json({
      mappings: rows.map((row: Record<string, unknown>) => publicVendorMapping(row)),
      summary: {
        total: Number(summary.total ?? 0),
        mapped: Number(summary.mapped ?? 0),
        incomplete: Number(summary.incomplete ?? 0),
        unmapped: Number(summary.unmapped ?? 0),
        ready: Number(summary.mapped ?? 0),
        styles: Number(summary.styles ?? 0),
        vendors: Number(summary.vendors ?? 0),
        lastUpdatedAt: summary.last_updated_at ?? null,
      },
      filters: {
        brands: brandRows.map((row: { value: string }) => row.value),
        categories: categoryRows.map((row: { value: string }) => row.value),
        vendors: vendorRows.map((row: { value: string }) => row.value),
        statuses: ["mapped", "incomplete", "unmapped"],
      },
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      permissions: {
        canEdit: user.role === "admin" || user.role === "planner",
        canImport: user.role === "admin" || user.role === "planner",
        canExport: true,
      },
      latestPlan: latestPlanRows[0] ? {
        id: String(latestPlanRows[0].id),
        label: latestPlanRows[0].label ? String(latestPlanRows[0].label) : "Planning run",
        status: String(latestPlanRows[0].status),
        createdAt: latestPlanRows[0].created_at,
      } : null,
      application: {
        endpoint: "/api/generate",
        method: "POST",
        body: latestPlanRows[0] ? { batchId: String(latestPlanRows[0].id) } : null,
        behavior: "Creates a versioned run when the selected plan is already generated.",
      },
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiError(error, "Could not load the supplier mapping master.");
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request, ["admin", "planner"]);
    const body = await request.json() as Record<string, unknown>;
    const input = normalizeVendorMappingInput(body);
    const mapping = insertableVendorMapping(input);
    const db = sql();
    const rows = await db`WITH created AS (
        INSERT INTO supplier_style_mappings
          (id,mapping_key,style_id,product_name,brand,category,article_type,vendor,supplier_email,supplier_sku,nlc_inr,hsn_code,gst_rate,supplier_gstin,supplier_state,lead_time_days,payment_terms,incoterms,moq,pack_size,mapping_status,source,created_by_user_id,updated_by_user_id)
        VALUES
          (${mapping.id},${mapping.mappingKey},${mapping.styleId},${mapping.productName},${mapping.brand},${mapping.category},${mapping.articleType},${mapping.vendor},${mapping.supplierEmail},${mapping.supplierSku},${mapping.nlc},${mapping.hsnCode},${mapping.gstRate},${mapping.supplierGstin},${mapping.supplierState},${mapping.leadTimeDays},${mapping.paymentTerms},${mapping.incoterms},${mapping.moq},${mapping.packSize},${vendorMappingStatus(mapping)},'manual',${user.id},${user.id})
        RETURNING *
      ), audited AS (
        INSERT INTO integration_runs (integration,direction,status,reference,details)
        SELECT 'supplier_mapping_master','internal','completed',id,
          ${dbJson({ action: "created", actorId: user.id, actor: user.displayName })}::jsonb
        FROM created
      )
      SELECT * FROM created`;
    return NextResponse.json({ mapping: publicVendorMapping(rows[0]) }, { status: 201 });
  } catch (error: any) {
    if (error?.code === "23505") return NextResponse.json({ error: "This style and supplier mapping already exists." }, { status: 409 });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "The mapping request is not valid JSON." }, { status: 400 });
    if (error instanceof Error && isValidationMessage(error.message)) return NextResponse.json({ error: error.message }, { status: 400 });
    return apiError(error, "Could not create the supplier mapping.");
  }
}

function positiveQueryInteger(value: string | null, fallback: number, maximum: number) {
  if (value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error("Pagination values are outside the allowed range.");
  return number;
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, character => `\\${character}`);
}

function isValidationMessage(message: string) {
  return /^(Style ID|Vendor|Supplier|Product|Brand|Category|Article|NLC|HSN|GST|Lead|Payment|Incoterms|MOQ|Pack)/.test(message);
}

function apiError(error: unknown, fallback: string) {
  if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof Error && error.message.startsWith("Pagination")) return NextResponse.json({ error: error.message }, { status: 400 });
  console.error(error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}
