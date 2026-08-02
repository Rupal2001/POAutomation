export const PO_REVISION_REQUIRED = "PO_REVISION_REQUIRED" as const;
export const INVALID_PO_REVISION = "INVALID_PO_REVISION" as const;
export const STALE_PO_REVISION = "STALE_PO_REVISION" as const;

// PostgreSQL INTEGER tops out at 2,147,483,647. Keep one value available for
// the atomic `revision = revision + 1` performed by a successful mutation.
export const MAX_EXPECTED_PO_REVISION = 2_147_483_646;

export type PoRevisionValidation =
  | { ok: true; value: number }
  | {
      ok: false;
      status: 400 | 428;
      code: typeof PO_REVISION_REQUIRED | typeof INVALID_PO_REVISION;
      message: string;
    };

/**
 * Validates the optimistic-concurrency token returned by the PO detail API.
 * Numeric strings are intentionally rejected: JSON clients must echo the
 * integer token without transforming it.
 */
export function validateExpectedPoRevision(value: unknown): PoRevisionValidation {
  if (value === undefined || value === null) {
    return {
      ok: false,
      status: 428,
      code: PO_REVISION_REQUIRED,
      message: "Reload this purchase order before changing it; its edit version is missing.",
    };
  }
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
    || value > MAX_EXPECTED_PO_REVISION
  ) {
    return {
      ok: false,
      status: 400,
      code: INVALID_PO_REVISION,
      message: "Reload this purchase order before changing it; its edit version is invalid.",
    };
  }
  return { ok: true, value };
}

