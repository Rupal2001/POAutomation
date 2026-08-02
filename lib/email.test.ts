import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverEmail, emailDeliveryFailureStatus, emailDeliveryRequiresDispatchReadiness, EmailDeliveryUncertainError, emailPreviewMatchesLiveSend, emailProviderStatus, formatEmailCalendarDate, parseEmailList, purchaseOrderEmailAttachments, renderPurchaseOrderEmail, renderPurchaseOrderEmailPreviewHtml } from "./email";

afterEach(() => {
  delete process.env.EMAIL_PROVIDER;
  delete process.env.EMAIL_FORCE_TO;
  delete process.env.EMAIL_FROM;
  delete process.env.EMAIL_REPLY_TO;
  delete process.env.RESEND_API_KEY;
  vi.unstubAllGlobals();
});

describe("purchase-order email", () => {
  it("normalizes and validates recipients", () => {
    expect(parseEmailList(" Buyer@Example.com;ops@example.com,buyer@example.com ")).toEqual(["buyer@example.com", "ops@example.com"]);
    expect(() => parseEmailList("not-an-email")).toThrow(/Invalid/);
  });

  it("escapes buyer and product content in HTML", () => {
    const result = renderPurchaseOrderEmail({
      id: "1", po_number: "PO-1", batch_id: null, vendor: "Vendor <One>", warehouse: "BLR", status: "approved",
      order_date: "2026-08-01", expected_delivery_date: "2026-08-10", currency: "INR", payment_terms: "Net 30", incoterms: "DAP",
      ship_to: "Myntra FC", bill_to: "Myntra Buying", notes: "Quote PO number", supplier_email: "supplier@example.com", supplier_gstin: "29ABCDE1234F1Z5", buyer_gstin: "29AAAAA0000A1Z5", supplier_state: "Karnataka",
      buyer_state: "Karnataka", place_of_supply: "Karnataka", lines: [{ lineId: "l1", sku: "S1", description: "Buds <Pro>", quantity: 2, receivedQty: 0, unitPrice: 799, currency: "INR", hsnCode: "8518", gstRate: 18 }],
      subtotal: 1598, freight: 100, discount: 50, tax: 287.64, total: 1935.64, created_by: "Admin", created_by_user_id: "u1", approved_by: "Approver", approved_by_user_id: "u2",
      approved_at: null, issued_at: null, closed_at: null, revision: 1, created_at: "2026-08-01", updated_at: "2026-08-01",
    }, "Please <confirm>");
    expect(result.html).toContain("Vendor &lt;One&gt;");
    expect(result.html).toContain("Please &lt;confirm&gt;");
    expect(result.html).not.toContain("Buds <Pro>");
    expect(result.html).toContain("Supplier GSTIN");
    expect(result.html).toContain("8518");
    expect(result.text).toContain("Merchandise subtotal: ₹1,598.00");
    expect(result.text).toContain("GST / tax: ₹287.64");
    expect(result.text).toContain("Grand total: ₹1,935.64");
    expect(result.html).toContain("1 Aug 2026");
    expect(result.html).toContain("10 Aug 2026");
    expect(result.text).toContain("PO date: 1 Aug 2026");
    expect(result.text).toContain("Expected delivery: 10 Aug 2026");
    expect(result.html).not.toContain("2026-08-01");
    expect(result.html).toContain('src="cid:styleflow-myntra-mark"');
    expect(result.html).toContain('alt="Myntra"');
    expect(result.html).toContain("StyleFlow");
    expect(result.html).toContain("Myntra Buying Operations");
    expect(result.html).toContain("background:#fff6f9");
    expect(result.text).toContain("StyleFlow · Myntra Buying Operations");

    const [brand] = purchaseOrderEmailAttachments();
    expect(brand).toMatchObject({
      filename: "myntra-mark.png",
      contentId: "styleflow-myntra-mark",
      contentType: "image/png",
    });
    expect(Buffer.from(brand.content, "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const previewHtml = renderPurchaseOrderEmailPreviewHtml(result.html);
    expect(previewHtml).toContain('src="data:image/png;base64,');
    expect(previewHtml).not.toContain("cid:styleflow-myntra-mark");
  });

  it("serializes the Myntra mark as a CID inline attachment for Resend", async () => {
    process.env.EMAIL_PROVIDER = "resend";
    process.env.EMAIL_FROM = "StyleFlow <po@example.com>";
    process.env.RESEND_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"id":"provider-message-1"}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await deliverEmail({
      to: ["supplier@example.com"],
      from: process.env.EMAIL_FROM,
      subject: "PO",
      html: '<img src="cid:styleflow-myntra-mark" alt="Myntra">',
      text: "StyleFlow · Myntra Buying Operations",
      attachments: purchaseOrderEmailAttachments(),
    }, "po/brand-test");

    expect(result).toMatchObject({ status: "sent", providerMessageId: "provider-message-1" });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload.html).toContain("cid:styleflow-myntra-mark");
    expect(payload.attachments).toEqual([expect.objectContaining({
      filename: "myntra-mark.png",
      content_id: "styleflow-myntra-mark",
      content_type: "image/png",
    })]);
    expect(Buffer.from(payload.attachments[0].content, "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(payload.attachments[0]).not.toHaveProperty("path");
  });

  it("formats PostgreSQL calendar values without timezone shifts or verbose Date strings", () => {
    expect(formatEmailCalendarDate("2026-08-02")).toBe("2 Aug 2026");
    expect(formatEmailCalendarDate(new Date("2026-08-02T00:00:00.000Z"))).toBe("2 Aug 2026");
    expect(formatEmailCalendarDate("2026-08-16T00:00:00.000Z")).toBe("16 Aug 2026");
    expect(formatEmailCalendarDate("not-a-date")).toBe("To be confirmed");
  });

  it("keeps local delivery in preview mode", async () => {
    const result = await deliverEmail({ to: ["a@example.com"], from: "b@example.com", subject: "PO", html: "<p>PO</p>", text: "PO" }, "po/1");
    expect(result).toEqual({ provider: "preview", status: "preview", providerMessageId: null });
  });

  it("requires dispatch readiness only when a live supplier can be contacted", () => {
    expect(emailDeliveryRequiresDispatchReadiness({ provider: "preview", forceToEnabled: false })).toBe(false);
    expect(emailDeliveryRequiresDispatchReadiness({ provider: "resend", forceToEnabled: true })).toBe(false);
    expect(emailDeliveryRequiresDispatchReadiness({ provider: "resend", forceToEnabled: false })).toBe(true);
  });

  it("does not treat a whitespace-only force recipient as a safe redirect", () => {
    process.env.EMAIL_PROVIDER = "resend";
    process.env.EMAIL_FORCE_TO = "   ";
    expect(emailProviderStatus().forceToEnabled).toBe(false);
    expect(emailDeliveryRequiresDispatchReadiness(emailProviderStatus())).toBe(true);
  });

  it("reports EMAIL_FORCE_TO only when the Resend provider can use it", () => {
    process.env.EMAIL_FORCE_TO = "test@example.com";
    expect(emailProviderStatus().forceToEnabled).toBe(false);
    process.env.EMAIL_PROVIDER = "resend";
    expect(emailProviderStatus().forceToEnabled).toBe(true);
  });

  it("authorizes a live send only from the same user's fresh, exact preview", () => {
    const request = {
      purchaseOrderId: "po-1",
      to: ["supplier@example.com"],
      cc: ["buyer@example.com"],
      subject: "PO-1",
      buyerMessage: "Please confirm receipt.",
      createdByUserId: "planner-1",
      purchaseOrderUpdatedAt: "2026-08-02T10:00:00.000Z",
    };
    const preview = {
      purchaseOrderId: "po-1",
      action: "preview",
      status: "preview" as const,
      to: ["supplier@example.com"],
      cc: ["buyer@example.com"],
      subject: "PO-1",
      buyerMessage: "Please confirm receipt.",
      createdByUserId: "planner-1",
      createdAt: "2026-08-02T10:01:00.000Z",
    };

    expect(emailPreviewMatchesLiveSend(preview, request)).toBe(true);
    expect(emailPreviewMatchesLiveSend({ ...preview, createdAt: "2026-08-02T09:59:59.999Z" }, request)).toBe(false);
    expect(emailPreviewMatchesLiveSend({ ...preview, createdByUserId: "planner-2" }, request)).toBe(false);
    expect(emailPreviewMatchesLiveSend({ ...preview, to: ["other@example.com"] }, request)).toBe(false);
    expect(emailPreviewMatchesLiveSend({ ...preview, subject: "Changed PO" }, request)).toBe(false);
    expect(emailPreviewMatchesLiveSend({ ...preview, buyerMessage: "Changed message" }, request)).toBe(false);
    expect(emailPreviewMatchesLiveSend({ ...preview, action: "send" }, request)).toBe(false);
  });

  it("fails closed when live delivery credentials are incomplete", async () => {
    process.env.EMAIL_PROVIDER = "resend";
    expect(emailProviderStatus().configured).toBe(false);
    await expect(deliverEmail({
      to: ["supplier@example.com"],
      from: "StyleFlow <po@example.com>",
      subject: "PO",
      html: "<p>PO</p>",
      text: "PO",
    }, "po/live-test")).rejects.toThrow(/RESEND_API_KEY.*EMAIL_FROM/);
  });

  it("classifies a connection loss as uncertain so retries stay blocked", async () => {
    process.env.EMAIL_PROVIDER = "resend";
    process.env.EMAIL_FROM = "StyleFlow <po@example.com>";
    process.env.RESEND_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection reset")));
    await expect(deliverEmail({
      to: ["supplier@example.com"], from: process.env.EMAIL_FROM, subject: "PO",
      html: "<p>PO</p>", text: "PO",
    }, "po/uncertain")).rejects.toBeInstanceOf(EmailDeliveryUncertainError);
  });

  it("treats unverifiable success and provider server errors as uncertain", async () => {
    process.env.EMAIL_PROVIDER = "resend";
    process.env.EMAIL_FROM = "StyleFlow <po@example.com>";
    process.env.RESEND_API_KEY = "test-key";
    const message = { to: ["supplier@example.com"], from: process.env.EMAIL_FROM, subject: "PO", html: "<p>PO</p>", text: "PO" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })));
    await expect(deliverEmail(message, "po/no-id")).rejects.toBeInstanceOf(EmailDeliveryUncertainError);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response('{"message":"upstream unavailable"}', { status: 503, headers: { "Content-Type": "application/json" } })));
    await expect(deliverEmail(message, "po/server-error")).rejects.toBeInstanceOf(EmailDeliveryUncertainError);
  });

  it("keeps a clear provider validation rejection retryable", async () => {
    process.env.EMAIL_PROVIDER = "resend";
    process.env.EMAIL_FROM = "StyleFlow <po@example.com>";
    process.env.RESEND_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"message":"invalid recipient"}', { status: 422, headers: { "Content-Type": "application/json" } })));
    await expect(deliverEmail({
      to: ["supplier@example.com"], from: process.env.EMAIL_FROM, subject: "PO", html: "<p>PO</p>", text: "PO",
    }, "po/rejected")).rejects.not.toBeInstanceOf(EmailDeliveryUncertainError);
  });

  it("keeps ambiguous provider failures distinct from confirmed failures", () => {
    expect(emailDeliveryFailureStatus(new EmailDeliveryUncertainError("unknown"))).toBe("uncertain");
    expect(emailDeliveryFailureStatus(new Error("provider rejected request"))).toBe("failed");
  });
});
