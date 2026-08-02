import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { canCreatePurchaseOrder } from "@/lib/po-access";
import { sql, type BatchRow } from "@/lib/db";
import {
  getSupplierResolutionContext,
  resolveSupplierAndCreateDraft,
  SupplierResolutionError,
  type SupplierResolutionRequest,
} from "@/lib/resolve-supplier-po";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(error: unknown) {
  if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof SupplierResolutionError) {
    return NextResponse.json({ error: error.message, code: error.code, ...error.details }, { status: error.status });
  }
  if (error instanceof SyntaxError) return NextResponse.json({ error: "The supplier-resolution request is not valid JSON.", code: "INVALID_JSON" }, { status: 400 });
  console.error(error);
  return NextResponse.json({ error: "Could not resolve the supplier and create the draft PO." }, { status: 500 });
}

async function generatedBatch(db: any, batchId: string) {
  if (!batchId || batchId.length > 100) throw new SupplierResolutionError("A valid planning run is required.", 400, "BATCH_ID_REQUIRED");
  const rows = await db`SELECT * FROM batches WHERE id=${batchId}` as BatchRow[];
  if (!rows.length) throw new SupplierResolutionError("Planning run not found.", 404, "BATCH_NOT_FOUND");
  if (rows[0].status !== "generated") throw new SupplierResolutionError("Only a completed, generated planning run can create purchase orders.", 409, "PLAN_NOT_GENERATED");
  return rows[0];
}

/** Exact, permissioned context for the inline form; no fuzzy mapping lookup. */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    if (!canCreatePurchaseOrder(user.role)) {
      return NextResponse.json({ error: "Planner access is required to resolve suppliers and create purchase orders." }, { status: 403 });
    }
    const query = request.nextUrl.searchParams;
    const batchId = String(query.get("batchId") ?? "").trim();
    const db = sql();
    const batch = await generatedBatch(db, batchId);
    const context = await getSupplierResolutionContext(db, batch, {
      sku: String(query.get("sku") ?? query.get("styleId") ?? ""),
      styleId: query.get("styleId") ?? undefined,
      warehouse: query.get("warehouse") ?? query.get("fc") ?? undefined,
      currentVendor: query.get("currentVendor") ?? undefined,
    });
    return NextResponse.json(context, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    if (!canCreatePurchaseOrder(user.role)) {
      return NextResponse.json({ error: "Planner access is required to resolve suppliers and create purchase orders." }, { status: 403 });
    }
    const body = await request.json() as Partial<SupplierResolutionRequest>;
    if (!body || typeof body !== "object" || Array.isArray(body) || !body.selection || !body.mapping) {
      throw new SupplierResolutionError("Planning run, recommendation and supplier details are required.", 400, "INVALID_SUPPLIER_RESOLUTION_REQUEST");
    }
    if (typeof body.selection !== "object" || Array.isArray(body.selection) || typeof body.mapping !== "object" || Array.isArray(body.mapping)) {
      throw new SupplierResolutionError("Recommendation and supplier details must be valid objects.", 400, "INVALID_SUPPLIER_RESOLUTION_REQUEST");
    }
    const db = sql();
    const batch = await generatedBatch(db, String(body.batchId ?? "").trim());
    const result = await resolveSupplierAndCreateDraft(db, batch, body as SupplierResolutionRequest, {
      id: user.id,
      displayName: user.displayName,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
