import { describe, expect, it } from "vitest";
import { validateAccount } from "./admin-users";

describe("administrator account validation", () => {
  const account = { username: "planner.one", displayName: "Planner One", email: "planner@example.com", role: "planner" as const };

  it("rejects default or username-based temporary credentials", () => {
    expect(validateAccount({ ...account, temporaryPassword: "planner.one" })).toMatch(/cannot be the username/);
    expect(validateAccount({ ...account, temporaryPassword: "admin" })).toMatch(/between 10 and 200/);
  });

  it("accepts a distinct temporary password", () => {
    expect(validateAccount({ ...account, temporaryPassword: "Temp-Password-2026" })).toBe("");
  });
});
