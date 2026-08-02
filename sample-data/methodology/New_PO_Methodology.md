# New PO Tab — Methodology

Documentation for the **New PO** tab added to `Noise_113_NewPO.xlsx`. This tab calculates a purchase order quantity ask for each style_id, using live formulas that recalculate automatically if the source tabs are refreshed.

## Source Tabs Used

| Tab | Fields Used |
|---|---|
| NOISE headphones Sell out | `order_Month`, `style_id`, `qty` |
| Current Inventory | `style_id`, `inv_units_q1` |
| Open PO | `style_id`, `pending_qty` |
| Style ID details | `Style Id`, `Model`, `MRP`, `NLC` |

## Input Parameters (top of sheet)

| Cell | Parameter | Value | Notes |
|---|---|---|---|
| C1 | Number of unique order days | Formula-derived (currently 30) | Distinct count of `order_Month` values in the Sell out tab; used as the DRR denominator |
| C2 | PO Cover Days | 45 | Editable input — drives the PO QTY ASK formula |
| C3 | DOH Threshold | 80 | Reference label for the filter cutoff applied to the DOH column |

## Column-by-Column Logic

1. **Style ID** — Unique list of `style_id` values from the Sell out tab (121 styles).
2. **Sum of Sales** — `SUMIFS` of `qty` from the Sell out tab, per style_id.
3. **DRR (Daily Run Rate)** — Sum of Sales ÷ Number of unique order days (cell C1).
4. **Current Inventory** — `SUMIFS` of `inv_units_q1` from the Current Inventory tab, per style_id.
5. **DOH (Days on Hand)** — Current Inventory ÷ DRR. Returns `"NA"` where DRR is 0 (no sales), to avoid a divide-by-zero error.
6. **Filter — DOH < 80** — An Excel AutoFilter is applied on the DOH column; rows with DOH ≥ 80 (or `"NA"`) are hidden. 49 of 121 styles currently meet the < 80 criteria.
7. **Open PO** — `SUMIFS` of `pending_qty` from the Open PO tab, per style_id.
8. **PO QTY ASK** — `(DRR × PO Cover Days) − Current Inventory − Open PO`, rounded to the nearest whole unit. Uses the 45-day cover set in cell C2.
9. **Model / MRP / NLC** — `VLOOKUP` from the Style ID details tab, per style_id.

## Known Data Notes

- The Current Inventory tab's `Model` column (column N) contains ~90 pre-existing `#N/A` errors in the original source file. These predate this build and do not affect the New PO tab, which sources Model/MRP/NLC from the Style ID details tab instead.
- The DOH Threshold cell (C3) currently serves as a display label; the actual AutoFilter condition is hardcoded to < 80 in the filter definition. To make the filter fully dynamic against C3, the filter's custom criteria would need to be rebuilt if the threshold changes.
