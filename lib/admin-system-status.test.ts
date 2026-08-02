import { describe, expect, it } from "vitest";
import { buildAdminSystemStatus, REQUIRED_SYSTEM_TABLES, type AdminSystemStatusInput } from "./admin-system-status";

const now = new Date("2026-08-02T10:00:00.000Z");

function input(overrides: Partial<AdminSystemStatusInput> = {}): AdminSystemStatusInput {
  return {
    now,
    environment: "local",
    database: {
      mode: "Local PostgreSQL",
      responseTimeMs: 4.4,
      serverTime: now,
      schemaTables: 10,
      requiredSchemaTables: 10,
      requiredSchemaReady: true,
    },
    snapshot: {
      id: "batch-1",
      label: "August Myntra plan",
      status: "generated",
      createdAt: "2026-08-02T09:00:00.000Z",
      dataAsOf: "2026-08-02",
      sourceType: "bulk_workbook",
      methodologyVersion: "style_drr_cover_v1",
      salesRows: 3_630,
      inventoryRows: 121,
      openPoRows: 9,
      styleMasterRows: 121,
    },
    latestInbound: {
      integration: "file_import",
      status: "completed",
      createdAt: "2026-08-02T09:00:00.000Z",
    },
    email: {
      provider: "preview",
      configured: true,
      mode: "Local preview — nothing leaves StyleFlow",
      forceToEnabled: false,
    },
    authentication: {
      totalUsers: 2,
      activeUsers: 2,
      activeAdmins: 1,
      temporaryPasswordUsers: 0,
      localDefaultBootstrapPending: false,
      sessionSigningReady: true,
      bootstrapCredentialsConfigured: false,
    },
    ...overrides,
  };
}

describe("admin system status", () => {
  it("reports a current snapshot while making preview email semantics explicit", () => {
    const status = buildAdminSystemStatus(input());

    expect(REQUIRED_SYSTEM_TABLES).toHaveLength(10);
    expect(REQUIRED_SYSTEM_TABLES).toEqual(expect.arrayContaining([
      "po_recommendation_claims",
      "schema_migrations",
      "supplier_style_mappings",
    ]));
    expect(status.database).toMatchObject({ status: "ready", responseTimeMs: 4, requiredSchemaTables: 10 });
    expect(status.planning).toMatchObject({ status: "ready" });
    expect(status.email).toMatchObject({ status: "attention", deliveryEnabled: false });
    expect(status.email.explanation).toMatch(/does not send/i);
    expect(status.authentication).toMatchObject({ status: "ready", activeAdmins: 1 });
    expect(JSON.stringify(status)).not.toMatch(/api[_-]?key|password_hash|connection.string/i);
  });

  it("surfaces stale planning data and an unchanged local bootstrap password", () => {
    const status = buildAdminSystemStatus(input({
      snapshot: {
        ...input().snapshot!,
        dataAsOf: "2026-07-01",
      },
      authentication: {
        ...input().authentication,
        temporaryPasswordUsers: 1,
        localDefaultBootstrapPending: true,
      },
    }));

    expect(status.planning.status).toBe("attention");
    expect(status.planning.explanation).toMatch(/32 days old/);
    expect(status.authentication.status).toBe("attention");
    expect(status.authentication.warnings.join(" ")).toMatch(/bootstrap administrator/i);
  });

  it("does not pretend that an empty warehouse is connected", () => {
    const status = buildAdminSystemStatus(input({ snapshot: null, latestInbound: null }));

    expect(status.planning).toEqual(expect.objectContaining({ status: "empty", snapshot: null }));
    expect(status.planning.explanation).toMatch(/upload/i);
  });
});
