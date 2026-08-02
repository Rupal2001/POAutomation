import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BatchRow } from "./db";
import type { Recommendation } from "./po-engine";
import { createDraftPurchaseOrders, executionQuantityProblem, operationalExpectedDeliveryDate, recommendationClaimKey, recommendationClaimRecord } from "./create-pos";

beforeEach(() => vi.stubEnv("DATABASE_URL", "postgresql://styleflow@localhost:5432/styleflow_test"));
afterEach(() => vi.unstubAllEnvs());

function batchWith(row: Partial<Recommendation>, vendorMaster: unknown[] = []) {
  return {
    id: "batch-1",
    recommendations: [{
      vendor: "Supplier mapping required",
      sku: "36627115",
      styleId: "36627115",
      warehouse: "ALL_MYNTRA",
      suggestedPoQty: 10,
      unitPrice: 100,
      exceptions: [{ code: "MISSING_VENDOR", severity: "critical", message: "No supplier is mapped." }],
      ...row,
    } as Recommendation],
    vendor_master_data: vendorMaster,
  } as BatchRow;
}

const selection = [{ vendor: "Supplier mapping required", sku: "36627115", warehouse: "ALL_MYNTRA", acknowledgeRisk: true }];

function readyRecommendation(vendor: string, sku: string, warehouse: string) {
  return {
    marketplace: "Myntra", vendor, sku, styleId: sku, warehouse, productName: `Noise ${sku}`, brand: "Noise",
    category: "Audio", mrpInr: 2999, suggestedPoQty: 10, signedPoQtyAsk: 10, dohEligible: true,
    calculationMethod: "style_drr_cover_v1", unitPrice: 1000, currency: "INR", exceptions: [],
    expectedDeliveryDate: "2026-08-20", leadTimeDays: 14, dailyRunRate: 2, safetyStock: 0,
    inventoryPosition: 5, explanation: "Approved methodology ask.",
  } as unknown as Recommendation;
}

function groupedBatch() {
  const recommendations = [
    readyRecommendation("Supplier A", "S1", "BLR_FC"),
    readyRecommendation("Supplier B", "S2", "DEL_FC"),
  ];
  return {
    id: "batch-grouped", status: "generated", coverage_days: 45, created_at: "2026-08-02", label: "Grouped",
    sales_data: [], inventory_data: [], open_po_data: [], planning_settings: {}, recommendations,
    vendor_master_data: [
      { vendor: "Supplier A", sku: "S1", styleId: "S1", warehouse: "BLR_FC", unitPrice: 1000 },
      { vendor: "Supplier B", sku: "S2", styleId: "S2", warehouse: "DEL_FC", unitPrice: 1000 },
    ],
  } as BatchRow;
}

describe("createDraftPurchaseOrders master-data guard", () => {
  it("rejects a placeholder supplier before any database write", async () => {
    const db = () => { throw new Error("database must not be reached"); };
    await expect(createDraftPurchaseOrders(db, batchWith({}), selection)).rejects.toThrow(/no supplier is mapped/i);
  });

  it("rejects a named supplier that is absent from the saved supplier master", async () => {
    const db = () => { throw new Error("database must not be reached"); };
    const row = { vendor: "Noise Supplier", exceptions: [] };
    const namedSelection = [{ ...selection[0], vendor: "Noise Supplier" }];
    await expect(createDraftPurchaseOrders(db, batchWith(row), namedSelection)).rejects.toThrow(/not mapped/i);
  });

  it("persists every supplier/FC group, claim and audit in one set-based statement", async () => {
    let atomicCalls = 0;
    let atomicSql = "";
    let orderInput: Record<string, unknown>[] = [];
    let claimInput: Record<string, unknown>[] = [];
    const db = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("");
      if (query.includes("SELECT claim_key FROM po_recommendation_claims")) return [];
      if (query.includes("SELECT batch_id,warehouse,lines FROM purchase_orders")) return [];
      if (query.includes("WITH input_orders")) {
        atomicCalls += 1;
        atomicSql = query;
        orderInput = values.find(value => Array.isArray(value) && value.some(row => row?.po_number)) as Record<string, unknown>[];
        claimInput = values.find(value => Array.isArray(value) && value.some(row => row?.claim_key)) as Record<string, unknown>[];
        return orderInput.map(order => ({ id: order.id, claim_count: claimInput.length }));
      }
      throw new Error(`Unexpected query: ${query}`);
    };
    const created = await createDraftPurchaseOrders(db, groupedBatch(), [
      { vendor: "Supplier A", sku: "S1", warehouse: "BLR_FC" },
      { vendor: "Supplier B", sku: "S2", warehouse: "DEL_FC" },
    ]);
    expect(created).toHaveLength(2);
    expect(atomicCalls).toBe(1);
    expect(orderInput).toHaveLength(2);
    expect(claimInput).toHaveLength(2);
    expect(atomicSql).toContain("INSERT INTO purchase_orders");
    expect(atomicSql).toContain("INSERT INTO po_recommendation_claims");
    expect(atomicSql).toContain("INSERT INTO po_events");
  });

  it("surfaces a later-group claim race as one 409-compatible failure from the single statement", async () => {
    let atomicCalls = 0;
    const db = async (strings: TemplateStringsArray) => {
      const query = strings.join("");
      if (query.includes("SELECT claim_key FROM po_recommendation_claims")) return [];
      if (query.includes("SELECT batch_id,warehouse,lines FROM purchase_orders")) return [];
      if (query.includes("WITH input_orders")) {
        atomicCalls += 1;
        throw Object.assign(new Error("duplicate key"), { code: "23505", constraint: "po_recommendation_claims_pkey" });
      }
      throw new Error(`Unexpected query: ${query}`);
    };
    await expect(createDraftPurchaseOrders(db, groupedBatch(), [
      { vendor: "Supplier A", sku: "S1", warehouse: "BLR_FC" },
      { vendor: "Supplier B", sku: "S2", warehouse: "DEL_FC" },
    ])).rejects.toThrow(/converted by another session/i);
    expect(atomicCalls).toBe(1);
  });
});

describe("operational PO delivery date", () => {
  it("never carries a historical planning ETA into a newly created PO", () => {
    expect(operationalExpectedDeliveryDate({ expectedDeliveryDate: "2026-06-15", leadTimeDays: 14 }, "2026-08-02"))
      .toBe("2026-08-16");
  });

  it("keeps a later valid supplier ETA", () => {
    expect(operationalExpectedDeliveryDate({ expectedDeliveryDate: "2026-08-25", leadTimeDays: 14 }, "2026-08-02"))
      .toBe("2026-08-25");
  });
});

describe("execution quantity controls", () => {
  it("enforces mapped MOQ and pack size without changing planning math", () => {
    expect(executionQuantityProblem(40, { moq: 50, packSize: 10 })).toMatch(/MOQ of 50/);
    expect(executionQuantityProblem(55, { moq: 50, packSize: 10 })).toMatch(/pack size of 10/);
    expect(executionQuantityProblem(60, { moq: 50, packSize: 10 })).toBeNull();
  });

  it("builds stable, bounded recommendation claims", () => {
    const key = recommendationClaimKey("batch-1", { vendor: "Supplier", warehouse: "BLR", sku: "S1" });
    expect(key).toBe(recommendationClaimKey("batch-1", { vendor: "Supplier", warehouse: "BLR", sku: "S1" }));
    expect(key).not.toBe(recommendationClaimKey("batch-2", { vendor: "Supplier", warehouse: "BLR", sku: "S1" }));
    expect(key).toBe(recommendationClaimKey("batch-1", { vendor: "Different Supplier", warehouse: "BLR", sku: "S1" }));
    expect(key.length).toBeLessThan(100);
    expect(recommendationClaimRecord("batch-1", { vendor: "Supplier", warehouse: "BLR", sku: "S1" }))
      .toEqual({ claim_key: key });
  });
});
