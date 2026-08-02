import { NextRequest, NextResponse } from "next/server";
import { AuthError, UserRole, hashPassword, requireUser } from "@/lib/auth";
import { publicUser, validateAccount } from "@/lib/admin-users";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser(request, ["admin"]);
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const db = sql();
    const [target] = await db`SELECT * FROM app_users WHERE id=${id}`;
    if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });

    const displayName = String(body.displayName ?? target.display_name).trim();
    const email = String(body.email ?? target.email ?? "").trim().toLowerCase();
    const role = String(body.role ?? target.role) as UserRole;
    const isActive = body.isActive === undefined ? Boolean(target.is_active) : body.isActive === true;
    const temporaryPassword = String(body.temporaryPassword ?? "");
    const validation = validateAccount({ username: target.username, displayName, email, role, temporaryPassword: temporaryPassword || undefined });
    if (validation) return NextResponse.json({ error: validation }, { status: 400 });

    if (session.id === id && (!isActive || role !== "admin")) {
      return NextResponse.json({ error: "You cannot remove your own active administrator access." }, { status: 400 });
    }
    if (target.role === "admin" && target.is_active && (!isActive || role !== "admin")) {
      const [{ count }] = await db`SELECT COUNT(*)::int AS count FROM app_users WHERE role='admin' AND is_active=true`;
      if (Number(count) <= 1) return NextResponse.json({ error: "Keep at least one active administrator." }, { status: 400 });
    }

    const securityChanged = Boolean(temporaryPassword) || target.role !== role || Boolean(target.is_active) !== isActive;
    const passwordHash = temporaryPassword ? await hashPassword(temporaryPassword) : target.password_hash;
    const mustChangePassword = temporaryPassword ? true : Boolean(target.must_change_password);
    const sessionVersion = Number(target.session_version) + (securityChanged ? 1 : 0);
    const [row] = await db`UPDATE app_users
      SET display_name=${displayName}, email=${email || null}, role=${role}, is_active=${isActive},
          password_hash=${passwordHash}, must_change_password=${mustChangePassword}, session_version=${sessionVersion},
          updated_by_user_id=${session.id}, updated_at=now()
      WHERE id=${id}
      RETURNING id,username,display_name,email,role,is_active,must_change_password,last_login_at,created_at,updated_at`;
    return NextResponse.json({ user: publicUser(row) });
  } catch (error: any) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "The user request is not valid JSON." }, { status: 400 });
    if (error?.code === "23505") return NextResponse.json({ error: "That email address is already used by another account." }, { status: 409 });
    console.error(error);
    return NextResponse.json({ error: "Could not update the user." }, { status: 500 });
  }
}
