import { describe, expect, it } from "vitest";
import {
  INVALID_PO_REVISION,
  MAX_EXPECTED_PO_REVISION,
  PO_REVISION_REQUIRED,
  validateExpectedPoRevision,
} from "./po-revision";

describe("purchase-order revision preconditions", () => {
  it("accepts positive PostgreSQL integer revisions that can still be incremented", () => {
    expect(validateExpectedPoRevision(1)).toEqual({ ok: true, value: 1 });
    expect(validateExpectedPoRevision(MAX_EXPECTED_PO_REVISION)).toEqual({
      ok: true,
      value: MAX_EXPECTED_PO_REVISION,
    });
  });

  it("requires clients to echo the revision returned by the detail API", () => {
    expect(validateExpectedPoRevision(undefined)).toMatchObject({
      ok: false,
      status: 428,
      code: PO_REVISION_REQUIRED,
    });
    expect(validateExpectedPoRevision(null)).toMatchObject({
      ok: false,
      status: 428,
      code: PO_REVISION_REQUIRED,
    });
  });

  it.each([0, -1, 1.5, "1", "", Number.NaN, Number.POSITIVE_INFINITY, MAX_EXPECTED_PO_REVISION + 1])(
    "rejects invalid revision value %s",
    value => {
      expect(validateExpectedPoRevision(value)).toMatchObject({
        ok: false,
        status: 400,
        code: INVALID_PO_REVISION,
      });
    },
  );
});

