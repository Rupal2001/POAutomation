// Run with: npm run db:init
// Reads lib/schema.sql and executes it against DATABASE_URL / POSTGRES_URL.
// Loads .env.local automatically so this works the same locally and in CI.

import { readFileSync } from "node:fs";
import { randomBytes, randomUUID, scrypt as nodeScrypt } from "node:crypto";
import { promisify } from "node:util";
import { neon } from "@neondatabase/serverless";
import postgres from "postgres";

const scrypt = promisify(nodeScrypt);

async function hashBootstrapPassword(password) {
  const cost = 16_384;
  const blockSize = 8;
  const parallelization = 1;
  const salt = randomBytes(16);
  const derivedKey = await scrypt(password, salt, 64, {
    cost,
    blockSize,
    parallelization,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    "scrypt",
    cost,
    blockSize,
    parallelization,
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

function isProductionDeployment() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}

function isLocalConnection(connectionString) {
  try {
    const hostname = new URL(connectionString).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return ["", "localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(hostname);
  } catch {
    return false;
  }
}

async function bootstrapAdmin(db, { local }) {
  const [{ count, active_admins: activeAdmins }] = await db`SELECT
    COUNT(*)::int AS count,
    COUNT(*) FILTER (WHERE role='admin' AND is_active=true)::int AS active_admins
    FROM app_users`;
  if (Number(activeAdmins) > 0) {
    console.log("Admin bootstrap skipped: an active administrator already exists.");
    return;
  }

  const production = isProductionDeployment();
  const configuredUsername = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim().toLowerCase();
  const configuredPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const username = configuredUsername || "admin";
  let password = configuredPassword;

  // A disposable local PostgreSQL database gets the documented admin/admin
  // convenience account only when it has no users at all. An established DB
  // that lost its last admin requires explicit recovery credentials.
  if (!password && local && !production && Number(count) === 0) password = "admin";

  if (!password) {
    throw new Error(
      "No active administrator exists. Set BOOTSTRAP_ADMIN_USERNAME and " +
        "BOOTSTRAP_ADMIN_PASSWORD, then run npm run db:init again."
    );
  }

  if ((production || !local) && (!configuredUsername || !configuredPassword)) {
    throw new Error(
      "Remote and production admin bootstrap requires explicit " +
        "BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD values."
    );
  }
  if (password === "admin" && (production || !local)) {
    throw new Error(
      "The admin/admin bootstrap is allowed only for a local database outside production."
    );
  }
  if ((production || !local) && password.length < 12) {
    throw new Error(
      "BOOTSTRAP_ADMIN_PASSWORD must contain at least 12 characters for remote or " +
        "production databases."
    );
  }
  if (password.length > 200 || (password !== "admin" && password.length < 10)) {
    throw new Error("BOOTSTRAP_ADMIN_PASSWORD must be between 10 and 200 characters.");
  }
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    throw new Error("BOOTSTRAP_ADMIN_USERNAME must be 3–40 lowercase letters, numbers, dots, dashes or underscores.");
  }

  const passwordHash = await hashBootstrapPassword(password);
  const displayName = process.env.BOOTSTRAP_ADMIN_DISPLAY_NAME?.trim() || "Administrator";
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase() || null;
  if (displayName.length < 2 || displayName.length > 100) {
    throw new Error("BOOTSTRAP_ADMIN_DISPLAY_NAME must be between 2 and 100 characters.");
  }
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Error("BOOTSTRAP_ADMIN_EMAIL must be a valid work email address.");
  }

  const inserted = await db`
    INSERT INTO app_users (
      id,
      username,
      display_name,
      email,
      role,
      password_hash,
      is_active,
      must_change_password
    ) VALUES (
      ${randomUUID()},
      ${username},
      ${displayName},
      ${email},
      'admin',
      ${passwordHash},
      true,
      true
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `;

  if (!inserted.length) {
    // Concurrent initialisers are harmless if one of them successfully created
    // an administrator. A conflicting non-admin identity is not overwritten.
    const [{ active_admins: concurrentAdmins }] = await db`SELECT
      COUNT(*) FILTER (WHERE role='admin' AND is_active=true)::int AS active_admins
      FROM app_users`;
    if (Number(concurrentAdmins) > 0) {
      console.log("Admin bootstrap skipped: another initializer created an administrator.");
      return;
    }
    throw new Error("Bootstrap username or email conflicts with an existing non-admin account. Choose different BOOTSTRAP_ADMIN credentials.");
  }

  if (password === "admin") {
    console.warn(
      "Created local admin/admin. This account must change its password at first login; " +
        "it is never created for a remote or production database."
    );
  } else {
    console.log(`Created bootstrap administrator: ${username}`);
  }
}

function loadDotEnvLocal() {
  try {
    const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // no .env.local — fine if the variable is already set some other way
  }
}

async function main() {
  loadDotEnvLocal();
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connectionString) {
    console.error(
      "No DATABASE_URL or POSTGRES_URL found. Add one to .env.local (see README.md)."
    );
    process.exit(1);
  }

  const schema = readFileSync(new URL("../lib/schema.sql", import.meta.url), "utf8");
  const local = isLocalConnection(connectionString);
  const sql = local ? postgres(connectionString, { max: 1 }) : neon(connectionString);

  // Strip whole-line comments before splitting. Previously a leading comment
  // caused the CREATE TABLE chunk to be discarded entirely.
  const statements = schema
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const statement of statements) {
    if (local) await sql.unsafe(statement);
    else await sql(statement);
  }
  await bootstrapAdmin(sql, { local });
  if (local) await sql.end();
  console.log("Database initialized: auth, page access, planning, purchase-order, audit, and integration tables are ready.");
}

main().catch((err) => {
  console.error("DB init failed:", err);
  process.exit(1);
});
