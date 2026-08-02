import { describe, expect, it } from "vitest";
import {
  ACCESS_AREAS,
  AccessControlValidationError,
  accessRequirementForRequest,
  defaultAreaAccess,
  effectiveAreaDecision,
  getEffectiveAreaAccess,
  parseAccessControlChanges,
} from "./access-control";

describe("page access defaults", () => {
  it("preserves every legacy workspace page for existing roles", () => {
    for (const role of ["admin", "planner", "approver", "senior_approver", "receiver", "viewer"] as const) {
      const access = defaultAreaAccess(role);
      for (const area of ACCESS_AREAS.filter((item) => item.key !== "admin_access_control")) {
        expect(access[area.key]).toBe(true);
      }
    }
  });

  it("keeps administration restricted to administrators", () => {
    expect(defaultAreaAccess("admin").admin_access_control).toBe(true);
    expect(defaultAreaAccess("planner").admin_access_control).toBe(false);
    expect(defaultAreaAccess("viewer").admin_access_control).toBe(false);
  });

  it("applies a user exception after the role policy", () => {
    expect(effectiveAreaDecision({ role: "planner", areaKey: "forecast_health", roleAllowed: true, userOverride: "deny" })).toBe(false);
    expect(effectiveAreaDecision({ role: "viewer", areaKey: "purchase_orders", roleAllowed: false, userOverride: "allow" })).toBe(true);
  });

  it("never allows an override to bypass the administrator boundary", () => {
    expect(effectiveAreaDecision({ role: "admin", areaKey: "admin_access_control", roleAllowed: false, userOverride: "deny" })).toBe(true);
    expect(effectiveAreaDecision({ role: "planner", areaKey: "admin_access_control", roleAllowed: true, userOverride: "allow" })).toBe(false);
  });

  it("merges stored role policy and personal exceptions", async () => {
    const database = (strings: TemplateStringsArray) => {
      const statement = strings.join("?");
      if (statement.includes("role_area_access")) {
        return Promise.resolve([{ area_key: "forecast_health", allowed: false }]);
      }
      return Promise.resolve([{ area_key: "purchase_orders", effect: "deny" }]);
    };
    const access = await getEffectiveAreaAccess({ id: "planner-1", role: "planner" }, database);
    expect(access.overview).toBe(true);
    expect(access.forecast_health).toBe(false);
    expect(access.purchase_orders).toBe(false);
  });

  it("uses compiled legacy defaults only while the access tables are absent", async () => {
    const database = () => Promise.reject(Object.assign(new Error("missing relation"), { code: "42P01" }));
    await expect(getEffectiveAreaAccess({ id: "viewer-1", role: "viewer" }, database))
      .resolves.toEqual(defaultAreaAccess("viewer"));
  });
});

describe("access-control change validation", () => {
  it("accepts optimistic role and user changes", () => {
    expect(parseAccessControlChanges({
      expectedRevision: 4,
      roleAccess: [{ role: "viewer", areaKey: "purchase_orders", allowed: false }],
      userOverrides: [{ userId: "user-1", areaKey: "purchase_orders", effect: "allow" }],
      reason: "Temporary buying cover",
    })).toEqual({
      expectedRevision: 4,
      roleAccess: [{ role: "viewer", areaKey: "purchase_orders", allowed: false }],
      userOverrides: [{ userId: "user-1", areaKey: "purchase_orders", effect: "allow" }],
      reason: "Temporary buying cover",
    });
  });

  it("uses inherit to remove a personal override", () => {
    const parsed = parseAccessControlChanges({
      expectedRevision: 2,
      userOverrides: [{ userId: "user-1", areaKey: "forecast_health", effect: "inherit" }],
    });
    expect(parsed.userOverrides[0].effect).toBe("inherit");
  });

  it("rejects stale-form shapes and duplicate targets", () => {
    expect(() => parseAccessControlChanges({
      expectedRevision: 1,
      roleAccess: [
        { role: "planner", areaKey: "overview", allowed: true },
        { role: "planner", areaKey: "overview", allowed: false },
      ],
    })).toThrow(/duplicates/);
    expect(() => parseAccessControlChanges({ roleAccess: [] })).toThrow(/revision/);
  });

  it("rejects attempts to remove or delegate administrator access", () => {
    expect(() => parseAccessControlChanges({
      expectedRevision: 1,
      roleAccess: [{ role: "admin", areaKey: "admin_access_control", allowed: false }],
    })).toThrow(AccessControlValidationError);
    expect(() => parseAccessControlChanges({
      expectedRevision: 1,
      roleAccess: [{ role: "planner", areaKey: "admin_access_control", allowed: true }],
    })).toThrow(/Administrators/);
    expect(() => parseAccessControlChanges({
      expectedRevision: 1,
      userOverrides: [{ userId: "admin-1", areaKey: "admin_access_control", effect: "deny" }],
    })).toThrow(/cannot have a personal exception/);
  });
});

describe("server request mapping", () => {
  it("maps every controlled browser page", () => {
    expect(accessRequirementForRequest("/dashboard")).toEqual(["overview"]);
    expect(accessRequirementForRequest("/results/batch-1")).toEqual(["review_orders"]);
    expect(accessRequirementForRequest("/purchase-orders/po-1")).toEqual(["purchase_orders"]);
    expect(accessRequirementForRequest("/admin/access-control")).toEqual(["admin_access_control"]);
  });

  it("allows shared read APIs from each consuming page", () => {
    expect(accessRequirementForRequest("/api/dashboard", "GET")).toEqual(["overview", "planning_readiness"]);
    expect(accessRequirementForRequest("/api/vendor-mappings", "GET")).toEqual(["supplier_mapping", "planning_readiness", "review_orders"]);
    expect(accessRequirementForRequest("/api/purchase-orders", "GET")).toEqual(["review_orders", "purchase_orders"]);
    expect(accessRequirementForRequest("/api/purchase-orders/resolve-supplier-and-create", "POST")).toEqual(["review_orders", "purchase_orders"]);
    expect(accessRequirementForRequest("/api/demo-files/supplier_mappings", "GET")).toEqual(["plan_builder", "supplier_mapping"]);
  });

  it("keeps auth, profile and global search reachable", () => {
    expect(accessRequirementForRequest("/profile")).toBeNull();
    expect(accessRequirementForRequest("/api/auth/me")).toBeNull();
    expect(accessRequirementForRequest("/api/profile", "PATCH")).toBeNull();
    expect(accessRequirementForRequest("/api/search")).toBeNull();
  });
});
