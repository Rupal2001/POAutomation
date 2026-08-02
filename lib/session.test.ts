import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertAuthConfiguration,
  createSessionToken,
  hashPassword,
  verifyPassword,
  verifySessionToken,
  type SessionUser,
} from "./session";

const user: SessionUser = {
  id: "user-1",
  username: "admin",
  displayName: "Administrator",
  email: null,
  role: "admin",
  mustChangePassword: true,
  sessionVersion: 1,
  lastLoginAt: null,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("password hashing", () => {
  it("uses a unique salt and verifies only the correct password", async () => {
    const first = await hashPassword("correct horse battery staple");
    const second = await hashPassword("correct horse battery staple");

    expect(first).not.toBe(second);
    expect(await verifyPassword("correct horse battery staple", first)).toBe(true);
    expect(await verifyPassword("wrong password", first)).toBe(false);
    expect(await verifyPassword("correct horse battery staple", "not-a-password-hash")).toBe(false);
  });
});

describe("signed sessions", () => {
  it("verifies an intact, unexpired token", () => {
    vi.stubEnv("AUTH_SECRET", "test-secret-that-is-long-enough-for-local-use");
    const token = createSessionToken(user, { now: 1_000, ttlSeconds: 60 });

    expect(verifySessionToken(token, { now: 1_030 })).toMatchObject({
      sub: "user-1",
      role: "admin",
      sessionVersion: 1,
      exp: 1_060,
    });
  });

  it("rejects expired and tampered tokens", () => {
    vi.stubEnv("AUTH_SECRET", "test-secret-that-is-long-enough-for-local-use");
    const token = createSessionToken(user, { now: 1_000, ttlSeconds: 60 });
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

    expect(verifySessionToken(token, { now: 1_060 })).toBeNull();
    expect(verifySessionToken(tampered, { now: 1_030 })).toBeNull();
  });

  it("fails closed on a weak production secret", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_SECRET", "too-short");
    expect(() => assertAuthConfiguration()).toThrow(/at least 32 characters/);
  });
});
