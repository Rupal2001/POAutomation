# StyleFlow — Myntra Supply Planning

StyleFlow is a Myntra-focused purchase-order planning and execution workbench. It turns style-level sell-out, current inventory, open POs and style commercial details into explainable INR buy recommendations using the approved **New PO** methodology, then carries approved decisions into auditable purchase orders.

The included demo combines a dated snapshot of public Myntra catalogue listings with synthetic planning operations. Public style IDs, product names, displayed MRP/selling price, listing seller and source URL were captured on 1 August 2026; demand, inventory, costs, supplier terms and PO relationships are generated demo assumptions. It does not contain confidential or internal Myntra data.

## Product capabilities

- One bulk methodology workbook or four independently uploaded source files
- Connected planning from the latest immutable PostgreSQL snapshot, with brand, style, supplier, product, category, article type, warehouse and date filters
- Fashion hierarchy: brand, category, style, size/SKU and fulfilment centre
- Indian rupees throughout the UI, exports, calculations and database
- Style-level DRR, DOH eligibility and cover-day PO ask from the supplied methodology
- Forecast accuracy, bias and confidence remain visible as supporting evidence; they do not replace the approved PO quantity formula
- Projected stockout and reorder-by dates
- Filterable replenishment workbench with inline quantity overrides
- In-app vendor–supplier mapping master with revision-safe editing, plan sync and CSV/XLSX import/export
- Operations control tower for source, commercial, approval and delivery readiness
- Supplier/FC-grouped draft purchase orders
- Approval, issue, partial receipt, receipt and close lifecycle
- Approved PO email preview/delivery with recipient validation, test redirection and an audit trail
- INR commercial totals, printable POs and audit trail
- Decision-oriented dashboard and category buy plan
- Manual and scheduled-planning controls with guarded auto-drafting
- Named user accounts, signed sessions, role-based access, profile security, user administration and operational health checks

## Local setup

Requirements: macOS with Homebrew, Node.js 20 or 22, and PostgreSQL 16.

```bash
node --version
brew install postgresql@16
brew services start postgresql@16
"$(brew --prefix postgresql@16)/bin/pg_isready"
"$(brew --prefix postgresql@16)/bin/createdb" po_ledger
npm ci
cp .env.example .env.local
id -un
openssl rand -hex 32
```

Open `.env.local`. Replace `YOUR_MAC_USERNAME` with the output of `id -un`, and paste the random value from `openssl` after `AUTH_SECRET=`. A normal Homebrew local installation does not need a PostgreSQL password:

```text
DATABASE_URL=postgresql://YOUR_MAC_USERNAME@127.0.0.1:5432/po_ledger
AUTH_SECRET=PASTE_THE_64_CHARACTER_OPENSSL_VALUE_HERE
EMAIL_PROVIDER=preview
```

Initialize the application schema, verify it, and start StyleFlow:

```bash
npm run db:init
npm run db:check
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

On an empty local database, `npm run db:init` creates the first account as
`admin` / `admin`. StyleFlow immediately asks that user to choose a private
password. Remote and production databases never create this insecure default;
set explicit `BOOTSTRAP_ADMIN_USERNAME`, `BOOTSTRAP_ADMIN_PASSWORD` and a long
random `AUTH_SECRET` before their first initialization.

### If local setup fails

- `database "po_ledger" already exists` is harmless; continue with `npm run db:init`.
- `password authentication failed for user ...` means `.env.local` points to a different PostgreSQL user, port or old database. Recheck `id -un`, port `5432`, and remove any stale copied connection string.
- `bad interpreter: Operation not permitted` after unzipping on macOS usually means the trusted archive retained a quarantine flag. From this project directory, run `xattr -dr com.apple.quarantine .` and then `npm ci` again.
- If `brew services start postgresql@16` fails, first run `brew services stop postgresql@16`, then start it once more and confirm readiness with the `pg_isready` command above. Do not run the database service as `root`.

Do not run `npm audit fix --force` merely to start the app; it can introduce breaking dependency upgrades. Review and upgrade dependencies as a separate maintenance change.

## Fastest functional test

1. Sign in with `admin` / `admin` and set a private password when prompted.
2. Open **New plan** and choose **Upload files**.
3. Choose **One bulk workbook**, then use `sample-data/methodology/Noise_113.xlsx`.
4. Keep **PO cover days = 45** and **DOH threshold = 80**, create the plan, and review the calculation evidence.
5. The attached regression sample should produce 30 global unique sales days, 121 styles, 49 styles below the DOH threshold, and 8,517 positive actionable units before supplier-mapping blocks are resolved.

After plans exist, use the permanent **Review orders** item in the left navigation to return to the latest saved plan that is available for recommendation review. Use **Plan history** when you need an older saved version or want to compare two plan versions.

To add a guarded synthetic 80:20 supplier mix to this local NOISE plan, preview the database change:

```bash
npm run sample:seed-noise
```

The v2 dry run measures the plan itself: it should report 121 distinct recommendation styles, a target of 97 mapped (80.17%) and 24 unresolved (19.83%). It also reports how many absent styles will be inserted without overwriting an existing mapping. If that exact guarded scope is reported, apply it only to this local demo database:

```bash
STYLEFLOW_DEMO_SEED_CONFIRM=styleflow-demo-noise-80-v2 npm run sample:seed-noise -- --apply
```

The seed refuses remote databases and does not enrich manual, imported or inline-resolution mappings. Materialisation and safe demo enrichment run in one transaction and are audited.

## Myntra catalogue demo data

Regenerate the reproducible dataset:

```bash
npm run sample:generate
```

Use the first four files from `sample-data/demo/` as the planning upload:

- `historical_sales.csv`: 210 days of fashion demand, returns, cancellations, promotions, discounts, stockouts, brands, categories, styles and sizes
- `current_inventory.csv`: sellable, reserved and backorder inventory across Indian FCs
- `open_purchase_orders.csv`: supplier inbound quantities, ETAs and statuses
- `vendor_master.csv`: INR costs, lead times, MOQ, packs, service levels and commercial terms

Two optional supporting files are included but are not additional planning inputs:

- `catalogue_sources.csv`: optional audit register containing every public listing URL, price capture date and provenance boundary
- `supplier_mappings.csv`: import-ready in-app supplier mapping sheet with 18 of 23 supplier profiles and 22 of 27 style mappings fully populated; five rows intentionally omit NLC and GSTIN for resolver testing

The generated demo contains 27 real public Myntra style IDs across nine categories (three styles per category), 38 SKU/FC combinations, 23 public marketplace-seller name snapshots, four fulfilment centres, 7,428 daily demand rows, 20 incoming PO lines and 61 supplier-rule rows. Public sellers are not asserted to be manufacturers or contracted procurement vendors. Captured retail prices and sellers are point-in-time facts that may change by date, promotion, session, size or location.

Choose **Separate source files** to upload this richer four-file set. StyleFlow detects it as a `myntra_operational_csv` bundle, resolves each SKU to its explicit `Style_ID`, and then applies the same approved style-level methodology used for the workbook. Blank-SKU rows in `vendor_master.csv` are vendor-wide commercial defaults, not missing style-detail rows; they can enrich an explicitly resolved style/supplier rule but cannot create or guess a supplier mapping. Size-specific supplier SKUs are not promoted to a misleading style-wide SKU. The generated regression produces 210 unique selling days, 27 styles, 19 actionable styles and 11,747 actionable units at the default 45-day cover and 80-day DOH gate.

The four operational CSVs repeat explicit provenance fields so source facts remain attached to recommendations. `Unit_Price` is a synthetic procurement cost and is never substituted with the captured customer-facing selling price. See [`sample-data/README.md`](sample-data/README.md) for the complete truth boundary.

## Approved New PO methodology

StyleFlow follows the bundled [`New_PO_Methodology.md`](sample-data/methodology/New_PO_Methodology.md) at style level:

1. Count distinct `order_Month` values across the sell-out source. This is the common denominator for every style.
2. Sum `qty` by `style_id`.
3. Calculate daily run rate (DRR) as style sales divided by unique order days.
4. Sum `inv_units_q1` by style and calculate days on hand (DOH) as inventory divided by DRR.
5. Mark a style eligible only when DOH is below the configured threshold (80 by default). A zero DRR is treated as `NA`, not divided by zero.
6. Sum `pending_qty` from open POs by style.
7. Calculate the signed PO ask, using 45 cover days by default, and round to a whole unit using Excel-compatible half-away-from-zero rounding.
8. Look up Model, MRP and NLC from style details. Missing supplier or commercial mapping remains visibly blocked rather than being guessed.

```text
Unique order days = distinct count of sell-out order dates
DRR               = sum of style sales ÷ unique order days
DOH               = current inventory ÷ DRR
Signed PO ask     = round((DRR × cover days) − current inventory − open PO)
Actionable units  = max(0, signed PO ask), only when DOH < threshold
```

The application keeps the signed ask for auditability even when it is zero or negative. Forecast diagnostics, confidence and exception evidence can help a planner judge risk, but they cannot silently change this approved calculation.

## Automation safeguards

The Data & Automation screen can rerun the latest immutable source snapshot. Optional auto-drafting is deliberately conservative:

- low-accuracy recommendations are excluded;
- existing source snapshots cannot produce duplicate drafts;
- POs are never auto-issued;
- human submission and approval remain required;
- every run and PO transition is audited.

The schedule is stored locally now. The same idempotent run endpoint can later be called by Vercel Cron after deployment.

## Data ingestion

The **New plan** screen supports two mutually exclusive routes:

- **Upload files:** either one `.xlsx` workbook containing all four source tabs, or four separate `.xlsx`/`.csv` files. A mixed bulk-plus-separate submission is rejected, and all four separate sources are required.
- **Live data connection:** reads the latest saved StyleFlow PostgreSQL snapshot and lets a planner filter it before creating a new version-preserving batch. This is an internal planning-warehouse connection, not a direct Myntra website, OMS, ERP or vendor API. A production connector can later populate the same canonical snapshot contract.

Required methodology fields:

| Source | Required fields | Purpose |
|---|---|---|
| Sell out | `order_Month`, `style_id`, `qty` | Unique selling days, style sales and DRR |
| Current Inventory | `style_id`, `inv_units_q1` | Inventory and DOH |
| Open PO | `style_id`, `pending_qty` | Supply already ordered |
| Style ID details | `Style Id`, `Model`, `MRP`, `NLC` | Product and INR commercial lookup |

The style-details source also accepts these optional PO-readiness fields (header aliases such as spaces, underscores and common vendor terminology are supported):

```text
Vendor, Contact_Email, Supplier_SKU, HSN_Code, GST_Rate,
Supplier_GSTIN, Supplier_State, Lead_Time_Days, Payment_Terms,
Incoterms, MOQ, Pack_Size
```

`GST_Rate` must be between 0 and 100. Lead time, MOQ and pack size must be non-negative whole numbers. These fields populate the saved supplier commercial master, expected-receipt evidence, GST/HSN PO lines and supplier terms; they do not alter the approved DRR/DOH PO-ask formula. Do not assign one supplier to every style merely to bypass a missing mapping.

Use these ready-to-fill templates:

- `sample-data/methodology/New_PO_Methodology.md`: the supplied formula specification retained with the project for auditability
- `sample-data/methodology/Noise_113.xlsx`: the supplied regression workbook used for the fastest functional test
- `sample-data/methodology/sell_out_template.csv`
- `sample-data/methodology/current_inventory_template.csv`
- `sample-data/methodology/open_po_template.csv`
- `sample-data/methodology/style_details_template.csv`

### Legacy enriched demo format

Required historical columns:

```text
Date, SKU, Vendor, Units_Sold
```

Recommended Myntra fields:

```text
Warehouse, Returns_Qty, Cancellations_Qty, Is_Promotion,
Discount_Pct, In_Stock, Category, Brand, Style_ID, Size
```

Inventory requires `SKU, Vendor, Current_Inventory`; supplier master requires `Vendor`; inbound supply requires `SKU, Vendor, Open_PO_Qty`. See the generated files for the full supported schemas. Any supplied currency must be `INR`.

If there are no open purchase orders, the open-PO upload is still required but may contain only the required header row. Supplying `Snapshot_Date` in inventory is strongly recommended because it anchors the planning date; otherwise the latest sales date is used.

## Purchase-order email

The default `EMAIL_PROVIDER=preview` is safe for local testing: StyleFlow validates recipients, renders the supplier message and records the attempt, but nothing leaves the application.

To enable real delivery later:

```text
EMAIL_PROVIDER=resend
EMAIL_FROM=StyleFlow PO Desk <purchasing@your-verified-domain.com>
EMAIL_REPLY_TO=buying-team@your-company.com
RESEND_API_KEY=re_...
EMAIL_FORCE_TO=your-own-test-address@company.com
```

Verify the sender domain with Resend first. Keep `EMAIL_FORCE_TO` during acceptance testing so every message is redirected to a controlled inbox. Preview-mode and redirected test sends are never blocked by dispatch readiness or a missing preview because they cannot contact the supplier. After removing `EMAIL_FORCE_TO`, every real supplier send requires dispatch readiness (or an audited Admin override) plus the same signed-in user's fresh, unchanged preview. Never commit `.env.local` or expose `RESEND_API_KEY` in screenshots.

## Administrator controls

The **Admin** area provides named-user management, read-only system readiness and **Access control**. Access control sets a page baseline for each role, then supports an individual Allow/Deny exception that takes precedence over the role. Policies are checked on direct page and mapped API requests, not merely hidden in navigation; changes use revision protection and an audit event. The Admin/access-control area is permanently Admin-only so it cannot be delegated or accidentally locked.

On desktop, use the circular arrow on the sidebar edge to switch between the labelled menu and the compact icon rail. The preference is remembered on that device, and the compact state expands the working canvas to the available width.

## Quality checks

```bash
npm test
npx tsc --noEmit
npm run build
npm run db:check
```

## Database tables

The required PostgreSQL schema contains fourteen application tables:

- `app_users`: named accounts, roles, secure password hashes and session-revocation state
- `batches`: version-preserving source snapshots, forecast policy and recommendations
- `purchase_orders`: PO headers, INR commercial totals and line items
- `po_recommendation_claims`: one-time recommendation-to-PO conversion claims
- `po_events`: PO workflow and receipt events appended by the current application API
- `automation_rules`: schedule, event and guarded auto-draft settings
- `integration_runs`: planning automation execution history
- `email_deliveries`: PO email preview/send attempts, delivery state and provider references
- `supplier_style_mappings`: governed Style ID–supplier commercial relationships and revisions
- `schema_migrations`: applied application-schema migration markers
- `access_control_state`: optimistic revision for the current access policy
- `role_area_access`: page-access baseline for each workspace role
- `user_area_access_overrides`: per-user Allow/Deny exceptions
- `access_control_events`: append-only access-policy change audit

GitHub/Vercel deployment and real Myntra/OMS/ERP/vendor connectors remain deferred to the deployment phase. The current connected-planning UI is intentionally backed by saved PostgreSQL snapshots so it can be exercised locally without pretending that production credentials or contracts already exist.

## Owner documentation

- [`docs/StyleFlow_Product_Overview_PRD.docx`](docs/StyleFlow_Product_Overview_PRD.docx): what the product is, why it exists, architecture, scope, mathematics, controls, limitations and roadmap.
- [`docs/StyleFlow_User_Guide.docx`](docs/StyleFlow_User_Guide.docx): beginner-friendly local setup and complete operating workflow with screenshots.
- [`docs/StyleFlow_Term_Glossary.docx`](docs/StyleFlow_Term_Glossary.docx): plain-language definitions for every specialist screen term, formula, data field, forecast measure, commercial field, PO status, role and system control.

Editable Markdown sources and the captured UI images sit in `docs/`. Rebuild the Word versions after documentation changes with:

```bash
npm run docs:build
```
