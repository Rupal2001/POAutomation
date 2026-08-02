import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { sql, BatchRow } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await requireUser(req);
    const db = sql();
    // The review workbench does not need transaction-level source rows. Avoid
    // sending up to 100k uploaded sales records (and unnecessary personal or
    // commercial data) to every browser opening a result.
    const rows = (await db`
      SELECT id,created_at,coverage_days,status,label,vendor_master_data,planning_settings,recommendations
      FROM batches
      WHERE id = ${id}
    `) as BatchRow[];
    if (rows.length === 0) {
      return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    }
    return NextResponse.json({ batch: rows[0] });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error(err);
    return NextResponse.json({ error: "Unexpected error while fetching the batch." }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await requireUser(req, ["admin", "planner"]);
    const db = sql();
    const rows = await db`UPDATE batches SET status='archived' WHERE id=${id} RETURNING id`;
    if (!rows.length) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    return NextResponse.json({ ok: true, status: "archived" });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error(err);
    return NextResponse.json({ error: "Unexpected error while deleting the batch." }, { status: 500 });
  }
}
