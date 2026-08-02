import {
  createHmac,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";

export const AUTH_COOKIE = "po_ledger_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 12;

export const USER_ROLES = [
  "admin",
  "planner",
  "approver",
  "senior_approver",
  "receiver",
  "viewer",
] as const;

export type UserRole = (typeof USER_ROLES)[number];

export interface AppUser {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  role: UserRole;
  password_hash: string;
  is_active: boolean;
  must_change_password: boolean;
  failed_attempts: number;
  locked_until: string | Date | null;
  session_version: number;
  last_login_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: UserRole;
  mustChangePassword: boolean;
  sessionVersion: number;
  lastLoginAt: string | null;
}

export interface SessionClaims {
  version: 1;
  sub: string;
  username: string;
  displayName: string;
  role: UserRole;
  sessionVersion: number;
  mustChangePassword: boolean;
  iat: number;
  exp: number;
}

type SessionIdentity = AppUser | SessionUser;

const PASSWORD_FORMAT = "scrypt";
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const MIN_PRODUCTION_SECRET_LENGTH = 32;
const MIN_DEVELOPMENT_SECRET_LENGTH = 16;

function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: {
    cost: number;
    blockSize: number;
    parallelization: number;
    maxmem: number;
  }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, keyLength, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function isProduction() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && (USER_ROLES as readonly string[]).includes(value);
}

/**
 * Fails closed when authentication is misconfigured. Production never uses a
 * built-in or weak fallback secret.
 */
export function assertAuthConfiguration(): void {
  const secret = process.env.AUTH_SECRET?.trim() ?? "";
  const minimum = isProduction()
    ? MIN_PRODUCTION_SECRET_LENGTH
    : MIN_DEVELOPMENT_SECRET_LENGTH;

  if (secret.length < minimum) {
    throw new Error(
      `AUTH_SECRET must contain at least ${minimum} characters${
        isProduction() ? " in production" : ""
      }.`
    );
  }

  if (
    isProduction() &&
    ["local-development", "development", "changeme", "change-me"].includes(
      secret.toLowerCase()
    )
  ) {
    throw new Error("AUTH_SECRET uses a known development value.");
  }
}

function getAuthSecret(): string {
  assertAuthConfiguration();
  return process.env.AUTH_SECRET!.trim();
}

/** Hashes a password using scrypt and a fresh 16-byte salt. */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== "string" || password.length === 0) {
    throw new TypeError("Password must not be empty.");
  }

  const salt = randomBytes(16);
  const derivedKey = await deriveKey(password, salt, SCRYPT_KEY_LENGTH, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
    maxmem: SCRYPT_MAX_MEMORY,
  });

  return [
    PASSWORD_FORMAT,
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

/** Returns false for malformed or unsupported password hashes. */
export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  if (typeof password !== "string" || typeof encodedHash !== "string") return false;

  const [format, costText, blockSizeText, parallelizationText, saltText, hashText, extra] =
    encodedHash.split("$");
  if (format !== PASSWORD_FORMAT || extra !== undefined) return false;

  const cost = Number(costText);
  const blockSize = Number(blockSizeText);
  const parallelization = Number(parallelizationText);
  if (
    cost !== SCRYPT_COST ||
    blockSize !== SCRYPT_BLOCK_SIZE ||
    parallelization !== SCRYPT_PARALLELIZATION ||
    !saltText ||
    !hashText
  ) {
    return false;
  }

  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(hashText, "base64url");
    if (salt.length !== 16 || expected.length !== SCRYPT_KEY_LENGTH) return false;

    const actual = await deriveKey(password, salt, expected.length, {
      cost,
      blockSize,
      parallelization,
      maxmem: SCRYPT_MAX_MEMORY,
    });

    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function toBase64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function sign(encodedPayload: string): string {
  return createHmac("sha256", getAuthSecret()).update(encodedPayload).digest("base64url");
}

function sessionFields(user: SessionIdentity) {
  if ("display_name" in user) {
    return {
      displayName: user.display_name,
      sessionVersion: user.session_version,
      mustChangePassword: user.must_change_password,
    };
  }
  return {
    displayName: user.displayName,
    sessionVersion: user.sessionVersion,
    mustChangePassword: user.mustChangePassword,
  };
}

/** Creates a signed, user-specific session token with a 12-hour lifetime. */
export function createSessionToken(
  user: SessionIdentity,
  options: { now?: number; ttlSeconds?: number } = {}
): string {
  if (!user.id || !user.username || !isUserRole(user.role)) {
    throw new TypeError("Cannot create a session for an invalid user.");
  }

  const fields = sessionFields(user);
  if (!Number.isSafeInteger(fields.sessionVersion) || fields.sessionVersion < 1) {
    throw new TypeError("Cannot create a session with an invalid session version.");
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const ttlSeconds = options.ttlSeconds ?? SESSION_TTL_SECONDS;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new TypeError("Invalid session lifetime.");
  }

  const claims: SessionClaims = {
    version: 1,
    sub: user.id,
    username: user.username,
    displayName: fields.displayName,
    role: user.role,
    sessionVersion: fields.sessionVersion,
    mustChangePassword: fields.mustChangePassword,
    iat: now,
    exp: now + ttlSeconds,
  };
  const payload = toBase64Url(JSON.stringify(claims));
  return `${payload}.${sign(payload)}`;
}

function isSessionClaims(value: unknown): value is SessionClaims {
  if (!value || typeof value !== "object") return false;
  const claims = value as Partial<SessionClaims>;
  return (
    claims.version === 1 &&
    typeof claims.sub === "string" &&
    claims.sub.length > 0 &&
    typeof claims.username === "string" &&
    claims.username.length > 0 &&
    typeof claims.displayName === "string" &&
    isUserRole(claims.role) &&
    Number.isSafeInteger(claims.sessionVersion) &&
    Number(claims.sessionVersion) >= 1 &&
    typeof claims.mustChangePassword === "boolean" &&
    Number.isSafeInteger(claims.iat) &&
    Number.isSafeInteger(claims.exp) &&
    Number(claims.exp) > Number(claims.iat)
  );
}

/** Verifies signature, shape and expiry. Database revocation is checked by getSessionUser. */
export function verifySessionToken(
  token: string | null | undefined,
  options: { now?: number } = {}
): SessionClaims | null {
  if (!token || typeof token !== "string") return null;
  const separator = token.indexOf(".");
  if (separator <= 0 || separator !== token.lastIndexOf(".")) return null;

  const payload = token.slice(0, separator);
  const suppliedSignature = Buffer.from(token.slice(separator + 1), "base64url");
  const expectedSignature = Buffer.from(sign(payload), "base64url");
  if (
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    return null;
  }

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isSessionClaims(claims)) return null;
    const now = options.now ?? Math.floor(Date.now() / 1000);
    if (claims.exp <= now || claims.iat > now + 60) return null;
    return claims;
  } catch {
    return null;
  }
}
