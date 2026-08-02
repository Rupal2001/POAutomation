import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BatchRow } from "./db";
import type { Recommendation } from "./po-engine";
import {
  normalizeDraftSupplierMapping,
  resolveSupplierAndCreateDraft,
  selectSupplierResolutionRecommendation,
  supplierMappingChanged,
  SupplierResolutionError,
} from "./resolve-supplier-po";
import type { VendorMappingRecord } from "./vendor-mappings";

afterEach(() => vi.unstubAllEnvs());
beforeEach(() => vi.stubEnv("DATABASE_URL", "postgresql://styleflow@localhost:5432/styleflow_test"));

function recommendation(overrides: Partial<Recommendation> = {}) {
  return {
    marketplace: "Myntra", vendor: "Supplier mapping required", sku: "S1", styleId: "S1", warehouse: "BLR_FC",
    productName: "Noise Airwave Max 5", brand: "Noise", category: "Audio", articleType: "Headphones", mrpInr: 4999,
    suggestedPoQty: 60, signedPoQtyAsk: 60, dohEligible: true, calculationMethod: "style_drr_cover_v1",
    unitPrice: null, currency: "INR", leadTimeDays: 14, expectedDeliveryDate: "2026-08-20",
    dailyRunRate: 5, safetyStock: 0, inventoryPosition: 20, explanation: "Signed ask from the approved method.",
    exceptions: [
      { code: "MISSING_VENDOR", severity: "critical", message: "Map supplier." },
      { code: "MISSING_PRICE", severity: "critical", message: "Add NLC." },
    ],
    ...overrides,
  } as Recommendation;
}

function batch(rows = [recommendation()]): BatchRow {
  return {
    id: "batch-1", status: "generated", coverage_days: 45, label: "Plan", created_at: "2026-08-02",
    sales_data: [], inventory_data: [], open_po_data: [], vendor_master_data: [], planning_settings: {}, recommendations: rows,
  };
}

function mapping(overrides: Partial<VendorMappingRecord> = {}): VendorMappingRecord {
  return {
    id: "map-1", mappingKey: "s1::::supplier a", styleId: "S1", productName: "Noise Airwave Max 5", brand: "Noise",
    category: "Audio", articleType: "Headphones", vendor: "Supplier A", supplierEmail: null, supplierSku: null,
    nlc: 1200, hsnCode: null, gstRate: null, supplierGstin: null, supplierState: null, leadTimeDays: null,
    paymentTerms: null, incoterms: null, moq: null, packSize: null, source: "manual", revision: 3,
    createdAt: "2026-08-01", updatedAt: "2026-08-02", ...overrides,
  };
}

function dbRow(value: VendorMappingRecord) {
  return {
    id: value.id, mapping_key: value.mappingKey, style_id: value.styleId, product_name: value.productName, brand: value.brand,
    category: value.category, article_type: value.articleType, vendor: value.vendor, supplier_email: value.supplierEmail,
    supplier_sku: value.supplierSku, nlc_inr: value.nlc, hsn_code: value.hsnCode, gst_rate: value.gstRate,
    supplier_gstin: value.supplierGstin, supplier_state: value.supplierState, lead_time_days: value.leadTimeDays,
    payment_terms: value.paymentTerms, incoterms: value.incoterms, moq: value.moq, pack_size: value.packSize,
    source: value.source, revision: value.revision, created_at: value.createdAt, updated_at: value.updatedAt,
  };
}

describe("inline supplier resolution", () => {
  it("requires only a real supplier and positive INR NLC for a draft", () => {
    const value = normalizeDraftSupplierMapping({ vendor: "Supplier A", nlc: "₹1,200" }, recommendation());
    expect(value).toMatchObject({ vendor: "Supplier A", nlc: 1200, supplierEmail: null, moq: null, packSize: null });
  });

  it("rejects a non-INR cost and missing minimum fields with stable codes", () => {
    expect(() => normalizeDraftSupplierMapping({ vendor: "Supplier A", nlc: 100, currency: "USD" }, recommendation()))
      .toThrowError(expect.objectContaining({ code: "NON_INR_SUPPLIER_COST", status: 422 }));
    expect(() => normalizeDraftSupplierMapping({ vendor: "Unassigned" }, recommendation()))
      .toThrowError(expect.objectContaining({ code: "SUPPLIER_DETAILS_INCOMPLETE", status: 422 }));
  });

  it("never guesses when the recommendation identity is ambiguous", () => {
    const rows = [recommendation(), recommendation({ warehouse: "DEL_FC" })];
    expect(() => selectSupplierResolutionRecommendation(batch(rows), { sku: "S1" }))
      .toThrowError(expect.objectContaining({ code: "AMBIGUOUS_RECOMMENDATION", status: 409 }));
    expect(selectSupplierResolutionRecommendation(batch(rows), { sku: "S1", warehouse: "DEL_FC" }).warehouse).toBe("DEL_FC");
  });

  it("preserves omitted staged fields and detects a governed commercial change", () => {
    const current = mapping();
    const unchanged = normalizeDraftSupplierMapping({ mappingId: current.id, expectedRevision: 3 }, recommendation(), current);
    expect(supplierMappingChanged(current, unchanged)).toBe(false);
    const changed = normalizeDraftSupplierMapping({ nlc: 1250 }, recommendation(), current);
    expect(supplierMappingChanged(current, changed)).toBe(true);
  });

  it("rejects stale mapping revisions before any PO or claim query", async () => {
    let calls = 0;
    const current = mapping();
    const db = async (strings: TemplateStringsArray) => {
      calls += 1;
      if (strings.join("").includes("FROM supplier_style_mappings")) return [dbRow(current)];
      throw new Error("No later query should run for a stale mapping.");
    };
    await expect(resolveSupplierAndCreateDraft(db, batch(), {
      batchId: "batch-1", selection: { sku: "S1", warehouse: "BLR_FC" },
      mapping: { mappingId: current.id, expectedRevision: 2 },
    }, { id: "planner-1", displayName: "Planner" }))
      .rejects.toMatchObject({ code: "STALE_VENDOR_MAPPING_REVISION", status: 409 });
    expect(calls).toBe(1);
  });

  it("requires an explicit mapping ID when supplier candidates exist", async () => {
    const rows = [mapping(), mapping({ id: "map-2", mappingKey: "s1::::supplier b", vendor: "Supplier B", revision: 1 })];
    const db = async (strings: TemplateStringsArray) => strings.join("").includes("FROM supplier_style_mappings") ? rows.map(dbRow) : [];
    await expect(resolveSupplierAndCreateDraft(db, batch(), {
      batchId: "batch-1", selection: { sku: "S1", warehouse: "BLR_FC" }, mapping: { vendor: "Supplier A", nlc: 1200 },
    }, { id: "planner-1", displayName: "Planner" }))
      .rejects.toMatchObject({ code: "AMBIGUOUS_SUPPLIER_MAPPING", status: 409 });
  });

  it("does not let supplier resolution bypass a hard methodology gate", async () => {
    const db = async () => [];
    await expect(resolveSupplierAndCreateDraft(db, batch([recommendation({ dohEligible: false })]), {
      batchId: "batch-1", selection: { sku: "S1", warehouse: "BLR_FC" }, mapping: { vendor: "Supplier A", nlc: 1200 },
    }, { id: "planner-1", displayName: "Planner" }))
      .rejects.toMatchObject({ code: "RECOMMENDATION_NOT_PO_READY", status: 409 });
  });

  it("resolves the importer NLC-only metadata flag when model and MRP are already proven", async () => {
    const nlcOnly = recommendation({
      exceptions: [
        { code: "MISSING_STYLE_METADATA", severity: "critical", message: "Style detail was incomplete." },
        { code: "MISSING_VENDOR", severity: "critical", message: "Map supplier." },
        { code: "MISSING_PRICE", severity: "critical", message: "Add NLC." },
      ],
    });
    const db = async (strings: TemplateStringsArray) => {
      const query = strings.join("");
      if (query.includes("WITH updated_mapping")) {
        return [{ id: "po-nlc", po_number: "MYN-PO-NLC", status: "draft", total: 72_000, mapping_revision: 1, mapping_created_at: "2026-08-02", mapping_updated_at: "2026-08-02", claim_count: 1 }];
      }
      return [];
    };
    const result = await resolveSupplierAndCreateDraft(db, batch([nlcOnly]), {
      batchId: "batch-1", selection: { sku: "S1", warehouse: "BLR_FC" }, mapping: { vendor: "Supplier A", nlc: 1200 },
    }, { id: "planner-1", displayName: "Planner" });
    expect(result.purchaseOrder).toMatchObject({ id: "po-nlc", status: "draft" });
  });

  it.each([
    { label: "model", productName: "", mrpInr: 4999 },
    { label: "MRP", productName: "Noise Airwave Max 5", mrpInr: 0 },
  ])("preserves the hard metadata block when $label is missing", async ({ productName, mrpInr }) => {
    const incomplete = recommendation({
      productName,
      mrpInr,
      exceptions: [
        { code: "MISSING_STYLE_METADATA", severity: "critical", message: "Style detail was incomplete." },
        { code: "MISSING_VENDOR", severity: "critical", message: "Map supplier." },
        { code: "MISSING_PRICE", severity: "critical", message: "Add NLC." },
      ],
    });
    let calls = 0;
    const db = async () => { calls += 1; return []; };
    await expect(resolveSupplierAndCreateDraft(db, batch([incomplete]), {
      batchId: "batch-1", selection: { sku: "S1", warehouse: "BLR_FC" }, mapping: { vendor: "Supplier A", nlc: 1200 },
    }, { id: "planner-1", displayName: "Planner" })).rejects.toMatchObject({ code: "RECOMMENDATION_NOT_PO_READY", status: 409 });
    expect(calls).toBe(1);
  });

  it("creates one atomic draft with an incomplete but draft-ready mapping", async () => {
    const queryKinds: string[] = [];
    const db = async (strings: TemplateStringsArray) => {
      const query = strings.join("");
      if (query.includes("WITH updated_mapping")) {
        queryKinds.push("atomic-create");
        return [{ id: "po-1", po_number: "MYN-PO-1", status: "draft", total: 72_000, mapping_revision: 1, mapping_created_at: "2026-08-02", mapping_updated_at: "2026-08-02", claim_count: 1 }];
      }
      if (query.includes("FROM supplier_style_mappings")) { queryKinds.push("mapping"); return []; }
      if (query.includes("FROM po_recommendation_claims")) { queryKinds.push("claim-check"); return []; }
      if (query.includes("FROM purchase_orders")) { queryKinds.push("po-check"); return []; }
      throw new Error(`Unexpected query: ${query}`);
    };
    const result = await resolveSupplierAndCreateDraft(db, batch(), {
      batchId: "batch-1", selection: { sku: "S1", warehouse: "BLR_FC" }, mapping: { vendor: "Supplier A", nlc: 1200 },
    }, { id: "planner-1", displayName: "Planner" });
    expect(result.purchaseOrder).toMatchObject({ id: "po-1", status: "draft", currency: "INR" });
    expect(result.mapping).toMatchObject({ revision: 1, status: "incomplete" });
    expect(result.dispatchReadiness.ready).toBe(false);
    expect(queryKinds).toContain("atomic-create");
  });

  it("updates the vendor-null editable base row and still enforces its stale revision", async () => {
    const base = mapping({ id: "base-1", mappingKey: "s1::::", vendor: null, nlc: null, revision: 4 });
    const operations: unknown[] = [];
    const db = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("");
      if (query.includes("WITH updated_mapping")) {
        operations.push(...values);
        return [{ id: "po-base", po_number: "MYN-PO-BASE", status: "draft", total: 72_000, mapping_revision: 5, mapping_created_at: "2026-08-01", mapping_updated_at: "2026-08-02", claim_count: 1 }];
      }
      if (query.includes("FROM supplier_style_mappings")) return [dbRow(base)];
      return [];
    };
    const result = await resolveSupplierAndCreateDraft(db, batch(), {
      batchId: "batch-1", selection: { sku: "S1", warehouse: "BLR_FC" },
      mapping: { mappingId: "base-1", expectedRevision: 4, vendor: "Supplier A", nlc: 1200 },
    }, { id: "planner-1", displayName: "Planner" });
    expect(result.mapping).toMatchObject({ id: "base-1", revision: 5, vendor: "Supplier A" });
    expect(operations).toContain("update");

    let staleCalls = 0;
    const staleDb = async (strings: TemplateStringsArray) => {
      staleCalls += 1;
      if (strings.join("").includes("FROM supplier_style_mappings")) return [dbRow(base)];
      throw new Error("Stale base mapping must have no side effects.");
    };
    await expect(resolveSupplierAndCreateDraft(staleDb, batch(), {
      batchId: "batch-1", selection: { sku: "S1", warehouse: "BLR_FC" },
      mapping: { mappingId: "base-1", expectedRevision: 3, vendor: "Supplier A", nlc: 1200 },
    }, { id: "planner-1", displayName: "Planner" })).rejects.toMatchObject({ code: "STALE_VENDOR_MAPPING_REVISION" });
    expect(staleCalls).toBe(1);
  });

  it("permits deliberate createNew beside a named mapping without auto-selecting it", async () => {
    const existing = mapping();
    const operations: unknown[] = [];
    const db = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("");
      if (query.includes("WITH updated_mapping")) {
        operations.push(...values);
        return [{ id: "po-new", po_number: "MYN-PO-NEW", status: "draft", total: 69_000, mapping_revision: 1, mapping_created_at: "2026-08-02", mapping_updated_at: "2026-08-02", claim_count: 1 }];
      }
      if (query.includes("FROM supplier_style_mappings")) return [dbRow(existing)];
      return [];
    };
    const result = await resolveSupplierAndCreateDraft(db, batch(), {
      batchId: "batch-1", selection: { sku: "S1", warehouse: "BLR_FC" },
      mapping: { createNew: true, vendor: "Supplier B", nlc: 1150 },
    }, { id: "planner-1", displayName: "Planner" });
    expect(result.mapping).toMatchObject({ vendor: "Supplier B", revision: 1 });
    expect(operations).toContain("create");
  });

  it("never renames a named governed mapping during PO creation", async () => {
    const existing = mapping();
    const db = async (strings: TemplateStringsArray) => strings.join("").includes("FROM supplier_style_mappings") ? [dbRow(existing)] : [];
    await expect(resolveSupplierAndCreateDraft(db, batch(), {
      batchId: "batch-1", selection: { sku: "S1", warehouse: "BLR_FC" },
      mapping: { mappingId: existing.id, expectedRevision: existing.revision, vendor: "Supplier B", nlc: 1200 },
    }, { id: "planner-1", displayName: "Planner" })).rejects.toMatchObject({ code: "CREATE_NEW_SUPPLIER_REQUIRED", status: 409 });
  });

  it("blocks a legacy prior PO for the same batch, FC and style regardless of supplier", async () => {
    const db = async (strings: TemplateStringsArray) => {
      const query = strings.join("");
      if (query.includes("FROM supplier_style_mappings")) return [];
      if (query.includes("FROM po_recommendation_claims")) return [];
      if (query.includes("FROM purchase_orders")) return [{ batch_id: "batch-1", warehouse: "BLR_FC", vendor: "Old Supplier", lines: [{ sku: "S1" }] }];
      throw new Error("The atomic write must not run for a legacy duplicate.");
    };
    await expect(resolveSupplierAndCreateDraft(db, batch(), {
      batchId: "batch-1", selection: { sku: "S1", warehouse: "BLR_FC" }, mapping: { vendor: "New Supplier", nlc: 1200 },
    }, { id: "planner-1", displayName: "Planner" })).rejects.toMatchObject({ code: "RECOMMENDATION_ALREADY_CONVERTED", status: 409 });
  });

  it("lets the unique atomic claim choose exactly one concurrent A/B supplier conversion", async () => {
    let claimPrechecks = 0;
    let releasePrechecks!: () => void;
    const bothAtPrecheck = new Promise<void>(resolve => { releasePrechecks = resolve; });
    let claimOwned = false;
    const atomicClaimKeys: string[] = [];
    const db = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("");
      if (query.includes("WITH updated_mapping")) {
        const claimKey = values.find(value => typeof value === "string" && value.startsWith("recommendation:"));
        atomicClaimKeys.push(String(claimKey));
        if (claimOwned) {
          throw Object.assign(new Error("duplicate key"), { code: "23505", constraint: "po_recommendation_claims_pkey" });
        }
        claimOwned = true;
        return [{ id: "po-winner", po_number: "MYN-PO-WINNER", status: "draft", total: 72_000, mapping_revision: 1, mapping_created_at: "2026-08-02", mapping_updated_at: "2026-08-02", claim_count: 1 }];
      }
      if (query.includes("FROM supplier_style_mappings")) return [];
      if (query.includes("FROM po_recommendation_claims")) {
        claimPrechecks += 1;
        if (claimPrechecks === 2) releasePrechecks();
        await bothAtPrecheck;
        return [];
      }
      if (query.includes("FROM purchase_orders")) return [];
      throw new Error(`Unexpected query: ${query}`);
    };
    const requestFor = (vendor: string) => resolveSupplierAndCreateDraft(db, batch(), {
      batchId: "batch-1",
      selection: { sku: "S1", warehouse: "BLR_FC" },
      mapping: { createNew: true, vendor, nlc: 1200 },
    }, { id: "planner-1", displayName: "Planner" });

    const outcomes = await Promise.allSettled([requestFor("Supplier A"), requestFor("Supplier B")]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(outcome => outcome.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "RECOMMENDATION_ALREADY_CONVERTED", status: 409 });
    expect(atomicClaimKeys).toHaveLength(2);
    expect(new Set(atomicClaimKeys).size).toBe(1);
  });

  it("leaves absent MOQ/pack optional but enforces either rule when supplied", async () => {
    const db = async () => [];
    await expect(resolveSupplierAndCreateDraft(db, batch(), {
      batchId: "batch-1", selection: { sku: "S1", warehouse: "BLR_FC", quantity: 60 },
      mapping: { vendor: "Supplier A", nlc: 1200, moq: 100 },
    }, { id: "planner-1", displayName: "Planner" })).rejects.toMatchObject({ code: "SUPPLIER_QUANTITY_RULE_FAILED" });
    await expect(resolveSupplierAndCreateDraft(db, batch(), {
      batchId: "batch-1", selection: { sku: "S1", warehouse: "BLR_FC", quantity: 60 },
      mapping: { vendor: "Supplier A", nlc: 1200, packSize: 25 },
    }, { id: "planner-1", displayName: "Planner" })).rejects.toMatchObject({ code: "SUPPLIER_QUANTITY_RULE_FAILED" });
  });

  it("requires explicit confirmation before replacing a named source supplier", async () => {
    const named = recommendation({ vendor: "Source Supplier", unitPrice: null, exceptions: [{ code: "MISSING_PRICE", severity: "critical", message: "Add NLC." }] });
    const db = async () => [];
    await expect(resolveSupplierAndCreateDraft(db, batch([named]), {
      batchId: "batch-1", selection: { sku: "S1", warehouse: "BLR_FC", currentVendor: "Source Supplier" },
      mapping: { vendor: "Replacement Supplier", nlc: 1200 },
    }, { id: "planner-1", displayName: "Planner" })).rejects.toMatchObject({ code: "SUPPLIER_REPLACEMENT_CONFIRMATION_REQUIRED", status: 409 });
  });
});
