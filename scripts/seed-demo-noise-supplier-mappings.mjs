import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import postgres from "postgres";

const config = JSON.parse(readFileSync(new URL("../sample-data/methodology/noise_demo_supplier_seed.json", import.meta.url), "utf8"));
const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");

if (args.has("--help")) {
  console.log(`Noise demo supplier seed v2

Dry run (read-only):
  npm run sample:seed-noise

Apply to the local demo database:
  STYLEFLOW_DEMO_SEED_CONFIRM=${config.seedId} npm run sample:seed-noise -- --apply

The v2 seed measures the latest plan's 121 distinct recommendation styles, inserts missing styles without overwriting any mapping, and targets 97 mapped / 24 unresolved styles. It refuses remote databases and never enriches manual, imported or inline-resolution mappings.`);
  process.exit(0);
}

loadDotEnvLocal();
const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!connectionString) throw new Error("No DATABASE_URL or POSTGRES_URL found. Add the local demo database to .env.local.");
if (!isLocalConnection(connectionString)) {
  throw new Error("This demo seed is local-only and refuses remote or production databases.");
}
if (apply && process.env.STYLEFLOW_DEMO_SEED_CONFIRM !== config.seedId) {
  throw new Error(`Apply mode requires STYLEFLOW_DEMO_SEED_CONFIRM=${config.seedId}. No rows were changed.`);
}

const db = isLocalConnection(connectionString) ? postgres(connectionString, { max: 1 }) : neon(connectionString);

try {
  const [batch] = await db`SELECT id,label,status,created_at,planning_settings,recommendations
    FROM batches
    WHERE status='generated'
    ORDER BY created_at DESC
    LIMIT 1`;
  if (!batch) throw new Error("No generated plan exists. No rows were changed.");

  const planStyles = planStyleRows(batch);
  validatePlanScope(batch, planStyles);
  const planIds = new Set(planStyles.map(row => row.styleId));
  const allMappings = await db`SELECT * FROM supplier_style_mappings ORDER BY style_id,id`;
  const currentMappings = allMappings.filter(row => planIds.has(String(row.style_id)));

  const absentRows = materializationRows(batch, planStyles, currentMappings);
  const virtualMappings = [...currentMappings, ...absentRows];
  const currentMappedStyles = mappedStyleIds(currentMappings);
  if (currentMappedStyles.size > config.targetMappedStyles) {
    throw new Error(`The latest plan already has ${currentMappedStyles.size} mapped styles, above the guarded target of ${config.targetMappedStyles}. No rows were changed.`);
  }

  const protectedUnresolved = [];
  const eligible = [];
  const mappingsByStyle = groupByStyle(virtualMappings);
  for (const style of planStyles) {
    if (currentMappedStyles.has(style.styleId)) continue;
    const mappings = mappingsByStyle.get(style.styleId) ?? [];
    if (mappings.some(row => !eligibleSource(row.source))) {
      protectedUnresolved.push(style.styleId);
      continue;
    }
    const editable = mappings
      .filter(row => eligibleSource(row.source))
      .sort((left, right) => sourceRank(left.source) - sourceRank(right.source) || String(left.id).localeCompare(String(right.id)))[0];
    if (editable) eligible.push({ style, mapping: editable });
  }

  const enrichNeeded = config.targetMappedStyles - currentMappedStyles.size;
  const selected = eligible
    .sort((left, right) => deterministicRank(left.style.styleId).localeCompare(deterministicRank(right.style.styleId)))
    .slice(0, enrichNeeded)
    .map(({ style, mapping }) => buildEnrichment(style, mapping));
  if (selected.length !== enrichNeeded) {
    throw new Error(`Only ${selected.length} safe demo rows can be enriched; ${enrichNeeded} are required. Protected mappings were not touched.`);
  }

  validateChangePlan({ planStyles, currentMappings, absentRows, selected, protectedUnresolved });
  const projectedMapped = currentMappedStyles.size + selected.length;
  const projectedUnresolved = planStyles.length - projectedMapped;
  const existingV2Ready = currentMappings.filter(row => row.source === config.sourceMarker && fullyReady(row)).length;

  console.log(config.description);
  console.log(`Latest plan: ${batch.label || batch.id} (${batch.id}).`);
  console.log(`Plan denominator: ${planStyles.length} distinct recommendation styles.`);
  console.log(`Current coverage: ${currentMappedStyles.size}/${planStyles.length} mapped; ${planStyles.length - currentMappedStyles.size} unresolved.`);
  console.log(`No-overwrite materialization: ${absentRows.length} absent style row(s) would be inserted as unmapped.`);
  console.log(`Safe enrichment: ${selected.length} demo/source/plan-sync row(s) would be fully populated; ${protectedUnresolved.length} protected unresolved row(s) remain untouched.`);
  console.log(`Target after apply: ${projectedMapped}/${planStyles.length} mapped (${percentage(projectedMapped, planStyles.length)}%); ${projectedUnresolved}/${planStyles.length} unresolved (${percentage(projectedUnresolved, planStyles.length)}%).`);

  if (!apply) {
    const changeCount = absentRows.length + selected.length;
    console.log(`Dry run only: ${changeCount} row operation(s) would run; ${existingV2Ready} v2 row(s) are already ready. Re-run with the explicit confirmation shown by --help to apply.`);
  } else if (!absentRows.length && !selected.length) {
    console.log("No-op: the exact 97/121 demo target is already applied. No rows, revisions or audit records changed.");
  } else {
    await db.begin(async transaction => {
      for (const row of absentRows) {
        const inserted = await transaction`INSERT INTO supplier_style_mappings
          (id,mapping_key,style_id,product_name,brand,category,article_type,vendor,nlc_inr,mapping_status,source)
          SELECT ${row.id},${row.mapping_key},${row.style_id},${row.product_name},${row.brand},${row.category},${row.article_type},NULL,NULL,'unmapped',${row.source}
          WHERE NOT EXISTS (SELECT 1 FROM supplier_style_mappings WHERE style_id=${row.style_id})
          ON CONFLICT (mapping_key) DO NOTHING
          RETURNING id`;
        if (inserted.length !== 1) {
          throw new Error(`Style ${row.style_id} acquired a mapping after the preview. The transaction was rolled back.`);
        }
      }

      for (const planned of selected) {
        const updated = await transaction`UPDATE supplier_style_mappings SET
            mapping_key=${planned.mappingKey},product_name=${planned.productName},brand=${planned.brand},
            category=${planned.category},article_type=${planned.articleType},vendor=${planned.vendor},
            supplier_email=${planned.supplierEmail},supplier_sku=${planned.supplierSku},nlc_inr=${planned.nlc},
            hsn_code=${planned.hsnCode},gst_rate=${planned.gstRate},supplier_gstin=${planned.supplierGstin},
            supplier_state=${planned.supplierState},lead_time_days=${planned.leadTimeDays},
            payment_terms=${planned.paymentTerms},incoterms=${planned.incoterms},moq=${planned.moq},
            pack_size=${planned.packSize},mapping_status='mapped',source=${config.sourceMarker},
            revision=revision+1,updated_at=now()
          WHERE id=${planned.id} AND revision=${planned.expectedRevision}
            AND source=${planned.expectedSource}
          RETURNING id`;
        if (updated.length !== 1) {
          throw new Error(`Mapping ${planned.id} changed after the preview or became protected. The transaction was rolled back.`);
        }
      }

      const [verified] = await transaction`WITH styles AS (
          SELECT DISTINCT COALESCE(NULLIF(item->>'styleId',''),NULLIF(item->>'sku','')) AS style_id
          FROM batches source
          CROSS JOIN LATERAL jsonb_array_elements(source.recommendations) item
          WHERE source.id=${String(batch.id)}
        )
        SELECT COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM supplier_style_mappings mapping
            WHERE mapping.style_id=styles.style_id AND mapping.mapping_status='mapped'
          ))::int AS mapped,
          COUNT(*) FILTER (WHERE NOT EXISTS (
            SELECT 1 FROM supplier_style_mappings mapping WHERE mapping.style_id=styles.style_id
          ))::int AS absent
        FROM styles`;
      const verifiedMapped = Number(verified?.mapped ?? 0);
      const verifiedTotal = Number(verified?.total ?? 0);
      const verifiedAbsent = Number(verified?.absent ?? 0);
      if (verifiedTotal !== config.expectedPlanStyles || verifiedMapped !== config.targetMappedStyles || verifiedAbsent !== 0) {
        throw new Error(`Post-write coverage was ${verifiedMapped}/${verifiedTotal} with ${verifiedAbsent} absent; expected ${config.targetMappedStyles}/${config.expectedPlanStyles} with none absent. The transaction was rolled back.`);
      }

      await transaction`INSERT INTO integration_runs (integration,direction,status,reference,details)
        VALUES ('supplier_mapping_master','internal','completed',${config.seedId},${JSON.stringify({
          action: "demo_seed_v2_applied",
          demoOnly: true,
          sourceMarker: config.sourceMarker,
          sourceBatchId: String(batch.id),
          planStyles: planStyles.length,
          previouslyMappedStyles: currentMappedStyles.size,
          materializedRows: absentRows.length,
          enrichedRows: selected.length,
          mappedStyles: verifiedMapped,
          unresolvedStyles: verifiedTotal - verifiedMapped,
          protectedUnresolvedStyles: protectedUnresolved.length,
          noOverwrite: true,
        })}::jsonb)`;
    });
    console.log(`Applied one atomic demo transaction: ${absentRows.length} missing style row(s) materialized, ${selected.length} safe row(s) enriched, and one audit run recorded.`);
  }
} finally {
  if (typeof db.end === "function") await db.end();
}

function planStyleRows(batch) {
  const recommendations = Array.isArray(batch.recommendations) ? batch.recommendations : [];
  const byStyle = new Map();
  for (const row of recommendations) {
    const styleId = String(row?.styleId || row?.sku || "").trim();
    if (!styleId) continue;
    const prior = byStyle.get(styleId);
    byStyle.set(styleId, prior ? mergeRecommendation(prior, row) : { ...row, styleId });
  }
  return [...byStyle.values()].sort((left, right) => left.styleId.localeCompare(right.styleId));
}

function mergeRecommendation(primary, fallback) {
  const merged = { ...primary };
  for (const [key, value] of Object.entries(fallback ?? {})) {
    if ((merged[key] === null || merged[key] === undefined || merged[key] === "") && value !== null && value !== undefined && value !== "") {
      merged[key] = value;
    }
  }
  return merged;
}

function validatePlanScope(batch, rows) {
  if (rows.length !== config.expectedPlanStyles) {
    throw new Error(`Expected exactly ${config.expectedPlanStyles} distinct recommendation styles in the latest plan; found ${rows.length}. No rows were changed.`);
  }
  const noiseRows = rows.filter(row => String(row.brand ?? "").trim().toLowerCase() === "noise").length;
  if (noiseRows !== config.expectedNoiseStyles) {
    throw new Error(`Expected ${config.expectedNoiseStyles} Noise styles; found ${noiseRows}. No rows were changed.`);
  }
  const sourceType = String(batch.planning_settings?.sourceType ?? "");
  if (sourceType && sourceType !== "file_upload") {
    throw new Error(`The latest plan source is ${sourceType}, not the guarded Noise file-upload sample. No rows were changed.`);
  }
}

function materializationRows(batch, planStyles, mappings) {
  const present = new Set(mappings.map(row => String(row.style_id)));
  return planStyles.filter(style => !present.has(style.styleId)).map(style => ({
    id: `demo-v2-${createHash("sha256").update(`${config.seedId}:${style.styleId}`).digest("hex").slice(0, 24)}`,
    mapping_key: `${style.styleId.toLocaleLowerCase("en-IN")}::::`,
    style_id: style.styleId,
    product_name: cleanText(style.productName, 500) || `NOISE demo style ${style.styleId}`,
    brand: cleanText(style.brand, 200) || "NOISE",
    category: cleanText(style.category, 200),
    article_type: cleanText(style.articleType, 200),
    source: `${config.planSyncSourcePrefix}${batch.id}`,
    revision: 1,
    mapping_status: "unmapped",
    vendor: null,
    nlc_inr: null,
  }));
}

function mappedStyleIds(mappings) {
  return new Set(mappings.filter(row => row.mapping_status === "mapped" && fullyReady(row)).map(row => String(row.style_id)));
}

function groupByStyle(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(row.style_id);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return groups;
}

function eligibleSource(value) {
  const source = String(value ?? "");
  return source === "source_snapshot"
    || source === config.sourceMarker
    || config.legacySourceMarkers.includes(source)
    || source.startsWith(config.planSyncSourcePrefix);
}

function sourceRank(value) {
  const source = String(value ?? "");
  if (source === config.sourceMarker) return 0;
  if (config.legacySourceMarkers.includes(source)) return 1;
  if (source === "source_snapshot") return 2;
  if (source.startsWith(config.planSyncSourcePrefix)) return 3;
  return 99;
}

function deterministicRank(styleId) {
  return createHash("sha256").update(`${config.seedId}:${styleId}`).digest("hex");
}

function buildEnrichment(style, row) {
  if (!eligibleSource(row.source)) throw new Error(`Mapping ${row.id} is protected and cannot be enriched.`);
  const currentVendor = realVendor(row.vendor) ? String(row.vendor).trim() : null;
  const assignedProfile = config.assignmentProfiles[hashNumber(`${config.seedId}:${style.styleId}`) % config.assignmentProfiles.length];
  const profile = currentVendor ? config.preservedSupplierProfile : assignedProfile;
  const vendor = currentVendor ?? assignedProfile.name;
  const text = [row.article_type, style.articleType, row.category, style.category, row.product_name, style.productName].filter(Boolean).join(" ").toLowerCase();
  return {
    id: String(row.id),
    styleId: style.styleId,
    expectedRevision: Number(row.revision),
    expectedSource: String(row.source),
    mappingKey: `${style.styleId.toLocaleLowerCase("en-IN")}::::${vendor.toLocaleLowerCase("en-IN")}`,
    productName: cleanText(row.product_name, 500) || cleanText(style.productName, 500) || `NOISE demo style ${style.styleId}`,
    brand: cleanText(row.brand, 200) || cleanText(style.brand, 200) || "NOISE",
    category: cleanText(row.category, 200) || cleanText(style.category, 200),
    articleType: cleanText(row.article_type, 200) || cleanText(style.articleType, 200),
    vendor,
    supplierEmail: validEmail(row.supplier_email) ? String(row.supplier_email).toLowerCase() : profile.email,
    supplierSku: String(row.supplier_sku ?? "").trim() || `DEMO-NOISE-${style.styleId}`,
    nlc: positiveNumber(row.nlc_inr) ?? positiveNumber(style.unitPrice) ?? config.defaults.nlcInr,
    hsnCode: /^\d{4,8}$/.test(String(row.hsn_code ?? "")) ? String(row.hsn_code) : hsnFor(text),
    gstRate: validRate(row.gst_rate) ? Number(row.gst_rate) : config.defaults.gstRate,
    supplierGstin: validGstin(row.supplier_gstin) ? String(row.supplier_gstin).toUpperCase() : profile.gstin,
    supplierState: String(row.supplier_state ?? "").trim() || profile.state,
    leadTimeDays: wholeAtLeast(row.lead_time_days, 0) ? Number(row.lead_time_days) : profile.leadTimeDays ?? config.defaults.leadTimeDays,
    paymentTerms: String(row.payment_terms ?? "").trim() || config.defaults.paymentTerms,
    incoterms: String(row.incoterms ?? "").trim() || config.defaults.incoterms,
    moq: wholeAtLeast(row.moq, 1) ? Number(row.moq) : config.defaults.moq,
    packSize: wholeAtLeast(row.pack_size, 1) ? Number(row.pack_size) : config.defaults.packSize,
  };
}

function validateChangePlan({ planStyles, currentMappings, absentRows, selected, protectedUnresolved }) {
  if (config.targetMappedStyles + config.targetUnresolvedStyles !== config.expectedPlanStyles) {
    throw new Error("The configured mapped and unresolved targets do not add up to the plan denominator.");
  }
  const present = new Set(currentMappings.map(row => String(row.style_id)));
  if (absentRows.some(row => present.has(row.style_id))) {
    throw new Error("The materialization plan would overwrite an existing style mapping.");
  }
  if (selected.some(row => !eligibleSource(row.expectedSource))) {
    throw new Error("The enrichment plan contains a protected mapping source.");
  }
  const protectedSources = new Set(currentMappings.filter(row => !eligibleSource(row.source)).map(row => String(row.style_id)));
  if (selected.some(row => protectedSources.has(row.styleId))) {
    throw new Error("The enrichment plan would modify a style that has a manual, imported or inline mapping.");
  }
  const selectedIds = new Set(selected.map(row => row.id));
  const retainedKeys = new Set(currentMappings.filter(row => !selectedIds.has(String(row.id))).map(row => String(row.mapping_key)));
  const selectedKeys = new Set();
  for (const row of selected) {
    if (selectedKeys.has(row.mappingKey)) throw new Error(`The v2 plan contains duplicate mapping key ${row.mappingKey}.`);
    if (retainedKeys.has(row.mappingKey)) throw new Error(`The v2 plan conflicts with existing mapping key ${row.mappingKey}.`);
    selectedKeys.add(row.mappingKey);
    if (!fullyReady({
      vendor: row.vendor, nlc_inr: row.nlc, supplier_sku: row.supplierSku,
      supplier_email: row.supplierEmail, hsn_code: row.hsnCode, gst_rate: row.gstRate,
      supplier_gstin: row.supplierGstin, supplier_state: row.supplierState,
      payment_terms: row.paymentTerms, incoterms: row.incoterms,
      lead_time_days: row.leadTimeDays, moq: row.moq, pack_size: row.packSize,
    })) throw new Error(`The generated demo enrichment for ${row.id} is incomplete.`);
  }
  if (protectedUnresolved.length > config.targetUnresolvedStyles) {
    throw new Error("Protected unresolved styles exceed the configured unresolved target. No rows were changed.");
  }
  if (new Set(planStyles.map(row => row.styleId)).size !== planStyles.length) {
    throw new Error("The plan style denominator is not unique.");
  }
}

function fullyReady(row) {
  return realVendor(row.vendor) && Number(row.nlc_inr) > 0 && Boolean(String(row.supplier_sku ?? "").trim())
    && validEmail(row.supplier_email) && /^\d{4,8}$/.test(String(row.hsn_code ?? "")) && validRate(row.gst_rate)
    && validGstin(row.supplier_gstin) && Boolean(String(row.supplier_state ?? "").trim())
    && Boolean(String(row.payment_terms ?? "").trim()) && Boolean(String(row.incoterms ?? "").trim())
    && wholeAtLeast(row.lead_time_days, 0) && wholeAtLeast(row.moq, 1) && wholeAtLeast(row.pack_size, 1);
}

function hsnFor(value) {
  if (/watch|wearable/.test(value)) return "8517";
  if (/cable|charger|adapter/.test(value)) return "8544";
  if (/case|strap|clip|accessor/.test(value)) return "3926";
  return "8518";
}

function hashNumber(value) {
  return Number.parseInt(createHash("sha256").update(value).digest("hex").slice(0, 8), 16);
}

function realVendor(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return Boolean(text) && !["supplier mapping required", "unassigned", "unknown", "n/a", "na", "not assigned", "not mapped"].includes(text);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? "").trim());
}

function validGstin(value) {
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(String(value ?? "").trim().toUpperCase());
}

function validRate(value) {
  if (value === null || value === undefined || String(value).trim() === "") return false;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100;
}

function wholeAtLeast(value, minimum) {
  if (value === null || value === undefined || String(value).trim() === "") return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function cleanText(value, maximum) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, maximum) : null;
}

function percentage(numerator, denominator) {
  return (numerator / denominator * 100).toFixed(2);
}

function isLocalConnection(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return ["", "localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(hostname);
  } catch {
    return false;
  }
}

function loadDotEnvLocal() {
  try {
    const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of text.split("\n")) {
      const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || match[2].startsWith("#") || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // The caller can provide DATABASE_URL directly.
  }
}
