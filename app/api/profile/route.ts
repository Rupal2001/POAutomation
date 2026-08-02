import { NextRequest, NextResponse } from "next/server";
import { AuthError, hashPassword, requireUser, setSessionCookie, verifyPassword } from "@/lib/auth";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(request: NextRequest) {
  try {
    const session = await requireUser(request, undefined, { allowPasswordChangeRequired: true });
    const body = await request.json() as Record<string, unknown>;
    const displayName = String(body.displayName ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    const currentPassword = String(body.currentPassword ?? "");
    const newPassword = String(body.newPassword ?? "");

    if (displayName.length < 2 || displayName.length > 100) {
      return NextResponse.json({ error: "Display name must be between 2 and 100 characters." }, { status: 400 });
    }
    if (email && !validEmail(email)) {
      return NextResponse.json({ error: "Enter a valid work email address." }, { status: 400 });
    }

    const db = sql();
    const [account] = await db`SELECT * FROM app_users WHERE id=${session.id}`;
    if (!account || !account.is_active) return NextResponse.json({ error: "This account is no longer active." }, { status: 401 });

    const changingPassword = Boolean(newPassword);
    if (account.must_change_password && !changingPassword) {
      return NextResponse.json({ error: "Change the temporary password before continuing." }, { status: 400 });
    }
    if (changingPassword) {
      if (!currentPassword || !(await verifyPassword(currentPassword, account.password_hash))) {
        return NextResponse.json({ error: "The current password is incorrect." }, { status: 400 });
      }
      if (newPassword.length < 10 || newPassword.length > 200) {
        return NextResponse.json({ error: "The new password must be between 10 and 200 characters." }, { status: 400 });
      }
      if (newPassword.toLowerCase() === account.username.toLowerCase() || newPassword.toLowerCase() === "admin") {
        return NextResponse.json({ error: "Choose a password that is not your username or the default password." }, { status: 400 });
      }
      if (await verifyPassword(newPassword, account.password_hash)) {
        return NextResponse.json({ error: "Choose a new password that is different from your current password." }, { status: 400 });
      }
    }

    const rows = changingPassword
      ? await db`UPDATE app_users
          SET display_name=${displayName}, email=${email || null}, password_hash=${await hashPassword(newPassword)},
              must_change_password=false, session_version=session_version+1, password_changed_at=now(),
              updated_by_user_id=${session.id}, updated_at=now()
          WHERE id=${session.id}
          RETURNING id,username,display_name,email,role,is_active,must_change_password,session_version,last_login_at,created_at,updated_at`
      : await db`UPDATE app_users
          SET display_name=${displayName}, email=${email || null}, updated_by_user_id=${session.id}, updated_at=now()
          WHERE id=${session.id}
          RETURNING id,username,display_name,email,role,is_active,must_change_password,session_version,last_login_at,created_at,updated_at`;

    const user = publicUser(rows[0]);
    const response = NextResponse.json({ user, passwordChanged: changingPassword });
    if (changingPassword) setSessionCookie(response, user);
    return response;
  } catch (error: any) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "The profile request is not valid JSON." }, { status: 400 });
    if (error?.code === "23505") return NextResponse.json({ error: "That email address is already used by another account." }, { status: 409 });
    console.error(error);
    return NextResponse.json({ error: "Could not save your profile." }, { status: 500 });
  }
}

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function publicUser(row: any) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    isActive: row.is_active,
    mustChangePassword: row.must_change_password,
    sessionVersion: Number(row.session_version),
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
