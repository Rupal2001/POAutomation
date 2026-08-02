"use client";

import { FormEvent, use, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import CoverageBar from "@/components/CoverageBar";
import Icon from "@/components/Icon";
import { EmptyState, InfoNote, LoadingState, MetricCard, PageIntro, Segment, StatusMessage } from "@/components/Ui";
import { formatBias, formatCompactINR, formatDate, formatDateTime, formatIndianNumber, formatINR, formatPct } from "@/lib/format";
import type { Recommendation, VendorMasterRow } from "@/lib/po-engine";
import { hasApplicableSupplierMaster, isPlaceholderSupplier, isStyleCoverRecommendation, purchaseOrderBlockReason, styleCoverAudit, supplierResolutionBlockReason } from "@/lib/recommendation-review";

type Rec = Recommendation & {
  marketplaceSeller?: string | null;
  sourceUrl?: string | null;
  priceCapturedOn?: string | null;
  catalogueDataProvenance?: string | null;
  commercialDataProvenance?: string | null;
  supplierMasterMapped?: boolean;
};
type Batch = { id: string; coverage_days: number; created_at: string; label: string | null; planning_settings: Record<string, any>; recommendations: Rec[]; vendor_master_data?: VendorMasterRow[] };
type View = "all" | "ready" | "review" | "no_order";
type SupplierCandidate = {
  id: string;
  styleId: string;
  vendor: string;
  supplierSku: string;
  supplierEmail: string;
  nlc: number | null;
  hsnCode: string;
  gstRate: number | null;
  supplierGstin: string;
  supplierState: string;
  leadTimeDays: number | null;
  paymentTerms: string;
  incoterms: string;
  moq: number | null;
  packSize: number | null;
  revision: number | null;
};
type SupplierResolutionDraft = Omit<SupplierCandidate, "id" | "styleId" | "revision"> & {
  mappingId: string | null;
  expectedRevision: number | null;
  quantity: number;
  overrideReason: string;
  acknowledgeRisk: boolean;
  replaceNamedSupplier: boolean;
  createNew: boolean;
};
type SupplierResolution = { row: Rec; draft: SupplierResolutionDraft; initialDraft: SupplierResolutionDraft };

export default function ResultsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [batch, setBatch] = useState<Batch | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [coverage, setCoverage] = useState(28);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [qty, setQty] = useState<Record<string, number>>({});
  const [overrideReasons, setOverrideReasons] = useState<Record<string, string>>({});
  const [activePoKeys, setActivePoKeys] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [view, setView] = useState<View>("all");
  const [category, setCategory] = useState("");
  const [fc, setFc] = useState("");
  const [supplier, setSupplier] = useState("");
  const [risk, setRisk] = useState("");
  const [moreFilters, setMoreFilters] = useState(false);
  const [sort, setSort] = useState("urgency");
  const [detail, setDetail] = useState<Rec | null>(null);
  const [preview, setPreview] = useState(false);
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const [supplierResolution, setSupplierResolution] = useState<SupplierResolution | null>(null);
  const [supplierCandidates, setSupplierCandidates] = useState<SupplierCandidate[]>([]);
  const [supplierChoice, setSupplierChoice] = useState("__new__");
  const [supplierRequiresChoice, setSupplierRequiresChoice] = useState(false);
  const [supplierReplacementNeedsConfirmation, setSupplierReplacementNeedsConfirmation] = useState(false);
  const [supplierHasEditableBase, setSupplierHasEditableBase] = useState(false);
  const [supplierLookupBusy, setSupplierLookupBusy] = useState(false);
  const [supplierResolveBusy, setSupplierResolveBusy] = useState(false);
  const [supplierResolveError, setSupplierResolveError] = useState("");
  const [supplierResolveCode, setSupplierResolveCode] = useState("");
  const [supplierResolveAttempted, setSupplierResolveAttempted] = useState(false);
  const [supplierCanEdit, setSupplierCanEdit] = useState(true);
  const detailRef = useRef<HTMLElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const supplierResolutionRef = useRef<HTMLElement>(null);
  const supplierOptionalRef = useRef<HTMLDetailsElement>(null);
  const supplierLookupRequestRef = useRef(0);
  const lastTriggerRef = useRef<HTMLElement | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const key = (row: Rec) => `${row.warehouse}::::${row.vendor}::::${row.sku}`;

  async function load() {
    const [batchResponse, poResponse] = await Promise.all([fetch(`/api/batches/${id}`), fetch("/api/purchase-orders")]);
    const batchData = await batchResponse.json();
    const poData = poResponse.ok ? await poResponse.json() : { purchaseOrders: [] };
    if (!batchResponse.ok) throw new Error(batchData.error);
    const loadedBatch = batchData.batch as Batch;
    const supplierMaster = loadedBatch.vendor_master_data ?? [];
    const nextBatch: Batch = {
      ...loadedBatch,
      recommendations: (loadedBatch.recommendations ?? []).map(row => ({
        ...row,
        supplierMasterMapped: hasApplicableSupplierMaster(row, supplierMaster),
      })),
    };
    const existing = new Set<string>();
    for (const order of poData.purchaseOrders ?? []) {
      if (["cancelled","closed","received"].includes(order.status)) continue;
      if (String(order.batch_id ?? order.batchId ?? "") !== id) continue;
      for (const line of order.lines ?? []) existing.add(`${order.warehouse}::::${line.sku}`);
    }
    setActivePoKeys(existing);
    setBatch(nextBatch);
    setCoverage(nextBatch.coverage_days);
    setQty(Object.fromEntries((nextBatch.recommendations ?? []).map(row => [key(row), row.suggestedPoQty])));
    const query = new URLSearchParams(window.location.search);
    setSelected(Object.fromEntries((nextBatch.recommendations ?? []).filter(row => isSafe(row, existing)).map(row => [key(row), true])));
    if (query.get("q")) setSearch(query.get("q")!);
    if (query.get("risk")) { setRisk(query.get("risk")!); setView("all"); setMoreFilters(true); }
  }

  useEffect(() => { load().catch(nextError => setError(nextError.message)); }, [id]);

  const supplierResolutionOpen = Boolean(supplierResolution);
  useEffect(() => {
    if (!supplierResolutionOpen) supplierLookupRequestRef.current += 1;
  }, [supplierResolutionOpen]);
  useEffect(() => () => { supplierLookupRequestRef.current += 1; }, []);
  useEffect(() => {
    const dialog = supplierResolutionOpen ? supplierResolutionRef.current : detail ? detailRef.current : preview ? previewRef.current : null;
    if (!dialog) return;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')).filter(element => !element.hasAttribute("disabled"));
    focusables()[0]?.focus();
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (supplierResolveBusy) return;
        setSupplierResolution(null); setDetail(null); setPreview(false); return;
      }
      if (event.key !== "Tab") return;
      const items = focusables(); if (!items.length) return;
      const first = items[0]; const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", handleKey);
    return () => { document.body.style.overflow = priorOverflow; document.removeEventListener("keydown", handleKey); lastTriggerRef.current?.focus(); };
  }, [detail, preview, supplierResolutionOpen, supplierResolveBusy]);

  async function recompute() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batchId: id, coverageDays: coverage, settings: { forecastMethod: "auto" }, createVersion: true }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      router.push(`/results/${result.batchId}`);
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "The scenario could not be recalculated."); setBusy(false); }
  }

  function openSupplierResolver(row: Rec, trigger?: HTMLElement) {
    if (trigger) lastTriggerRef.current = trigger;
    const initialDraft = supplierDraftFromRow(row, batch?.vendor_master_data ?? [], qty[key(row)] ?? row.suggestedPoQty, overrideReasons[key(row)] ?? "");
    setDetail(null);
    setPreview(false);
    setSupplierCandidates([]);
    setSupplierChoice("__new__");
    setSupplierRequiresChoice(false);
    setSupplierReplacementNeedsConfirmation(false);
    setSupplierHasEditableBase(false);
    setSupplierCanEdit(true);
    setSupplierResolveError("");
    setSupplierResolveCode("");
    setSupplierResolveAttempted(false);
    setSupplierResolution({ row, draft: initialDraft, initialDraft });
    void loadSupplierCandidates(row, initialDraft);
  }

  async function loadSupplierCandidates(row: Rec, initialDraft: SupplierResolutionDraft, preferredId?: string | null) {
    const requestId = ++supplierLookupRequestRef.current;
    setSupplierLookupBusy(true);
    setSupplierResolveError("");
    try {
      const query = new URLSearchParams({ batchId: id, sku: row.sku, warehouse: row.warehouse, currentVendor: row.vendor });
      const response = await fetch(`/api/purchase-orders/resolve-supplier-and-create?${query}`, { cache: "no-store" });
      const result = await response.json().catch(() => ({}));
      if (requestId !== supplierLookupRequestRef.current) return;
      if (!response.ok && response.status === 403) {
        setSupplierCanEdit(false);
        setSupplierResolveError(result.error || "Planner or administrator access is required to create a draft PO.");
        setSupplierResolveCode("FORBIDDEN");
        return;
      }
      if (!response.ok) throw new Error(result.error || "Existing supplier relationships could not be checked.");
      const candidates = (Array.isArray(result.mappings) ? result.mappings : []).map(normalizeSupplierCandidate).filter((candidate: SupplierCandidate) => !isPlaceholderSupplier(candidate.vendor));
      const editableBase = result.editableBaseMapping ? normalizeSupplierCandidate(result.editableBaseMapping) : null;
      const requiresChoice = Boolean(result.requiresExplicitSelection) || candidates.length > 1;
      setSupplierCandidates(candidates);
      setSupplierRequiresChoice(requiresChoice);
      setSupplierReplacementNeedsConfirmation(Boolean(result.replacementNeedsConfirmation));
      setSupplierHasEditableBase(Boolean(editableBase?.id));
      setSupplierCanEdit(result.permissions?.canEdit !== false);
      setSupplierResolution(current => {
        if (!current || recommendationIdentity(current.row) !== recommendationIdentity(row)) return current;
        const preferred = preferredId ? [...candidates, ...(editableBase ? [editableBase] : [])].find((candidate: SupplierCandidate) => candidate.id === preferredId) : null;
        if (preferred) {
          setSupplierChoice(isPlaceholderSupplier(preferred.vendor) ? "__base__" : preferred.id);
          return { ...current, draft: draftFromCandidate(preferred, initialDraft) };
        }
        if (candidates.length === 1 && !requiresChoice) {
          setSupplierChoice(candidates[0].id);
          return { ...current, draft: draftFromCandidate(candidates[0], initialDraft) };
        }
        if (requiresChoice) {
          setSupplierChoice("");
          return { ...current, draft: blankSupplierChoice(initialDraft) };
        }
        if (editableBase?.id) {
          setSupplierChoice("__base__");
          return { ...current, draft: draftFromCandidate(editableBase, initialDraft) };
        }
        setSupplierChoice("__new__");
        return { ...current, draft: { ...initialDraft, createNew: true } };
      });
      if (result.permissions?.canEdit === false) {
        setSupplierResolveError("Planner or administrator access is required to save supplier details and create a draft PO.");
        setSupplierResolveCode("FORBIDDEN");
      }
    } catch (nextError) {
      if (requestId !== supplierLookupRequestRef.current) return;
      setSupplierResolveError(nextError instanceof Error ? nextError.message : "Existing supplier relationships could not be checked.");
      setSupplierResolveCode("LOOKUP_FAILED");
    } finally {
      if (requestId === supplierLookupRequestRef.current) setSupplierLookupBusy(false);
    }
  }

  function chooseSupplier(value: string) {
    if (!supplierResolution) return;
    setSupplierChoice(value);
    setSupplierResolveError("");
    setSupplierResolveCode("");
    setSupplierResolveAttempted(false);
    if (value === "__new__") {
      const draft = supplierCandidates.length
        ? { ...blankSupplierChoice(supplierResolution.initialDraft), createNew: true }
        : { ...supplierResolution.initialDraft, createNew: true };
      setSupplierResolution({ ...supplierResolution, draft });
      return;
    }
    const candidate = supplierCandidates.find(item => item.id === value);
    if (candidate) setSupplierResolution({ ...supplierResolution, draft: draftFromCandidate(candidate, supplierResolution.initialDraft) });
  }

  function updateSupplierDraft(values: Partial<SupplierResolutionDraft>) {
    setSupplierResolution(current => current ? { ...current, draft: { ...current.draft, ...values } } : current);
    setSupplierResolveError("");
    setSupplierResolveCode("");
  }

  async function resolveSupplierAndCreateDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supplierResolution) return;
    setSupplierResolveAttempted(true);
    const { row, draft } = supplierResolution;
    const issues = supplierDraftErrors(row, draft, supplierRequiresChoice && !supplierChoice);
    if (issues.length) {
      setSupplierResolveError(issues[0]);
      if (hasInvalidEnteredSupplierDetails(draft)) supplierOptionalRef.current?.setAttribute("open", "");
      window.requestAnimationFrame(() => supplierResolutionRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus());
      return;
    }
    setSupplierResolveBusy(true);
    setSupplierResolveError("");
    setSupplierResolveCode("");
    try {
      const response = await fetch("/api/purchase-orders/resolve-supplier-and-create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchId: id,
          selection: {
            sku: row.sku,
            styleId: row.styleId,
            warehouse: row.warehouse,
            currentVendor: row.vendor,
            quantity: draft.quantity,
            overrideReason: draft.overrideReason.trim() || undefined,
            acknowledgeRisk: draft.acknowledgeRisk || !hasUnresolvedCriticalRisk(row),
          },
          mapping: compactSupplierMapping(draft),
          replaceNamedSupplier: namedSupplierChanged(row, draft) ? draft.replaceNamedSupplier : undefined,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const code = String(result.code || "");
        if (code === "AMBIGUOUS_SUPPLIER_MAPPING" && Array.isArray(result.candidates)) {
          const candidates = result.candidates.map(normalizeSupplierCandidate).filter((candidate: SupplierCandidate) => !isPlaceholderSupplier(candidate.vendor));
          setSupplierCandidates(candidates);
          setSupplierRequiresChoice(true);
          setSupplierChoice("");
          setSupplierResolution(current => current ? { ...current, draft: blankSupplierChoice(current.initialDraft) } : current);
        }
        setSupplierResolveCode(code || (response.status === 403 ? "FORBIDDEN" : ""));
        throw new Error(result.error || "The supplier details could not be saved and no draft PO was created.");
      }
      const purchaseOrder = result.purchaseOrder ?? result.purchaseOrders?.[0] ?? result.created?.[0];
      if (!purchaseOrder?.id) throw new Error("The supplier details were saved, but the new draft PO could not be opened. Open the PO queue to find it.");
      router.push(`/purchase-orders/${encodeURIComponent(purchaseOrder.id)}?created=1&supplierResolved=1`);
    } catch (nextError) {
      setSupplierResolveError(nextError instanceof Error ? nextError.message : "The supplier details could not be saved and no draft PO was created.");
      setSupplierResolveBusy(false);
    }
  }

  async function createDrafts() {
    if (!batch) return;
    const invalidQuantity = chosen.find(row => !Number.isSafeInteger(qty[key(row)]) || qty[key(row)] <= 0);
    if (invalidQuantity) { setError(`Enter a positive whole-unit quantity for ${invalidQuantity.productName || invalidQuantity.sku}.`); setPreview(false); return; }
    const selections = chosen.map(row => ({ vendor: row.vendor, sku: row.sku, warehouse: row.warehouse, quantity: qty[key(row)], overrideReason: overrideReasons[key(row)], acknowledgeRisk: riskAcknowledged || !hasCritical(row) }));
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/purchase-orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batchId: id, selections }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      router.push(result.created.length === 1 ? `/purchase-orders/${result.created[0].id}` : "/purchase-orders?created=1");
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "Draft POs could not be created."); setPreview(false); setBusy(false); }
  }

  const rows = batch?.recommendations ?? [];
  const filtered = useMemo(() => rows.filter(row => {
    const text = [row.sku,row.styleId,row.productName,row.brand,row.category,row.colour,row.vendor].join(" ").toLowerCase();
    const rowView = buyingStatus(row, activePoKeys).view;
    return (!search || text.includes(search.toLowerCase())) && (view === "all" || rowView === view) && (!category || row.category === category) && (!fc || row.warehouse === fc) && (!supplier || row.vendor === supplier) && (!risk || row.exceptions.some(exception => exception.code === risk));
  }).sort((a,b) => sortRows(a,b,sort,activePoKeys)), [rows, search, view, category, fc, supplier, risk, sort, activePoKeys]);

  const selectableVisible = filtered.filter(row => canSelect(row, activePoKeys));
  const selectedVisible = selectableVisible.filter(row => selected[key(row)]).length;
  useEffect(() => { if (selectAllRef.current) selectAllRef.current.indeterminate = selectedVisible > 0 && selectedVisible < selectableVisible.length; }, [selectedVisible, selectableVisible.length]);

  const chosen = rows.filter(row => selected[key(row)] && canSelect(row, activePoKeys));
  const selectedUnits = chosen.reduce((total,row) => total + (qty[key(row)] || 0), 0);
  const selectedValue = chosen.reduce((total,row) => total + (qty[key(row)] || 0) * (row.unitPrice || 0), 0);
  const groups = groupSelections(chosen, qty, key);
  const risky = chosen.filter(hasCritical);
  const invalidQuantities = chosen.filter(row => !Number.isSafeInteger(qty[key(row)]) || qty[key(row)] <= 0);
  const missingReasons = chosen.filter(row => qty[key(row)] !== row.suggestedPoQty && !overrideReasons[key(row)]?.trim());
  const hiddenSelected = chosen.filter(row => !filtered.some(visible => key(visible) === key(row))).length;
  const metrics = summarize(rows);
  const methodologyPlan = rows.some(isStyleCoverRecommendation);
  const methodologyMetrics = summarizeStyleCover(rows);
  const supplierResolutionIssues = supplierResolution
    ? supplierDraftErrors(supplierResolution.row, supplierResolution.draft, supplierRequiresChoice && !supplierChoice)
    : [];
  const supplierDispatchMissing = supplierResolution ? dispatchDetailGaps(supplierResolution.draft) : [];
  const supplierResolutionStage = supplierResolutionIssues.length
    ? "blocked"
    : supplierDispatchMissing.length ? "draft" : "send";
  const supplierDraftValue = supplierResolution && Number(supplierResolution.draft.nlc) > 0 && supplierResolution.draft.quantity > 0
    ? Number(supplierResolution.draft.nlc) * supplierResolution.draft.quantity
    : null;
  const supplierPlanNlc = supplierResolution ? positiveNumber(supplierResolution.row.unitPrice) : null;
  const supplierUnitCostDelta = supplierResolution && supplierPlanNlc !== null && Number(supplierResolution.draft.nlc) > 0
    ? Number(supplierResolution.draft.nlc) - supplierPlanNlc
    : null;

  if (error && !batch) return <EmptyState title="This plan could not be opened" icon="alert"><p>{error}</p></EmptyState>;
  if (!batch) return <LoadingState>Preparing an explained recommendation queue…</LoadingState>;

  return <div className={`results-page${chosen.length ? " pb-28" : ""}`}>
    <PageIntro
      eyebrow={`${methodologyPlan ? "New PO methodology" : "Plan history"} / ${batch.label || "Planning run"}`}
      title="Review what to order"
      description={methodologyPlan
        ? <>The documented DRR and DOH policy reviewed <strong>{rows.length} sold styles</strong>. {methodologyMetrics.eligible} are below the {formatAuditNumber(methodologyMetrics.threshold)}-day gate and {methodologyMetrics.actionable} have a positive order ask. {methodologyMetrics.blocked} actionable style{methodologyMetrics.blocked === 1 ? " is" : "s are"} blocked until the required style and supplier master data is complete. Plan saved {formatDateTime(batch.created_at)}.</>
        : <>We found <strong>{rows.length} recommendation lines worth {formatCompactINR(metrics.value)}</strong> before GST. Resolve {metrics.critical} urgent issues before creating drafts. Plan saved {formatDateTime(batch.created_at)}.</>}
      actions={<><label className="compact-field"><span>{methodologyPlan ? "PO cover target" : "Scenario horizon"}</span><div><input className="field" type="number" min={methodologyPlan ? 1 : 7} max={methodologyPlan ? 365 : 90} value={coverage} onChange={event => setCoverage(Number(event.target.value))}/><em>days</em></div></label><button className="btn-secondary" disabled={busy} onClick={recompute}><Icon name="refresh"/>{busy ? "Re-running…" : "Re-run as new version"}</button><a className="btn-secondary" href={`/api/export/${id}?format=csv`}><Icon name="download"/>Export</a></>}
    />

    {error && <StatusMessage type="error">{error}</StatusMessage>}

    {methodologyPlan ? <div className="workbench-metrics">
      <MetricCard label="Proposed investment" value={formatCompactINR(metrics.value)} detail={`${formatIndianNumber(metrics.units)} actionable units before planner changes`} tone="brand" icon="rupee"/>
      <MetricCard label="Below DOH gate" value={`${methodologyMetrics.eligible} / ${rows.length}`} detail={`Eligible only when DOH is below ${formatAuditNumber(methodologyMetrics.threshold)} days`} tone="positive" icon="check"/>
      <MetricCard label="Positive PO ask" value={methodologyMetrics.actionable} detail="Eligible styles where the rounded signed ask is above zero" tone="brand" icon="purchaseOrder"/>
      <MetricCard label="Master data blocked" value={methodologyMetrics.blocked} detail="Actionable styles missing supplier, model or valid NLC" tone={methodologyMetrics.blocked ? "critical" : "positive"} icon="alert"/>
      <MetricCard label="Selling days used" value={methodologyMetrics.uniqueDays || "—"} detail="Unique dates across the selected sell-out period" tone="neutral" icon="calendar"/>
    </div> : <div className="workbench-metrics">
      <MetricCard label="Proposed investment" value={formatCompactINR(metrics.value)} detail={`${formatIndianNumber(metrics.units)} units before planner changes`} tone="brand" icon="rupee"/>
      <MetricCard label="Urgent stock gaps" value={`${metrics.critical} / ${rows.length}`} detail={`${metrics.riskStyles} styles may run out before receipt`} tone={metrics.critical ? "critical" : "positive"} icon="alert"/>
      <MetricCard label="Estimated GMV exposure" value={formatCompactINR(metrics.gmvRisk)} detail="During projected stockout gaps" tone={metrics.gmvRisk ? "warning" : "positive"} icon="target"/>
      <MetricCard label="Ready to order" value={metrics.ready} detail="Priced and clear of blocking risks" tone="positive" icon="check"/>
      <MetricCard label="Historical forecast match" value={formatPct(metrics.accuracy)} detail="Demand-weighted holdout result" tone={(metrics.accuracy || 0) >= 75 ? "positive" : "warning"} icon="forecast"/>
    </div>}

    <section className="panel overflow-hidden workbench-panel">
      <div className="workbench-primary-toolbar">
        <Segment value={view} onChange={setView} label="Recommendation view" options={[
          { value: "all", label: "All", count: rows.length },
          { value: "ready", label: "Ready to order", count: rows.filter(row => buyingStatus(row, activePoKeys).view === "ready").length },
          { value: "review", label: "Needs review", count: rows.filter(row => buyingStatus(row, activePoKeys).view === "review").length },
          { value: "no_order", label: "No order needed", count: rows.filter(row => buyingStatus(row, activePoKeys).view === "no_order").length },
        ]}/>
        <div className="workbench-search"><Icon name="search"/><label className="sr-only" htmlFor="recommendation-search">Search recommendations</label><input id="recommendation-search" className="field" placeholder="Search product, brand, style or SKU…" value={search} onChange={event => setSearch(event.target.value)}/>{search && <button aria-label="Clear search" onClick={() => setSearch("")}><Icon name="close"/></button>}</div>
        <button className={`btn-secondary ${moreFilters ? "filter-active" : ""}`} aria-expanded={moreFilters} onClick={() => setMoreFilters(value => !value)}><Icon name="filter"/>More filters{[category,fc,supplier,risk].filter(Boolean).length ? ` (${[category,fc,supplier,risk].filter(Boolean).length})` : ""}</button>
      </div>
      {moreFilters && <div className="workbench-filter-row">
        <label><span>Category</span><select className="field" value={category} onChange={event => setCategory(event.target.value)}><option value="">All categories</option>{unique(rows.map(row => row.category)).map(value => <option key={value}>{value}</option>)}</select></label>
        <label><span>Fulfilment centre</span><select className="field" value={fc} onChange={event => setFc(event.target.value)}><option value="">All FCs</option>{unique(rows.map(row => row.warehouse)).map(value => <option key={value} value={value}>{friendlyFc(value)}</option>)}</select></label>
        <label><span>Supplier</span><select className="field" value={supplier} onChange={event => setSupplier(event.target.value)}><option value="">All suppliers</option>{unique(rows.map(row => row.vendor)).map(value => <option key={value}>{value}</option>)}</select></label>
        <label><span>Planning issue</span><select className="field" value={risk} onChange={event => setRisk(event.target.value)}><option value="">All issues</option>{unique(rows.flatMap(row => row.exceptions.map(exception => exception.code))).map(value => <option key={value} value={value}>{friendlyException(value)}</option>)}</select></label>
        <label><span>Sort by</span><select className="field" value={sort} onChange={event => setSort(event.target.value)}><option value="urgency">Urgency, then value</option><option value="value">Highest investment</option><option value="cover">Lowest stock cover</option><option value="accuracy">Lowest forecast match</option></select></label>
        <button className="btn-secondary" onClick={() => { setCategory(""); setFc(""); setSupplier(""); setRisk(""); setSort("urgency"); }}>Reset filters</button>
      </div>}
      <div className="workbench-result-summary"><span><strong>{filtered.length}</strong> lines shown{risk ? ` with ${friendlyException(risk).toLowerCase()}` : ""}</span><span><strong>{chosen.length}</strong> selected{hiddenSelected ? ` · ${hiddenSelected} outside this view` : ""}</span><span><strong>{activePoKeys.size}</strong> live PO line(s) protected from duplicate ordering</span></div>

      <div className="desktop-table-wrap"><table className="data-table recommendation-table"><caption>Explained Myntra replenishment recommendations</caption><thead><tr><th scope="col" className="select-column"><input ref={selectAllRef} aria-label="Select all eligible recommendations in this view" type="checkbox" disabled={!selectableVisible.length} checked={selectableVisible.length > 0 && selectedVisible === selectableVisible.length} onChange={event => setSelected(current => ({ ...current, ...Object.fromEntries(selectableVisible.map(row => [key(row), event.target.checked])) }))}/></th><th scope="col">Product</th><th scope="col">Recommended action and reason</th><th scope="col" className="text-right">Available now</th><th scope="col" className="text-right">Confirmed inbound</th><th scope="col">Stock cover</th><th scope="col" className="text-right">Order quantity</th><th scope="col" className="text-right">Estimated cost</th></tr></thead><tbody>{filtered.map(row => {
        const rowKey=key(row); const state=buyingStatus(row,activePoKeys); const override=(qty[rowKey]??0)!==row.suggestedPoQty; const available=Math.max(0,row.currentInventory-row.reservedQty-row.backorderQty);
        return <tr key={rowKey} className={selected[rowKey] ? "row-selected" : ""}><td className="select-column"><input aria-label={`Select ${row.productName || row.sku}`} type="checkbox" disabled={!canSelect(row,activePoKeys)} checked={!!selected[rowKey]} onChange={event => setSelected(current => ({...current,[rowKey]:event.target.checked}))}/></td><th scope="row"><button className="product-button" onClick={event => {lastTriggerRef.current=event.currentTarget;setDetail(row)}}><strong>{row.productName || `${row.brand} · ${row.category}`}</strong><span>{row.brand} · {row.colour || "Assorted"} · Size {row.size || "OS"}</span><small>{row.sku} · {friendlyFc(row.warehouse)}</small></button></th><td><div className="recommendation-action-cell"><button className="action-button" onClick={event => {lastTriggerRef.current=event.currentTarget;setDetail(row)}}><span className={`decision-badge decision-${state.tone}`}><Icon name={state.tone==="ready"?"check":"alert"}/>{state.label}</span><strong>{state.action}</strong><small>{state.reason}</small></button>{canResolveSupplier(row,activePoKeys)&&<button type="button" className="resolve-supplier-inline" onClick={event=>openSupplierResolver(row,event.currentTarget)}><Icon name="purchaseOrder"/>Add supplier & raise PO</button>}</div></td><td className="numeric-cell"><strong>{formatIndianNumber(available)}</strong>{row.backorderQty>0&&<small className="critical-copy">{formatIndianNumber(row.backorderQty)} backordered</small>}</td><td className="numeric-cell"><strong>{formatIndianNumber(row.openPoQty)}</strong>{row.overdueOpenPoQty>0&&<small className="critical-copy">{formatIndianNumber(row.overdueOpenPoQty)} overdue</small>}</td><td><CoverageBar daysOnHand={row.daysOnHand} coverageDays={batch.coverage_days} compact/></td><td className="quantity-cell"><input className={`field ${override?"overridden":""}`} aria-label={`Order quantity for ${row.sku}`} type="number" min="1" step="1" value={qty[rowKey]??0} disabled={!canSelect(row,activePoKeys)} onChange={event => setQty(current => ({...current,[rowKey]:Number(event.target.value)}))}/>{override&&<select aria-label={`Reason for changing ${row.sku}`} className="override-reason" value={overrideReasons[rowKey]||""} onChange={event=>setOverrideReasons(current=>({...current,[rowKey]:event.target.value}))}><option value="">Choose reason…</option><option>Budget limit</option><option>Supplier pack adjustment</option><option>Campaign decision</option><option>Inventory transfer planned</option><option>Other planner judgement</option></select>}<small>System: {formatIndianNumber(row.suggestedPoQty)}</small></td><td className="numeric-cell cost-cell"><strong>{row.unitPrice===null?"Cost missing":formatCompactINR((qty[rowKey]||0)*row.unitPrice)}</strong><small>{row.unitPrice===null?"Add cost to raise PO":`${formatIndianNumber(qty[rowKey]||0)} × ${formatCompactINR(row.unitPrice)}`}</small></td></tr>;
      })}</tbody></table></div>

      <div className="mobile-card-list recommendation-mobile-list">{filtered.map(row => {
        const rowKey=key(row); const state=buyingStatus(row,activePoKeys); const override=(qty[rowKey]??0)!==row.suggestedPoQty; const available=Math.max(0,row.currentInventory-row.reservedQty-row.backorderQty);
        return <article className={`recommendation-card ${selected[rowKey]?"selected":""}`} key={rowKey}><div className="recommendation-card-head"><label><input type="checkbox" disabled={!canSelect(row,activePoKeys)} checked={!!selected[rowKey]} onChange={event=>setSelected(current=>({...current,[rowKey]:event.target.checked}))}/><span className="sr-only">Select {row.productName||row.sku}</span></label><button onClick={event=>{lastTriggerRef.current=event.currentTarget;setDetail(row)}}><h3>{row.productName||`${row.brand} · ${row.category}`}</h3><p>{row.brand} · {row.size||"OS"} · {friendlyFc(row.warehouse)}</p></button><Icon name="chevronRight"/></div><div className={`recommendation-action action-${state.tone}`}><strong>{state.label}</strong><span>{state.reason}</span></div>{canResolveSupplier(row,activePoKeys)&&<button type="button" className="resolve-supplier-mobile" onClick={event=>openSupplierResolver(row,event.currentTarget)}><Icon name="purchaseOrder"/>Add supplier & raise PO<Icon name="arrowRight"/></button>}<dl><div><dt>Available now</dt><dd>{formatIndianNumber(available)}</dd></div><div><dt>Inbound</dt><dd>{formatIndianNumber(row.openPoQty)}</dd></div><div><dt>Cover</dt><dd>{row.daysOnHand===null?"No history":`${Math.max(0,row.daysOnHand).toFixed(0)} days`}</dd></div><div><dt>Cost</dt><dd>{row.unitPrice===null?"Missing":formatCompactINR((qty[rowKey]||0)*row.unitPrice)}</dd></div></dl><label className="mobile-quantity"><span>Order quantity</span><input className="field" type="number" min="1" step="1" disabled={!canSelect(row,activePoKeys)} value={qty[rowKey]??0} onChange={event=>setQty(current=>({...current,[rowKey]:Number(event.target.value)}))}/><small>System recommendation: {formatIndianNumber(row.suggestedPoQty)}</small></label>{override&&<label className="mobile-quantity"><span>Why are you changing it?</span><select className="field" value={overrideReasons[rowKey]||""} onChange={event=>setOverrideReasons(current=>({...current,[rowKey]:event.target.value}))}><option value="">Choose a reason…</option><option>Budget limit</option><option>Supplier pack adjustment</option><option>Campaign decision</option><option>Inventory transfer planned</option><option>Other planner judgement</option></select></label>}</article>;
      })}</div>
      {!filtered.length && <div className="workbench-empty"><Icon name="filter"/><h3>No products match these filters</h3><p>Reset filters to see the full plan.</p><button className="btn-secondary" onClick={() => {setSearch("");setView("all");setCategory("");setFc("");setSupplier("");setRisk("")}}>Reset filters</button></div>}
    </section>

    {chosen.length>0 && <div className="selection-tray"><div className="selection-summary"><strong>{chosen.length} selected line{chosen.length===1?"":"s"} · {groups.length} supplier/FC draft{groups.length===1?"":"s"}</strong><span>{formatIndianNumber(selectedUnits)} units · {formatCompactINR(selectedValue)} before GST{hiddenSelected?` · ${hiddenSelected} selected outside this view`:""}</span></div><div className="selection-warnings">{risky.length>0&&<span><Icon name="alert"/>{risky.length} urgent</span>}{invalidQuantities.length>0&&<span><Icon name="alert"/>{invalidQuantities.length} invalid quantit{invalidQuantities.length===1?"y":"ies"}</span>}{missingReasons.length>0&&<span><Icon name="alert"/>{missingReasons.length} override reason{missingReasons.length===1?"":"s"} missing</span>}</div><button className="selection-clear" onClick={()=>setSelected({})}>Clear</button><button className="btn-primary" disabled={busy||invalidQuantities.length>0||missingReasons.length>0} onClick={()=>{setRiskAcknowledged(false);setPreview(true)}}>Preview {groups.length} draft PO{groups.length===1?"":"s"}<Icon name="arrowRight"/></button></div>}

    {detail && <div className="drawer-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setDetail(null)}}><aside ref={detailRef} className="detail-drawer recommendation-drawer" role="dialog" aria-modal="true" aria-labelledby="recommendation-detail-title"><div className="drawer-head"><div><p className="eyebrow">Why this recommendation?</p><h2 id="recommendation-detail-title">{detail.productName||`${detail.brand} · ${detail.styleId||detail.sku}`}</h2><p>{detail.brand} · {detail.colour||"Assorted"} · Size {detail.size||"OS"} · {friendlyFc(detail.warehouse)}</p></div><button className="icon-button" aria-label="Close recommendation details" onClick={()=>setDetail(null)}><Icon name="close"/></button></div><div className="drawer-body">
      <RecommendationCallout row={detail}/>
      <CatalogueSnapshot row={detail}/>
      {canResolveSupplier(detail,activePoKeys)&&<section className="resolve-supplier-drawer-callout"><span><Icon name="purchaseOrder"/></span><div><h3>Raise this PO without leaving the plan</h3><p>Add or confirm the supplier and INR unit cost. StyleFlow will save the governed relationship and create an editable draft in one safe step.</p><small>This does not change the recommended PO quantity or its calculation.</small></div><button className="btn-primary" type="button" onClick={event=>openSupplierResolver(detail,event.currentTarget)}>Add supplier & raise PO<Icon name="arrowRight"/></button></section>}
      <section><h3>Inventory timing</h3><div className="inventory-timeline"><TimelinePoint label="Today" value={`${formatIndianNumber(Math.max(0,detail.currentInventory-detail.reservedQty-detail.backorderQty))} available`} state="current"/><TimelinePoint label={detail.projectedStockoutDate?formatDate(detail.projectedStockoutDate):"No stockout"} value={detail.projectedStockoutDate?"Projected stockout":"Cover remains positive"} state={detail.projectedStockoutDate?"risk":"good"}/><TimelinePoint label={formatDate(detail.expectedDeliveryDate)} value={`${formatIndianNumber(detail.suggestedPoQty)} suggested`} state="receipt"/></div></section>
      {isStyleCoverRecommendation(detail)
        ? <MethodologyMath row={detail}/>
        : <section><h3>How the quantity was calculated</h3><div className="formula-card"><Formula label={`Demand for ${detail.leadTimeDays+detail.reviewPeriodDays} protection days`} value={Math.round(detail.dailyRunRate*(detail.leadTimeDays+detail.reviewPeriodDays))} sign=""/><Formula label="Safety buffer" value={detail.safetyStock} sign="+"/><Formula label="Usable inventory position" value={detail.inventoryPosition} sign="−"/><Formula label="Raw need" value={detail.rawPoQty} sign="="/><Formula label="After supplier MOQ / pack rules" value={detail.suggestedPoQty} sign="→" highlight/></div><p className="formula-explanation">{detail.explanation}</p></section>}
      <section><h3>Commercial impact</h3><div className="drawer-metrics"><DrawerMetric label="Estimated PO cost" value={detail.estimatedValue===null?"Cost missing":formatCompactINR(detail.estimatedValue)}/><DrawerMetric label="GMV exposure" value={detail.estimatedGmvAtRisk===null?"Price missing":formatCompactINR(detail.estimatedGmvAtRisk)}/><DrawerMetric label="Stockout gap" value={`${detail.stockoutExposureDays} days`}/><DrawerMetric label="Estimated lost units" value={formatIndianNumber(detail.estimatedLostSalesUnits)}/></div>{detail.estimatedGmvAtRisk!==null&&<p className="range-note">Exposure range: {formatCompactINR(detail.estimatedGmvAtRiskLower||0)}–{formatCompactINR(detail.estimatedGmvAtRiskUpper||0)}. This is an estimate, not guaranteed lost revenue.</p>}</section>
      <section><h3>Issues to decide</h3><div className="drawer-exceptions">{detail.exceptions.length?detail.exceptions.map(exception=><div key={exception.code} className={`exception-${exception.severity}`}><Icon name={exception.severity==="critical"?"alert":"info"}/><div><strong>{friendlyException(exception.code)}</strong><p>{exception.message}</p><span>{exceptionAction(exception.code)}</span></div></div>):<div className="no-exception"><Icon name="check"/>No blocking issue was found.</div>}</div></section>
      <details className="technical-details"><summary>Forecast and data evidence</summary><div className="drawer-metrics"><DrawerMetric label="Selected model" value={detail.forecastModelLabel}/><DrawerMetric label="Historical match" value={formatPct(detail.forecastAccuracy)}/><DrawerMetric label="Typical error" value={formatPct(detail.forecastWmape)}/><DrawerMetric label="Tendency" value={formatBias(detail.forecastBias)}/><DrawerMetric label="Returns" value={formatPct(detail.returnRate)}/><DrawerMetric label="Cancellations" value={formatPct(detail.cancellationRate)}/></div><div className="evidence-note">{isStyleCoverRecommendation(detail)&&<p><strong>Evidence only:</strong> forecast diagnostics do not change the documented DRR, DOH or PO-ask calculation.</p>}<strong>{dataGrade(detail)}</strong><p>{detail.forecastQualityReasons?.join(" ") || `${detail.backtestDays} holdout days were evaluated.`}</p><p>{detail.stockoutDaysInHistory} unavailable day(s) excluded · {detail.promotionAdjustedDays} promotion day(s) normalised · {detail.dataLatencyDays} day data gap.</p></div></details>
    </div></aside></div>}

    {supplierResolution&&<div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!supplierResolveBusy)setSupplierResolution(null)}}><section ref={supplierResolutionRef} className="modal-card modal-wide supplier-resolution-modal" role="dialog" aria-modal="true" aria-labelledby="supplier-resolution-title" aria-describedby="supplier-resolution-description"><div className="modal-head"><div><p className="eyebrow">Resolve supplier and raise PO</p><h2 id="supplier-resolution-title">Create a draft for {supplierResolution.row.productName||`Style ${supplierResolution.row.styleId||supplierResolution.row.sku}`}</h2><p id="supplier-resolution-description">Confirm the supplier and INR unit cost now. You can complete dispatch details here or later on the draft.</p></div><button className="icon-button" type="button" aria-label="Close supplier and PO form" disabled={supplierResolveBusy} onClick={()=>setSupplierResolution(null)}><Icon name="close"/></button></div><form onSubmit={resolveSupplierAndCreateDraft} noValidate><div className="modal-body supplier-resolution-body">
      <div className="supplier-resolution-context"><span><Icon name="purchaseOrder"/></span><div><strong>{supplierResolution.row.brand||"Myntra"} · Style {supplierResolution.row.styleId||supplierResolution.row.sku}</strong><p>{friendlyFc(supplierResolution.row.warehouse)} · System recommendation {formatIndianNumber(supplierResolution.row.suggestedPoQty)} units</p></div><div><small>Current block</small><strong>{uiPoBlock(supplierResolution.row)?.code==="MISSING_PRICE"?"INR unit cost missing":"Supplier relationship missing"}</strong></div></div>
      <div className={`supplier-resolution-stage stage-${supplierResolutionStage}`} aria-live="polite"><span><Icon name={supplierResolutionStage==="blocked"?"alert":"check"}/></span><div><strong>{supplierResolutionStage==="blocked"?"Needs supplier details":supplierResolutionStage==="draft"?"Draft ready · dispatch details remain":"Supplier details complete"}</strong><p>{supplierResolutionStage==="blocked"?supplierResolutionIssues[0]:supplierResolutionStage==="draft"?`${supplierDispatchMissing.length} optional supplier detail${supplierDispatchMissing.length===1?"":"s"} can be completed before the PO is sent.`:"Final buyer, address and approval checks still apply on the PO before it can be sent."}</p></div></div>
      {supplierResolveError&&<StatusMessage type="error"><p>{supplierResolveError}</p><div className="supplier-resolution-error-actions">{["STALE_VENDOR_MAPPING_REVISION","LOOKUP_FAILED","SUPPLIER_MAPPING_SELECTION_REQUIRED","SUPPLIER_MAPPING_NOT_APPLICABLE","SUPPLIER_MAPPING_CONFLICT"].includes(supplierResolveCode)&&<button className="text-link" type="button" disabled={supplierLookupBusy} onClick={()=>loadSupplierCandidates(supplierResolution.row,supplierResolution.initialDraft,supplierResolution.draft.mappingId)}>{supplierLookupBusy?"Reloading…":"Reload current supplier details"}</button>}{supplierResolveCode==="RECOMMENDATION_ALREADY_CONVERTED"&&<a className="text-link" href="/purchase-orders">Open PO queue</a>}</div></StatusMessage>}
      <fieldset className="supplier-resolution-required"><legend>Required to create the draft</legend><p>A real supplier and positive INR unit cost are the commercial minimum. The draft remains editable and is not approved or sent.</p>
        {supplierLookupBusy?<div className="supplier-candidate-loading"><span/><div><strong>Checking saved supplier relationships…</strong><small>This prevents duplicate or ambiguous mappings.</small></div></div>:supplierCandidates.length>0&&<label><span className="field-label">Saved supplier relationship{supplierRequiresChoice?" *":""}</span><select className="field" value={supplierChoice} aria-invalid={supplierResolveAttempted&&supplierRequiresChoice&&!supplierChoice} onChange={event=>chooseSupplier(event.target.value)}>{supplierRequiresChoice&&<option value="">Choose the supplier for this PO…</option>}{supplierCandidates.map(candidate=><option key={candidate.id} value={candidate.id}>{candidate.vendor} · {candidate.nlc&&candidate.nlc>0?`${formatINR(candidate.nlc)} NLC`:"cost needed"}</option>)}<option value="__new__">Use a different supplier</option></select><small className="field-help">{supplierCandidates.length===1&&!supplierRequiresChoice?"One saved relationship was found and loaded. Choose “Use a different supplier” only when this PO belongs to another legal supplier.":"More than one relationship exists for this style. Choose one explicitly; StyleFlow will never guess."}</small></label>}
        {!supplierLookupBusy&&!supplierCandidates.length&&<div className="supplier-new-note"><Icon name="info"/><span><strong>{supplierHasEditableBase?"Complete the existing unmapped relationship":"No saved supplier relationship was found"}</strong><small>{supplierHasEditableBase?"The plan’s base mapping row is retained behind this form. Entering the supplier and cost will update it safely instead of creating a duplicate.":"Enter the legal supplier below. It will be saved with an audit revision when the draft is created."}</small></span></div>}
        <div className="supplier-resolution-grid">
          <ResolutionField label="Legal supplier name" value={supplierResolution.draft.vendor} required disabled={(Boolean(supplierResolution.draft.mappingId)&&supplierChoice!=="__base__")||!supplierChoice} invalid={supplierResolveAttempted&&isPlaceholderSupplier(supplierResolution.draft.vendor)} placeholder="e.g. Imagine Marketing Ltd" onChange={value=>updateSupplierDraft({vendor:value})}/>
          <ResolutionNumber label="Unit cost / NLC" value={supplierResolution.draft.nlc} required prefix="₹" min={0.01} step={0.01} invalid={supplierResolveAttempted&&!(Number(supplierResolution.draft.nlc)>0)} onChange={value=>updateSupplierDraft({nlc:value})}/>
          <ResolutionNumber label="PO quantity" value={supplierResolution.draft.quantity} required min={1} step={1} invalid={supplierResolveAttempted&&(!Number.isSafeInteger(supplierResolution.draft.quantity)||supplierResolution.draft.quantity<=0||Boolean(executionRuleIssue(supplierResolution.draft)))} onChange={value=>updateSupplierDraft({quantity:value??0})}/>
        </div>
        <div className="supplier-cost-preview"><dl><div><dt>Quantity</dt><dd>{formatIndianNumber(supplierResolution.draft.quantity||0)} units</dd></div><div><dt>Entered NLC</dt><dd>{Number(supplierResolution.draft.nlc)>0?formatINR(Number(supplierResolution.draft.nlc)):"Enter cost"}</dd></div><div><dt>Draft merchandise value</dt><dd>{supplierDraftValue===null?"—":formatINR(supplierDraftValue)}</dd></div></dl>{supplierUnitCostDelta!==null&&Math.abs(supplierUnitCostDelta)>.005&&<p className={supplierUnitCostDelta>0?"cost-delta-up":"cost-delta-down"}>The entered cost is <strong>{formatINR(Math.abs(supplierUnitCostDelta))} per unit {supplierUnitCostDelta>0?"higher":"lower"}</strong> than the plan cost. At this quantity, merchandise value changes by <strong>{formatINR(Math.abs(supplierUnitCostDelta)*supplierResolution.draft.quantity)} {supplierUnitCostDelta>0?"more":"less"}</strong>.</p>}</div>
        <div className="supplier-calculation-note"><Icon name="info"/><p><strong>The recommendation stays unchanged.</strong> Supplier details and execution rules do not alter the DRR, DOH or signed PO calculation. The draft records any quantity change separately.</p></div>
        {supplierResolution.draft.quantity!==supplierResolution.row.suggestedPoQty&&<label><span className="field-label">Why are you changing the quantity? *</span><select className="field" value={supplierResolution.draft.overrideReason} aria-invalid={supplierResolveAttempted&&!supplierResolution.draft.overrideReason.trim()} onChange={event=>updateSupplierDraft({overrideReason:event.target.value})}><option value="">Choose a reason…</option><option>Budget limit</option><option>Supplier pack adjustment</option><option>Campaign decision</option><option>Inventory transfer planned</option><option>Other planner judgement</option></select></label>}
        {(supplierReplacementNeedsConfirmation||namedSupplierChanged(supplierResolution.row,supplierResolution.draft))&&namedSupplierChanged(supplierResolution.row,supplierResolution.draft)&&<label className="supplier-confirmation"><input type="checkbox" checked={supplierResolution.draft.replaceNamedSupplier} aria-invalid={supplierResolveAttempted&&!supplierResolution.draft.replaceNamedSupplier||undefined} onChange={event=>updateSupplierDraft({replaceNamedSupplier:event.target.checked})}/><span><strong>Use {supplierResolution.draft.vendor} instead of {supplierResolution.row.vendor} for this draft.</strong><small>The source plan named a different supplier. Confirm this governed replacement; the recommendation quantity will not change.</small></span></label>}
        {hasUnresolvedCriticalRisk(supplierResolution.row)&&<label className="supplier-confirmation risk"><input type="checkbox" checked={supplierResolution.draft.acknowledgeRisk} aria-invalid={supplierResolveAttempted&&!supplierResolution.draft.acknowledgeRisk||undefined} onChange={event=>updateSupplierDraft({acknowledgeRisk:event.target.checked})}/><span><strong>I reviewed the remaining urgent planning risk.</strong><small>Creating the draft does not resolve stockout, backorder or supply timing actions.</small></span></label>}
      </fieldset>
      <details ref={supplierOptionalRef} className="supplier-resolution-optional"><summary><span><strong>Complete before sending</strong><small>Optional when blank; entered values must be valid</small></span><em>{supplierDispatchMissing.length?`${supplierDispatchMissing.length} to complete`:"Supplier details complete"}</em><Icon name="chevronRight"/></summary><div><p>These fields support tax, delivery and supplier communication. Leave them blank for the draft or enter valid values now; missing values stay visible on the draft and its send-readiness checks.</p><div className="supplier-resolution-subgroup"><h3>Order and delivery rules</h3><div className="supplier-resolution-grid supplier-resolution-grid-3"><ResolutionNumber label="Lead time" value={supplierResolution.draft.leadTimeDays} suffix="days" min={0} step={1} invalid={supplierResolveAttempted&&supplierResolution.draft.leadTimeDays!==null&&(!Number.isSafeInteger(supplierResolution.draft.leadTimeDays)||supplierResolution.draft.leadTimeDays<0)} onChange={value=>updateSupplierDraft({leadTimeDays:value})}/><ResolutionNumber label="Minimum order quantity" value={supplierResolution.draft.moq} min={1} step={1} invalid={supplierResolveAttempted&&supplierResolution.draft.moq!==null&&(!Number.isSafeInteger(supplierResolution.draft.moq)||supplierResolution.draft.moq<=0)} onChange={value=>updateSupplierDraft({moq:value})}/><ResolutionNumber label="Pack size" value={supplierResolution.draft.packSize} min={1} step={1} invalid={supplierResolveAttempted&&supplierResolution.draft.packSize!==null&&(!Number.isSafeInteger(supplierResolution.draft.packSize)||supplierResolution.draft.packSize<=0)} onChange={value=>updateSupplierDraft({packSize:value})}/></div>{executionRuleIssue(supplierResolution.draft)&&<p className="supplier-execution-warning"><Icon name="alert"/>{executionRuleIssue(supplierResolution.draft)}</p>}</div>
        <div className="supplier-resolution-subgroup"><h3>Supplier, tax and dispatch details</h3><div className="supplier-resolution-grid supplier-resolution-grid-3"><ResolutionField label="Supplier SKU" value={supplierResolution.draft.supplierSku} onChange={value=>updateSupplierDraft({supplierSku:value})}/><ResolutionField label="Supplier email" type="email" value={supplierResolution.draft.supplierEmail} invalid={supplierResolveAttempted&&Boolean(supplierResolution.draft.supplierEmail)&&!emailValid(supplierResolution.draft.supplierEmail)} placeholder="orders@supplier.com" onChange={value=>updateSupplierDraft({supplierEmail:value})}/><ResolutionField label="HSN code" value={supplierResolution.draft.hsnCode} inputMode="numeric" maxLength={8} invalid={supplierResolveAttempted&&Boolean(supplierResolution.draft.hsnCode)&&!/^\d{4,8}$/.test(supplierResolution.draft.hsnCode)} onChange={value=>updateSupplierDraft({hsnCode:value.replace(/\D/g,"").slice(0,8)})}/><ResolutionNumber label="GST rate" value={supplierResolution.draft.gstRate} suffix="%" min={0} max={100} step={0.01} invalid={supplierResolveAttempted&&supplierResolution.draft.gstRate!==null&&(supplierResolution.draft.gstRate<0||supplierResolution.draft.gstRate>100)} onChange={value=>updateSupplierDraft({gstRate:value})}/><ResolutionField label="Supplier GSTIN" value={supplierResolution.draft.supplierGstin} maxLength={15} invalid={supplierResolveAttempted&&Boolean(supplierResolution.draft.supplierGstin)&&!gstinValid(supplierResolution.draft.supplierGstin)} onChange={value=>updateSupplierDraft({supplierGstin:value.toUpperCase()})}/><ResolutionField label="Supplier state" value={supplierResolution.draft.supplierState} placeholder="e.g. Karnataka" onChange={value=>updateSupplierDraft({supplierState:value})}/><ResolutionField label="Payment terms" value={supplierResolution.draft.paymentTerms} placeholder="e.g. Net 30 days" onChange={value=>updateSupplierDraft({paymentTerms:value})}/><ResolutionField label="Incoterms" value={supplierResolution.draft.incoterms} placeholder="e.g. DAP" onChange={value=>updateSupplierDraft({incoterms:value.toUpperCase()})}/></div></div></div></details>
    </div><div className="modal-footer supplier-resolution-footer"><span>Creates one editable draft PO. Nothing is approved or emailed.</span><div><button className="btn-secondary" type="button" disabled={supplierResolveBusy} onClick={()=>setSupplierResolution(null)}>Cancel</button><button className="btn-primary" type="submit" disabled={supplierResolveBusy||supplierLookupBusy||!supplierCanEdit||supplierResolveCode==="LOOKUP_FAILED"}>{supplierResolveBusy?"Saving and creating…":"Save supplier & create draft PO"}<Icon name="arrowRight"/></button></div></div></form></section></div>}

    {preview && <div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setPreview(false)}}><section ref={previewRef} className="modal-card modal-wide po-preview-modal" role="dialog" aria-modal="true" aria-labelledby="po-preview-title"><div className="modal-head po-preview-head"><div className="preview-title-brand"><span aria-hidden="true"><img src="/brand/myntra-mark.png" alt=""/></span><div><p className="eyebrow">StyleFlow · Final check</p><h2 id="po-preview-title">Create {groups.length} draft purchase order{groups.length===1?"":"s"}?</h2><p>Grouped by supplier and fulfilment centre. Drafts are saved only—nothing is approved or sent.</p></div></div><button className="icon-button" aria-label="Close PO preview" onClick={()=>setPreview(false)}><Icon name="close"/></button></div><div className="modal-body">
      <div className="preview-total"><div><span>Selected merchandise value</span><strong>{formatCompactINR(selectedValue)}</strong><small>{formatIndianNumber(selectedUnits)} units · before GST</small></div><div><span>Draft POs</span><strong>{groups.length}</strong><small>{chosen.length} recommendation lines</small></div><div><span>Needs acknowledgement</span><strong>{risky.length}</strong><small>urgent line{risky.length===1?"":"s"}</small></div></div>
      <div className="preview-groups">{groups.map(group=><article key={group.key}><div><span className="preview-supplier-icon"><Icon name="purchaseOrder"/></span><div><h3>{group.vendor}</h3><p>{friendlyFc(group.warehouse)}</p></div><strong>{formatCompactINR(group.value)}</strong></div><dl><div><dt>Lines</dt><dd>{group.lines}</dd></div><div><dt>Units</dt><dd>{formatIndianNumber(group.units)}</dd></div><div><dt>Urgent</dt><dd>{group.risky}</dd></div></dl></article>)}</div>
      {missingReasons.length>0&&<StatusMessage type="error">Add an override reason to {missingReasons.length} changed line{missingReasons.length===1?"":"s"} before creating drafts.</StatusMessage>}
      {invalidQuantities.length>0&&<StatusMessage type="error">Enter a positive whole-unit quantity for every selected line.</StatusMessage>}
      {risky.length>0&&<label className="risk-acknowledgement"><input type="checkbox" checked={riskAcknowledged} onChange={event=>setRiskAcknowledged(event.target.checked)}/><span><strong>I reviewed the {risky.length} urgent line{risky.length===1?"":"s"} included in these drafts.</strong><small>Creating a draft does not resolve the stockout gap; transfer or expedite actions may still be needed.</small></span></label>}
      <InfoNote title="What this action does"><p>Saves editable PO drafts with quantities and INR costs. It does not approve them, email suppliers, reserve budget or update inventory.</p></InfoNote>
    </div><div className="modal-footer"><button className="btn-secondary" onClick={()=>setPreview(false)}>Keep reviewing</button><button className="btn-primary" disabled={busy||invalidQuantities.length>0||missingReasons.length>0||(risky.length>0&&!riskAcknowledged)} onClick={createDrafts}>{busy?"Creating drafts…":`Create ${groups.length} draft PO${groups.length===1?"":"s"}`}<Icon name="arrowRight"/></button></div></section></div>}
  </div>;
}

function canResolveSupplier(row: Rec, active: Set<string>) {
  if (row.suggestedPoQty <= 0 || active.has(activeRecommendationKey(row))) return false;
  return Boolean(supplierResolutionBlockReason(row, row.supplierMasterMapped !== false));
}

function recommendationIdentity(row: Rec) {
  return `${row.warehouse}::::${row.vendor}::::${row.sku}`;
}

function activeRecommendationKey(row: Pick<Rec,"warehouse"|"sku">) {
  return `${row.warehouse}::::${row.sku}`;
}

function supplierDraftFromRow(row: Rec, vendorMaster: VendorMasterRow[], quantity: number, overrideReason: string): SupplierResolutionDraft {
  const currentVendor = isPlaceholderSupplier(row.vendor) ? "" : row.vendor.trim();
  const styleId = String(row.styleId || row.sku).trim();
  const rules = currentVendor ? vendorMaster.filter(rule => {
    if (rule.vendor.trim().toLocaleLowerCase("en-IN") !== currentVendor.toLocaleLowerCase("en-IN")) return false;
    const productMatches = (!rule.sku && !rule.styleId) || rule.sku === row.sku || rule.sku === styleId || rule.styleId === styleId;
    return productMatches && (!rule.warehouse || rule.warehouse === row.warehouse);
  }).sort((left, right) => Number(Boolean(left.sku || left.styleId)) + Number(Boolean(left.warehouse)) - Number(Boolean(right.sku || right.styleId)) - Number(Boolean(right.warehouse))) : [];
  const rule = Object.assign({} as VendorMasterRow, ...rules);
  const rowNlc = positiveNumber(row.unitPrice);
  const ruleNlc = positiveNumber(rule.unitPrice);
  return {
    mappingId: null,
    expectedRevision: null,
    vendor: currentVendor,
    supplierSku: String(row.supplierSku || rule.supplierSku || "").trim(),
    supplierEmail: String(rule.contactEmail || "").trim(),
    nlc: rowNlc ?? ruleNlc,
    hsnCode: String(rule.hsnCode || "").trim(),
    gstRate: nullableNumber(rule.gstRate),
    supplierGstin: String(rule.gstin || "").trim().toUpperCase(),
    supplierState: String(rule.supplierState || "").trim(),
    leadTimeDays: nullableNumber(rule.leadTimeDays),
    paymentTerms: String(rule.paymentTerms || "").trim(),
    incoterms: String(rule.incoterms || "").trim().toUpperCase(),
    moq: nullableNumber(rule.moq),
    packSize: nullableNumber(rule.packSize),
    quantity: Number.isSafeInteger(quantity) && quantity > 0 ? quantity : row.suggestedPoQty,
    overrideReason,
    acknowledgeRisk: false,
    replaceNamedSupplier: false,
    createNew: false,
  };
}

function normalizeSupplierCandidate(raw: any): SupplierCandidate {
  return {
    id: String(raw.id ?? raw.mappingId ?? ""),
    styleId: String(raw.styleId ?? raw.style_id ?? "").trim(),
    vendor: String(raw.vendor ?? raw.vendorName ?? "").trim(),
    supplierSku: String(raw.supplierSku ?? raw.supplier_sku ?? "").trim(),
    supplierEmail: String(raw.supplierEmail ?? raw.contactEmail ?? raw.supplier_email ?? "").trim(),
    nlc: nullableNumber(raw.nlc ?? raw.nlcInr ?? raw.unitCostInr),
    hsnCode: String(raw.hsnCode ?? raw.hsn_code ?? "").trim(),
    gstRate: nullableNumber(raw.gstRate ?? raw.gst_rate),
    supplierGstin: String(raw.supplierGstin ?? raw.supplier_gstin ?? raw.gstin ?? "").trim().toUpperCase(),
    supplierState: String(raw.supplierState ?? raw.supplier_state ?? "").trim(),
    leadTimeDays: nullableNumber(raw.leadTimeDays ?? raw.lead_time_days),
    paymentTerms: String(raw.paymentTerms ?? raw.payment_terms ?? "").trim(),
    incoterms: String(raw.incoterms ?? "").trim().toUpperCase(),
    moq: nullableNumber(raw.moq),
    packSize: nullableNumber(raw.packSize ?? raw.pack_size),
    revision: nullableNumber(raw.revision),
  };
}

function draftFromCandidate(candidate: SupplierCandidate, initial: SupplierResolutionDraft): SupplierResolutionDraft {
  return {
    ...initial,
    mappingId: candidate.id,
    expectedRevision: candidate.revision,
    vendor: candidate.vendor,
    supplierSku: candidate.supplierSku,
    supplierEmail: candidate.supplierEmail,
    nlc: candidate.nlc,
    hsnCode: candidate.hsnCode,
    gstRate: candidate.gstRate,
    supplierGstin: candidate.supplierGstin,
    supplierState: candidate.supplierState,
    leadTimeDays: candidate.leadTimeDays,
    paymentTerms: candidate.paymentTerms,
    incoterms: candidate.incoterms,
    moq: candidate.moq,
    packSize: candidate.packSize,
    replaceNamedSupplier: false,
    createNew: false,
  };
}

function blankSupplierChoice(initial: SupplierResolutionDraft): SupplierResolutionDraft {
  return {
    ...initial,
    mappingId: null,
    expectedRevision: null,
    vendor: "",
    supplierSku: "",
    supplierEmail: "",
    nlc: null,
    hsnCode: "",
    gstRate: null,
    supplierGstin: "",
    supplierState: "",
    leadTimeDays: null,
    paymentTerms: "",
    incoterms: "",
    moq: null,
    packSize: null,
    replaceNamedSupplier: false,
    createNew: false,
  };
}

function supplierDraftErrors(row: Rec, draft: SupplierResolutionDraft, supplierChoiceRequired: boolean) {
  const errors: string[] = [];
  if (supplierChoiceRequired) errors.push("Choose the supplier relationship for this PO, or choose Use a different supplier.");
  if (isPlaceholderSupplier(draft.vendor)) errors.push("Enter the legal supplier name.");
  if (!(Number(draft.nlc) > 0) || Number(draft.nlc) > 1_000_000_000) errors.push("Enter a positive INR unit cost / NLC within the allowed range.");
  if (!Number.isSafeInteger(draft.quantity) || draft.quantity <= 0 || draft.quantity > 1_000_000_000) errors.push("Enter a positive whole-unit PO quantity within the allowed range.");
  if (draft.mappingId && (!Number.isSafeInteger(draft.expectedRevision) || Number(draft.expectedRevision) < 1)) errors.push("Reload this saved supplier relationship before using it.");
  if (draft.supplierEmail && !emailValid(draft.supplierEmail)) errors.push("Enter a valid supplier email or leave it blank for now.");
  if (draft.hsnCode && !/^\d{4,8}$/.test(draft.hsnCode)) errors.push("HSN must contain 4–8 digits or be left blank for now.");
  if (draft.gstRate !== null && (!Number.isFinite(draft.gstRate) || draft.gstRate < 0 || draft.gstRate > 100)) errors.push("GST rate must be between 0 and 100.");
  if (draft.supplierGstin && !gstinValid(draft.supplierGstin)) errors.push("Enter a valid 15-character Indian supplier GSTIN or leave it blank for now.");
  if (draft.leadTimeDays !== null && (!Number.isSafeInteger(draft.leadTimeDays) || draft.leadTimeDays < 0)) errors.push("Lead time must be a whole number of zero days or more.");
  if (draft.moq !== null && (!Number.isSafeInteger(draft.moq) || draft.moq <= 0)) errors.push("MOQ must be a positive whole number or left blank.");
  if (draft.packSize !== null && (!Number.isSafeInteger(draft.packSize) || draft.packSize <= 0)) errors.push("Pack size must be a positive whole number or left blank.");
  const executionIssue = executionRuleIssue(draft);
  if (executionIssue) errors.push(executionIssue);
  if (draft.quantity !== row.suggestedPoQty && !draft.overrideReason.trim()) errors.push("Choose a reason for changing the system-recommended quantity.");
  if (namedSupplierChanged(row, draft) && !draft.replaceNamedSupplier) errors.push(`Confirm that ${draft.vendor} should replace ${row.vendor} for this draft.`);
  if (hasUnresolvedCriticalRisk(row) && !draft.acknowledgeRisk) errors.push("Review and acknowledge the remaining urgent planning risk.");
  return errors;
}

function executionRuleIssue(draft: SupplierResolutionDraft) {
  if (Number.isSafeInteger(draft.moq) && Number(draft.moq) > 0 && draft.quantity < Number(draft.moq)) return `PO quantity must be at least the supplier MOQ of ${formatIndianNumber(Number(draft.moq))} units.`;
  if (Number.isSafeInteger(draft.packSize) && Number(draft.packSize) > 0 && draft.quantity % Number(draft.packSize) !== 0) return `PO quantity must be a multiple of the supplier pack size of ${formatIndianNumber(Number(draft.packSize))} units.`;
  return "";
}

function hasInvalidEnteredSupplierDetails(draft: SupplierResolutionDraft) {
  return Boolean(
    (draft.supplierEmail && !emailValid(draft.supplierEmail)) ||
    (draft.hsnCode && !/^\d{4,8}$/.test(draft.hsnCode)) ||
    (draft.gstRate !== null && (!Number.isFinite(draft.gstRate) || draft.gstRate < 0 || draft.gstRate > 100)) ||
    (draft.supplierGstin && !gstinValid(draft.supplierGstin)) ||
    (draft.leadTimeDays !== null && (!Number.isSafeInteger(draft.leadTimeDays) || draft.leadTimeDays < 0)) ||
    (draft.moq !== null && (!Number.isSafeInteger(draft.moq) || draft.moq <= 0)) ||
    (draft.packSize !== null && (!Number.isSafeInteger(draft.packSize) || draft.packSize <= 0)) ||
    executionRuleIssue(draft)
  );
}

function dispatchDetailGaps(draft: SupplierResolutionDraft) {
  const missing: string[] = [];
  if (!draft.supplierSku) missing.push("supplier SKU");
  if (!emailValid(draft.supplierEmail)) missing.push("supplier email");
  if (!/^\d{4,8}$/.test(draft.hsnCode)) missing.push("HSN code");
  if (draft.gstRate === null || draft.gstRate < 0 || draft.gstRate > 100) missing.push("GST rate");
  if (!gstinValid(draft.supplierGstin)) missing.push("supplier GSTIN");
  if (!draft.supplierState) missing.push("supplier state");
  if (draft.leadTimeDays === null) missing.push("lead time");
  if (draft.moq === null) missing.push("MOQ");
  if (draft.packSize === null) missing.push("pack size");
  if (!draft.paymentTerms) missing.push("payment terms");
  if (!draft.incoterms) missing.push("Incoterms");
  return missing;
}

function compactSupplierMapping(draft: SupplierResolutionDraft) {
  const payload: Record<string, unknown> = { vendor: draft.vendor.trim(), nlc: draft.nlc };
  if (draft.mappingId) payload.mappingId = draft.mappingId;
  if (draft.expectedRevision !== null) payload.expectedRevision = draft.expectedRevision;
  if (draft.createNew) payload.createNew = true;
  const textFields = [
    ["supplierSku", draft.supplierSku], ["supplierEmail", draft.supplierEmail], ["hsnCode", draft.hsnCode],
    ["supplierGstin", draft.supplierGstin], ["supplierState", draft.supplierState], ["paymentTerms", draft.paymentTerms], ["incoterms", draft.incoterms],
  ] as const;
  for (const [name, value] of textFields) if (value.trim()) payload[name] = value.trim();
  const numberFields = [
    ["gstRate", draft.gstRate], ["leadTimeDays", draft.leadTimeDays], ["moq", draft.moq], ["packSize", draft.packSize],
  ] as const;
  for (const [name, value] of numberFields) if (value !== null) payload[name] = value;
  return payload;
}

function namedSupplierChanged(row: Rec, draft: SupplierResolutionDraft) {
  return !isPlaceholderSupplier(row.vendor) && Boolean(draft.vendor.trim()) && row.vendor.trim().toLocaleLowerCase("en-IN") !== draft.vendor.trim().toLocaleLowerCase("en-IN");
}

function hasUnresolvedCriticalRisk(row: Rec) {
  return row.exceptions.some(exception => exception.severity === "critical" && !["MISSING_VENDOR", "MISSING_PRICE"].includes(exception.code));
}

function emailValid(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function gstinValid(value: string) {
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[A-Z0-9]$/.test(value.trim().toUpperCase());
}

function positiveNumber(value: unknown) {
  const number = nullableNumber(value);
  return number !== null && number > 0 ? number : null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function ResolutionField({ label, value, onChange, disabled, required, invalid, type = "text", placeholder, inputMode, maxLength }: { label: string; value: string; onChange: (value: string) => void; disabled?: boolean; required?: boolean; invalid?: boolean; type?: string; placeholder?: string; inputMode?: "numeric"; maxLength?: number }) {
  return <label><span className="field-label">{label}{required ? " *" : ""}</span><input className="field" type={type} value={value} disabled={disabled} required={required} aria-invalid={invalid||undefined} placeholder={placeholder} inputMode={inputMode} maxLength={maxLength} onChange={event=>onChange(event.target.value)}/></label>;
}

function ResolutionNumber({ label, value, onChange, required, invalid, prefix, suffix, min, max, step }: { label: string; value: number | null; onChange: (value: number | null) => void; required?: boolean; invalid?: boolean; prefix?: string; suffix?: string; min?: number; max?: number; step?: number }) {
  return <label><span className="field-label">{label}{required ? " *" : ""}</span><div className={`mapping-number-field ${prefix?"has-prefix":""}`}><input className="field" type="number" value={value??""} required={required} aria-invalid={invalid||undefined} min={min} max={max} step={step} onChange={event=>onChange(event.target.value===""?null:Number(event.target.value))}/>{prefix&&<span className="mapping-number-prefix">{prefix}</span>}{suffix&&<span className="mapping-number-suffix">{suffix}</span>}</div></label>;
}

function buyingStatus(row: Rec, active: Set<string>) {
  const rowKey=activeRecommendationKey(row);
  if (active.has(rowKey)) return { view:"review" as View,tone:"blocked",label:"Already ordered",action:"Open the live PO before ordering more",reason:"A live PO contains this recommendation key." };
  const audit=styleCoverAudit(row);
  if(audit&&!audit.eligible) return {view:"no_order" as View,tone:"ready",label:"Outside DOH gate",action:"No PO under the current policy",reason:`DOH is ${audit.daysOnHand===null?"not available":`${formatAuditNumber(audit.daysOnHand)} days`}; it must be below ${formatAuditNumber(audit.dohThreshold)} days.`};
  if(audit&&audit.actionablePoQty<=0) return {view:"no_order" as View,tone:"ready",label:"Stock covers target",action:"No order required",reason:`The signed ask is ${formatIndianNumber(audit.signedPoQtyAsk)}; negative asks become 0 actionable units.`};
  if (row.suggestedPoQty<=0) return { view:"no_order" as View,tone:"ready",label:"No order needed",action:row.excessInventoryUnits>0?"Hold buying and review excess":"Keep monitoring",reason:row.excessInventoryUnits>0?`${formatIndianNumber(row.excessInventoryUnits)} units above target.`:"Current and inbound stock cover the need." };
  const poBlock=uiPoBlock(row);
  if(poBlock) return {view:"review" as View,tone:"blocked",label:poBlock.code==="MISSING_VENDOR"?"Map supplier":poBlock.code==="MISSING_STYLE_METADATA"?"Complete style master":poBlock.code==="MISSING_PRICE"?"Add missing cost":"Correct source data",action:primaryAction(row,poBlock.code),reason:poBlock.message};
  if (hasCritical(row)) return { view:"review" as View,tone:"blocked",label:"Resolve urgent risk",action:primaryAction(row),reason:primaryReason(row) };
  if(audit) return {view:"ready" as View,tone:"ready",label:"Ready to order",action:`Order ${formatIndianNumber(row.suggestedPoQty)} units`,reason:`DRR ${formatAuditNumber(audit.dailyRunRate)} × ${audit.coverDays} days − ${formatIndianNumber(audit.currentInventory)} stock − ${formatIndianNumber(audit.openPoQuantity)} open PO.`};
  if (row.forecastQuality==="low"||(row.forecastAccuracy!==null&&row.forecastAccuracy<70)) return { view:"review" as View,tone:"review",label:"Review forecast",action:"Validate demand before ordering",reason:`Historical match is ${formatPct(row.forecastAccuracy)}.` };
  return { view:"ready" as View,tone:"ready",label:"Ready to order",action:`Order ${formatIndianNumber(row.suggestedPoQty)} units`,reason:`Protects ${row.leadTimeDays+row.reviewPeriodDays} days after stock and confirmed inbound.` };
}
function canSelect(row:Rec,active:Set<string>){return row.suggestedPoQty>0&&!uiPoBlock(row)&&!active.has(activeRecommendationKey(row))}
function isSafe(row:Rec,active:Set<string>){if(isStyleCoverRecommendation(row))return canSelect(row,active)&&!hasCritical(row);return canSelect(row,active)&&!hasCritical(row)&&row.forecastQuality==="high"&&(row.forecastAccuracy===null||row.forecastAccuracy>=70)}
function hasCritical(row:Rec){return row.exceptions.some(exception=>exception.severity==="critical")}
function uiPoBlock(row:Rec){return supplierResolutionBlockReason(row,row.supplierMasterMapped!==false)??purchaseOrderBlockReason(row)??(row.supplierMasterMapped===false?{code:"MISSING_VENDOR",severity:"critical" as const,message:`Supplier ${row.vendor} is not mapped to this style in the saved supplier master.`}:null)}
function primaryAction(row:Rec,overrideCode?:string){const code=overrideCode||row.exceptions.find(exception=>exception.severity==="critical")?.code;return ({STOCKOUT_BEFORE_RECEIPT:"Arrange a transfer or expedite, then review the buy",BACKORDERS:"Protect allocation and confirm urgent supply",OVERDUE_SUPPLY:"Escalate the overdue supplier receipt",LIFECYCLE_BLOCK:"Do not replenish this lifecycle",MISSING_VENDOR:"Assign a real supplier to this style",MISSING_STYLE_METADATA:"Add model, MRP and NLC to the style master",MISSING_PRICE:"Add a valid INR NLC or unit cost",INVALID_NEGATIVE_SALES:"Correct the negative sell-out quantity",INVALID_NEGATIVE_INVENTORY:"Correct or classify the negative inventory",INVALID_NEGATIVE_OPEN_PO:"Correct the reversed pending-PO quantity"} as Record<string,string>)[code||""]||"Review the critical issue before buying"}
function primaryReason(row:Rec){const exception=row.exceptions.find(item=>item.severity==="critical");return exception?.message||"This line has a blocking planning exception."}
function unique(values:(string|undefined)[]){return [...new Set(values.filter((value):value is string=>Boolean(value)))].sort()}
function sortRows(a:Rec,b:Rec,sort:string,active:Set<string>){if(sort==="value")return Number(b.estimatedValue||0)-Number(a.estimatedValue||0);if(sort==="cover")return Number(a.daysOnHand??Infinity)-Number(b.daysOnHand??Infinity);if(sort==="accuracy")return Number(a.forecastAccuracy??-1)-Number(b.forecastAccuracy??-1);const rank=(row:Rec)=>active.has(activeRecommendationKey(row))?2:hasCritical(row)?4:buyingStatus(row,active).view==="review"?3:row.suggestedPoQty>0?1:0;return rank(b)-rank(a)||Number(b.estimatedGmvAtRisk||b.estimatedValue||0)-Number(a.estimatedGmvAtRisk||a.estimatedValue||0)}
function summarize(rows:Rec[]){const actual=rows.reduce((sum,row)=>sum+row.backtestActualUnits,0);const error=rows.reduce((sum,row)=>sum+row.backtestAbsoluteErrorUnits,0);const critical=rows.filter(hasCritical);return{value:rows.reduce((sum,row)=>sum+Number(row.estimatedValue||0),0),units:rows.reduce((sum,row)=>sum+row.suggestedPoQty,0),critical:critical.length,riskStyles:new Set(critical.map(row=>row.styleId||row.sku)).size,gmvRisk:critical.reduce((sum,row)=>sum+Number(row.estimatedGmvAtRisk||0),0),ready:rows.filter(row=>row.suggestedPoQty>0&&row.unitPrice!==null&&!hasCritical(row)&&row.forecastQuality==="high"&&(row.forecastAccuracy===null||row.forecastAccuracy>=70)).length,accuracy:actual?Math.max(0,100-error/actual*100):null}}
function summarizeStyleCover(rows:Rec[]){const methodRows=rows.filter(isStyleCoverRecommendation);const actionable=methodRows.filter(row=>row.dohEligible===true&&Number(row.signedPoQtyAsk??0)>0);return{eligible:methodRows.filter(row=>row.dohEligible===true).length,actionable:actionable.length,blocked:actionable.filter(row=>Boolean(uiPoBlock(row))).length,uniqueDays:Math.max(0,...methodRows.map(row=>Number(row.uniqueOrderDays??0))),threshold:Number(methodRows[0]?.dohThreshold??80)}}
function groupSelections(rows:Rec[],qty:Record<string,number>,key:(row:Rec)=>string){const map=new Map<string,{key:string;vendor:string;warehouse:string;lines:number;units:number;value:number;risky:number}>();for(const row of rows){const groupKey=`${row.vendor}::::${row.warehouse}`;const item=map.get(groupKey)||{key:groupKey,vendor:row.vendor,warehouse:row.warehouse,lines:0,units:0,value:0,risky:0};item.lines++;item.units+=qty[key(row)]||0;item.value+=(qty[key(row)]||0)*(row.unitPrice||0);if(hasCritical(row))item.risky++;map.set(groupKey,item)}return[...map.values()]}
function friendlyFc(value:string){return({BLR_FC:"Bengaluru FC",DEL_FC:"Delhi FC",MUM_FC:"Mumbai FC",KOL_FC:"Kolkata FC"}as Record<string,string>)[value]||value.replaceAll("_"," ")}
function friendlyException(code:string){return({STOCKOUT_BEFORE_RECEIPT:"Stockout before normal supply",BACKORDERS:"Customer units already waiting",LOW_FORECAST_ACCURACY:"Low historical forecast match",HIGH_RETURNS:"High return rate",LATE_SUPPLY:"Supply arrives after the need date",OVERDUE_SUPPLY:"Supplier receipt is overdue",MISSING_PRICE:"INR NLC or unit cost missing",MISSING_VENDOR:"Supplier mapping missing",MISSING_STYLE_METADATA:"Style master incomplete",MISSING_INVENTORY:"Inventory row missing",INVALID_NEGATIVE_SALES:"Negative sell-out quantity",INVALID_NEGATIVE_INVENTORY:"Negative current inventory",INVALID_NEGATIVE_OPEN_PO:"Negative pending PO quantity",ZERO_DRR:"No daily run rate",ABOVE_DOH_THRESHOLD:"Outside the DOH eligibility gate",SUPPLY_COVERS_TARGET:"Current and inbound stock cover the target",MOQ_OVERSTOCK:"Supplier minimum creates extra stock",LOW_DATA_QUALITY:"Limited demand evidence",EXCESS_INVENTORY:"Stock is above target",LIFECYCLE_BLOCK:"Lifecycle blocks replenishment",END_OF_LIFE:"End-of-life article"}as Record<string,string>)[code]||code.replaceAll("_"," ").toLowerCase()}
function exceptionAction(code:string){return({STOCKOUT_BEFORE_RECEIPT:"Decide on transfer or expedited delivery for the gap.",BACKORDERS:"Prioritise customer allocation and supplier follow-up.",LOW_FORECAST_ACCURACY:"Use this as supporting evidence; it does not change the documented PO formula.",HIGH_RETURNS:"Check fit, quality and restock assumptions.",LATE_SUPPLY:"Confirm a faster ETA or replacement supply.",OVERDUE_SUPPLY:"Escalate the supplier and exclude uncertain supply.",MISSING_PRICE:"Add a valid INR NLC or supplier unit cost.",MISSING_VENDOR:"Assign a real supplier in the supplier master; this line cannot be selected yet.",MISSING_STYLE_METADATA:"Add model, MRP and NLC to the style master; this line cannot be selected yet.",MISSING_INVENTORY:"Confirm whether zero inventory is correct before acting.",INVALID_NEGATIVE_SALES:"Correct the sell-out source before creating a PO.",INVALID_NEGATIVE_INVENTORY:"Correct the inventory source or classify backorders separately before creating a PO.",INVALID_NEGATIVE_OPEN_PO:"Correct cancelled or reversed PO lines before creating a new PO.",ZERO_DRR:"No PO is created because DRR and DOH are not available.",ABOVE_DOH_THRESHOLD:"No PO is created because DOH must be strictly below the configured gate.",SUPPLY_COVERS_TARGET:"Keep the signed result for audit; actionable PO quantity stays at zero.",MOQ_OVERSTOCK:"Confirm the excess is commercially acceptable.",LOW_DATA_QUALITY:"Validate sales and availability history.",EXCESS_INVENTORY:"Pause buying or plan redistribution/markdown.",LIFECYCLE_BLOCK:"Keep replenishment suppressed unless lifecycle is corrected.",END_OF_LIFE:"Avoid new buying and clear residual stock."}as Record<string,string>)[code]||"Record a planner decision before proceeding."}
function dataGrade(row:Rec){return row.forecastQuality==="high"?`Data grade A · ${row.forecastConfidenceScore}/100`:row.forecastQuality==="medium"?`Data grade B · ${row.forecastConfidenceScore}/100`:`Data grade C · ${row.forecastConfidenceScore}/100`}
function RecommendationCallout({row}:{row:Rec}){const state=buyingStatus(row,new Set());const audit=styleCoverAudit(row);return<section className={`recommendation-callout callout-${state.tone}`}><span><Icon name={state.tone==="ready"?"check":"alert"}/></span><div><p>Recommended action</p><h3>{state.action}</h3><div>{audit?<>DOH is <strong>{audit.daysOnHand===null?"not available":`${formatAuditNumber(audit.daysOnHand)} days`}</strong> against a strict <strong>{formatAuditNumber(audit.dohThreshold)}-day</strong> gate. The signed ask is <strong>{formatIndianNumber(audit.signedPoQtyAsk)} units</strong>; the actionable quantity is <strong>{formatIndianNumber(audit.actionablePoQty)} units</strong>.</>:row.projectedStockoutDate?<>Stock may run out on <strong>{formatDate(row.projectedStockoutDate)}</strong>; normal receipt is <strong>{formatDate(row.expectedDeliveryDate)}</strong>.</>:<>Stock remains covered through the current planning window.</>}</div></div></section>}
function CatalogueSnapshot({row}:{row:Rec}){
  const productUrl=safeMyntraUrl(row.sourceUrl);
  if(isStyleCoverRecommendation(row)){
    const block=uiPoBlock(row);
    return <section aria-labelledby="style-master-snapshot-title">
      <h3 id="style-master-snapshot-title">Style and supplier master</h3>
      <div className="drawer-metrics">
        <DrawerMetric label="Style ID" value={row.styleId||row.sku}/>
        <DrawerMetric label="Model / product" value={row.productName||"Missing from style master"}/>
        <DrawerMetric label="MRP" value={row.mrpInr===null||row.mrpInr===undefined?"Missing from style master":formatINR(row.mrpInr)}/>
        <DrawerMetric label="NLC / PO unit cost" value={row.unitPrice===null?"Missing from style master":formatINR(row.unitPrice)}/>
        <DrawerMetric label="Mapped supplier" value={row.exceptions.some(exception=>exception.code==="MISSING_VENDOR")?"Not mapped":row.vendor}/>
        <DrawerMetric label="PO readiness" value={block?"Blocked · complete master data":"Master data ready"}/>
      </div>
      <InfoNote title={block?"Why this line is blocked":"Why these fields matter"} tone={block?"warning":"neutral"}><p>{block?block.message:"Model, MRP, NLC and a real supplier mapping make the quantity commercially usable and auditable. Forecast accuracy is supporting evidence only."}</p></InfoNote>
    </section>;
  }
  return <section aria-labelledby="myntra-catalogue-snapshot-title">
    <h3 id="myntra-catalogue-snapshot-title">Myntra catalogue snapshot</h3>
    <div className="drawer-metrics">
      <DrawerMetric label="Style ID" value={row.styleId||"Not supplied"}/>
      <DrawerMetric label="MRP" value={row.mrpInr===null||row.mrpInr===undefined?"Not captured":formatINR(row.mrpInr)}/>
      <DrawerMetric label="Public product name" value={row.productName||"Not supplied"}/>
      <DrawerMetric label="Observed selling price" value={row.sellingPriceInr===null||row.sellingPriceInr===undefined?"Not captured":formatINR(row.sellingPriceInr)}/>
      <DrawerMetric label="Marketplace seller on listing" value={row.marketplaceSeller||"Not captured"}/>
      <DrawerMetric label="Price observed on" value={row.priceCapturedOn?formatDate(row.priceCapturedOn):"Not captured"}/>
    </div>
    {productUrl&&<p className="range-note"><a className="btn-secondary" href={productUrl} target="_blank" rel="noopener noreferrer" aria-label="Open the official Myntra product page in a new tab">Open product on Myntra <Icon name="arrowRight"/></a></p>}
    <InfoNote title="Public facts versus demo planning data" tone="neutral"><p><strong>Public listing snapshot:</strong> style ID, product name, MRP, observed selling price and marketplace seller. The observed selling price is a customer-facing catalogue price—not the PO unit cost.</p><p><strong>Synthetic demo inputs:</strong> inventory, demand, procurement cost, supplier terms, lead times, forecasts and every PO relationship. Where this demo reuses a seller name as a planning supplier, that relationship is synthetic and does not confirm a real contract.</p></InfoNote>
  </section>;
}
function safeMyntraUrl(value:string|null|undefined){
  if(!value)return null;
  try{const url=new URL(value);const host=url.hostname.toLowerCase();if(url.protocol!=="https:"||url.username||url.password||(host!=="myntra.com"&&!host.endsWith(".myntra.com")))return null;return url.toString()}catch{return null}
}
function TimelinePoint({label,value,state}:{label:string;value:string;state:string}){return<div className={`timeline-point point-${state}`}><span/><div><strong>{label}</strong><small>{value}</small></div></div>}
function MethodologyMath({row}:{row:Rec}){
  const audit=styleCoverAudit(row);
  if(!audit)return null;
  const gatePass=audit.eligible;
  return <section><h3>Documented DRR and PO calculation</h3>
    <div className={`methodology-gate ${gatePass?"gate-pass":"gate-stop"}`}>
      <span><Icon name={gatePass?"check":"alert"}/></span>
      <div><small>Step 1 · DOH eligibility gate</small><strong>DOH = inventory ÷ DRR = {audit.daysOnHand===null?"not available":`${formatAuditNumber(audit.daysOnHand)} days`}</strong><p>{gatePass?`${formatAuditNumber(audit.daysOnHand??0)} is below ${formatAuditNumber(audit.dohThreshold)}, so this style enters PO calculation.`:`The rule is strictly below ${formatAuditNumber(audit.dohThreshold)} days. This style is excluded from ordering.`}</p></div>
    </div>
    <h3 className="methodology-step-title">Step 2 · Signed PO ask</h3>
    <div className="formula-card methodology-formula-card">
      <Formula label="Total units sold in the selected period" value={audit.totalSalesUnits} sign=""/>
      <Formula label="Unique selling dates across the selected period" value={audit.uniqueOrderDays} sign="÷"/>
      <Formula label="Daily run rate (DRR)" value={`${formatAuditNumber(audit.dailyRunRate,4)} units/day`} sign="="/>
      <Formula label="PO cover target" value={`${formatIndianNumber(audit.coverDays)} days`} sign="×"/>
      <Formula label="Target stock (DRR × cover days)" value={formatAuditNumber(audit.targetStockUnits)} sign="="/>
      <Formula label="Current inventory" value={audit.currentInventory} sign="−"/>
      <Formula label="Open PO quantity" value={audit.openPoQuantity} sign="−"/>
      <Formula label="Signed PO ask (Excel ROUND, halves away from zero)" value={audit.signedPoQtyAsk} sign="="/>
      <Formula label="Actionable PO quantity (never below zero)" value={audit.actionablePoQty} sign="→" highlight/>
    </div>
    <p className="formula-explanation">{row.explanation} A negative signed ask remains visible for audit, while the actionable quantity becomes zero. Forecast evidence does not change this formula.</p>
  </section>;
}
function formatAuditNumber(value:number,maxFractionDigits=2){return new Intl.NumberFormat("en-IN",{maximumFractionDigits:maxFractionDigits}).format(value)}
function Formula({label,value,sign,highlight}:{label:string;value:number|string;sign:string;highlight?:boolean}){return<div className={highlight?"formula-highlight":""}><span>{sign}</span><p>{label}</p><strong>{typeof value==="number"?formatIndianNumber(value):value}</strong></div>}
function DrawerMetric({label,value}:{label:string;value:string}){return<div><span>{label}</span><strong>{value}</strong></div>}
