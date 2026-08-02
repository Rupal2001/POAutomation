import { describe, expect, it } from "vitest";
import { calculateTotals, canTransition, nonNegativeMoney, normalizePurchaseOrderLines, preservePurchaseOrderLineControls, purchaseOrderLineValidationError } from "./purchase-orders";

describe("purchase order workflow", () => {
  it("calculates commercial totals", () => {
    expect(calculateTotals([{ lineId: "1", sku: "A", quantity: 10, receivedQty: 0, unitPrice: 400, currency: "INR" }], 500, 200, 300)).toEqual({ subtotal: 4000, total: 4600 });
  });
  it("enforces approval before issue", () => {
    expect(canTransition("draft", "issued")).toBe(false);
    expect(canTransition("draft", "pending_approval")).toBe(true);
    expect(canTransition("approved", "issued")).toBe(true);
  });
  it("rejects unsafe draft line quantities, prices, taxes and currencies", () => {
    const valid = { lineId: "1", sku: "A", quantity: 10, receivedQty: 0, unitPrice: 400, currency: "INR", gstRate: 18, hsnCode: "8518" };
    expect(purchaseOrderLineValidationError([valid])).toBeNull();
    expect(purchaseOrderLineValidationError([{ ...valid, quantity: 1.5 }])).toMatch(/whole-unit/);
    expect(purchaseOrderLineValidationError([{ ...valid, unitPrice: -1 }])).toMatch(/unit cost/);
    expect(purchaseOrderLineValidationError([{ ...valid, gstRate: 101 }])).toMatch(/GST/);
    expect(purchaseOrderLineValidationError([{ ...valid, currency: "USD" }])).toMatch(/INR/);
    expect(purchaseOrderLineValidationError([valid, { ...valid, sku: "B" }])).toMatch(/appears more than once/);
    expect(purchaseOrderLineValidationError([{ ...valid, expectedDeliveryDate: "2026-02-30" }])).toMatch(/delivery date/);
    expect(purchaseOrderLineValidationError([{ ...valid, quantity: 80, moq: 100, packSize: 20 }])).toMatch(/MOQ of 100/);
    expect(purchaseOrderLineValidationError([{ ...valid, quantity: 110, moq: 100, packSize: 20 }])).toMatch(/pack size of 20/);
    expect(purchaseOrderLineValidationError([{ ...valid, quantity: 120, moq: 100, packSize: 20 }])).toBeNull();
  });
  it("canonicalizes client line scalars and discards unknown properties", () => {
    expect(normalizePurchaseOrderLines([{ lineId: " 1 ", sku: " A ", quantity: "10", receivedQty: "0", unitPrice: "400", currency: "inr", ignored: "secret" }]))
      .toEqual([{ lineId: "1", sku: "A", supplierSku: undefined, description: undefined, quantity: 10, receivedQty: 0, unitPrice: 400, currency: "INR", expectedDeliveryDate: undefined, hsnCode: undefined, gstRate: 0, moq: undefined, packSize: undefined, overrideReason: undefined, sourceRecommendation: undefined }]);
  });
  it("preserves persisted supplier controls when a draft-edit payload omits or weakens them", () => {
    const persisted = [{ lineId: "1", sku: "A", quantity: 120, receivedQty: 0, unitPrice: 400, currency: "INR", moq: 100, packSize: 20 }];
    const edited = normalizePurchaseOrderLines([{ ...persisted[0], quantity: 90, moq: 1, packSize: 1 }]) as any[];
    const protectedLines = preservePurchaseOrderLineControls(edited, persisted);
    expect(protectedLines[0]).toMatchObject({ quantity: 90, moq: 100, packSize: 20 });
    expect(purchaseOrderLineValidationError(protectedLines)).toMatch(/MOQ of 100/);
  });
  it("validates non-negative monetary adjustments", () => {
    expect(nonNegativeMoney("125.50", "Freight")).toBe(125.5);
    expect(() => nonNegativeMoney(-1, "Freight")).toThrow(/non-negative/);
  });
});
