import { afterEach, describe, expect, it, vi } from "vitest";
import { dbJson, isLocalPostgresConnection } from "./db";

afterEach(() => vi.unstubAllEnvs());

describe("database target classification", () => {
  it("recognizes loopback hosts", () => {
    expect(isLocalPostgresConnection("postgresql://styleflow:secret@localhost:55432/po_ledger")).toBe(true);
    expect(isLocalPostgresConnection("postgresql://styleflow:secret@127.0.0.1:55432/po_ledger")).toBe(true);
    expect(isLocalPostgresConnection("postgresql://styleflow:secret@[::1]:55432/po_ledger")).toBe(true);
  });

  it("does not mistake credentials or database names for a local host", () => {
    expect(isLocalPostgresConnection("postgresql://styleflow:localhost@db.example.com/po_ledger")).toBe(false);
    expect(isLocalPostgresConnection("postgresql://styleflow:secret@db.example.com/localhost")).toBe(false);
    expect(isLocalPostgresConnection("not-a-postgres-url-containing-localhost")).toBe(false);
  });
});

describe("dbJson", () => {
  it("keeps structured values for postgres.js local JSONB parameters", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://styleflow@localhost:5432/styleflow_test");
    const value = [{ style_id: "1001" }];
    expect(dbJson(value)).toBe(value);
  });

  it("serializes structured values for Neon HTTP JSONB parameters", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://styleflow@db.example.com/styleflow_test");
    expect(dbJson([{ style_id: "1001" }])).toBe('[{"style_id":"1001"}]');
  });
});
