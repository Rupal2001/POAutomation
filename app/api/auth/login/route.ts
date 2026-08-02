import { NextRequest, NextResponse } from "next/server";
import { AppUser, assertAuthConfiguration, hashPassword, setSessionCookie, toSessionUser, verifyPassword } from "@/lib/auth";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const dummyHash = hashPassword("styleflow-invalid-user-timing-placeholder");

export async function POST(request: NextRequest) {
  try {
    assertAuthConfiguration();
    const body = await request.json() as { username?: unknown; password?: unknown };
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!username || !password || username.length > 100 || password.length > 500) return invalidCredentials();

    const db = sql();
    const rows = await db`SELECT * FROM app_users WHERE lower(username)=lower(${username}) LIMIT 1` as AppUser[];
    const account = rows[0];
    if (!account) {
      await verifyPassword(password, await dummyHash);
      return invalidCredentials();
    }

    const lockedUntil = account.locked_until ? new Date(account.locked_until) : null;
    if (lockedUntil && lockedUntil.getTime() > Date.now()) {
      const retryAfter = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 1000));
      return NextResponse.json(
        { error: "Too many unsuccessful attempts. Try again in a few minutes." },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
    }

    // Always perform the password KDF for an existing account, including a
    // deactivated one, so account state is not exposed through response timing.
    const passwordValid = await verifyPassword(password, account.password_hash);
    const valid = account.is_active && passwordValid;
    if (!valid) {
      await db`UPDATE app_users
        SET failed_attempts=CASE WHEN failed_attempts+1 >= ${MAX_FAILED_ATTEMPTS} THEN 0 ELSE failed_attempts+1 END,
            locked_until=CASE WHEN failed_attempts+1 >= ${MAX_FAILED_ATTEMPTS}
              THEN now()+(${LOCK_MINUTES} * interval '1 minute') ELSE locked_until END,
            updated_at=now()
        WHERE id=${account.id}`;
      return invalidCredentials();
    }

    const updated = await db`UPDATE app_users
      SET failed_attempts=0, locked_until=NULL, last_login_at=now(), updated_at=now()
      WHERE id=${account.id}
      RETURNING *` as AppUser[];
    const user = toSessionUser(updated[0]);
    const response = NextResponse.json({ ok: true, user });
    setSessionCookie(response, user);
    return response;
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: "The sign-in request is not valid JSON." }, { status: 400 });
    console.error(error);
    const configurationError = error instanceof Error && error.message.startsWith("AUTH_SECRET");
    return NextResponse.json(
      { error: configurationError ? "Authentication is not configured. Ask the workspace administrator to set AUTH_SECRET." : "Sign-in is temporarily unavailable." },
      { status: configurationError ? 503 : 500 }
    );
  }
}

function invalidCredentials() {
  return NextResponse.json({ error: "Incorrect username or password." }, { status: 401 });
}
