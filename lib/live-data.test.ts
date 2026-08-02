import { describe, expect, it } from "vitest";
import { filterPlanningSnapshot, getLiveDataOptions, validateLiveDataFilters, type PlanningSnapshot } from "./live-data";

const snapshot: PlanningSnapshot = {
  sales: [
    { date: "2026-06-01", sku: "1", styleId: "1", vendor: "Vendor A", warehouse: "BLR", unitsSold: 3, brand: "Noise", productName: "Buds One", category: "Audio", articleType: "Headphones" },
    { date: "2026-06-02", sku: "1", styleId: "1", vendor: "Vendor A", warehouse: "BLR", unitsSold: 4, brand: "Noise", productName: "Buds One", category: "Audio", articleType: "Headphones" },
    { date: "2026-06-02", sku: "2", styleId: "2", vendor: "Vendor B", warehouse: "DEL", unitsSold: 2, brand: "Roadster", productName: "Tee Two", category: "Apparel", articleType: "Tshirts" },
  ],
  inventory: [
    { sku: "1", styleId: "1", vendor: "Vendor A", warehouse: "BLR", currentInventory: 10 },
    { sku: "2", styleId: "2", vendor: "Vendor B", warehouse: "DEL", currentInventory: 5 },
  ],
  openPos: [
    { sku: "1", styleId: "1", vendor: "Vendor B", warehouse: "BLR", openPoQty: 7 },
  ],
  vendorMaster: [
    { sku: "1", styleId: "1", vendor: "Vendor A", productName: "Buds One", unitPrice: 799 },
    { sku: "2", styleId: "2", vendor: "Vendor B", productName: "Tee Two", unitPrice: 499 },
  ],
};

describe("live planning snapshot filters", () => {
  it("returns distinct cascading-filter domains and date bounds", () => {
    expect(getLiveDataOptions(snapshot)).toMatchObject({
      brands: ["Noise", "Roadster"],
      styleIds: ["1", "2"],
      vendors: ["Vendor A", "Vendor B"],
      products: ["Buds One", "Tee Two"],
      dateMin: "2026-06-01",
      dateMax: "2026-06-02",
    });
  });

  it("uses the sales period as the style universe and joins other sources", () => {
    const result = filterPlanningSnapshot(snapshot, { brands: ["Noise"], dateFrom: "2026-06-02", dateTo: "2026-06-02" });
    expect(result.sales).toHaveLength(1);
    expect(result.inventory.map(row => row.styleId)).toEqual(["1"]);
    expect(result.openPos.map(row => row.styleId)).toEqual(["1"]);
  });

  it("keeps all pending supply when a supplier is nominated", () => {
    const result = filterPlanningSnapshot(snapshot, { vendors: ["Vendor A"] });
    expect(result.sales.map(row => row.styleId)).toEqual(["1", "1"]);
    expect(result.openPos).toHaveLength(1);
    expect(result.openPos[0].vendor).toBe("Vendor B");
    expect(result.vendorMaster.map(row => row.vendor)).toEqual(["Vendor A"]);
  });

  it("offers suppliers only from the commercial master, never from prior open POs", () => {
    const operationalVendorOnly: PlanningSnapshot = {
      ...snapshot,
      openPos: [...snapshot.openPos, { sku: "2", styleId: "2", vendor: "Former Supplier", warehouse: "DEL", openPoQty: 3 }],
    };
    expect(getLiveDataOptions(operationalVendorOnly).vendors).toEqual(["Vendor A", "Vendor B"]);
    expect(() => filterPlanningSnapshot(operationalVendorOnly, { vendors: ["Former Supplier"] })).toThrow(/Unknown vendors/);
  });

  it("rejects invalid ranges and unknown selections", () => {
    const options = getLiveDataOptions(snapshot);
    expect(() => validateLiveDataFilters({ dateFrom: "2026-06-03", dateTo: "2026-06-02" }, options)).toThrow(/after/);
    expect(() => validateLiveDataFilters({ brands: ["Unknown"] }, options)).toThrow(/Unknown brands/);
    expect(() => validateLiveDataFilters({ dateFrom: "2026-02-30" }, options)).toThrow(/valid YYYY-MM-DD/);
  });

  it("does not offer unsafe FC filtering for network-grained demand", () => {
    const networkSnapshot: PlanningSnapshot = {
      sales: [{ date: "2026-06-01", sku: "1", styleId: "1", vendor: "Vendor A", warehouse: "ALL_MYNTRA", unitsSold: 10 }],
      inventory: [{ sku: "1", styleId: "1", vendor: "Vendor A", warehouse: "BLR", currentInventory: 40 }],
      openPos: [{ sku: "1", styleId: "1", vendor: "Vendor A", warehouse: "DEL", openPoQty: 15 }],
      vendorMaster: [{ sku: "1", styleId: "1", vendor: "Vendor A", unitPrice: 799 }],
    };
    const options = getLiveDataOptions(networkSnapshot);
    expect(options.warehouses).toEqual([]);
    expect(() => validateLiveDataFilters({ warehouses: ["ALL_MYNTRA"] }, options)).toThrow(/Unknown warehouses/);
    const unfiltered = filterPlanningSnapshot(networkSnapshot, {});
    expect(unfiltered.inventory).toHaveLength(1);
    expect(unfiltered.openPos).toHaveLength(1);
  });

  it("treats conventional MAIN and case-insensitive network labels as network demand", () => {
    const mainSnapshot: PlanningSnapshot = {
      sales: [{ date: "2026-06-01", sku: "1", styleId: "1", vendor: "Vendor A", warehouse: "main", unitsSold: 10 }],
      inventory: [{ sku: "1", styleId: "1", vendor: "Vendor A", warehouse: "BLR", currentInventory: 40 }],
      openPos: [],
      vendorMaster: [{ sku: "1", styleId: "1", vendor: "Vendor A", unitPrice: 799 }],
    };
    expect(getLiveDataOptions(mainSnapshot).warehouses).toEqual([]);
    expect(filterPlanningSnapshot(mainSnapshot, {}).inventory).toHaveLength(1);
  });

  it("rejects impossible calendar dates in live filters", () => {
    const options = getLiveDataOptions(snapshot);
    expect(() => validateLiveDataFilters({ dateFrom: "2026-02-31" }, options)).toThrow(/valid YYYY-MM-DD/);
  });

  it("offers warehouse filters only when sell-out itself has real FC grain", () => {
    expect(getLiveDataOptions(snapshot).warehouses).toEqual(["BLR", "DEL"]);
    const result = filterPlanningSnapshot(snapshot, { warehouses: ["BLR"] });
    expect(result.sales.map(row => row.styleId)).toEqual(["1", "1"]);
    expect(result.inventory.map(row => row.warehouse)).toEqual(["BLR"]);
    expect(result.openPos.map(row => row.warehouse)).toEqual(["BLR"]);
  });
});
