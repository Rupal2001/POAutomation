import { describe, expect, it } from "vitest";
import type { PurchaseOrderRow } from "./db";
import { canonicalIsoCalendarDate, purchaseOrderSendMissing, purchaseOrderSendReadinessDecision, purchaseOrderSendReadinessOverrideAudit } from "./po-readiness";

function order(overrides: Partial<PurchaseOrderRow> = {}): PurchaseOrderRow {
  return {
    id: "po-1", po_number: "PO-1", batch_id: null, vendor: "Supplier", warehouse: "BLR", status: "approved",
    order_date: "2026-08-01", expected_delivery_date: "2026-08-10", currency: "INR", payment_terms: null,
    incoterms: null, ship_to: "Myntra FC", bill_to: null, notes: null, supplier_email: "supplier@example.com",
    supplier_gstin: "29ABCDE1234F1Z5", buyer_gstin: "29AAAAA0000A1Z5", supplier_state: "Karnataka",
    buyer_state: "Karnataka", place_of_supply: "Karnataka",
    lines: [{ lineId: "l1", sku: "S1", quantity: 2, receivedQty: 0, unitPrice: 100, currency: "INR", hsnCode: "8518" }],
    subtotal: 200, freight: 0, discount: 0, tax: 0, total: 200, created_by: "Planner", created_by_user_id: "u1",
    approved_by: "Approver", approved_by_user_id: "u2", approved_at: "2026-08-01", issued_at: null,
    closed_at: null, revision: 1, created_at: "2026-08-01", updated_at: "2026-08-01", ...overrides,
  };
}

describe("PO send readiness", () => {
  it("canonicalizes PostgreSQL DATE values without a timezone shift", () => {
    expect(canonicalIsoCalendarDate("2026-08-16T00:00:00.000Z")).toBe("2026-08-16");
    expect(canonicalIsoCalendarDate(new Date("2026-08-16T00:00:00.000Z"))).toBe("2026-08-16");
    expect(canonicalIsoCalendarDate("2026-02-30T00:00:00.000Z")).toBeNull();
  });

  it("accepts driver-returned ISO timestamps in send readiness", () => {
    expect(purchaseOrderSendMissing(order({
      order_date: "2026-08-01T00:00:00.000Z",
      expected_delivery_date: "2026-08-16T00:00:00.000Z",
    }), "2026-08-02")).toEqual([]);
  });

  it("accepts a commercially complete order", () => {
    expect(purchaseOrderSendMissing(order(), "2026-08-02")).toEqual([]);
  });

  it("reports missing legal and line details", () => {
    expect(purchaseOrderSendMissing(order({ buyer_gstin: null, lines: [] }), "2026-08-02")).toEqual([
      "buyer GSTIN",
      "at least one order line",
    ]);
  });

  it("blocks an ETA before the order date or current operating date", () => {
    expect(purchaseOrderSendMissing(order({ order_date: "2026-08-10", expected_delivery_date: "2026-08-09" }), "2026-08-02"))
      .toContain("expected delivery date on or after the PO date");
    expect(purchaseOrderSendMissing(order({ order_date: "2026-07-01", expected_delivery_date: "2026-07-20" }), "2026-08-02"))
      .toContain("expected delivery date that is not in the past");
  });

  it("keeps missing send details blocked for non-Admin roles", () => {
    expect(purchaseOrderSendReadinessDecision("planner", ["buyer GSTIN", "ship-to address"], true, "Urgent business exception"))
      .toEqual({ ok: false, status: 400, error: "This PO is not ready to send. Add buyer GSTIN and ship-to address." });
  });

  it("requires an explicit Admin confirmation and meaningful reason", () => {
    expect(purchaseOrderSendReadinessDecision("admin", ["buyer GSTIN"], false, "Urgent business exception"))
      .toMatchObject({ ok: false, error: expect.stringMatching(/Confirm the Admin/i) });
    expect(purchaseOrderSendReadinessDecision("admin", ["buyer GSTIN"], true, "urgent"))
      .toMatchObject({ ok: false, error: expect.stringMatching(/meaningful Admin override reason/i) });
    expect(purchaseOrderSendReadinessDecision("admin", ["buyer GSTIN"], true, "1234567890"))
      .toMatchObject({ ok: false, error: expect.stringMatching(/two words/i) });
  });

  it("returns the exact missing-field snapshot for an audited Admin override", () => {
    const decision = purchaseOrderSendReadinessDecision("admin", ["buyer GSTIN", "HSN code on every line"], true, "Supplier dispatch approved by finance");
    expect(decision).toEqual({ ok: true, override: {
      missingFields: ["buyer GSTIN", "HSN code on every line"],
      reason: "Supplier dispatch approved by finance",
    } });
    expect(decision.ok && purchaseOrderSendReadinessOverrideAudit(decision.override, { id: "admin-1", displayName: "Buying Admin", role: "admin" }))
      .toEqual({
        missingFields: ["buyer GSTIN", "HSN code on every line"],
        reason: "Supplier dispatch approved by finance",
        actor: { id: "admin-1", displayName: "Buying Admin", role: "admin" },
      });
    expect(purchaseOrderSendReadinessOverrideAudit(null, { id: "admin-1", displayName: "Buying Admin", role: "admin" })).toBeNull();
    expect(purchaseOrderSendReadinessDecision("planner", [], false, ""))
      .toEqual({ ok: true, override: null });
  });
});
