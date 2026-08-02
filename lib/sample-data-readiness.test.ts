import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseVendorMappingFile } from "./vendor-mapping-files";
import { vendorMappingIssues, vendorMappingStatus } from "./vendor-mappings";

const expectedIncompleteSuppliers = [
  "INDRA FAB PRIVATE LIMITED",
  "KEEV LIFESTYLES PRIVATE LIMITED",
  "Truenet Commerce",
  "WHITE IMPACT",
  "ZEAL BIZFASHION VENTURES PRIVATE LIMITED",
];

describe("generated demo supplier readiness", () => {
  it("keeps an importable, deterministic 80:20 mapping mix", async () => {
    const primary = readFileSync(`${process.cwd()}/sample-data/supplier_mappings.csv`);
    const demo = readFileSync(`${process.cwd()}/sample-data/demo/supplier_mappings.csv`);
    expect(demo.equals(primary)).toBe(true);

    const parsed = await parseVendorMappingFile(primary, "supplier_mappings.csv");
    expect(parsed.report).toMatchObject({ inputRows: 27, acceptedRows: 27, duplicateRowsCollapsed: 0 });

    const mapped = parsed.rows.filter(mapping => vendorMappingStatus(mapping) === "mapped");
    const incomplete = parsed.rows.filter(mapping => vendorMappingStatus(mapping) === "incomplete");
    expect(mapped).toHaveLength(22);
    expect(incomplete).toHaveLength(5);
    expect(incomplete.map(mapping => mapping.vendor).sort()).toEqual(expectedIncompleteSuppliers);
    expect(incomplete.every(mapping => mapping.vendor && mapping.nlc === null && mapping.supplierGstin === null)).toBe(true);
    expect(incomplete.map(mapping => vendorMappingIssues(mapping))).toEqual(Array.from({ length: 5 }, () => [
      "Add a positive INR NLC.",
      "Add the supplier GSTIN.",
    ]));
    expect(mapped.every(mapping => vendorMappingIssues(mapping).length === 0)).toBe(true);
    expect(parsed.rows.every(mapping => [
      mapping.styleId, mapping.productName, mapping.brand, mapping.category, mapping.articleType,
      mapping.vendor, mapping.supplierEmail, mapping.supplierSku, mapping.hsnCode, mapping.supplierState,
      mapping.paymentTerms, mapping.incoterms,
    ].every(value => typeof value === "string" && value.trim().length > 0))).toBe(true);
    expect(parsed.rows.every(mapping => [
      mapping.gstRate, mapping.leadTimeDays, mapping.moq, mapping.packSize,
    ].every(value => typeof value === "number" && Number.isFinite(value)))).toBe(true);

    const statusBySupplier = new Map<string, Set<string>>();
    for (const mapping of parsed.rows) {
      const states = statusBySupplier.get(mapping.vendor!) ?? new Set<string>();
      states.add(vendorMappingStatus(mapping));
      statusBySupplier.set(mapping.vendor!, states);
    }
    const readySuppliers = [...statusBySupplier.values()].filter(states => states.size === 1 && states.has("mapped"));
    expect(statusBySupplier.size).toBe(23);
    expect(readySuppliers).toHaveLength(18);
  });

  it("guards the local Noise workbook seed at exactly 97 of 121 plan styles", () => {
    const config = JSON.parse(readFileSync(`${process.cwd()}/sample-data/methodology/noise_demo_supplier_seed.json`, "utf8"));
    expect(config).toMatchObject({
      seedId: "styleflow-demo-noise-80-v2",
      sourceMarker: "demo_noise_seed_80_v2",
      legacySourceMarkers: ["demo_noise_seed_80_v1"],
      planSyncSourcePrefix: "plan_sync:",
      expectedPlanStyles: 121,
      expectedNoiseStyles: 121,
      targetMappedStyles: 97,
      targetUnresolvedStyles: 24,
    });
    expect(config.targetMappedStyles / config.expectedPlanStyles * 100).toBeCloseTo(80.17, 2);
    expect(config.targetUnresolvedStyles / config.expectedPlanStyles * 100).toBeCloseTo(19.83, 2);
    expect(config.defaults.nlcInr).toBeGreaterThan(0);
    expect(config.defaults.paymentTerms).toBeTruthy();
    expect(config.defaults.incoterms).toBeTruthy();
    const profiles = [config.preservedSupplierProfile, ...config.assignmentProfiles];
    expect(profiles).toHaveLength(4);
    for (const profile of profiles) {
      expect(profile.email).toMatch(/@supplier-demo\.example$/);
      expect(profile.gstin).toMatch(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/);
      expect(profile.state).toBeTruthy();
    }
  });
});
