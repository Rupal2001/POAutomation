# Myntra planning sample data

This directory contains a realistic **demo dataset**, not production Myntra data. It combines a dated public-catalogue snapshot with generated planning and procurement assumptions so the application can be explored safely.

## What is public catalogue data

`catalogue_sources.csv` is the source register for **27 styles across nine Myntra categories** (three styles per category). For each example style it records:

- the Myntra style ID, brand, product title, article type and displayed marketplace seller;
- the displayed MRP and selling price in Indian rupees; and
- the public Myntra product URL and the date on which the listing facts were captured.

The catalogue facts were captured on **2026-08-01**. Marketplace prices, availability, titles and sellers can change after that date; the file is a snapshot, not a live catalogue feed. `Marketplace_Seller` means the seller displayed on the public listing at capture time. It does not establish that the seller is the manufacturer, the brand owner, or a contracted purchase-order supplier.

## What is synthetic

The following are generated demo assumptions, even when a real public seller name is reused in the `Vendor` column:

- demo SKU and supplier-SKU variants, sizes and FC allocation;
- sales, returns, cancellations, promotions and stock availability history;
- inventory, reservations, backorders and open purchase orders;
- procurement cost (`Unit_Price`), MOQ, pack size, lead time and service level;
- GST rates, HSN headings, payment terms, supplier contact details, location and format-valid synthetic GSTINs; and
- lifecycle, availability, launch/end-of-life dates and every inferred commercial relationship.

Email addresses under `supplier-demo.example` are deliberately non-deliverable examples. Synthetic GSTINs are provided only to exercise validation and document-readiness flows; they do not assert or represent any seller's real tax registration.

## Price fields are intentionally separate

- `MRP_INR` and `Selling_Price_INR` / `Typical_Selling_Price_INR` are public retail-listing snapshot fields.
- `Unit_Price` is a synthetic procurement-cost assumption used to estimate PO and inventory investment.

The planner must never substitute the selling price for procurement cost. GMV exposure uses the captured selling price; purchase-order value uses `Unit_Price`. All monetary values in these files are INR.

## Provenance fields

The four upload files carry the source context with the recommendation:

- `Marketplace_Seller`
- `Myntra_Product_URL`
- `Price_Captured_On`
- `Catalogue_Data_Provenance`
- `Commercial_Data_Provenance`

Use `npm run sample:generate` to regenerate both this directory and `sample-data/demo/`. The four operational CSVs can be uploaded to the app; `catalogue_sources.csv` is an optional audit/reference download and is not required by the planning engine. `supplier_mappings.csv` is an optional, import-ready sheet for the in-app vendor–supplier mapping workspace.

## Deliberate 80:20 supplier-readiness mix

The generated mapping sheet makes **18 of 23 suppliers (78.26%)** fully populated. Because the five intentionally incomplete suppliers each represent one style, **22 of 27 style mappings (81.48%)** are fully populated. Complete examples include supplier identity, supplier SKU/email, INR NLC, HSN/GST, a format-valid synthetic GSTIN/state, lead time, payment terms, Incoterms, MOQ and pack size.

Five rows in `supplier_mappings.csv` intentionally omit **NLC and GSTIN**. Their supplier identity and catalogue facts remain visible, so a planner can use the inline Raise PO resolver to add the positive INR cost, create a draft and then complete the remaining tax detail before dispatch. The four-file operational upload keeps its required NLC values so it remains a valid planning dataset; those same five suppliers still omit synthetic GSTIN and therefore remain commercially incomplete. This incompleteness is test data, not evidence about the public marketplace seller.

In the separate-file upload flow, the app recognizes these as SKU/warehouse-grained operational exports and converts them to the approved style-level New PO contract. `Style_ID` remains the calculation identity; `SKU` is used only to join the richer source rows. The blank-SKU rows in `vendor_master.csv` are intentionally valid vendor-wide defaults. They never become styles by themselves and never nominate a supplier unless a style-specific rule identifies that supplier. With the generated files and the default controls, the regression result is 210 selling days, 27 styles, 19 actionable styles and 11,747 actionable units.

Do not use this dataset to raise real orders. Production use needs authorised catalogue, inventory, sales, supplier-master and purchase-order feeds with current commercial agreements.

## Optional local Noise-workbook mapping seed

The bundled `methodology/Noise_113.xlsx` demo may already have source-snapshot mapping rows in PostgreSQL. `npm run sample:seed-noise` performs a **read-only dry run** against the local database and previews the guarded v2 enrichment against all 121 distinct recommendation styles: exactly 97 become fully mapped (80.17%), while 24 remain unresolved (19.83%) for inline-resolution testing. Styles absent from the mapping master are materialised with no-overwrite semantics before the safe demo rows are enriched.

The seed configuration is [`methodology/noise_demo_supplier_seed.json`](methodology/noise_demo_supplier_seed.json). All added contacts, GSTINs, supplier SKUs, INR costs and terms are synthetic demo values. The script refuses remote databases, aborts if the expected Noise sample shape has changed, never enriches manual/imported/inline-resolution mappings, preserves existing supplier names and requires a separate explicit confirmation before `--apply`. Apply mode is a single audited transaction; rerunning it at 97/121 is a no-op. Running the dry run does not change the database.
