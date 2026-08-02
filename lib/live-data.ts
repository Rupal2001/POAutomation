import type { InventoryRow, OpenPoRow, SalesRow, VendorMasterRow } from "./po-engine";

export const LIVE_CONNECTION_NAME = "StyleFlow planning warehouse";

export interface LiveDataFilters {
  brands?: string[];
  styleIds?: string[];
  vendors?: string[];
  products?: string[];
  categories?: string[];
  articleTypes?: string[];
  warehouses?: string[];
  dateFrom?: string | null;
  dateTo?: string | null;
}

export interface PlanningSnapshot {
  sales: SalesRow[];
  inventory: InventoryRow[];
  openPos: OpenPoRow[];
  vendorMaster: VendorMasterRow[];
}

export interface LiveDataOptions {
  brands: string[];
  styleIds: string[];
  vendors: string[];
  products: string[];
  categories: string[];
  articleTypes: string[];
  warehouses: string[];
  dateMin: string | null;
  dateMax: string | null;
}

type Profile = {
  styleId: string;
  brands: Set<string>;
  vendors: Set<string>;
  products: Set<string>;
  categories: Set<string>;
  articleTypes: Set<string>;
};

const clean = (value: unknown) => String(value ?? "").trim();
const styleOf = (row: { styleId?: string; sku?: string }) => clean(row.styleId) || clean(row.sku);
const warehouseOf = (row: { warehouse?: string }) => clean(row.warehouse) || "MAIN";
const NETWORK_WAREHOUSE_MARKERS = new Set(["ALL", "ALL_MYNTRA", "MAIN", "NETWORK", "MYNTRA_NETWORK"]);
const PLACEHOLDER_VENDORS = new Set(["", "SUPPLIER MAPPING REQUIRED", "UNASSIGNED", "UNKNOWN", "N/A", "NA", "NOT ASSIGNED", "NOT MAPPED"]);
const normalizedWarehouse = (value: unknown) => clean(value).toUpperCase().replace(/[\s-]+/g, "_");
const validIsoDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
};

function sorted(values: Iterable<string>) {
  return [...new Set([...values].map(clean).filter(Boolean))].sort((a, b) => a.localeCompare(b, "en-IN", { numeric: true }));
}

function wanted(value: string, selections?: string[]) {
  const selected = new Set((selections ?? []).map(clean).filter(Boolean));
  return selected.size === 0 || selected.has(clean(value));
}

function warehouseWanted(row: { warehouse?: string }, selections?: string[]) {
  const selected = new Set((selections ?? []).map(clean).filter(Boolean));
  if (selected.size === 0) return true;
  if ([...selected].some(value => NETWORK_WAREHOUSE_MARKERS.has(normalizedWarehouse(value)))) return true;
  const warehouse = warehouseOf(row);
  return selected.has(warehouse);
}

function anyWanted(values: Set<string>, selections?: string[]) {
  const selected = new Set((selections ?? []).map(clean).filter(Boolean));
  if (selected.size === 0) return true;
  for (const value of values) if (selected.has(value)) return true;
  return false;
}

function profilesFor(snapshot: PlanningSnapshot) {
  const profiles = new Map<string, Profile>();
  const allRows = [
    ...snapshot.sales.map(row => ({ row, commercialMaster: false })),
    ...snapshot.inventory.map(row => ({ row, commercialMaster: false })),
    ...snapshot.openPos.map(row => ({ row, commercialMaster: false })),
    ...snapshot.vendorMaster.map(row => ({ row, commercialMaster: true })),
  ];
  for (const { row, commercialMaster } of allRows) {
    const styleId = styleOf(row);
    if (!styleId) continue;
    const profile = profiles.get(styleId) ?? {
      styleId,
      brands: new Set<string>(),
      vendors: new Set<string>(),
      products: new Set<string>(),
      categories: new Set<string>(),
      articleTypes: new Set<string>(),
    };
    const fields: [Set<string>, unknown][] = [
      [profile.brands, row.brand],
      [profile.products, row.productName],
      [profile.categories, row.category],
      [profile.articleTypes, row.articleType],
    ];
    for (const [target, value] of fields) {
      const text = clean(value);
      if (text) target.add(text);
    }
    // A supplier filter is a commercial nomination, not a historical-source
    // attribute. Open POs and operational rows may name prior suppliers, but
    // they must never make an unmapped supplier selectable for a new order.
    if (commercialMaster) {
      const vendor = clean(row.vendor);
      if (!PLACEHOLDER_VENDORS.has(vendor.toUpperCase())) profile.vendors.add(vendor);
    }
    profiles.set(styleId, profile);
  }
  return profiles;
}

export function getLiveDataOptions(snapshot: PlanningSnapshot): LiveDataOptions {
  const profiles = profilesFor(snapshot);
  const dates = snapshot.sales.map(row => clean(row.date)).filter(validIsoDate).sort();
  const salesWarehouses = snapshot.sales.map(row => clean(row.warehouse));
  // Warehouse scoping is safe only when every demand row has real FC grain.
  // Workbook methodology data is network/style/date grained; exposing inventory
  // FCs in that case would combine network demand with partial supply and overbuy.
  const warehouseFilterSafe = salesWarehouses.length > 0
    && salesWarehouses.every(warehouse => warehouse && !NETWORK_WAREHOUSE_MARKERS.has(normalizedWarehouse(warehouse)));
  return {
    brands: sorted([...profiles.values()].flatMap(profile => [...profile.brands])),
    styleIds: sorted(profiles.keys()),
    vendors: sorted([...profiles.values()].flatMap(profile => [...profile.vendors])),
    products: sorted([...profiles.values()].flatMap(profile => [...profile.products])),
    categories: sorted([...profiles.values()].flatMap(profile => [...profile.categories])),
    articleTypes: sorted([...profiles.values()].flatMap(profile => [...profile.articleTypes])),
    warehouses: warehouseFilterSafe ? sorted(salesWarehouses) : [],
    dateMin: dates.at(0) ?? null,
    dateMax: dates.at(-1) ?? null,
  };
}

export function validateLiveDataFilters(filters: LiveDataFilters, options: LiveDataOptions) {
  if (filters.dateFrom && !validIsoDate(filters.dateFrom)) throw new Error("Start date must be a valid YYYY-MM-DD date.");
  if (filters.dateTo && !validIsoDate(filters.dateTo)) throw new Error("End date must be a valid YYYY-MM-DD date.");
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) throw new Error("Start date cannot be after end date.");
  const domains: [keyof LiveDataFilters, keyof LiveDataOptions][] = [
    ["brands", "brands"], ["styleIds", "styleIds"], ["vendors", "vendors"], ["products", "products"],
    ["categories", "categories"], ["articleTypes", "articleTypes"], ["warehouses", "warehouses"],
  ];
  for (const [filterKey, optionKey] of domains) {
    const allowed = new Set(options[optionKey] as string[]);
    const unknown = ((filters[filterKey] as string[] | undefined) ?? []).map(clean).filter(value => value && !allowed.has(value));
    if (unknown.length) throw new Error(`Unknown ${String(filterKey)} selection: ${unknown.join(", ")}`);
  }
}

/**
 * Builds an immutable planning subset from a connected snapshot.
 *
 * Sales dates scope the demand window. Product filters resolve to Style IDs first,
 * so rows that do not repeat every catalogue attribute are still joined correctly.
 * A vendor selection nominates the applicable supplier master rows, while all open
 * supply for the chosen styles remains included to avoid double-buying against a PO
 * placed with another supplier.
 */
export function filterPlanningSnapshot(snapshot: PlanningSnapshot, filters: LiveDataFilters): PlanningSnapshot {
  const options = getLiveDataOptions(snapshot);
  validateLiveDataFilters(filters, options);
  const profiles = profilesFor(snapshot);
  const requestedStyles = new Set((filters.styleIds ?? []).map(clean).filter(Boolean));
  const profileStyles = new Set(
    [...profiles.values()]
      .filter(profile => requestedStyles.size === 0 || requestedStyles.has(profile.styleId))
      .filter(profile => anyWanted(profile.brands, filters.brands))
      .filter(profile => anyWanted(profile.vendors, filters.vendors))
      .filter(profile => anyWanted(profile.products, filters.products))
      .filter(profile => anyWanted(profile.categories, filters.categories))
      .filter(profile => anyWanted(profile.articleTypes, filters.articleTypes))
      .map(profile => profile.styleId)
  );

  const sales = snapshot.sales.filter(row => {
    const date = clean(row.date);
    return profileStyles.has(styleOf(row))
      && (!filters.dateFrom || date >= filters.dateFrom)
      && (!filters.dateTo || date <= filters.dateTo)
      && warehouseWanted(row, filters.warehouses);
  });
  const soldStyles = new Set(sales.map(styleOf).filter(Boolean));
  const inventory = snapshot.inventory.filter(row => soldStyles.has(styleOf(row)) && warehouseWanted(row, filters.warehouses));
  // All pending supply for the selected styles is deliberately retained. See the
  // function comment: vendor is a supplier nomination filter, not a reason to hide
  // commitments that reduce the new PO ask.
  const openPos = snapshot.openPos.filter(row => soldStyles.has(styleOf(row)) && warehouseWanted(row, filters.warehouses));
  const vendorMaster = snapshot.vendorMaster.filter(row => {
    const styleId = styleOf(row);
    return (!styleId || soldStyles.has(styleId)) && wanted(clean(row.vendor), filters.vendors);
  });
  return { sales, inventory, openPos, vendorMaster };
}
