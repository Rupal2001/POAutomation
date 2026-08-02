CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'viewer'
    CHECK (role IN ('admin', 'planner', 'approver', 'senior_approver', 'receiver', 'viewer')),
  password_hash TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  must_change_password BOOLEAN NOT NULL DEFAULT true,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TIMESTAMPTZ,
  session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version >= 1),
  last_login_at TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ,
  created_by_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  updated_by_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_username_lower
  ON app_users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_email_lower
  ON app_users (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_app_users_active_role
  ON app_users (is_active, role);

-- Page/area access is intentionally separate from operational permissions.
-- Existing role checks still decide who may approve, receive or administer;
-- these policies decide which application areas a signed-in user may open.
CREATE TABLE IF NOT EXISTS access_control_state (
  id TEXT PRIMARY KEY DEFAULT 'default',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_by_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (id = 'default')
);

CREATE TABLE IF NOT EXISTS role_area_access (
  role TEXT NOT NULL
    CHECK (role IN ('admin', 'planner', 'approver', 'senior_approver', 'receiver', 'viewer')),
  area_key TEXT NOT NULL CHECK (char_length(area_key) BETWEEN 2 AND 80),
  allowed BOOLEAN NOT NULL,
  updated_by_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role, area_key)
);

CREATE TABLE IF NOT EXISTS user_area_access_overrides (
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  area_key TEXT NOT NULL CHECK (char_length(area_key) BETWEEN 2 AND 80),
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  updated_by_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, area_key)
);

CREATE INDEX IF NOT EXISTS idx_user_area_access_overrides_area
  ON user_area_access_overrides (area_key, user_id);

CREATE TABLE IF NOT EXISTS access_control_events (
  id BIGSERIAL PRIMARY KEY,
  revision INTEGER NOT NULL UNIQUE CHECK (revision >= 2),
  actor_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  changes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (reason IS NULL OR char_length(reason) <= 500),
  CHECK (jsonb_typeof(changes) = 'object')
);

INSERT INTO access_control_state (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;

-- Legacy-compatible defaults: every authenticated role retains every existing
-- workspace page. The administration area remains administrator-only.
INSERT INTO role_area_access (role, area_key, allowed)
SELECT role, area_key,
  CASE WHEN area_key = 'admin_access_control' THEN role = 'admin' ELSE true END
FROM unnest(ARRAY['admin','planner','approver','senior_approver','receiver','viewer']) role
CROSS JOIN unnest(ARRAY[
  'overview','plan_builder','review_orders','forecast_health','purchase_orders',
  'planning_readiness','plan_history','supplier_mapping','data_automation',
  'admin_access_control'
]) area_key
ON CONFLICT (role, area_key) DO NOTHING;

UPDATE role_area_access
SET allowed = (role = 'admin'), updated_at = now()
WHERE area_key = 'admin_access_control'
  AND allowed IS DISTINCT FROM (role = 'admin');

DELETE FROM user_area_access_overrides
WHERE area_key = 'admin_access_control';

ALTER TABLE role_area_access
  DROP CONSTRAINT IF EXISTS role_area_access_admin_boundary_check,
  ADD CONSTRAINT role_area_access_admin_boundary_check CHECK (
    area_key <> 'admin_access_control'
    OR (role = 'admin' AND allowed = true)
    OR (role <> 'admin' AND allowed = false)
  ) NOT VALID;

ALTER TABLE user_area_access_overrides
  DROP CONSTRAINT IF EXISTS user_area_access_overrides_admin_boundary_check,
  ADD CONSTRAINT user_area_access_overrides_admin_boundary_check CHECK (
    area_key <> 'admin_access_control'
  ) NOT VALID;

ALTER TABLE app_users
  DROP CONSTRAINT IF EXISTS app_users_identity_shape_check,
  ADD CONSTRAINT app_users_identity_shape_check CHECK (
    char_length(username) BETWEEN 3 AND 40
    AND username = lower(trim(username))
    AND username ~ '^[a-z0-9._-]+$'
    AND char_length(display_name) BETWEEN 2 AND 100
    AND (email IS NULL OR (char_length(email) <= 254 AND email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'))
  ) NOT VALID;

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  coverage_days INTEGER NOT NULL DEFAULT 45,
  status TEXT NOT NULL DEFAULT 'uploaded',
  label TEXT,
  sales_data JSONB NOT NULL,
  inventory_data JSONB NOT NULL,
  open_po_data JSONB NOT NULL,
  vendor_master_data JSONB,
  planning_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommendations JSONB
);

ALTER TABLE batches ADD COLUMN IF NOT EXISTS planning_settings JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE batches
  DROP CONSTRAINT IF EXISTS batches_shape_check,
  ADD CONSTRAINT batches_shape_check CHECK (
    coverage_days BETWEEN 1 AND 365
    AND status IN ('uploaded','processing','generated','failed','archived')
    AND (label IS NULL OR char_length(label) <= 160)
    AND jsonb_typeof(sales_data) = 'array'
    AND jsonb_typeof(inventory_data) = 'array'
    AND jsonb_typeof(open_po_data) = 'array'
    AND (vendor_master_data IS NULL OR jsonb_typeof(vendor_master_data) = 'array')
    AND jsonb_typeof(planning_settings) = 'object'
    AND (recommendations IS NULL OR jsonb_typeof(recommendations) = 'array')
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_batches_created_at ON batches (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_batches_active_created_at
  ON batches (created_at DESC) WHERE status <> 'archived';

CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  po_number TEXT NOT NULL UNIQUE,
  batch_id TEXT REFERENCES batches(id) ON DELETE SET NULL,
  vendor TEXT NOT NULL,
  warehouse TEXT NOT NULL DEFAULT 'MAIN',
  status TEXT NOT NULL DEFAULT 'draft',
  order_date DATE,
  expected_delivery_date DATE,
  currency TEXT NOT NULL DEFAULT 'INR',
  payment_terms TEXT,
  incoterms TEXT,
  ship_to TEXT,
  bill_to TEXT,
  notes TEXT,
  supplier_email TEXT,
  supplier_gstin TEXT,
  buyer_gstin TEXT,
  supplier_state TEXT,
  buyer_state TEXT,
  place_of_supply TEXT,
  lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
  freight NUMERIC(18,2) NOT NULL DEFAULT 0,
  discount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  total NUMERIC(18,2) NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT 'Planner',
  created_by_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  approved_by TEXT,
  approved_by_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  issued_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_vendor ON purchase_orders (vendor, created_at DESC);

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS supplier_gstin TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS supplier_email TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS buyer_gstin TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS supplier_state TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS buyer_state TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS place_of_supply TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS created_by_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS approved_by_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;

ALTER TABLE purchase_orders
  DROP CONSTRAINT IF EXISTS purchase_orders_business_integrity_check,
  ADD CONSTRAINT purchase_orders_business_integrity_check CHECK (
    char_length(trim(po_number)) BETWEEN 1 AND 100
    AND char_length(trim(vendor)) BETWEEN 1 AND 200
    AND char_length(trim(warehouse)) BETWEEN 1 AND 100
    AND status IN ('draft','pending_approval','approved','issued','partially_received','received','closed','cancelled')
    AND currency = 'INR'
    AND jsonb_typeof(lines) = 'array'
    AND subtotal >= 0 AND freight >= 0 AND discount >= 0 AND tax >= 0 AND total >= 0
    AND discount <= subtotal + freight
    AND total = subtotal + freight - discount + tax
    AND revision >= 1
    AND (order_date IS NULL OR expected_delivery_date IS NULL OR expected_delivery_date >= order_date)
    AND (supplier_email IS NULL OR (char_length(supplier_email) <= 254 AND supplier_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'))
    AND (supplier_gstin IS NULL OR supplier_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$')
    AND (buyer_gstin IS NULL OR buyer_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$')
  ) NOT VALID;

-- One immutable recommendation identity can be converted to a PO only once.
-- The API inserts these claims in the same transaction/CTE as the PO so two
-- concurrent browser requests cannot both pass a read-before-write check.
CREATE TABLE IF NOT EXISTS po_recommendation_claims (
  claim_key TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (char_length(claim_key) BETWEEN 1 AND 500)
);

CREATE INDEX IF NOT EXISTS idx_po_recommendation_claims_batch
  ON po_recommendation_claims (batch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_po_recommendation_claims_order
  ON po_recommendation_claims (purchase_order_id);

CREATE TABLE IF NOT EXISTS email_deliveries (
  id TEXT PRIMARY KEY,
  purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL CHECK (action IN ('preview', 'send')),
  provider TEXT NOT NULL CHECK (provider IN ('preview', 'resend')),
  status TEXT NOT NULL CHECK (status IN ('processing', 'uncertain', 'preview', 'sent', 'failed')),
  to_addresses JSONB NOT NULL DEFAULT '[]'::jsonb,
  cc_addresses JSONB NOT NULL DEFAULT '[]'::jsonb,
  from_address TEXT NOT NULL,
  reply_to TEXT,
  subject TEXT NOT NULL,
  buyer_message TEXT,
  provider_message_id TEXT,
  error_message TEXT,
  created_by_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- Existing installations originally allowed only processing/preview/sent/failed.
-- Replace the generated check constraint in one ALTER so ambiguous provider
-- outcomes are distinct from requests that are actively in flight.
ALTER TABLE email_deliveries
  DROP CONSTRAINT IF EXISTS email_deliveries_status_check,
  ADD CONSTRAINT email_deliveries_status_check
    CHECK (status IN ('processing', 'uncertain', 'preview', 'sent', 'failed'));

ALTER TABLE email_deliveries
  DROP CONSTRAINT IF EXISTS email_deliveries_shape_check,
  ADD CONSTRAINT email_deliveries_shape_check CHECK (
    jsonb_typeof(to_addresses) = 'array'
    AND jsonb_typeof(cc_addresses) = 'array'
    AND char_length(trim(subject)) BETWEEN 1 AND 200
    AND (buyer_message IS NULL OR char_length(buyer_message) <= 4000)
    AND ((status IN ('processing','uncertain') AND completed_at IS NULL)
      OR (status IN ('preview','sent','failed') AND completed_at IS NOT NULL))
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_email_deliveries_order
  ON email_deliveries (purchase_order_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_deliveries_one_active_dispatch
  ON email_deliveries (purchase_order_id)
  WHERE action = 'send' AND status IN ('processing', 'uncertain', 'sent');
DROP INDEX IF EXISTS idx_email_deliveries_one_dispatch;

CREATE TABLE IF NOT EXISTS po_events (
  id BIGSERIAL PRIMARY KEY,
  purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'Planner',
  note TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_events_order ON po_events (purchase_order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS integration_runs (
  id BIGSERIAL PRIMARY KEY,
  integration TEXT NOT NULL,
  direction TEXT NOT NULL,
  status TEXT NOT NULL,
  reference TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_integration_runs_lookup
  ON integration_runs (integration, direction, created_at DESC);

CREATE TABLE IF NOT EXISTS supplier_style_mappings (
  id TEXT PRIMARY KEY,
  mapping_key TEXT NOT NULL UNIQUE,
  style_id TEXT NOT NULL CHECK (char_length(style_id) BETWEEN 1 AND 100),
  product_name TEXT,
  brand TEXT,
  category TEXT,
  article_type TEXT,
  vendor TEXT,
  supplier_email TEXT,
  supplier_sku TEXT,
  nlc_inr NUMERIC(18,2),
  hsn_code TEXT,
  gst_rate NUMERIC(6,3),
  supplier_gstin TEXT,
  supplier_state TEXT,
  lead_time_days INTEGER,
  payment_terms TEXT,
  incoterms TEXT,
  moq INTEGER,
  pack_size INTEGER,
  mapping_status TEXT NOT NULL DEFAULT 'unmapped'
    CHECK (mapping_status IN ('mapped','incomplete','unmapped')),
  source TEXT NOT NULL DEFAULT 'manual',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  updated_by_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (vendor IS NULL OR char_length(vendor) BETWEEN 1 AND 200),
  CHECK (nlc_inr IS NULL OR (nlc_inr > 0 AND nlc_inr <= 1000000000)),
  CHECK (gst_rate IS NULL OR (gst_rate >= 0 AND gst_rate <= 100)),
  CHECK (lead_time_days IS NULL OR (lead_time_days >= 0 AND lead_time_days <= 3650)),
  CHECK (moq IS NULL OR (moq > 0 AND moq <= 1000000000)),
  CHECK (pack_size IS NULL OR (pack_size > 0 AND pack_size <= 1000000000))
);

CREATE INDEX IF NOT EXISTS idx_supplier_style_mappings_style
  ON supplier_style_mappings (style_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_style_mappings_vendor
  ON supplier_style_mappings (vendor, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_style_mappings_catalogue
  ON supplier_style_mappings (brand, category);

ALTER TABLE supplier_style_mappings ADD COLUMN IF NOT EXISTS mapping_status TEXT NOT NULL DEFAULT 'unmapped';
ALTER TABLE supplier_style_mappings DROP CONSTRAINT IF EXISTS supplier_style_mappings_mapping_status_check,
  ADD CONSTRAINT supplier_style_mappings_mapping_status_check
  CHECK (mapping_status IN ('mapped','incomplete','unmapped'));

-- Seed the editable mapping master from the latest authoritative source once.
-- ON CONFLICT deliberately preserves any commercial values curated in-app.
WITH latest_source AS (
  SELECT id,vendor_master_data
  FROM batches
  WHERE status <> 'archived'
    AND COALESCE(NULLIF(planning_settings->>'sourceBatchId',''), id) = id
    AND COALESCE(planning_settings->>'sourceType','') <> 'live_connection'
  ORDER BY created_at DESC
  LIMIT 1
), normalized AS (
  SELECT DISTINCT ON (mapping_key)
    'snapshot-' || md5(latest_source.id || ':' || mapping_key) AS id,
    mapping_key,
    style_id,
    NULLIF(left(trim(item->>'productName'),500),'') AS product_name,
    NULLIF(left(trim(item->>'brand'),200),'') AS brand,
    NULLIF(left(trim(item->>'category'),200),'') AS category,
    NULLIF(left(trim(item->>'articleType'),200),'') AS article_type,
    vendor,
    CASE WHEN char_length(trim(COALESCE(item->>'contactEmail',''))) <= 254
      AND trim(COALESCE(item->>'contactEmail','')) ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      THEN lower(trim(item->>'contactEmail')) ELSE NULL END AS supplier_email,
    NULLIF(left(trim(item->>'supplierSku'),200),'') AS supplier_sku,
    CASE WHEN COALESCE(item->>'unitPrice','') ~ '^[0-9]+(?:\.[0-9]+)?$'
      AND (item->>'unitPrice')::numeric > 0 AND (item->>'unitPrice')::numeric <= 1000000000
      THEN (item->>'unitPrice')::numeric ELSE NULL END AS nlc_inr,
    CASE WHEN trim(COALESCE(item->>'hsnCode','')) ~ '^[0-9]{4,8}$' THEN trim(item->>'hsnCode') ELSE NULL END AS hsn_code,
    CASE WHEN COALESCE(item->>'gstRate','') ~ '^[0-9]+(?:\.[0-9]+)?$' AND (item->>'gstRate')::numeric BETWEEN 0 AND 100 THEN (item->>'gstRate')::numeric ELSE NULL END AS gst_rate,
    CASE WHEN upper(trim(COALESCE(item->>'gstin',''))) ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
      THEN upper(trim(item->>'gstin')) ELSE NULL END AS supplier_gstin,
    NULLIF(left(trim(item->>'supplierState'),100),'') AS supplier_state,
    CASE WHEN COALESCE(item->>'leadTimeDays','') ~ '^[0-9]{1,10}$'
      AND (item->>'leadTimeDays')::numeric BETWEEN 0 AND 3650 THEN (item->>'leadTimeDays')::integer ELSE NULL END AS lead_time_days,
    NULLIF(left(trim(item->>'paymentTerms'),300),'') AS payment_terms,
    NULLIF(left(trim(item->>'incoterms'),100),'') AS incoterms,
    CASE WHEN COALESCE(item->>'moq','') ~ '^[1-9][0-9]{0,9}$'
      AND (item->>'moq')::numeric <= 1000000000 THEN (item->>'moq')::integer ELSE NULL END AS moq,
    CASE WHEN COALESCE(item->>'packSize','') ~ '^[1-9][0-9]{0,9}$'
      AND (item->>'packSize')::numeric <= 1000000000 THEN (item->>'packSize')::integer ELSE NULL END AS pack_size
  FROM latest_source
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(latest_source.vendor_master_data) = 'array'
      THEN latest_source.vendor_master_data ELSE '[]'::jsonb END
  ) item
  CROSS JOIN LATERAL (
    SELECT
      COALESCE(NULLIF(left(trim(item->>'styleId'),100),''),NULLIF(left(trim(item->>'sku'),100),'')) AS style_id,
      CASE
        WHEN lower(trim(COALESCE(item->>'vendor',''))) IN ('','supplier mapping required','unassigned','unknown','n/a','na','not assigned','not mapped') THEN NULL
        ELSE left(trim(item->>'vendor'),200)
      END AS vendor
  ) identity
  CROSS JOIN LATERAL (
    SELECT lower(identity.style_id) || '::::' || lower(COALESCE(identity.vendor,'')) AS mapping_key
  ) keyed
  WHERE identity.style_id IS NOT NULL
  ORDER BY mapping_key
)
INSERT INTO supplier_style_mappings
  (id,mapping_key,style_id,product_name,brand,category,article_type,vendor,supplier_email,supplier_sku,nlc_inr,hsn_code,gst_rate,supplier_gstin,supplier_state,lead_time_days,payment_terms,incoterms,moq,pack_size,mapping_status,source)
SELECT id,mapping_key,style_id,product_name,brand,category,article_type,vendor,supplier_email,supplier_sku,nlc_inr,hsn_code,gst_rate,supplier_gstin,supplier_state,lead_time_days,payment_terms,incoterms,moq,pack_size,
  CASE
    WHEN vendor IS NULL THEN 'unmapped'
    WHEN nlc_inr IS NULL OR supplier_sku IS NULL OR supplier_email IS NULL OR hsn_code IS NULL
      OR gst_rate IS NULL OR supplier_gstin IS NULL OR supplier_state IS NULL
      OR lead_time_days IS NULL OR moq IS NULL OR pack_size IS NULL THEN 'incomplete'
    ELSE 'mapped'
  END,
  'source_snapshot'
FROM normalized
ON CONFLICT (mapping_key) DO NOTHING;

UPDATE supplier_style_mappings SET mapping_status=CASE
  WHEN vendor IS NULL THEN 'unmapped'
  WHEN nlc_inr IS NULL OR supplier_sku IS NULL OR supplier_email IS NULL OR hsn_code IS NULL
    OR gst_rate IS NULL OR supplier_gstin IS NULL OR supplier_state IS NULL
    OR lead_time_days IS NULL OR moq IS NULL OR pack_size IS NULL THEN 'incomplete'
  ELSE 'mapped'
END
WHERE mapping_status IS DISTINCT FROM CASE
  WHEN vendor IS NULL THEN 'unmapped'
  WHEN nlc_inr IS NULL OR supplier_sku IS NULL OR supplier_email IS NULL OR hsn_code IS NULL
    OR gst_rate IS NULL OR supplier_gstin IS NULL OR supplier_state IS NULL
    OR lead_time_days IS NULL OR moq IS NULL OR pack_size IS NULL THEN 'incomplete'
  ELSE 'mapped'
END;

-- These constraints are NOT VALID so older rows are preserved for explicit
-- remediation, while every new or edited mapping must satisfy the contract.
ALTER TABLE supplier_style_mappings
  DROP CONSTRAINT IF EXISTS supplier_style_mappings_commercial_shape_check,
  ADD CONSTRAINT supplier_style_mappings_commercial_shape_check CHECK (
    style_id = trim(style_id)
    AND char_length(mapping_key) BETWEEN 5 AND 404
    AND (product_name IS NULL OR char_length(product_name) <= 500)
    AND (brand IS NULL OR char_length(brand) <= 200)
    AND (category IS NULL OR char_length(category) <= 200)
    AND (article_type IS NULL OR char_length(article_type) <= 200)
    AND (supplier_email IS NULL OR (char_length(supplier_email) <= 254 AND supplier_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'))
    AND (supplier_sku IS NULL OR char_length(supplier_sku) <= 200)
    AND (hsn_code IS NULL OR hsn_code ~ '^[0-9]{4,8}$')
    AND (supplier_gstin IS NULL OR supplier_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$')
    AND (supplier_state IS NULL OR char_length(supplier_state) <= 100)
    AND (payment_terms IS NULL OR char_length(payment_terms) <= 300)
    AND (incoterms IS NULL OR char_length(incoterms) <= 100)
    AND char_length(source) BETWEEN 1 AND 100
    AND updated_at >= created_at
  ) NOT VALID;

ALTER TABLE supplier_style_mappings
  DROP CONSTRAINT IF EXISTS supplier_style_mappings_readiness_check,
  ADD CONSTRAINT supplier_style_mappings_readiness_check CHECK (
    (mapping_status = 'unmapped' AND vendor IS NULL)
    OR (mapping_status = 'mapped' AND vendor IS NOT NULL AND nlc_inr IS NOT NULL
      AND supplier_sku IS NOT NULL AND supplier_email IS NOT NULL AND hsn_code IS NOT NULL
      AND gst_rate IS NOT NULL AND supplier_gstin IS NOT NULL AND supplier_state IS NOT NULL
      AND lead_time_days IS NOT NULL AND moq IS NOT NULL AND pack_size IS NOT NULL)
    OR (mapping_status = 'incomplete' AND vendor IS NOT NULL AND NOT (
      nlc_inr IS NOT NULL AND supplier_sku IS NOT NULL AND supplier_email IS NOT NULL AND hsn_code IS NOT NULL
      AND gst_rate IS NOT NULL AND supplier_gstin IS NOT NULL AND supplier_state IS NOT NULL
      AND lead_time_days IS NOT NULL AND moq IS NOT NULL AND pack_size IS NOT NULL
    ))
  ) NOT VALID;

ALTER TABLE purchase_orders ALTER COLUMN currency SET DEFAULT 'INR';

CREATE TABLE IF NOT EXISTS automation_rules (
  id TEXT PRIMARY KEY DEFAULT 'default',
  enabled BOOLEAN NOT NULL DEFAULT false,
  cadence TEXT NOT NULL DEFAULT 'daily',
  run_hour_ist INTEGER NOT NULL DEFAULT 6,
  auto_create_drafts BOOLEAN NOT NULL DEFAULT false,
  approval_threshold NUMERIC(18,2) NOT NULL DEFAULT 250000,
  event_name TEXT,
  promotion_uplift_pct NUMERIC(8,2) NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  last_run_status TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE automation_rules
  DROP CONSTRAINT IF EXISTS automation_rules_business_check,
  ADD CONSTRAINT automation_rules_business_check CHECK (
    cadence IN ('manual','daily','weekly')
    AND run_hour_ist BETWEEN 0 AND 23
    AND approval_threshold BETWEEN 0 AND 1000000000
    AND promotion_uplift_pct BETWEEN 0 AND 500
    AND (event_name IS NULL OR char_length(event_name) <= 120)
  ) NOT VALID;

INSERT INTO automation_rules (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version)
VALUES ('2026-08-02-industry-ready-v1')
ON CONFLICT (version) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('2026-08-02-page-access-control-v1')
ON CONFLICT (version) DO NOTHING;
