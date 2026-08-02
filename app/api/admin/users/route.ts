import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { AuthError, USER_ROLES, UserRole, hashPassword, requireUser } from "@/lib/auth";
import { publicUser, validateAccount } from "@/lib/admin-users";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requireUser(request, ["admin"]);
    const db = sql();
    const rows = await db`SELECT id,username,display_name,email,role,is_active,must_change_password,last_login_at,created_at,updated_at
      FROM app_users ORDER BY is_active DESC, display_name ASC, username ASC`;
    return NextResponse.json({ users: rows.map(publicUser), roles: USER_ROLES });
  } catch (error) {
    return authOrServerError(error, "Could not load workspace users.");
  }
}

export async function POST(request: NextRequest) {
  try {
    const administrator = await requireUser(request, ["admin"]);
    const body = await request.json() as Record<string, unknown>;
    const username = String(body.username ?? "").trim().toLowerCase();
    const displayName = String(body.displayName ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    const role = String(body.role ?? "viewer") as UserRole;
    const temporaryPassword = String(body.temporaryPassword ?? "");
    const validation = validateAccount({ username, displayName, email, role, temporaryPassword });
    if (validation) return NextResponse.json({ error: validation }, { status: 400 });

    const db = sql();
    const [row] = await db`INSERT INTO app_users
      (id,username,display_name,email,role,password_hash,is_active,must_change_password,created_by_user_id,updated_by_user_id)
      VALUES (${randomUUID()},${username},${displayName},${email || null},${role},${await hashPassword(temporaryPassword)},true,true,${administrator.id},${administrator.id})
      RETURNING id,username,display_name,email,role,is_active,must_change_password,last_login_at,created_at,updated_at`;
    return NextResponse.json({ user: publicUser(row) }, { status: 201 });
  } catch (error: any) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: "The user request is not valid JSON." }, { status: 400 });
    if (error?.code === "23505") return NextResponse.json({ error: "That username is already in use." }, { status: 409 });
    return authOrServerError(error, "Could not create the user.");
  }
}

function authOrServerError(error: unknown, fallback: string) {
  if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
  console.error(error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}
