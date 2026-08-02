import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
const apiBase = process.env.API_BASE || "http://127.0.0.1:3103";
const batchId = process.env.E2E_BATCH_ID || "d2afd260-8545-4735-b09a-dbbb40ddbdad";
const styleId = process.env.E2E_STYLE_ID || "30953254";
const testPassword = process.env.E2E_PASSWORD || "StyleFlow-E2E-Only-2026!";
const runToken = randomBytes(4).toString("hex");

if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const parsedDatabase = new URL(databaseUrl);
const databaseName = parsedDatabase.pathname.replace(/^\//, "");
if (!["localhost", "127.0.0.1", "::1"].includes(parsedDatabase.hostname) || !databaseName.startsWith("styleflow_inline_audit_")) {
  throw new Error("This destructive workflow test only runs against a local styleflow_inline_audit_* database.");
}

const db = postgres(databaseUrl, { max: 1 });
const users = {
  planner: { username: `e2e_inline_planner_${runToken}`, displayName: `E2E Inline Planner ${runToken}`, role: "planner" },
  approver: { username: `e2e_inline_approver_${runToken}`, displayName: `E2E Senior Approver ${runToken}`, role: "senior_approver" },
  receiver: { username: `e2e_inline_receiver_${runToken}`, displayName: `E2E Receiver ${runToken}`, role: "receiver" },
};

try {
  await seedTestUsers();
  const plannerCookie = await login(users.planner.username);
  const initialBatch = await api(`/api/batches/${batchId}`, { cookie: plannerCookie });
  const sourceRecommendation = recommendationFrom(initialBatch.batch);
  assert(Number.isFinite(Number(sourceRecommendation.unitPrice)) && Number(sourceRecommendation.unitPrice) > 0, "The E2E recommendation needs a positive INR NLC.");
  const sourceSnapshot = JSON.stringify(sourceRecommendation);

  const context = await api(`/api/purchase-orders/resolve-supplier-and-create?${new URLSearchParams({
    batchId,
    sku: sourceRecommendation.sku,
    styleId: sourceRecommendation.styleId || sourceRecommendation.sku,
    warehouse: sourceRecommendation.warehouse,
    currentVendor: sourceRecommendation.vendor,
  })}`, { cookie: plannerCookie });
  assert(context.editableBaseMapping?.id, "Expected one editable unmapped mapping row.");

  const createBody = {
    batchId,
    selection: {
      sku: sourceRecommendation.sku,
      styleId: sourceRecommendation.styleId,
      warehouse: sourceRecommendation.warehouse,
      currentVendor: sourceRecommendation.vendor,
      quantity: sourceRecommendation.suggestedPoQty,
    },
    mapping: {
      mappingId: context.editableBaseMapping.id,
      expectedRevision: context.editableBaseMapping.revision,
      vendor: "StyleFlow E2E Noise Supplier",
      nlc: Number(sourceRecommendation.unitPrice),
      supplierSku: `E2E-NOISE-${styleId}`,
      supplierEmail: "noise-orders@supplier-demo.example",
      hsnCode: "8518",
      gstRate: 18,
      supplierGstin: "06DEMOS9999A1Z5",
      supplierState: "Haryana",
      leadTimeDays: 14,
      moq: 1,
      packSize: 1,
      paymentTerms: "Net 30 days",
      incoterms: "DAP",
    },
  };
  const created = await api("/api/purchase-orders/resolve-supplier-and-create", {
    cookie: plannerCookie,
    method: "POST",
    body: createBody,
    expected: 201,
  });
  const poId = created.purchaseOrder.id;
  assert(created.purchaseOrder.currency === "INR", "Created PO must use INR.");
  assert(created.mapping.revision === context.editableBaseMapping.revision + 1, "Mapping revision was not advanced.");
  assert(created.dispatchReadiness.ready === true, "Complete supplier details should be dispatch-ready.");

  const postCreateContext = await api(`/api/purchase-orders/resolve-supplier-and-create?${new URLSearchParams({
    batchId,
    sku: sourceRecommendation.sku,
    styleId: sourceRecommendation.styleId || sourceRecommendation.sku,
    warehouse: sourceRecommendation.warehouse,
    currentVendor: sourceRecommendation.vendor,
  })}`, { cookie: plannerCookie });
  const currentMapping = postCreateContext.mappings.find(mapping => mapping.id === created.mapping.id);
  assert(currentMapping, "The newly resolved supplier mapping was not returned by the lookup API.");
  const duplicate = await api("/api/purchase-orders/resolve-supplier-and-create", {
    cookie: plannerCookie,
    method: "POST",
    body: {
      ...createBody,
      mapping: { ...createBody.mapping, mappingId: currentMapping.id, expectedRevision: currentMapping.revision },
    },
    expected: 409,
  });
  assert(duplicate.code === "RECOMMENDATION_ALREADY_CONVERTED", "Duplicate conversion did not fail with the stable claim guard.");

  const afterBatch = await api(`/api/batches/${batchId}`, { cookie: plannerCookie });
  assert(JSON.stringify(recommendationFrom(afterBatch.batch)) === sourceSnapshot, "Inline supplier resolution mutated the immutable recommendation.");

  let detail = await api(`/api/purchase-orders/${poId}`, { cookie: plannerCookie });
  let order = detail.purchaseOrder;
  assert(order.vendor === "StyleFlow E2E Noise Supplier", "Created PO did not freeze the chosen legal supplier.");
  assert(order.lines[0].supplierMappingId === created.mapping.id, "PO line did not freeze mapping identity.");
  assert(order.lines[0].supplierMappingRevision === created.mapping.revision, "PO line did not freeze mapping revision.");
  assert(Number(order.lines[0].unitPrice) === Number(sourceRecommendation.unitPrice), "PO line did not freeze the entered INR NLC.");
  const receiptDate = calendarDate(order.order_date);

  const edited = await api(`/api/purchase-orders/${poId}`, {
    cookie: plannerCookie,
    method: "PATCH",
    body: {
      expectedRevision: order.revision,
      lines: order.lines,
      expectedDeliveryDate: calendarDate(order.expected_delivery_date),
      paymentTerms: "Net 30 days",
      incoterms: "DAP",
      shipTo: "Myntra Bengaluru FC, Karnataka, India",
      billTo: "Myntra Designs Pvt Ltd, Bengaluru, Karnataka, India",
      notes: "Isolated StyleFlow end-to-end workflow test.",
      supplierEmail: "noise-orders@supplier-demo.example",
      supplierGstin: "06DEMOS9999A1Z5",
      buyerGstin: "29DEMOB1234A1Z5",
      supplierState: "Haryana",
      buyerState: "Karnataka",
      placeOfSupply: "Karnataka",
      freight: 0,
      discount: 0,
    },
  });
  const submitted = await api(`/api/purchase-orders/${poId}`, {
    cookie: plannerCookie,
    method: "PATCH",
    body: { expectedRevision: edited.revision, action: "pending_approval" },
  });
  assert(submitted.status === "pending_approval", "PO did not enter pending approval.");
  // This specifically proves planner RBAC: planners cannot approve. The
  // separate-creator maker-checker rule is covered by the PO route tests; an
  // approver cannot create a PO, so this planner session cannot isolate both
  // controls in one identity.
  const plannerApprovalDenied = await api(`/api/purchase-orders/${poId}`, {
    cookie: plannerCookie,
    method: "PATCH",
    body: { expectedRevision: submitted.revision, action: "approved" },
    expected: 403,
  });
  assert(/role|approv/i.test(String(plannerApprovalDenied.error || "")), "Planner approval denial did not return an authorization explanation.");

  const approverCookie = await login(users.approver.username);
  const approved = await api(`/api/purchase-orders/${poId}`, {
    cookie: approverCookie,
    method: "PATCH",
    body: { expectedRevision: submitted.revision, action: "approved" },
  });
  assert(approved.status === "approved", "Senior approver did not approve the PO.");

  const emailContext = await api(`/api/purchase-orders/${poId}/email`, { cookie: plannerCookie });
  assert(emailContext.provider?.provider === "preview", "E2E refuses to contact a live email provider; start the isolated server with EMAIL_PROVIDER=preview.");
  assert(emailContext.permissions?.canSend === true, "Approved and complete PO was not email-ready.");

  const preview = await api(`/api/purchase-orders/${poId}/email`, {
    cookie: plannerCookie,
    method: "POST",
    expected: 201,
    body: {
      action: "preview",
      idempotencyKey: `preview-${Date.now()}`,
      to: "noise-orders@supplier-demo.example",
      subject: `StyleFlow E2E ${created.purchaseOrder.poNumber}`,
      buyerMessage: "Please confirm the expected receipt date.",
    },
  });
  assert(preview.preview?.html && preview.preview?.text, "Supplier email preview was not rendered.");

  const testSend = await api(`/api/purchase-orders/${poId}/email`, {
    cookie: plannerCookie,
    method: "POST",
    expected: 200,
    body: {
      action: "send",
      idempotencyKey: `send-${Date.now()}`,
      to: "noise-orders@supplier-demo.example",
      subject: `StyleFlow E2E ${created.purchaseOrder.poNumber}`,
      buyerMessage: "Please confirm the expected receipt date.",
    },
  });
  assert(testSend.delivery?.status === "preview" && testSend.delivered === false, "Local test send must remain a non-delivering preview.");
  assert(testSend.purchaseOrderStatus === "approved", "Preview-only send must leave the PO approved.");

  const issued = await api(`/api/purchase-orders/${poId}`, {
    cookie: plannerCookie,
    method: "PATCH",
    body: {
      expectedRevision: approved.revision,
      action: "issued",
      note: "Supplier email preview verified; external delivery intentionally not configured in isolated test.",
    },
  });
  assert(issued.status === "issued", "PO was not marked as externally issued.");

  const receiverCookie = await login(users.receiver.username);
  detail = await api(`/api/purchase-orders/${poId}`, { cookie: receiverCookie });
  order = detail.purchaseOrder;
  const line = order.lines[0];
  const firstReceipt = await api(`/api/purchase-orders/${poId}/receive`, {
    cookie: receiverCookie,
    method: "POST",
    body: {
      expectedRevision: issued.revision,
      receipts: [{ lineId: line.lineId, quantity: 1 }],
      receiptDate,
      grn: "E2E-GRN-PARTIAL",
      invoice: "E2E-INV-001",
      note: "Partial receipt validation.",
    },
  });
  assert(firstReceipt.status === "partially_received", "First receipt should be partial.");
  assert(Number(firstReceipt.lines[0].receivedQty) === 1, "Partial receipt quantity was not persisted.");
  const finalReceipt = await api(`/api/purchase-orders/${poId}/receive`, {
    cookie: receiverCookie,
    method: "POST",
    body: {
      expectedRevision: firstReceipt.revision,
      receipts: [{ lineId: line.lineId, quantity: Number(line.quantity) - 1 }],
      receiptDate,
      grn: "E2E-GRN-COMPLETE",
      invoice: "E2E-INV-001",
      note: "Final receipt validation.",
    },
  });
  assert(finalReceipt.status === "received", "Final receipt should complete the PO.");
  assert(Number(finalReceipt.lines[0].receivedQty) === Number(line.quantity), "Full received quantity does not match the ordered quantity.");
  const closed = await api(`/api/purchase-orders/${poId}`, {
    cookie: plannerCookie,
    method: "PATCH",
    body: { expectedRevision: finalReceipt.revision, action: "closed" },
  });
  assert(closed.status === "closed", "PO did not close after full receipt.");

  detail = await api(`/api/purchase-orders/${poId}`, { cookie: plannerCookie });
  const eventTypes = new Set(detail.events.map(event => event.event_type));
  for (const event of ["created", "edited", "pending_approval", "approved", "email_previewed", "issued", "receipt", "closed"]) {
    assert(eventTypes.has(event), `Missing ${event} audit event.`);
  }
  const creationEvent = detail.events.find(event => event.event_type === "created");
  assert(creationEvent.payload?.supplierResolution?.mappingId === created.mapping.id, "Creation audit lacks supplier mapping provenance.");

  console.log(JSON.stringify({
    ok: true,
    batchId,
    styleId,
    purchaseOrderId: poId,
    purchaseOrderNumber: created.purchaseOrder.poNumber,
    mappingRevision: created.mapping.revision,
    currency: created.purchaseOrder.currency,
    duplicateGuard: duplicate.code,
    emailPreview: "rendered",
    emailSend: "safe preview only; no external recipient contacted",
    finalStatus: detail.purchaseOrder.status,
    auditedEvents: [...eventTypes].sort(),
  }, null, 2));
} finally {
  await db.end();
}

async function seedTestUsers() {
  for (const user of Object.values(users)) {
    const passwordHash = passwordHashFor(testPassword);
    const updated = await db`UPDATE app_users SET
        display_name=${user.displayName},email=${`${user.username}@example.test`},role=${user.role},password_hash=${passwordHash},
        is_active=true,must_change_password=false,failed_attempts=0,locked_until=NULL,
        session_version=session_version+1,updated_at=now()
      WHERE lower(username)=lower(${user.username})
      RETURNING id`;
    if (updated.length === 0) {
      await db`INSERT INTO app_users
        (id,username,display_name,email,role,password_hash,is_active,must_change_password,failed_attempts,session_version)
        VALUES (${randomUUID()},${user.username},${user.displayName},${`${user.username}@example.test`},${user.role},${passwordHash},true,false,0,1)`;
    }
  }
}

function passwordHashFor(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, { cost: 16_384, blockSize: 8, parallelization: 1, maxmem: 64 * 1024 * 1024 });
  return ["scrypt", 16_384, 8, 1, salt.toString("base64url"), key.toString("base64url")].join("$");
}

async function login(username) {
  const response = await fetch(`${apiBase}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: testPassword }),
  });
  const payload = await response.json();
  if (response.status !== 200) throw new Error(`Login failed for ${username}: ${response.status} ${JSON.stringify(payload)}`);
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error(`Login for ${username} did not return a session cookie.`);
  return setCookie.split(";", 1)[0];
}

async function api(path, { cookie, method = "GET", body, expected = 200 } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({ error: "Response was not JSON." }));
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(response.status)) {
    throw new Error(`${method} ${path} returned ${response.status}; expected ${allowed.join("/")}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function recommendationFrom(batch) {
  const recommendation = (batch.recommendations || []).find(row => String(row.styleId || row.sku) === styleId);
  if (!recommendation) throw new Error(`Style ${styleId} was not found in batch ${batchId}.`);
  if (!(Number(recommendation.suggestedPoQty) > 1)) throw new Error(`Style ${styleId} is not actionable enough for partial/full receipt testing.`);
  return recommendation;
}

function calendarDate(value) {
  const match = String(value || "").match(/^\d{4}-\d{2}-\d{2}/);
  if (!match) throw new Error(`Invalid calendar date: ${value}`);
  return match[0];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
