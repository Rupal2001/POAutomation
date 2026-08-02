import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
const apiBase = process.env.API_BASE || "http://127.0.0.1:3103";
const password = process.env.E2E_PASSWORD || "StyleFlow-E2E-Only-2026!";
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const parsed = new URL(databaseUrl);
const databaseName = parsed.pathname.replace(/^\//, "");
if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) || !databaseName.startsWith("styleflow_inline_audit_")) {
  throw new Error("This destructive workflow test only runs against a local styleflow_inline_audit_* database.");
}

const db = postgres(databaseUrl, { max: 1 });
const token = randomBytes(4).toString("hex");
const admin = {
  username: `e2e_admin_${token}`,
  displayName: `E2E Admin ${token}`,
  email: `e2e_admin_${token}@example.test`,
};

try {
  const [adminRow] = await db`INSERT INTO app_users
    (id,username,display_name,email,role,password_hash,is_active,must_change_password,failed_attempts,session_version)
    VALUES (${randomUUID()},${admin.username},${admin.displayName},${admin.email},'admin',${passwordHashFor(password)},true,false,0,1)
    RETURNING id`;
  const cookie = await login();

  const reviewResponse = await fetch(`${apiBase}/review-orders`, { headers: { Cookie: cookie }, redirect: "manual" });
  const reviewLocation = reviewResponse.headers.get("location") || "";
  assert([307, 308].includes(reviewResponse.status) && /^\/results\/[0-9a-f-]+$/i.test(reviewLocation), "Review orders did not redirect to the latest reviewable plan.");

  let queue = await api("/api/purchase-orders", { cookie });
  let pending = queue.purchaseOrders.filter(order => order.status === "pending_approval");
  if (!pending.length) {
    let fixture = queue.purchaseOrders.find(order => order.status === "draft");
    if (!fixture) {
      fixture = queue.purchaseOrders.find(order => order.status === "approved");
      assert(fixture, "The audit fixture needs a draft, pending, or approved purchase order.");
      const reopenedFixture = await api(`/api/purchase-orders/${fixture.id}`, {
        cookie,
        method: "PATCH",
        body: { action: "draft", note: "E2E reopen to create an approval decision", expectedRevision: fixture.revision },
      });
      fixture = { ...fixture, status: "draft", revision: reopenedFixture.revision };
    }
    await api(`/api/purchase-orders/${fixture.id}`, {
      cookie,
      method: "PATCH",
      body: { action: "pending_approval", expectedRevision: fixture.revision },
    });
    queue = await api("/api/purchase-orders", { cookie });
    pending = queue.purchaseOrders.filter(order => order.status === "pending_approval");
  }
  assert(pending.length >= 1, "The audit fixture needs one pending purchase order.");
  assert(pending[0].permissions?.canApprove && pending[0].permissions?.canReturnToDraft, "Admin row permissions were not exposed.");
  await db`UPDATE purchase_orders SET created_by_user_id=${adminRow.id},created_by=${admin.displayName} WHERE id=${pending[0].id}`;

  let approvedResult = await api(`/api/purchase-orders/${pending[0].id}`, {
    cookie,
    method: "PATCH",
    body: { action: "approved", expectedRevision: pending[0].revision },
  });
  assert(approvedResult.status === "approved", "Inline approval did not approve the row.");
  const [selfApprovalEvent] = await db`SELECT payload FROM po_events
    WHERE purchase_order_id=${pending[0].id} AND event_type='approved'
    ORDER BY created_at DESC LIMIT 1`;
  assert(selfApprovalEvent?.payload?.selfApproval === true, "Self-approval was not marked explicitly in the audit event.");
  const reopened = await api(`/api/purchase-orders/${pending[0].id}`, {
    cookie,
    method: "PATCH",
    body: { action: "draft", note: "E2E reopen before queue return test", expectedRevision: approvedResult.revision },
  });
  const resubmitted = await api(`/api/purchase-orders/${pending[0].id}`, {
    cookie,
    method: "PATCH",
    body: { action: "pending_approval", expectedRevision: reopened.revision },
  });
  const returnedResult = await api(`/api/purchase-orders/${pending[0].id}`, {
    cookie,
    method: "PATCH",
    body: { action: "draft", note: "E2E return reason for planner correction", expectedRevision: resubmitted.revision },
  });
  assert(returnedResult.status === "draft", "Inline return did not return the row to draft.");
  const finalSubmission = await api(`/api/purchase-orders/${pending[0].id}`, {
    cookie,
    method: "PATCH",
    body: { action: "pending_approval", expectedRevision: returnedResult.revision },
  });
  approvedResult = await api(`/api/purchase-orders/${pending[0].id}`, {
    cookie,
    method: "PATCH",
    body: { action: "approved", expectedRevision: finalSubmission.revision },
  });

  queue = await api("/api/purchase-orders", { cookie });
  const approvedCandidates = queue.purchaseOrders.filter(order => order.status === "approved");
  let target;
  let emailContext;
  for (const candidate of approvedCandidates) {
    const context = await api(`/api/purchase-orders/${candidate.id}/email`, { cookie });
    if (context.readiness?.missing?.length) {
      target = candidate;
      emailContext = context;
      break;
    }
  }
  assert(target && emailContext, "No approved PO with incomplete readiness was available for the safe-test and Admin override checks.");
  assert(emailContext.provider?.provider === "preview", "This E2E must run with the non-delivering preview provider.");
  assert(emailContext.permissions.canSend && !emailContext.permissions.canOverrideReadiness, "Safe preview send should be available without a dispatch-readiness override.");
  const message = {
    to: emailContext.defaults.to.length ? emailContext.defaults.to : ["supplier-audit@example.test"],
    cc: [],
    subject: emailContext.defaults.subject,
    buyerMessage: "Automated safe-preview audit; no supplier is contacted.",
  };

  const testSend = await api(`/api/purchase-orders/${target.id}/email`, {
    cookie,
    method: "POST",
    body: { ...message, action: "send", idempotencyKey: `admin-safe-send-${token}` },
  });
  assert(testSend.delivery?.status === "preview" && testSend.delivered === false && testSend.purchaseOrderStatus === "approved", "Safe preview send must bypass readiness and pre-generated-preview gates without contacting a supplier.");
  const preview = await api(`/api/purchase-orders/${target.id}/email`, {
    cookie,
    method: "POST",
    body: { ...message, action: "preview", idempotencyKey: `admin-preview-${token}` },
    expected: 201,
  });
  assert(preview.preview?.html, "Email preview was not rendered.");

  const detail = await api(`/api/purchase-orders/${target.id}`, { cookie });
  const blockedExternal = await api(`/api/purchase-orders/${target.id}`, {
    cookie,
    method: "PATCH",
    body: { action: "issued", note: "Sent outside for E2E audit", expectedRevision: detail.purchaseOrder.revision },
    expected: 400,
  });
  assert(/override/i.test(blockedExternal.error), "External send without the explicit override was not rejected clearly.");
  const externalReason = "Authorised external dispatch exception for E2E audit";
  const issued = await api(`/api/purchase-orders/${target.id}`, {
    cookie,
    method: "PATCH",
    body: {
      action: "issued",
      note: "Sent outside StyleFlow through the E2E audit channel",
      expectedRevision: detail.purchaseOrder.revision,
      sendReadinessOverride: true,
      sendReadinessOverrideReason: externalReason,
    },
  });
  assert(issued.status === "issued", "Admin external-send override did not issue the PO.");

  const finalDetail = await api(`/api/purchase-orders/${target.id}`, { cookie });
  const overrideEvents = finalDetail.events.filter(event => event.event_type === "send_readiness_overridden");
  const issuedEvent = finalDetail.events.find(event => event.event_type === "issued");
  assert(!overrideEvents.some(event => event.payload?.channel === "email" && event.payload?.deliveryId === testSend.delivery.id), "Safe preview send must not create a dispatch-readiness override event.");
  assert(issuedEvent?.payload?.sendReadinessOverride?.reason === externalReason, "External-send override audit payload is incomplete.");

  console.log(JSON.stringify({
    ok: true,
    reviewOrdersEntry: reviewLocation,
    inlineApproval: approvedResult.status,
    selfApprovalAudited: true,
    inlineReturn: returnedResult.status,
    safeEmailTest: "sent without readiness override or pre-generated preview; no external recipient contacted",
    adminExternalSendOverride: issued.status,
    missingFieldsAudited: emailContext.readiness.missing,
    finalPurchaseOrder: target.po_number,
  }, null, 2));
} finally {
  await db.end();
}

function passwordHashFor(value) {
  const salt = randomBytes(16);
  const key = scryptSync(value, salt, 64, { cost: 16_384, blockSize: 8, parallelization: 1, maxmem: 64 * 1024 * 1024 });
  return ["scrypt", 16_384, 8, 1, salt.toString("base64url"), key.toString("base64url")].join("$");
}

async function login() {
  const response = await fetch(`${apiBase}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: admin.username, password }),
  });
  const payload = await response.json();
  if (response.status !== 200) throw new Error(`Admin login failed: ${response.status} ${JSON.stringify(payload)}`);
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Admin login did not return a session cookie.");
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
  if (!allowed.includes(response.status)) throw new Error(`${method} ${path} returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
