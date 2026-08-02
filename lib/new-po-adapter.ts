import { calculateNewPoMethodology, NEW_PO_METHODOLOGY_VERSION, type NewPoCalculationInput } from "./new-po-methodology";
import { NETWORK_WAREHOUSE, UNASSIGNED_VENDOR } from "./new-po-engine";
import type { InventoryRow, OpenPoRow, SalesRow, VendorMasterRow } from "./po-engine";

export interface AdaptedNewPoDataset {
  sales: SalesRow[];
  inventory: InventoryRow[];
  openPos: OpenPoRow[];
  vendorMaster: VendorMasterRow[];
  calculationPreview: ReturnType<typeof calculateNewPoMethodology>;
  asOfDate: string;
}

const clean = (value: unknown) => String(value ?? "").trim();

export function adaptNewPoDataset(input: NewPoCalculationInput, coverDays = 45, dohThreshold = 80): AdaptedNewPoDataset {
  const calculationPreview = calculateNewPoMethodology(input, { coverDays, dohThreshold });
  // The calculator has already rejected conflicting duplicates. Collapse exact
  // duplicates here so supplier rules remain deterministic and first-seen, just
  // like Excel UNIQUE in the source methodology.
  const detailByStyle = new Map<string, NewPoCalculationInput["styleDetails"][number]>();
  for (const row of input.styleDetails) if (!detailByStyle.has(row.styleId)) detailByStyle.set(row.styleId, row);
  const uniqueStyleDetails = [...detailByStyle.values()];
  const vendorSets = new Map<string, Set<string>>();
  for (const row of uniqueStyleDetails) {
    const vendor = clean(row.vendorName);
    if (!vendor) continue;
    const set = vendorSets.get(row.styleId) ?? new Set<string>();
    set.add(vendor);
    vendorSets.set(row.styleId, set);
  }
  const vendorFor = (styleId: string) => {
    const vendors = [...(vendorSets.get(styleId) ?? [])];
    return vendors.length === 1 ? vendors[0] : UNASSIGNED_VENDOR;
  };
  const sourceReference = (row: NewPoCalculationInput["styleDetails"][number]) => [
    row.fileName || "source file",
    row.sheetName,
    row.rowNumber ? `row ${row.rowNumber}` : undefined,
  ].filter(Boolean).join(" · ");
  const meta = (styleId: string) => {
    const detail = detailByStyle.get(styleId);
    const sales = input.sales.find(row => row.styleId === styleId);
    const inventory = input.inventory.find(row => row.styleId === styleId);
    const openPo = input.openPos.find(row => row.styleId === styleId);
    return {
      marketplace: "Myntra",
      styleId,
      productName: detail?.model,
      mrpInr: detail?.mrpInr,
      category: sales?.masterCategory ?? openPo?.masterCategory,
      brand: sales?.brand ?? inventory?.brand ?? openPo?.brand,
      articleType: sales?.articleType ?? inventory?.articleType ?? openPo?.articleType,
      catalogueDataProvenance: detail ? `Uploaded style master · ${sourceReference(detail)}` : "Style metadata missing from uploaded source",
      commercialDataProvenance: detail ? `Uploaded supplier/NLC master · ${sourceReference(detail)}` : "Supplier/NLC mapping missing from uploaded source",
    };
  };

  const sales: SalesRow[] = input.sales.map(row => ({
    ...meta(row.styleId),
    date: row.salesDate,
    sku: row.styleId,
    vendor: vendorFor(row.styleId),
    warehouse: NETWORK_WAREHOUSE,
    unitsSold: row.quantity,
    // Operational enrichments affect forecast evidence only. The calculation
    // preview above has already applied the exact formula to gross `quantity`.
    returnsQty: row.returnsQty ?? 0,
    cancellationsQty: row.cancellationsQty ?? 0,
    isPromotion: row.isPromotion ?? false,
    inStock: row.inStock ?? true,
  }));
  const inventory: InventoryRow[] = input.inventory.map(row => ({
    ...meta(row.styleId),
    sku: row.styleId,
    vendor: vendorFor(row.styleId),
    warehouse: clean(row.warehouseName) || clean(row.warehouseId) || NETWORK_WAREHOUSE,
    currentInventory: row.inventoryUnits,
    reservedQty: 0,
    backorderQty: 0,
  }));
  const openPos: OpenPoRow[] = input.openPos.map(row => ({
    ...meta(row.styleId),
    sku: row.styleId,
    vendor: clean(row.vendorName) || vendorFor(row.styleId),
    warehouse: clean(row.warehouseId) || NETWORK_WAREHOUSE,
    openPoQty: row.pendingQuantity,
    expectedDate: row.estimatedShipmentDate,
    status: row.poStatus,
  }));
  const vendorMaster: VendorMasterRow[] = uniqueStyleDetails.map(row => ({
    ...meta(row.styleId),
    sku: row.styleId,
    vendor: vendorFor(row.styleId),
    supplierSku: row.supplierSku,
    contactEmail: row.contactEmail,
    hsnCode: row.hsnCode,
    gstRate: row.gstRate,
    gstin: row.supplierGstin,
    supplierState: row.supplierState,
    leadTimeDays: row.leadTimeDays,
    paymentTerms: row.paymentTerms,
    incoterms: row.incoterms,
    moq: row.moq,
    packSize: row.packSize,
    unitPrice: row.nlcInr,
    currency: "INR",
    marketplace: "Myntra",
  }));
  const asOfDate = input.sales.map(row => row.salesDate).sort().at(-1)!;
  return { sales, inventory, openPos, vendorMaster, calculationPreview, asOfDate };
}

export function newPoPlanningSettings(dataset: AdaptedNewPoDataset, source: Record<string, unknown>, dohThreshold = 80) {
  const preview = dataset.calculationPreview;
  return {
    calculationMethod: "style_drr_cover_v1" as const,
    methodologyVersion: NEW_PO_METHODOLOGY_VERSION,
    dohThreshold,
    uniqueOrderDays: preview.summary.distinctSalesDays,
    asOfDate: dataset.asOfDate,
    sourceType: "file_upload",
    currency: "INR",
    source,
    importSummary: preview.summary,
    dataQuality: preview.dataQuality,
  };
}
