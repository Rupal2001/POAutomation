import { NextRequest, NextResponse } from "next/server";
import {
  AccessControlValidationError,
  getAccessControlSnapshot,
  parseAccessControlChanges,
  saveAccessControlChanges,
} from "@/lib/access-control";
import { AuthError, requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requireUser(request, ["admin"]);
    const snapshot = await getAccessControlSnapshot(sql());
    return NextResponse.json(snapshot, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return accessControlError(error, "Could not load access control.");
  }
}

export async function PUT(request: NextRequest) {
  try {
    const administrator = await requireUser(request, ["admin"]);
    const changes = parseAccessControlChanges(await request.json());
    const database = sql();
    const revision = await saveAccessControlChanges(changes, administrator, database);
    if (!revision) {
      return NextResponse.json(
        { error: "Access settings changed in another session. Reload and apply your changes again.", code: "STALE_REVISION" },
        { status: 409 }
      );
    }
    const snapshot = await getAccessControlSnapshot(database);
    return NextResponse.json({
      ...snapshot,
      message: "Access settings saved. They apply from each user's next request.",
    }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return accessControlError(error, "Could not save access control.");
  }
}

function accessControlError(error: unknown, fallback: string) {
  if (error instanceof AuthError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json(
      { error: "The access-control request is not valid JSON." },
      { status: 400 }
    );
  }
  if (error instanceof AccessControlValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "42P01") {
    return NextResponse.json(
      { error: "Access-control tables are not installed. Run npm run db:init, then reload this page.", code: "SCHEMA_UPGRADE_REQUIRED" },
      { status: 503 }
    );
  }
  console.error(error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}
