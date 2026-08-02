import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = sql();
    const [row] = await db`SELECT now() AS database_time`;
    return NextResponse.json({ ok: true, database: "connected", databaseTime: row.database_time });
  } catch (error) {
    console.error("Database health check failed:", error);
    return NextResponse.json({ ok: false, database: "unavailable", error: "Database health check failed." }, { status: 503 });
  }
}
