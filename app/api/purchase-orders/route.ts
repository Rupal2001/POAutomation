import { NextRequest, NextResponse } from "next/server";
import { sql, BatchRow } from "@/lib/db";
import { createDraftPurchaseOrders, PoSelection } from "@/lib/create-pos";
import { AuthError, requireUser } from "@/lib/auth";
import { canCreatePurchaseOrder, purchaseOrderQueuePermissions } from "@/lib/po-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const db = sql(); const status = req.nextUrl.searchParams.get("status");
    const rows = status ? await db`SELECT * FROM purchase_orders WHERE status=${status} ORDER BY created_at DESC LIMIT 200` : await db`SELECT * FROM purchase_orders ORDER BY created_at DESC LIMIT 200`;
    return NextResponse.json({
      purchaseOrders: rows.map((row: Record<string, unknown>) => ({
        ...row,
        revision: Number(row.revision),
        permissions: purchaseOrderQueuePermissions(user.role, String(row.status)),
      })),
      currentUser: { id: user.id, displayName: user.displayName, role: user.role },
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "The purchase-order request is not valid JSON." }, { status: 400 });
    console.error(error);
    return NextResponse.json({ error: "Could not list purchase orders." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    if (!canCreatePurchaseOrder(user.role)) return NextResponse.json({ error: "Planner access is required to create purchase orders." }, { status: 403 });
    const body = await req.json() as { batchId?: string; selections?: PoSelection[] };
    if (!body.batchId || !body.selections?.length) return NextResponse.json({ error: "Select at least one recommendation." }, { status: 400 });
    const db = sql(); const batches = await db`SELECT * FROM batches WHERE id=${body.batchId}` as BatchRow[];
    if (!batches.length) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    if (batches[0].status !== "generated") return NextResponse.json({ error: "Only a completed, generated planning run can create purchase orders." }, { status: 409 });
    const created = await createDraftPurchaseOrders(db, batches[0], body.selections, {
      displayName: user.displayName,
      userId: user.id,
    });
    return NextResponse.json({ created }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error(error);
    const message = error instanceof Error ? error.message : "Could not create draft purchase orders.";
    const status = /already exists|already converted|another session/i.test(message) ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
