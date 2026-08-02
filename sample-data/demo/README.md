# Demo upload pack

Upload these four files to run the Myntra replenishment demo:

1. `historical_sales.csv`
2. `current_inventory.csv`
3. `open_purchase_orders.csv`
4. `vendor_master.csv`

`catalogue_sources.csv` is an optional source register for audit and does not need to be uploaded.

`supplier_mappings.csv` is an optional import-ready sheet for the in-app vendor–supplier mapping workspace. It contains 18 of 23 fully populated supplier profiles (22 of 27 style mappings); five suppliers deliberately omit NLC and GSTIN so the inline Raise PO resolver can be tested.

The pack mixes two clearly labelled data classes:

- **Public listing snapshot:** Myntra style ID, product title, brand, displayed MRP, displayed selling price, displayed marketplace seller and product URL, captured on **2026-08-01**.
- **Synthetic demo assumptions:** all demand, FC, inventory, procurement cost, vendor relationship, tax/HSN, MOQ, pack, lead-time, lifecycle and PO data. Most rows include format-valid synthetic GSTINs for workflow testing; these are not the sellers' real tax identities. Five deliberately incomplete rows in `supplier_mappings.csv` leave NLC and GSTIN blank. The required NLC remains present in the four-file operational upload.

Public prices and sellers are volatile and may no longer match the live listing. A displayed marketplace seller is not proof of manufacturer status or a contracted PO relationship. `Unit_Price` is the synthetic procurement cost; the captured selling price is a retail/GMV field and must not be used as PO cost. All money is INR.

See [`../README.md`](../README.md) for the full truth boundary and field definitions. Do not use these files for real purchasing.
