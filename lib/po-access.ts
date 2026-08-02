import type { UserRole } from "./session";

const BUYER_ROLES: readonly UserRole[] = ["admin", "planner"];
const APPROVER_ROLES: readonly UserRole[] = ["admin", "approver", "senior_approver"];

export function canCreatePurchaseOrder(role: UserRole) {
  return BUYER_ROLES.includes(role);
}

export function canEditPurchaseOrder(role: UserRole) {
  return BUYER_ROLES.includes(role);
}

export function canEmailPurchaseOrder(role: UserRole) {
  return BUYER_ROLES.includes(role);
}

export function canOverridePurchaseOrderSendReadiness(role: UserRole) {
  return role === "admin";
}

export function canReceivePurchaseOrder(role: UserRole) {
  return role === "admin" || role === "receiver";
}

export function canTransitionPurchaseOrder(role: UserRole, from: string, to: string) {
  if (role === "admin") return true;
  if (to === "approved") return APPROVER_ROLES.includes(role);
  if (to === "pending_approval" || to === "issued" || to === "closed") {
    return role === "planner";
  }
  if (to === "draft") {
    return from === "pending_approval"
      ? APPROVER_ROLES.includes(role)
      : role === "planner" || APPROVER_ROLES.includes(role);
  }
  if (to === "cancelled") {
    return role === "planner" || APPROVER_ROLES.includes(role);
  }
  return false;
}

export function needsSeniorApproval(role: UserRole) {
  return role !== "admin" && role !== "senior_approver";
}

export function canApproveOwnPurchaseOrder(role: UserRole) {
  return APPROVER_ROLES.includes(role);
}

/**
 * Coarse role visibility for queue actions. The revisioned PATCH endpoint is
 * still authoritative for non-Admin maker-checker, value thresholds and current state.
 */
export function purchaseOrderQueuePermissions(role: UserRole, status: string) {
  return {
    canApprove: status === "pending_approval" && canTransitionPurchaseOrder(role, status, "approved"),
    canReturnToDraft: status === "pending_approval" && canTransitionPurchaseOrder(role, status, "draft"),
  };
}
