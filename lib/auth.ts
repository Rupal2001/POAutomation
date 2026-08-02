import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export {
  AUTH_COOKIE,
  SESSION_TTL_SECONDS,
  USER_ROLES,
  assertAuthConfiguration,
  createSessionToken,
  hashPassword,
  isUserRole,
  verifyPassword,
  verifySessionToken,
} from "@/lib/session";
export type {
  AppUser,
  SessionClaims,
  SessionUser,
  UserRole,
} from "@/lib/session";

import {
  AUTH_COOKIE,
  SESSION_TTL_SECONDS,
  createSessionToken,
  verifySessionToken,
  type AppUser,
  type SessionUser,
  type UserRole,
} from "@/lib/session";

export class AuthError extends Error {
  readonly status: number;
  readonly code: "AUTHENTICATION_REQUIRED" | "FORBIDDEN" | "PASSWORD_CHANGE_REQUIRED";

  constructor(
    message: string,
    status: 401 | 403 = 401,
    code: "AUTHENTICATION_REQUIRED" | "FORBIDDEN" | "PASSWORD_CHANGE_REQUIRED" =
      status === 403 ? "FORBIDDEN" : "AUTHENTICATION_REQUIRED"
  ) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

type CookieValue = { value: string } | string | undefined;
type CookieStore = { get(name: string): CookieValue };
export type AuthRequestSource = Request | { cookies: CookieStore } | CookieStore;

function parseCookieHeader(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function cookieValue(value: CookieValue): string | undefined {
  return typeof value === "string" ? value : value?.value;
}

async function readSessionToken(source?: AuthRequestSource): Promise<string | undefined> {
  if (!source) {
    return cookieValue((await cookies()).get(AUTH_COOKIE));
  }

  if (source instanceof Request) {
    return parseCookieHeader(source.headers.get("cookie"), AUTH_COOKIE);
  }

  if ("cookies" in source) {
    return cookieValue(source.cookies.get(AUTH_COOKIE));
  }

  return cookieValue(source.get(AUTH_COOKIE));
}

export function toSessionUser(row: AppUser): SessionUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    mustChangePassword: row.must_change_password,
    sessionVersion: row.session_version,
    lastLoginAt:
      row.last_login_at instanceof Date
        ? row.last_login_at.toISOString()
        : row.last_login_at,
  };
}

/**
 * Resolves the signed cookie and checks that the database user is active,
 * unlocked, and still has the same session_version and role.
 */
export async function getSessionUser(source?: AuthRequestSource): Promise<SessionUser | null> {
  const token = await readSessionToken(source);
  const claims = verifySessionToken(token);
  if (!claims) return null;

  const db = sql();
  const rows = (await db`
    SELECT
      id,
      username,
      display_name,
      email,
      role,
      password_hash,
      is_active,
      must_change_password,
      failed_attempts,
      locked_until,
      session_version,
      last_login_at,
      created_at,
      updated_at
    FROM app_users
    WHERE id = ${claims.sub}
      AND is_active = true
      AND (locked_until IS NULL OR locked_until <= now())
    LIMIT 1
  `) as AppUser[];

  const row = rows[0];
  if (
    !row ||
    row.session_version !== claims.sessionVersion ||
    row.role !== claims.role ||
    row.username !== claims.username
  ) {
    return null;
  }
  return toSessionUser(row);
}

export async function requireUser(
  source?: AuthRequestSource,
  allowedRoles?: readonly UserRole[],
  options: { allowPasswordChangeRequired?: boolean } = {},
): Promise<SessionUser> {
  const user = await getSessionUser(source);
  if (!user) throw new AuthError("Authentication required.", 401);
  if (user.mustChangePassword && !options.allowPasswordChangeRequired) {
    throw new AuthError("Change your temporary password before using StyleFlow.", 403, "PASSWORD_CHANGE_REQUIRED");
  }
  if (allowedRoles && !allowedRoles.includes(user.role)) {
    throw new AuthError("You do not have permission to perform this action.", 403);
  }
  return user;
}

export async function requireRole(
  source: AuthRequestSource | undefined,
  ...allowedRoles: UserRole[]
): Promise<SessionUser> {
  return requireUser(source, allowedRoles);
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

export function setSessionCookie(response: NextResponse, user: AppUser | SessionUser): void {
  response.cookies.set(AUTH_COOKIE, createSessionToken(user), sessionCookieOptions());
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(AUTH_COOKIE, "", {
    ...sessionCookieOptions(),
    maxAge: 0,
    expires: new Date(0),
  });
}
