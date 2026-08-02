import { describe, expect, it } from "vitest";
import { buildVendorMappingCsv, parseVendorMappingFile, VendorMappingFileError } from "./vendor-mapping-files";
import type { VendorMappingRecord } from "./vendor-mappings";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("supplier mapping files", () => {
  it("parses CSV aliases and collapses identical duplicate rows", async () => {
    const csv = "Style ID,Vendor,NLC INR,Supplier Email,Supplier SKU,HSN Code,GST Rate,Supplier GSTIN,Supplier State,Lead Time Days,MOQ,Pack Size\n"
      + "123,Supplier A,799,supplier@example.com,SUP-1,8518,18,29ABCDE1234F1Z5,Karnataka,14,10,5\n"
      + "123,Supplier A,799,supplier@example.com,SUP-1,8518,18,29ABCDE1234F1Z5,Karnataka,14,10,5\n";
    const result = await parseVendorMappingFile(bytes(csv), "mapping.csv");
    expect(result.rows).toHaveLength(1);
    expect(result.report).toMatchObject({ inputRows: 2, acceptedRows: 1, duplicateRowsCollapsed: 1 });
  });

  it("rejects conflicting duplicate authority rows", async () => {
    const csv = "Style ID,Vendor,NLC INR\n123,Supplier A,799\n123,Supplier A,899\n";
    await expect(parseVendorMappingFile(bytes(csv), "mapping.csv")).rejects.toBeInstanceOf(VendorMappingFileError);
  });

  it("neutralizes spreadsheet formulas in CSV exports", () => {
    const row = {
      id: "m1", mappingKey: "1::::supplier", styleId: "1", productName: "=WEBSERVICE(\"bad\")", brand: "Noise",
      category: "Audio", articleType: "Headphones", vendor: "Supplier", supplierEmail: null, supplierSku: null,
      nlc: null, hsnCode: null, gstRate: null, supplierGstin: null, supplierState: null, leadTimeDays: null,
      paymentTerms: null, incoterms: null, moq: null, packSize: null, source: "manual", revision: 1,
      createdAt: "2026-08-01", updatedAt: "2026-08-01",
    } satisfies VendorMappingRecord;
    expect(buildVendorMappingCsv([row])).toContain("'=WEBSERVICE");
  });
});
