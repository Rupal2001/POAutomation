import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/*
 * Deterministic Myntra marketplace demo data.
 *
 * Product codes, listing titles, brands, public marketplace seller names, MRP
 * and displayed selling prices are point-in-time snapshots from public Myntra
 * product pages captured on 2026-08-01. Prices and sellers can change.
 *
 * Demand, inventory, FC placement, procurement cost, MOQ, pack size, lead
 * time, tax setup, supplier contact data and the assumed PO relationship are
 * synthetic. They must never be represented as internal Myntra business data.
 */

const outputs = [
  fileURLToPath(new URL("../sample-data/demo/", import.meta.url)),
  fileURLToPath(new URL("../sample-data/", import.meta.url)),
];
for (const output of outputs) mkdirSync(output, { recursive: true });

const DAY = 86_400_000;
const AS_OF_DATE = "2026-08-01";
const HISTORY_DAYS = 210;
const start = Date.parse(`${AS_OF_DATE}T00:00:00Z`) - HISTORY_DAYS * DAY;

const PRICE_CAPTURED_ON = "2026-08-01";
const CATALOGUE_PROVENANCE = "Public Myntra product listing snapshot";
const COMMERCIAL_PROVENANCE = "Synthetic demo planning assumption";

// Keep most of the demo immediately usable while retaining a small, explicit
// remediation queue for the inline supplier resolver. These five suppliers
// each represent one catalogue style, giving both supplier- and style-level
// readiness ratios close to 80:20 without guessing production commercial data.
const INCOMPLETE_SUPPLIER_CODES = new Set(["TRUENET", "WHITE", "KEEV", "ZEAL", "INDRA"]);
const GSTIN_STATE_CODES = {
  Karnataka: "29",
  Rajasthan: "08",
  Haryana: "06",
  "West Bengal": "19",
  Maharashtra: "27",
};
let gstinSequence = 1000;

const profiles = {
  apparel: { city: "Bengaluru", state: "Karnataka", leadTime: 14, reviewPeriod: 7, moq: 100, packSize: 20, maxOrderQty: 4000, minimumOrderValue: 60000, freightFreeThreshold: 150000, paymentTerms: "Net 30" },
  ethnic: { city: "Jaipur", state: "Rajasthan", leadTime: 18, reviewPeriod: 10, moq: 80, packSize: 10, maxOrderQty: 3000, minimumOrderValue: 80000, freightFreeThreshold: 175000, paymentTerms: "Net 45" },
  active: { city: "Gurugram", state: "Haryana", leadTime: 16, reviewPeriod: 7, moq: 72, packSize: 12, maxOrderQty: 3600, minimumOrderValue: 90000, freightFreeThreshold: 180000, paymentTerms: "Net 30" },
  footwear: { city: "Gurugram", state: "Haryana", leadTime: 22, reviewPeriod: 14, moq: 48, packSize: 12, maxOrderQty: 2400, minimumOrderValue: 100000, freightFreeThreshold: 225000, paymentTerms: "Net 45" },
  accessory: { city: "Kolkata", state: "West Bengal", leadTime: 13, reviewPeriod: 10, moq: 60, packSize: 10, maxOrderQty: 3000, minimumOrderValue: 50000, freightFreeThreshold: 120000, paymentTerms: "Net 30" },
  beauty: { city: "Mumbai", state: "Maharashtra", leadTime: 12, reviewPeriod: 7, moq: 120, packSize: 24, maxOrderQty: 6000, minimumOrderValue: 50000, freightFreeThreshold: 125000, paymentTerms: "Net 30" },
  home: { city: "Panipat", state: "Haryana", leadTime: 20, reviewPeriod: 14, moq: 40, packSize: 5, maxOrderQty: 1800, minimumOrderValue: 75000, freightFreeThreshold: 160000, paymentTerms: "Net 45" },
};
const seller = (name, code, profile) => {
  const commercialReady = !INCOMPLETE_SUPPLIER_CODES.has(code);
  const supplierProfile = profiles[profile];
  const stateCode = GSTIN_STATE_CODES[supplierProfile.state];
  if (!stateCode) throw new Error(`No synthetic GSTIN state code is configured for ${supplierProfile.state}.`);
  gstinSequence += 1;
  return {
    name,
    ...supplierProfile,
    email: `${code.toLowerCase()}@supplier-demo.example`,
    commercialReady,
    // Format-valid but deliberately synthetic; it is never a claim about the
    // public marketplace seller's real tax registration.
    gstin: commercialReady ? `${stateCode}DEMOS${String(gstinSequence).padStart(4, "0")}A1Z5` : "",
  };
};

// Names below are public seller snapshots. Every commercial attribute added by
// `seller()` is synthetic and is marked as such in vendor_master.csv.
const suppliers = {
  GARG: seller("GARG ACRYLICS LTD.", "GARG", "apparel"),
  ARF: seller("AR FASHION STUDIO", "ARF", "apparel"),
  TRUENET: seller("Truenet Commerce", "TRUENET", "apparel"),
  IBA: seller("M/S IBA CRAFTS PRIVATE LIMITED", "IBA", "apparel"),
  VISION: seller("Vision Star", "VISION", "apparel"),
  WHITE: seller("WHITE IMPACT", "WHITE", "apparel"),
  ASTITVA: seller("Astitva Creations Private Limited", "ASTITVA", "ethnic"),
  KEEV: seller("KEEV LIFESTYLES PRIVATE LIMITED", "KEEV", "ethnic"),
  SANGAM: seller("SANGAM (INDIA) LIMITED", "SANGAM", "active"),
  GURKIRPA: seller("GURKIRPA LIFESTYLE COMPANY", "GURKIRPA", "active"),
  ZEAL: seller("ZEAL BIZFASHION VENTURES PRIVATE LIMITED", "ZEAL", "active"),
  TREESPOON: seller("Treespoon Private Limited", "TREESPOON", "footwear"),
  SUPERCOM: seller("Supercom Net", "SUPERCOM", "footwear"),
  SAPPHIRE: seller("SAPPHIRE WOLF FASHION PRIVATE LIMITED", "SAPPHIRE", "footwear"),
  KPLEATHER: seller("KP Leather Associates", "KPLEATHER", "accessory"),
  PARUL: seller("PARUL HANDICRAFTS (P)LTD", "PARUL", "accessory"),
  KASTNER: seller("Kastner Leather Trading Pvt Ltd", "KASTNER", "accessory"),
  CROSSROADS: seller("CROSSROADS CLOTHING PVT LTD", "CROSSROADS", "apparel"),
  OMNITECH: seller("Omnitech Retail", "OMNITECH", "apparel"),
  NYRAA: seller("Nyraa Young Cosmetics Private Limited", "NYRAA", "beauty"),
  HONASA: seller("HONASA CONSUMER - SJIT", "HONASA", "beauty"),
  INDRA: seller("INDRA FAB PRIVATE LIMITED", "INDRA", "home"),
  FASHIONDECOR: seller("FASHION DECOR", "FASHIONDECOR", "home"),
};

const product = (spec) => ({
  gender: "Unisex",
  size: "One Size",
  colour: "Assorted",
  gstRate: 12,
  trend: 0,
  demandProfile: "core",
  cancellationRate: 0.035,
  returnRate: 0.1,
  stockCoverDays: 18,
  reservedDays: 2,
  backorderDays: 0,
  safetyDays: 9,
  serviceLevel: 0.95,
  incoming: [],
  lifecycleStage: "Core",
  availabilityStatus: "Active",
  launchDate: "2025-01-01",
  endOfLifeDate: "",
  intermittentProbability: 0,
  ...spec,
  cost: spec.cost ?? Math.max(1, Math.round(spec.sellingPrice * (spec.costRatio ?? 0.52))),
});

const listing = (spec) => ({
  ...spec,
  marketplaceSeller: suppliers[spec.supplier].name,
  sourceUrl: spec.sourceUrl,
  priceCapturedOn: PRICE_CAPTURED_ON,
  catalogueDataProvenance: CATALOGUE_PROVENANCE,
  commercialDataProvenance: COMMERCIAL_PROVENANCE,
});
const variant = (catalogueRow, spec) => product({
  ...catalogueRow,
  ...spec,
  sku: `MYN-${catalogueRow.styleId}-${spec.sizeCode}`,
  supplierSku: `DEMO-${catalogueRow.styleId}-${spec.sizeCode}`,
});

const catalogue = {
  roadsterTee: listing({ styleId: "3314131", supplier: "GARG", brand: "Roadster", name: "Roadster Men Black Solid Round Neck T-shirt", category: "Men Western Wear", articleType: "T-shirts", gender: "Men", colour: "Black", mrp: 299, sellingPrice: 239, sourceUrl: "https://www.myntra.com/tshirts/roadster/roadster-men-black-solid-round-neck-t-shirt/3314131/buy" }),
  roadsterJeans: listing({ styleId: "7139482", supplier: "ARF", brand: "Roadster", name: "Roadster Men Black Slim Fit Mid-Rise Clean Look Stretchable Jeans", category: "Men Western Wear", articleType: "Jeans", gender: "Men", colour: "Black", mrp: 1699, sellingPrice: 729, sourceUrl: "https://www.myntra.com/jeans/roadster/roadster-men-black-slim-fit-mid-rise-clean-look-stretchable-jeans/7139482/buy" }),
  roadsterSecondTee: listing({ styleId: "21422548", supplier: "TRUENET", brand: "Roadster", name: "Roadster Men T-shirt", category: "Men Western Wear", articleType: "T-shirts", gender: "Men", colour: "As listed", mrp: 399, sellingPrice: 191, sourceUrl: "https://www.myntra.com/tshirts/roadster/roadster-men-t-shirt/21422548/buy" }),
  dressberryDress: listing({ styleId: "20721342", supplier: "IBA", brand: "DressBerry", name: "DressBerry Pink Floral Midi Dress", category: "Women Western Wear", articleType: "Dresses", gender: "Women", colour: "Pink", mrp: 3099, sellingPrice: 1116, sourceUrl: "https://www.myntra.com/dresses/dressberry/dressberry-pink-floral-midi-dress/20721342/buy" }),
  dressberrySquareTop: listing({ styleId: "32016912", supplier: "VISION", brand: "DressBerry", name: "DressBerry Square Neck Top", category: "Women Western Wear", articleType: "Tops", gender: "Women", colour: "As listed", mrp: 699, sellingPrice: 286, sourceUrl: "https://www.myntra.com/tops/dressberry/dressberry-square-neck-top/32016912/buy" }),
  dressberryTop: listing({ styleId: "39808527", supplier: "WHITE", brand: "DressBerry", name: "DressBerry Top", category: "Women Western Wear", articleType: "Tops", gender: "Women", colour: "As listed", mrp: 1999, sellingPrice: 614, sourceUrl: "https://www.myntra.com/tops/dressberry/dressberry-top/39808527/buy" }),
  anoukKurta: listing({ styleId: "38471815", supplier: "ASTITVA", brand: "Anouk", name: "Anouk Women Kurta", category: "Women Ethnic Wear", articleType: "Kurtas", gender: "Women", colour: "As listed", mrp: 1999, sellingPrice: 566, sourceUrl: "https://www.myntra.com/kurtas/anouk/anouk-women-kurta/38471815/buy" }),
  anoukEmbroidered: listing({ styleId: "34530975", supplier: "ASTITVA", brand: "Anouk", name: "Anouk Women Ethnic Motifs Embroidered A-Line Kurta", category: "Women Ethnic Wear", articleType: "Kurtas", gender: "Women", colour: "As listed", mrp: 1799, sellingPrice: 559, sourceUrl: "https://www.myntra.com/kurtas/anouk/anouk-women-ethnic-motifs-embroidered-a-line-kurta/34530975/buy" }),
  anoukSaree: listing({ styleId: "30534878", supplier: "KEEV", brand: "Anouk", name: "Anouk Saree", category: "Women Ethnic Wear", articleType: "Sarees", gender: "Women", colour: "As listed", mrp: 4799, sellingPrice: 1014, sourceUrl: "https://www.myntra.com/sarees/anouk/anouk-saree/30534878/buy" }),
  hrxYogaTights: listing({ styleId: "13346136", supplier: "SANGAM", brand: "HRX by Hrithik Roshan", name: "HRX Women Skinny Fit Seamless Rapid-Dry Antimicrobial Yoga Tights", category: "Sports Wear", articleType: "Tights", gender: "Women", colour: "As listed", mrp: 1699, sellingPrice: 496, sourceUrl: "https://www.myntra.com/tights/hrxbyhrithikroshan/hrx-by-hrithik-roshan-women-skinny-fit-seamless-rapid-dry-antimicrobial-yoga-tights/13346136/buy" }),
  hrxMidRiseTights: listing({ styleId: "25587450", supplier: "GURKIRPA", brand: "HRX by Hrithik Roshan", name: "HRX Women Mid Rise Tights", category: "Sports Wear", articleType: "Tights", gender: "Women", colour: "As listed", mrp: 1499, sellingPrice: 494, sourceUrl: "https://www.myntra.com/tights/hrxbyhrithikroshan/hrx-by-hrithik-roshan-women-mid-rise-tights/25587450/buy" }),
  hrxShorts: listing({ styleId: "42042400", supplier: "ZEAL", brand: "HRX by Hrithik Roshan", name: "HRX Men Shorts", category: "Sports Wear", articleType: "Shorts", gender: "Men", colour: "As listed", mrp: 1798, sellingPrice: 728, sourceUrl: "https://www.myntra.com/shorts/hrxbyhrithikroshan/hrx-by-hrithik-roshan-men-shorts/42042400/buy" }),
  hrxRunOne: listing({ styleId: "40200375", supplier: "TREESPOON", brand: "HRX by Hrithik Roshan", name: "HRX Men Running Shoes", category: "Footwear", articleType: "Sports Shoes", gender: "Men", colour: "As listed", mrp: 3999, sellingPrice: 1299, sourceUrl: "https://www.myntra.com/sports-shoes/hrxbyhrithikroshan/hrx-by-hrithik-roshan-men-running-shoes/40200375/buy" }),
  hrxRunTwo: listing({ styleId: "36220389", supplier: "SUPERCOM", brand: "HRX by Hrithik Roshan", name: "HRX Men Running Shoes", category: "Footwear", articleType: "Sports Shoes", gender: "Men", colour: "As listed", mrp: 3499, sellingPrice: 1084, sourceUrl: "https://www.myntra.com/sports-shoes/hrxbyhrithikroshan/hrx-by-hrithik-roshan-men-running-shoes/36220389/buy" }),
  roadsterSneaker: listing({ styleId: "31026146", supplier: "SAPPHIRE", brand: "Roadster", name: "Roadster Women PU Stylish Casual Lightweight Comfort Sneaker", category: "Footwear", articleType: "Casual Shoes", gender: "Women", colour: "As listed", mrp: 2499, sellingPrice: 704, sourceUrl: "https://www.myntra.com/casual-shoes/roadster/roadster-women-pu-stylish-casual-lightweight-comfort-sneaker/31026146/buy" }),
  roadsterBackpack: listing({ styleId: "18774016", supplier: "KPLEATHER", brand: "Roadster", name: "Roadster X fwd Unisex Black Backpacks 30 L", category: "Accessories", articleType: "Backpacks", gender: "Unisex", colour: "Black", mrp: 2499, sellingPrice: 649, sourceUrl: "https://www.myntra.com/backpacks/roadster/-roadster-unisex-black-backpacks/18774016/buy" }),
  dressberryHandbag: listing({ styleId: "33559982", supplier: "PARUL", brand: "DressBerry", name: "DressBerry Women Black Embellished Floral Satin Handbag", category: "Accessories", articleType: "Handbags", gender: "Women", colour: "Black", mrp: 2199, sellingPrice: 835, sourceUrl: "https://www.myntra.com/handbags/dressberry/dressberry-women-black-embellished-floral-satin-handbag-/33559982/buy" }),
  mastHarbourBelt: listing({ styleId: "23839854", supplier: "KASTNER", brand: "Mast & Harbour", name: "Mast & Harbour Men Black Slim Formal Belt", category: "Accessories", articleType: "Belts", gender: "Men", colour: "Black", mrp: 1999, sellingPrice: 399, sourceUrl: "https://www.myntra.com/belts/mastharbour/mast--harbour-men-black-slim-formal-belt/23839854/buy" }),
  ykBoysTee: listing({ styleId: "24541476", supplier: "CROSSROADS", brand: "YK", name: "YK Boys Typography Printed Pure Cotton Oversized Fit Casual T-shirt", category: "Kids Wear", articleType: "T-shirts", gender: "Boys", colour: "As listed", mrp: 1295, sellingPrice: 439, sourceUrl: "https://www.myntra.com/tshirts/yk/yk-boys-typography-printed-pure-cotton-oversized-fit-casual-t-shirt/24541476/buy" }),
  ykPrintedTee: listing({ styleId: "42034038", supplier: "OMNITECH", brand: "YK", name: "YK Boys Printed T-shirt", category: "Kids Wear", articleType: "T-shirts", gender: "Boys", colour: "As listed", mrp: 2299, sellingPrice: 919, sourceUrl: "https://www.myntra.com/tshirts/yk/yk-boys-printed-t-shirt/42034038/buy" }),
  ykGirlsDress: listing({ styleId: "32465313", supplier: "OMNITECH", brand: "YK", name: "YK Girls Floral Fit & Flare Dress", category: "Kids Wear", articleType: "Dresses", gender: "Girls", colour: "Floral", mrp: 1599, sellingPrice: 639, sourceUrl: "https://www.myntra.com/dresses/yk/yk-girls-floral-fit--flare-dress/32465313/buy" }),
  nandiayanLipstick: listing({ styleId: "32619377", supplier: "NYRAA", brand: "nandiayan", name: "nandiayan Women Liquid Lipstick Set of 12 Smudge Proof Matte Shades – 2.5 ml Each", category: "Beauty & Personal Care", articleType: "Lipstick", gender: "Women", colour: "Multi", mrp: 455, sellingPrice: 278, sourceUrl: "https://www.myntra.com/lipstick/nandiayan/nandiayan-women-liquid-lipstick-set-of-12-smudge-proof-matte-shades--25ml-each/32619377/buy" }),
  etudeTint: listing({ styleId: "27916434", supplier: "SUPERCOM", brand: "ETUDE", name: "ETUDE Dear Darling Water Tint 9g – Red Grapefruit Ade 4", category: "Beauty & Personal Care", articleType: "Lip Tint", gender: "Women", colour: "Red Grapefruit", mrp: 450, sellingPrice: 382, sourceUrl: "https://www.myntra.com/lipstick/etude/etude-dear-darling-water-tint-9g---red-grapefruit-ade-4/27916434/buy" }),
  mamaearthLipstick: listing({ styleId: "28546552", supplier: "HONASA", brand: "Mamaearth", name: "Mamaearth Creamy Matte Long Stay Lipstick With Murumuru Butter – Apricot Taupe", category: "Beauty & Personal Care", articleType: "Lipstick", gender: "Women", colour: "Apricot Taupe", mrp: 399, sellingPrice: 239, sourceUrl: "https://www.myntra.com/lipstick/mamaearth/mamaearth-creamy-matte-long-stay-lipstick-with-murumuru-butter---apricot-taupe/28546552/buy" }),
  klottheBedsheet: listing({ styleId: "19917876", supplier: "SUPERCOM", brand: "KLOTTHE", name: "KLOTTHE Ruby Blue Conversational Cotton 300 TC King Fine Bedsheet with 2 Pillow Covers – 250 × 220 cm", category: "Home & Living", articleType: "Bedsheets", gender: "Home", colour: "Ruby Blue", mrp: 2999, sellingPrice: 359, sourceUrl: "https://www.myntra.com/bedsheets/klotthe/klotthe-ruby-blue-conversational-cotton-300-tc-king-fine-bedsheet-with-2-pillow-covers-250-x-220-cm/19917876/buy" }),
  sangriaBedsheet: listing({ styleId: "38831890", supplier: "INDRA", brand: "Sangria", name: "Sangria Blue 300 TC King Double Bedsheet With 2 Pillow Covers – 2.74 m × 2.74 m", category: "Home & Living", articleType: "Bedsheets", gender: "Home", colour: "Blue", mrp: 4499, sellingPrice: 1484, sourceUrl: "https://www.myntra.com/bedsheets/sangria/sangria-blue-300-tc-king-double-bedsheet-with-2-pillow-covers-274-m-x-274-m/38831890/buy" }),
  fabinalivBedsheet: listing({ styleId: "38606077", supplier: "FASHIONDECOR", brand: "FABINALIV", name: "FABINALIV Off White Cartoon Print 300 TC King Bedsheet with 2 Pillow Covers", category: "Home & Living", articleType: "Bedsheets", gender: "Home", colour: "Off White", mrp: 3329, sellingPrice: 664, sourceUrl: "https://www.myntra.com/bedsheets/fabinaliv/fabinaliv-off-white-cartoon-print-300-tc-king-bedsheet-with-2-pillow-covers/38606077/buy" }),
};

// Thirty-eight SKU/FC combinations: three real public styles per category,
// plus repeated style/size placements across FCs to exercise transfer decisions.
const products = [
  variant(catalogue.roadsterTee, { sizeCode: "M", size: "M", warehouse: "BLR_FC", base: 34, trend: 0.0012, demandProfile: "summer", lifecycleStage: "Growth", returnRate: 0.09, stockCoverDays: 3.5, reservedDays: 2.5, backorderDays: 1.2, safetyDays: 12, serviceLevel: 0.98, incoming: [{ days: 6, cover: 20, status: "in_transit" }, { days: 25, cover: 16, status: "confirmed" }] }),
  variant(catalogue.roadsterTee, { sizeCode: "M", size: "M", warehouse: "DEL_FC", base: 28, trend: 0.001, demandProfile: "summer", returnRate: 0.09, stockCoverDays: 10, reservedDays: 2, safetyDays: 11, incoming: [{ days: 12, cover: 18, status: "supplier_acknowledged" }] }),
  variant(catalogue.roadsterJeans, { sizeCode: "32", size: "32", warehouse: "MUM_FC", base: 18, trend: 0.0007, demandProfile: "denim", returnRate: 0.12, stockCoverDays: 8, reservedDays: 2, safetyDays: 11, incoming: [{ days: 9, cover: 18, status: "in_transit" }] }),
  variant(catalogue.roadsterJeans, { sizeCode: "34", size: "34", warehouse: "BLR_FC", base: 15, trend: -0.0004, demandProfile: "denim", lifecycleStage: "Markdown", returnRate: 0.13, stockCoverDays: 58, reservedDays: 1.2, safetyDays: 8 }),
  variant(catalogue.roadsterSecondTee, { sizeCode: "L", size: "L", warehouse: "KOL_FC", base: 12, trend: 0.0015, demandProfile: "youth", lifecycleStage: "Launch", launchDate: "2026-07-05", returnRate: 0.1, stockCoverDays: 11, reservedDays: 2, safetyDays: 11 }),

  variant(catalogue.dressberryDress, { sizeCode: "M", size: "M", warehouse: "MUM_FC", base: 17, trend: 0.0011, demandProfile: "summer", cancellationRate: 0.045, returnRate: 0.34, stockCoverDays: 4.5, reservedDays: 3, backorderDays: 0.8, safetyDays: 13, serviceLevel: 0.98, incoming: [{ days: 8, cover: 22, status: "in_transit" }] }),
  variant(catalogue.dressberryDress, { sizeCode: "M", size: "M", warehouse: "BLR_FC", base: 13, trend: 0.0008, demandProfile: "summer", cancellationRate: 0.045, returnRate: 0.22, stockCoverDays: 16, reservedDays: 2.5, safetyDays: 12 }),
  variant(catalogue.dressberrySquareTop, { sizeCode: "S", size: "S", warehouse: "KOL_FC", base: 22, trend: 0.0012, demandProfile: "youth", returnRate: 0.18, stockCoverDays: 8, reservedDays: 2.8, safetyDays: 12, incoming: [{ days: 11, cover: 20, status: "supplier_acknowledged" }] }),
  variant(catalogue.dressberrySquareTop, { sizeCode: "M", size: "M", warehouse: "DEL_FC", base: 19, trend: 0.001, demandProfile: "youth", availabilityStatus: "Paused", returnRate: 0.18, stockCoverDays: 31, reservedDays: 2.2, safetyDays: 11 }),
  variant(catalogue.dressberryTop, { sizeCode: "L", size: "L", warehouse: "BLR_FC", base: 21, trend: 0.0013, demandProfile: "youth", returnRate: 0.17, stockCoverDays: 6, reservedDays: 3, safetyDays: 13, serviceLevel: 0.98, incoming: [{ days: 5, cover: 18, status: "in_transit" }] }),

  variant(catalogue.anoukKurta, { sizeCode: "M", size: "M", warehouse: "DEL_FC", base: 19, trend: 0.0007, demandProfile: "ethnic", returnRate: 0.16, stockCoverDays: 10, reservedDays: 2.5, safetyDays: 12, incoming: [{ days: 17, cover: 24, status: "confirmed" }] }),
  variant(catalogue.anoukKurta, { sizeCode: "M", size: "M", warehouse: "KOL_FC", base: 16, trend: 0.0005, demandProfile: "ethnic", returnRate: 0.17, stockCoverDays: 18, reservedDays: 2, safetyDays: 11 }),
  variant(catalogue.anoukEmbroidered, { sizeCode: "L", size: "L", warehouse: "MUM_FC", base: 12, trend: 0.0009, demandProfile: "ethnic", returnRate: 0.19, stockCoverDays: 5, reservedDays: 2.4, backorderDays: 1, safetyDays: 14, serviceLevel: 0.99, incoming: [{ days: 20, cover: 28, status: "confirmed" }] }),
  variant(catalogue.anoukEmbroidered, { sizeCode: "XL", size: "XL", warehouse: "BLR_FC", base: 10, trend: -0.0001, demandProfile: "ethnic", returnRate: 0.18, stockCoverDays: 38, reservedDays: 1.5, safetyDays: 9 }),
  variant(catalogue.anoukSaree, { sizeCode: "OS", size: "One Size", warehouse: "DEL_FC", base: 8, demandProfile: "ethnic", intermittentProbability: 0.22, returnRate: 0.14, stockCoverDays: 28, reservedDays: 1.2, safetyDays: 9 }),

  variant(catalogue.hrxYogaTights, { sizeCode: "M", size: "M", warehouse: "MUM_FC", base: 16, trend: 0.0011, demandProfile: "active", returnRate: 0.16, stockCoverDays: 14, reservedDays: 2, safetyDays: 11 }),
  variant(catalogue.hrxYogaTights, { sizeCode: "M", size: "M", warehouse: "BLR_FC", base: 14, trend: 0.001, demandProfile: "active", returnRate: 0.16, stockCoverDays: 7, reservedDays: 2.4, safetyDays: 12, incoming: [{ days: 8, cover: 20, status: "in_transit" }] }),
  variant(catalogue.hrxMidRiseTights, { sizeCode: "L", size: "L", warehouse: "DEL_FC", base: 12, trend: 0.0007, demandProfile: "active", returnRate: 0.15, stockCoverDays: 9, reservedDays: 2, safetyDays: 11, incoming: [{ days: -5, cover: 16, status: "issued" }] }),
  variant(catalogue.hrxMidRiseTights, { sizeCode: "L", size: "L", warehouse: "KOL_FC", base: 10, trend: 0.0004, demandProfile: "active", returnRate: 0.15, stockCoverDays: 26, reservedDays: 1.5, safetyDays: 9 }),
  variant(catalogue.hrxShorts, { sizeCode: "32", size: "32", warehouse: "BLR_FC", base: 13, trend: 0.0015, demandProfile: "active", lifecycleStage: "Launch", launchDate: "2026-07-08", returnRate: 0.11, stockCoverDays: 10, reservedDays: 2, safetyDays: 11 }),

  variant(catalogue.hrxRunOne, { sizeCode: "UK8", size: "UK 8", warehouse: "MUM_FC", base: 10, trend: 0.0007, demandProfile: "active", returnRate: 0.2, gstRate: 18, stockCoverDays: 7, reservedDays: 1.8, safetyDays: 13, incoming: [{ days: -4, cover: 10, status: "issued" }, { days: 27, cover: 32, status: "confirmed" }] }),
  variant(catalogue.hrxRunOne, { sizeCode: "UK8", size: "UK 8", warehouse: "DEL_FC", base: 9, trend: 0.0006, demandProfile: "active", returnRate: 0.2, gstRate: 18, stockCoverDays: 17, reservedDays: 1.5, safetyDays: 11 }),
  variant(catalogue.hrxRunTwo, { sizeCode: "UK9", size: "UK 9", warehouse: "BLR_FC", base: 13, trend: 0.0009, demandProfile: "youth", returnRate: 0.19, gstRate: 18, stockCoverDays: 9, reservedDays: 2.2, safetyDays: 12, incoming: [{ days: 15, cover: 26, status: "supplier_acknowledged" }] }),
  variant(catalogue.hrxRunTwo, { sizeCode: "UK9", size: "UK 9", warehouse: "MUM_FC", base: 11, trend: 0.0007, demandProfile: "youth", returnRate: 0.2, gstRate: 18, stockCoverDays: 27, reservedDays: 1.5, safetyDays: 10 }),
  variant(catalogue.roadsterSneaker, { sizeCode: "UK6", size: "UK 6", warehouse: "KOL_FC", base: 8, trend: -0.001, demandProfile: "youth", lifecycleStage: "Markdown", returnRate: 0.21, gstRate: 18, stockCoverDays: 64, reservedDays: 1, safetyDays: 8 }),

  variant(catalogue.roadsterBackpack, { sizeCode: "OS", size: "One Size", warehouse: "MUM_FC", base: 11, trend: 0.0006, demandProfile: "accessory", intermittentProbability: 0.48, returnRate: 0.08, stockCoverDays: 13, reservedDays: 1.8, safetyDays: 9, incoming: [{ days: 10, cover: 20, status: "in_transit" }] }),
  variant(catalogue.dressberryHandbag, { sizeCode: "OS", size: "One Size", warehouse: "DEL_FC", base: 14, trend: 0.0008, demandProfile: "accessory", returnRate: 0.09, stockCoverDays: 7, reservedDays: 2, safetyDays: 10, incoming: [{ days: 12, cover: 24, status: "supplier_acknowledged" }] }),
  variant(catalogue.mastHarbourBelt, { sizeCode: "34", size: "34", warehouse: "BLR_FC", base: 9, trend: -0.001, demandProfile: "accessory", lifecycleStage: "End of Life", endOfLifeDate: "2026-07-31", returnRate: 0.07, stockCoverDays: 62, reservedDays: 1, safetyDays: 7 }),

  variant(catalogue.ykBoysTee, { sizeCode: "7-8Y", size: "7-8Y", warehouse: "DEL_FC", base: 15, trend: 0.0009, demandProfile: "campus", returnRate: 0.11, stockCoverDays: 6, reservedDays: 2.2, safetyDays: 12, incoming: [{ days: 7, cover: 22, status: "in_transit" }] }),
  variant(catalogue.ykBoysTee, { sizeCode: "7-8Y", size: "7-8Y", warehouse: "KOL_FC", base: 13, trend: 0.0007, demandProfile: "campus", returnRate: 0.11, stockCoverDays: 20, reservedDays: 1.5, safetyDays: 10 }),
  variant(catalogue.ykPrintedTee, { sizeCode: "9-10Y", size: "9-10Y", warehouse: "MUM_FC", base: 10, trend: -0.0003, demandProfile: "campus", lifecycleStage: "Markdown", returnRate: 0.12, stockCoverDays: 48, reservedDays: 1.2, safetyDays: 8 }),
  variant(catalogue.ykGirlsDress, { sizeCode: "10-11Y", size: "10-11Y", warehouse: "BLR_FC", base: 13, trend: 0.001, demandProfile: "campus", lifecycleStage: "Launch", launchDate: "2026-07-05", returnRate: 0.14, stockCoverDays: 11, reservedDays: 2, safetyDays: 11 }),

  variant(catalogue.nandiayanLipstick, { sizeCode: "OS", size: "One Size", warehouse: "BLR_FC", base: 7, trend: 0.0004, demandProfile: "beauty", intermittentProbability: 0.32, returnRate: 0.05, stockCoverDays: 16, reservedDays: 1, safetyDays: 10 }),
  variant(catalogue.etudeTint, { sizeCode: "OS", size: "One Size", warehouse: "DEL_FC", base: 20, trend: 0.0011, demandProfile: "beauty", returnRate: 0.04, stockCoverDays: 5, reservedDays: 2.5, safetyDays: 13, incoming: [{ days: 9, cover: 22, status: "in_transit" }] }),
  variant(catalogue.mamaearthLipstick, { sizeCode: "OS", size: "One Size", warehouse: "MUM_FC", base: 9, trend: -0.0011, demandProfile: "beauty", lifecycleStage: "Markdown", returnRate: 0.04, stockCoverDays: 72, reservedDays: 0.8, safetyDays: 7 }),

  variant(catalogue.klottheBedsheet, { sizeCode: "KING", size: "King", warehouse: "KOL_FC", base: 5, trend: 0.0004, demandProfile: "home", intermittentProbability: 0.4, returnRate: 0.09, stockCoverDays: 12, reservedDays: 1, safetyDays: 10, incoming: [{ days: 14, cover: 24, status: "confirmed" }] }),
  variant(catalogue.sangriaBedsheet, { sizeCode: "KING", size: "King", warehouse: "BLR_FC", base: 7, trend: 0.0008, demandProfile: "home", intermittentProbability: 0.22, returnRate: 0.1, stockCoverDays: 6, reservedDays: 1.5, safetyDays: 12, incoming: [{ days: -6, cover: 18, status: "issued" }] }),
  variant(catalogue.fabinalivBedsheet, { sizeCode: "KING", size: "King", warehouse: "DEL_FC", base: 4, trend: -0.0006, demandProfile: "home", intermittentProbability: 0.48, lifecycleStage: "End of Life", endOfLifeDate: "2026-07-31", returnRate: 0.08, stockCoverDays: 88, reservedDays: 0.5, safetyDays: 7 }),
];

function pseudoRandom(seed) {
  let value = seed >>> 0;
  value += 0x6d2b79f5;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
}

function dateBetween(date, from, to) {
  return date >= from && date <= to;
}

function demandSeasonality(profile, date) {
  const month = Number(date.slice(5, 7));
  if (profile === "winter") return month <= 2 ? 1.55 : month >= 11 ? 1.35 : 0.42;
  if (profile === "summer") return month >= 3 && month <= 6 ? 1.18 : month === 7 ? 1.08 : 0.92;
  if (profile === "ethnic") return [2, 3, 4].includes(month) ? 1.25 : month === 7 ? 1.08 : 0.95;
  if (profile === "active") return month === 1 ? 1.28 : month === 6 ? 1.12 : 1;
  if (profile === "campus") return month === 6 || month === 7 ? 1.35 : 0.88;
  if (profile === "beauty") return [2, 3, 10, 11].includes(month) ? 1.14 : 1;
  if (profile === "home") return month >= 5 && month <= 7 ? 1.12 : 0.96;
  if (profile === "office") return month === 1 || month === 4 || month === 7 ? 1.08 : 1;
  if (profile === "denim") return month >= 4 && month <= 6 ? 0.9 : 1.05;
  return 1;
}

function promotionFor(date, productRow) {
  if (dateBetween(date, "2026-01-22", "2026-01-27")) return { name: "Myntra Republic Day Sale", multiplier: 1.65 };
  if (dateBetween(date, "2026-03-01", "2026-03-05")) return { name: "Myntra Birthday Blast", multiplier: productRow.demandProfile === "youth" ? 1.85 : 1.45 };
  if (dateBetween(date, "2026-04-10", "2026-04-14")) return { name: "Myntra Summer Style Fest", multiplier: ["summer", "accessory"].includes(productRow.demandProfile) ? 1.8 : 1.35 };
  if (dateBetween(date, "2026-05-29", "2026-06-07")) return { name: "Myntra EORS", multiplier: ["youth", "summer", "footwear"].includes(productRow.demandProfile) ? 2.75 : 2.35 };
  if (dateBetween(date, "2026-07-12", "2026-07-17")) return { name: "Myntra Monsoon Style Fest", multiplier: ["ethnic", "winter"].includes(productRow.demandProfile) ? 1.35 : 1.65 };
  if (dateBetween(date, "2026-07-22", "2026-07-26") && ["campus", "youth"].includes(productRow.demandProfile)) return { name: "Myntra Back to Campus", multiplier: 1.85 };
  return { name: "Organic", multiplier: 1 };
}

function csvCell(value) {
  if (value === undefined || value === null) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const row = (values) => values.map(csvCell).join(",");
const roundToPack = (qty, packSize) => Math.max(packSize, Math.ceil(qty / packSize) * packSize);
const styleIdOf = (p) => p.styleId;
const productKey = (p) => `${p.warehouse}::::${p.sku}`;

// Short, explicit unavailable periods exercise the forecast engine's
// stockout-censoring logic without overwhelming the demand history.
const stockoutWindows = {
  "BLR_FC::::MYN-3314131-M": [["2026-07-03", "2026-07-05"]],
  "MUM_FC::::MYN-20721342-M": [["2026-07-18", "2026-07-20"]],
  "MUM_FC::::MYN-34530975-L": [["2026-07-28", "2026-07-30"]],
  "DEL_FC::::MYN-24541476-7-8Y": [["2026-06-24", "2026-06-25"]],
  "DEL_FC::::MYN-27916434-OS": [["2026-07-26", "2026-07-28"]],
};
const isInStockOn = (p, date) => !(stockoutWindows[productKey(p)] ?? []).some(([from, to]) => dateBetween(date, from, to));

const salesHeader = [
  "Date", "SKU", "Vendor", "Warehouse", "Units_Sold", "Returns_Qty", "Cancellations_Qty",
  "Is_Promotion", "Discount_Pct", "In_Stock", "Category", "Brand", "Style_ID", "Size",
  "Gross_Orders", "Fulfilled_Units", "Net_Realised_Units", "Net_GMV_INR", "Promotion", "Marketplace",
  "Product_Name", "Article_Type", "Gender", "Colour", "MRP_INR", "Selling_Price_INR",
  "Lifecycle_Stage", "Availability_Status", "Launch_Date", "End_Of_Life_Date",
  "Marketplace_Seller", "Myntra_Product_URL", "Price_Captured_On", "Catalogue_Data_Provenance",
  "Commercial_Data_Provenance",
];
const sales = [row(salesHeader)];
const salesByProduct = new Map(products.map((p) => [productKey(p), []]));
let totalGrossOrders = 0;
let totalRealisedUnits = 0;

for (let day = 0; day < HISTORY_DAYS; day++) {
  const date = new Date(start + day * DAY).toISOString().slice(0, 10);
  const dateObject = new Date(`${date}T00:00:00Z`);
  const dayOfWeek = dateObject.getUTCDay();
  const dayOfMonth = dateObject.getUTCDate();
  const weekend = [0, 6].includes(dayOfWeek) ? 1.18 : dayOfWeek === 5 ? 1.08 : dayOfWeek === 1 ? 0.92 : 1;
  const payday = dayOfMonth <= 5 ? 1.1 : 1;

  for (let index = 0; index < products.length; index++) {
    const p = products[index];
    // Pre-launch dates are absent rather than encoded as zero sales or a
    // stockout. This gives new articles honestly short histories.
    if (date < p.launchDate || (p.endOfLifeDate && date > p.endOfLifeDate)) continue;
    const promo = promotionFor(date, p);
    const trend = Math.max(0.65, 1 + day * p.trend);
    const wave = 1 + Math.sin((day + index * 2.7) / 8.5) * 0.1;
    const noise = 0.84 + pseudoRandom((day + 1) * 65_537 + (index + 1) * 9_973) * 0.34;
    const inStock = isInStockOn(p, date);
    const hasDemand = pseudoRandom((day + 1) * 104_729 + (index + 1) * 15_485) >= p.intermittentProbability;
    const grossOrders = inStock && hasDemand ? Math.max(0, Math.round(p.base * weekend * payday * trend * wave * noise * demandSeasonality(p.demandProfile, date) * promo.multiplier)) : 0;
    const cancelledUnits = Math.min(grossOrders, Math.round(grossOrders * p.cancellationRate * (0.75 + pseudoRandom(day * 131 + index * 17 + 9) * 0.65)));
    const fulfilledUnits = grossOrders - cancelledUnits;
    const returnedUnits = Math.min(fulfilledUnits, Math.round(fulfilledUnits * p.returnRate * (0.78 + pseudoRandom(day * 173 + index * 31 + 19) * 0.5)));
    const netRealisedUnits = fulfilledUnits - returnedUnits;
    const realisedSellingPrice = Math.round(p.sellingPrice * (promo.multiplier > 1 ? 0.94 : 1));
    const discountPct = Math.round((1 - realisedSellingPrice / p.mrp) * 1000) / 10;
    const netGmv = netRealisedUnits * realisedSellingPrice;
    // The forecasting contract treats Units_Sold as gross marketplace demand,
    // then adjusts it with the optional cancellation and return columns.
    salesByProduct.get(productKey(p)).push(netRealisedUnits);
    totalGrossOrders += grossOrders;
    totalRealisedUnits += netRealisedUnits;
    sales.push(row([
      date, p.sku, suppliers[p.supplier].name, p.warehouse, grossOrders, returnedUnits, cancelledUnits,
      promo.name === "Organic" ? "no" : "yes", discountPct, inStock ? "yes" : "no", p.category,
      p.brand, styleIdOf(p), p.size, grossOrders, fulfilledUnits, netRealisedUnits, netGmv, promo.name,
      "Myntra", p.name, p.articleType, p.gender, p.colour, p.mrp, realisedSellingPrice,
      p.lifecycleStage, p.availabilityStatus, p.launchDate, p.endOfLifeDate,
      p.marketplaceSeller, p.sourceUrl, p.priceCapturedOn, p.catalogueDataProvenance, p.commercialDataProvenance,
    ]));
  }
}

const trailingAverage = (p, days = 28) => {
  const values = salesByProduct.get(productKey(p)).slice(-days);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
};

const inventory = [row([
  "SKU", "Vendor", "Warehouse", "Snapshot_Date", "Current_Inventory", "Reserved_Qty", "Backorder_Qty", "Marketplace",
  "Brand", "Product_Name", "Category", "Style_ID", "Article_Type", "Gender", "Size", "Colour", "MRP_INR",
  "Selling_Price_INR", "Inventory_Value_INR", "Stock_Cover_Target_Days", "Lifecycle_Stage",
  "Availability_Status", "Launch_Date", "End_Of_Life_Date",
  "Marketplace_Seller", "Myntra_Product_URL", "Price_Captured_On", "Catalogue_Data_Provenance",
  "Commercial_Data_Provenance",
])];

for (const p of products) {
  const rate = trailingAverage(p);
  const currentInventory = Math.max(0, Math.round(rate * p.stockCoverDays));
  const reservedQty = Math.max(0, Math.round(rate * p.reservedDays));
  const backorderQty = Math.max(0, Math.round(rate * p.backorderDays));
  inventory.push(row([
    p.sku, suppliers[p.supplier].name, p.warehouse, AS_OF_DATE, currentInventory, reservedQty, backorderQty, "Myntra",
    p.brand, p.name, p.category, styleIdOf(p), p.articleType, p.gender, p.size, p.colour, p.mrp, p.sellingPrice,
    currentInventory * p.cost, p.stockCoverDays, p.lifecycleStage, p.availabilityStatus, p.launchDate, p.endOfLifeDate,
    p.marketplaceSeller, p.sourceUrl, p.priceCapturedOn, p.catalogueDataProvenance, p.commercialDataProvenance,
  ]));
}

const openPos = [row([
  "SKU", "Vendor", "Warehouse", "Open_PO_Qty", "Expected_Date", "PO_Number", "Status", "Currency",
  "Unit_Cost_INR", "PO_Value_INR", "Marketplace", "Brand", "Product_Name", "Category", "Size", "Colour",
  "Style_ID", "Marketplace_Seller", "Myntra_Product_URL", "Price_Captured_On",
  "Catalogue_Data_Provenance", "Commercial_Data_Provenance",
])];
let poSequence = 1001;
for (const p of products) {
  const supplier = suppliers[p.supplier];
  const rate = trailingAverage(p);
  for (const receipt of p.incoming) {
    const quantity = roundToPack(rate * receipt.cover, p.packSize ?? supplier.packSize);
    const expectedDate = new Date(Date.parse(`${AS_OF_DATE}T00:00:00Z`) + receipt.days * DAY).toISOString().slice(0, 10);
    openPos.push(row([
      p.sku, supplier.name, p.warehouse, quantity, expectedDate, `MYN-PO-2026-${poSequence++}`, receipt.status,
      "INR", p.cost, quantity * p.cost, "Myntra", p.brand, p.name, p.category, p.size, p.colour,
      p.styleId, p.marketplaceSeller, p.sourceUrl, p.priceCapturedOn, p.catalogueDataProvenance, p.commercialDataProvenance,
    ]));
  }
}

const vendorHeader = [
  "Vendor", "SKU", "Warehouse", "Supplier_SKU", "MOQ", "Pack_Size", "Max_Order_Qty", "Lead_Time_Days",
  "Review_Period_Days", "Safety_Stock", "Service_Level", "Unit_Price", "Currency", "Minimum_Order_Value",
  "Freight_Free_Threshold", "Payment_Terms", "Incoterms", "Contact_Email", "Marketplace", "Supplier_City",
  "Supplier_State", "GSTIN", "Brand", "Product_Name", "Category", "HSN_Code", "Article_Type", "Gender", "Size", "Colour",
  "MRP_INR", "Typical_Selling_Price_INR", "GST_Rate", "Return_Allowance_Pct",
  "Lifecycle_Stage", "Availability_Status", "Launch_Date", "End_Of_Life_Date",
  "Marketplace_Seller", "Myntra_Product_URL", "Price_Captured_On", "Catalogue_Data_Provenance",
  "Commercial_Data_Provenance",
];
const vendors = [row(vendorHeader)];
const vendorRow = (values) => row(vendorHeader.map((header) => values[header] ?? ""));
const hsnByArticle = {
  "T-shirts": "6109", Jeans: "6203", Dresses: "6204", Tops: "6106", Kurtas: "6211", Sarees: "5007",
  Tights: "6104", Shorts: "6103", "Sports Shoes": "6404", "Casual Shoes": "6404", Backpacks: "4202",
  Handbags: "4202", Belts: "4203", Lipstick: "3304", "Lip Tint": "3304", Bedsheets: "6302",
};

for (const [code, supplier] of Object.entries(suppliers)) {
  const representative = products.find((p) => p.supplier === code);
  vendors.push(vendorRow({
    Vendor: supplier.name, Supplier_SKU: `${code}-GENERAL`, MOQ: supplier.moq, Pack_Size: supplier.packSize,
    Max_Order_Qty: supplier.maxOrderQty, Lead_Time_Days: supplier.leadTime,
    Review_Period_Days: supplier.reviewPeriod, Service_Level: 0.95,
    Unit_Price: representative?.cost ?? "", Currency: "INR", Minimum_Order_Value: supplier.minimumOrderValue,
    Freight_Free_Threshold: supplier.freightFreeThreshold, Payment_Terms: supplier.paymentTerms,
    Incoterms: "DDP", Contact_Email: supplier.email, Marketplace: "Myntra", Supplier_City: supplier.city,
    Supplier_State: supplier.state, GSTIN: supplier.gstin, Marketplace_Seller: supplier.name,
    Catalogue_Data_Provenance: "Public seller name; no product attached",
    Commercial_Data_Provenance: COMMERCIAL_PROVENANCE,
  }));
}

for (const p of products) {
  const supplier = suppliers[p.supplier];
  const safetyStock = roundToPack(trailingAverage(p) * p.safetyDays, p.packSize ?? supplier.packSize);
  vendors.push(vendorRow({
    Vendor: supplier.name, SKU: p.sku, Warehouse: p.warehouse, Supplier_SKU: p.supplierSku,
    MOQ: p.moq ?? supplier.moq, Pack_Size: p.packSize ?? supplier.packSize,
    Max_Order_Qty: p.maxOrderQty ?? supplier.maxOrderQty, Lead_Time_Days: p.leadTime ?? supplier.leadTime,
    Review_Period_Days: p.reviewPeriod ?? supplier.reviewPeriod, Safety_Stock: safetyStock,
    Service_Level: p.serviceLevel, Unit_Price: p.cost, Currency: "INR",
    Minimum_Order_Value: supplier.minimumOrderValue, Freight_Free_Threshold: supplier.freightFreeThreshold,
    Payment_Terms: supplier.paymentTerms, Incoterms: "DDP", Contact_Email: supplier.email,
    Marketplace: "Myntra", Supplier_City: supplier.city, Supplier_State: supplier.state, GSTIN: supplier.gstin,
    Brand: p.brand, Product_Name: p.name, Category: p.category, HSN_Code: hsnByArticle[p.articleType] ?? "",
    Article_Type: p.articleType, Gender: p.gender, Size: p.size, Colour: p.colour, MRP_INR: p.mrp,
    Typical_Selling_Price_INR: p.sellingPrice, GST_Rate: p.gstRate,
    Return_Allowance_Pct: Math.round(p.returnRate * 100), Lifecycle_Stage: p.lifecycleStage,
    Availability_Status: p.availabilityStatus, Launch_Date: p.launchDate, End_Of_Life_Date: p.endOfLifeDate,
    Marketplace_Seller: p.marketplaceSeller, Myntra_Product_URL: p.sourceUrl,
    Price_Captured_On: p.priceCapturedOn, Catalogue_Data_Provenance: p.catalogueDataProvenance,
    Commercial_Data_Provenance: p.commercialDataProvenance,
  }));
}

// This fifth file can be imported directly in the in-app supplier mapping
// workspace. It deliberately has one governed relationship per Style ID,
// unlike vendor_master.csv, whose operational rules can be SKU/FC-grained.
const mappingHeader = [
  "Style ID", "Product Name", "Brand", "Category", "Article Type", "Vendor", "Supplier Email",
  "Supplier SKU", "NLC INR", "HSN Code", "GST Rate", "Supplier GSTIN", "Supplier State",
  "Lead Time Days", "Payment Terms", "Incoterms", "MOQ", "Pack Size",
];
const supplierMappings = [row(mappingHeader)];
const mappedStyleIds = new Set();
for (const p of products) {
  if (mappedStyleIds.has(p.styleId)) continue;
  mappedStyleIds.add(p.styleId);
  const supplier = suppliers[p.supplier];
  supplierMappings.push(row([
    p.styleId, p.name, p.brand, p.category, p.articleType, supplier.name, supplier.email,
    `DEMO-STYLE-${p.styleId}`, supplier.commercialReady ? p.cost : "", hsnByArticle[p.articleType] ?? "",
    p.gstRate, supplier.gstin, supplier.state, p.leadTime ?? supplier.leadTime, supplier.paymentTerms,
    "DDP", p.moq ?? supplier.moq, p.packSize ?? supplier.packSize,
  ]));
}

const usedSupplierCodes = new Set(products.map((p) => p.supplier));
const readySupplierCodes = [...usedSupplierCodes].filter((code) => suppliers[code].commercialReady);
const readyStyleIds = new Set(products.filter((p) => suppliers[p.supplier].commercialReady).map((p) => p.styleId));
const supplierReadyPct = readySupplierCodes.length / usedSupplierCodes.size * 100;
const styleReadyPct = readyStyleIds.size / mappedStyleIds.size * 100;
if (supplierReadyPct < 75 || supplierReadyPct > 85 || styleReadyPct < 75 || styleReadyPct > 85) {
  throw new Error(`Demo supplier readiness must stay near 80%; found ${supplierReadyPct.toFixed(1)}% suppliers and ${styleReadyPct.toFixed(1)}% styles.`);
}

const sourceHeader = [
  "Category", "Style_ID", "Brand", "Product_Name", "Article_Type", "Gender", "MRP_INR",
  "Selling_Price_INR", "Marketplace_Seller", "Myntra_Product_URL", "Price_Captured_On",
  "Catalogue_Data_Provenance", "Commercial_Data_Provenance",
];
const sources = [row(sourceHeader)];
const seenStyles = new Set();
for (const p of products) {
  if (seenStyles.has(p.styleId)) continue;
  seenStyles.add(p.styleId);
  sources.push(row([
    p.category, p.styleId, p.brand, p.name, p.articleType, p.gender, p.mrp, p.sellingPrice,
    p.marketplaceSeller, p.sourceUrl, p.priceCapturedOn, p.catalogueDataProvenance,
    "Demand, FC, buying cost, MOQ, lead time, tax, inventory and PO relationships are synthetic demo assumptions",
  ]));
}

const files = {
  "historical_sales.csv": sales,
  "current_inventory.csv": inventory,
  "open_purchase_orders.csv": openPos,
  "vendor_master.csv": vendors,
  "supplier_mappings.csv": supplierMappings,
  "catalogue_sources.csv": sources,
};

for (const output of outputs) {
  for (const [filename, lines] of Object.entries(files)) writeFileSync(`${output}${filename}`, `${lines.join("\n")}\n`);
}

console.log(`Created sourced-catalogue + synthetic-operations Myntra demo CSVs in ${outputs.join(" and ")}`);
console.log(`  ${seenStyles.size} real public style IDs across ${new Set(products.map((p) => p.category)).size} categories`);
console.log(`  ${products.length} SKU/warehouse combinations across ${Object.keys(suppliers).length} public marketplace seller snapshots and 4 fulfilment centres`);
console.log(`  ${sales.length - 1} daily sales rows from ${new Date(start).toISOString().slice(0, 10)} to 2026-07-31`);
console.log(`  ${openPos.length - 1} open PO lines; all supplier and PO values are INR`);
console.log(`  ${readySupplierCodes.length}/${usedSupplierCodes.size} suppliers (${supplierReadyPct.toFixed(2)}%) and ${readyStyleIds.size}/${mappedStyleIds.size} style mappings (${styleReadyPct.toFixed(2)}%) are fully PO-ready`);
console.log(`  ${usedSupplierCodes.size - readySupplierCodes.length} suppliers intentionally omit NLC and GSTIN for inline-resolution testing`);
console.log(`  ${totalGrossOrders.toLocaleString("en-IN")} gross orders and ${totalRealisedUnits.toLocaleString("en-IN")} net realised units`);
