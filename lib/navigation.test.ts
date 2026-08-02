import { describe, expect, it } from "vitest";
import { isNavigationActive } from "./navigation";

describe("navigation route matching", () => {
  it("keeps Review orders active on the stable entry and plan detail routes", () => {
    expect(isNavigationActive("/review-orders", "/review-orders")).toBe(true);
    expect(isNavigationActive("/results/batch-123", "/review-orders")).toBe(true);
  });

  it("does not mark Review orders active on unrelated routes", () => {
    expect(isNavigationActive("/purchase-orders", "/review-orders")).toBe(false);
    expect(isNavigationActive("/results", "/review-orders")).toBe(false);
  });

  it("matches ordinary destinations only at route boundaries", () => {
    expect(isNavigationActive("/history/compare", "/history")).toBe(true);
    expect(isNavigationActive("/history-old", "/history")).toBe(false);
  });

  it("keeps the plan builder active only at the root route", () => {
    expect(isNavigationActive("/", "/")).toBe(true);
    expect(isNavigationActive("/dashboard", "/")).toBe(false);
  });
});
