import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enrichStyleDetailsWithMappings,
  loadVendorMappingsForStyles,
  mergeVendorMasterMappings,
  normalizeVendorMappingInput,
  vendorMappingStatus,
  vendorMappingIssues,
  type VendorMappingRecord,
} from "./vendor-mappings";

afterEach(() => vi.unstubAllEnvs());

function record(overrides: Partial<VendorMappingRecord> = {}): VendorMappingRecord {
  return {
    id: "m1", mappingKey: "1::::supplier a", styleId: "1", productName: "Noise Buds", brand: "Noise",
    category: "Audio", articleType: "Headphones", vendor: "Supplier A", supplierEmail: "supplier@example.com",
    supplierSku: "SUP-1", nlc: 799, hsnCode: "8518", gstRate: 18, supplierGstin: "29ABCDE1234F1Z5",
    supplierState: "Karnataka", leadTimeDays: 14, paymentTerms: "Net 30", incoterms: "DAP", moq: 10,
    packSize: 5, source: "manual", revision: 2, createdAt: "2026-08-01", updatedAt: "2026-08-02", ...overrides,
  };
}

describe("supplier mapping master", () => {
  it("canonicalizes Indian commercial fields and derives readiness", () => {
    const mapping = normalizeVendorMappingInput({
      styleId: " 123 ", vendor: " Supplier A ", supplierEmail: "SUPPLIER@EXAMPLE.COM", nlc: "₹1,299",
      supplierSku: "SUP-123", hsnCode: "8518", gstRate: "18", supplierGstin: "29abcde1234f1z5",
      supplierState: "Karnataka", leadTimeDays: "14", moq: "10", packSize: "5",
    });
    expect(mapping).toMatchObject({ styleId: "123", vendor: "Supplier A", supplierEmail: "supplier@example.com", nlc: 1299, supplierGstin: "29ABCDE1234F1Z5" });
    expect(vendorMappingStatus(mapping)).toBe("mapped");
    expect(vendorMappingIssues(mapping)).toEqual([]);
  });

  it("treats placeholder suppliers as unmapped", () => {
    const mapping = normalizeVendorMappingInput({ styleId: "1", vendor: "Supplier mapping required" });
    expect(mapping.vendor).toBeNull();
    expect(vendorMappingStatus(mapping)).toBe("unmapped");
  });

  it("does not silently choose among multiple suppliers for a source with no supplier", () => {
    const base = [{ styleId: "1", sku: "1", vendor: "Supplier mapping required", productName: "Noise Buds", unitPrice: 700 }];
    const mappings = [record(), record({ id: "m2", mappingKey: "1::::supplier b", vendor: "Supplier B" })];
    expect(mergeVendorMasterMappings(base, mappings).map(row => row.vendor)).toEqual(["Supplier mapping required"]);
    expect(mergeVendorMasterMappings(base, mappings, { includeMultipleSupplierCandidates: true }).map(row => row.vendor).sort())
      .toEqual(["Supplier A", "Supplier B"]);
  });

  it("enriches an uploaded style only when its supplier choice is unambiguous", () => {
    const details = [{ styleId: "1", model: "Noise Buds", mrpInr: 1999, nlcInr: 900 }];
    expect(enrichStyleDetailsWithMappings(details, [record()])[0]).toMatchObject({ vendorName: "Supplier A", nlcInr: 799, packSize: 5 });
    expect(enrichStyleDetailsWithMappings(details, [record(), record({ id: "m2", vendor: "Supplier B" })])[0].vendorName).toBeUndefined();
  });

  it("binds local PostgreSQL style filters as JSON rather than a string scalar", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://styleflow@localhost:5432/styleflow_test");
    const boundValues: unknown[] = [];
    const db = async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      boundValues.push(...values);
      return [];
    };

    await loadVendorMappingsForStyles(db, ["1001", "1002", "1001"]);

    expect(boundValues[0]).toEqual(["1001", "1002"]);
  });
});
