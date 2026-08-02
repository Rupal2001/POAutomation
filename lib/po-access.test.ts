import { describe, expect, it } from "vitest";
import {
  canCreatePurchaseOrder,
  canEditPurchaseOrder,
  canEmailPurchaseOrder,
  canOverridePurchaseOrderSendReadiness,
  canReceivePurchaseOrder,
  canTransitionPurchaseOrder,
  needsSeniorApproval,
  canApproveOwnPurchaseOrder,
  purchaseOrderQueuePermissions,
} from "./po-access";

describe("purchase-order role controls", () => {
  it("keeps buying mutations with planners and administrators", () => {
    expect(canCreatePurchaseOrder("planner")).toBe(true);
    expect(canEditPurchaseOrder("planner")).toBe(true);
    expect(canEmailPurchaseOrder("planner")).toBe(true);
    expect(canCreatePurchaseOrder("viewer")).toBe(false);
    expect(canEmailPurchaseOrder("approver")).toBe(false);
    expect(canOverridePurchaseOrderSendReadiness("admin")).toBe(true);
    expect(canOverridePurchaseOrderSendReadiness("planner")).toBe(false);
    expect(canOverridePurchaseOrderSendReadiness("senior_approver")).toBe(false);
  });

  it("separates approval and receiving duties", () => {
    expect(canTransitionPurchaseOrder("approver", "pending_approval", "approved")).toBe(true);
    expect(canTransitionPurchaseOrder("planner", "pending_approval", "approved")).toBe(false);
    expect(canReceivePurchaseOrder("receiver")).toBe(true);
    expect(canReceivePurchaseOrder("planner")).toBe(false);
  });

  it("requires a senior approver for high-value orders", () => {
    expect(needsSeniorApproval("approver")).toBe(true);
    expect(needsSeniorApproval("senior_approver")).toBe(false);
    expect(needsSeniorApproval("admin")).toBe(false);
  });

  it("allows every authorised approver to approve a PO they created", () => {
    expect(canApproveOwnPurchaseOrder("admin")).toBe(true);
    expect(canApproveOwnPurchaseOrder("approver")).toBe(true);
    expect(canApproveOwnPurchaseOrder("senior_approver")).toBe(true);
    expect(canApproveOwnPurchaseOrder("planner")).toBe(false);
  });

  it("exposes only role-eligible pending-approval queue actions", () => {
    expect(purchaseOrderQueuePermissions("approver", "pending_approval"))
      .toEqual({ canApprove: true, canReturnToDraft: true });
    expect(purchaseOrderQueuePermissions("senior_approver", "pending_approval"))
      .toEqual({ canApprove: true, canReturnToDraft: true });
    expect(purchaseOrderQueuePermissions("planner", "pending_approval"))
      .toEqual({ canApprove: false, canReturnToDraft: false });
    expect(purchaseOrderQueuePermissions("admin", "draft"))
      .toEqual({ canApprove: false, canReturnToDraft: false });
  });
});
