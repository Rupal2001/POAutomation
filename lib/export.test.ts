import { describe, expect, it } from "vitest";
import { safeSpreadsheetText } from "./export";

describe("planning export safety", () => {
  it("neutralizes upload-controlled spreadsheet formulas", () => {
    expect(safeSpreadsheetText("=HYPERLINK(\"https://example.test\")")).toBe("'=HYPERLINK(\"https://example.test\")");
    expect(safeSpreadsheetText("+1+1")).toBe("'+1+1");
    expect(safeSpreadsheetText("@SUM(A1:A2)")).toBe("'@SUM(A1:A2)");
    expect(safeSpreadsheetText("Noise Buds")).toBe("Noise Buds");
  });
});
