"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { EmptyState, LoadingState, MetricCard, PageIntro, Segment, StatusMessage } from "@/components/Ui";
import { formatDateTime, formatIndianNumber, formatINR } from "@/lib/format";

type MappingView = "all" | "ready" | "incomplete" | "unmapped";
type MappingState = Exclude<MappingView, "all">;
type MappingSummary = { total: number; ready: number; incomplete: number; unmapped: number };
type MappingFilters = { brands: string[]; categories: string[]; vendors: string[] };
type MappingPagination = { page: number; limit: number; total: number; totalPages: number };
type LatestPlan = { id: string; label: string; status: string; createdAt: string | null };

type SupplierMapping = {
  id: string;
  styleId: string;
  productName: string;
  brand: string;
  category: string;
  articleType: string;
  vendorName: string;
  supplierSku: string;
  contactEmail: string;
  unitCostInr: number | null;
  hsnCode: string;
  gstRate: number | null;
  supplierGstin: string;
  supplierState: string;
  leadTimeDays: number | null;
  paymentTerms: string;
  incoterms: string;
  moq: number | null;
  packSize: number | null;
  updatedAt: string | null;
  revision: number | null;
  serverStatus: string;
  serverReady: boolean | null;
  serverIssues: string[];
};

type MappingDraft = Omit<SupplierMapping, "id" | "updatedAt" | "serverStatus" | "serverReady" | "serverIssues">;

const emptyDraft: MappingDraft = {
  styleId: "",
  productName: "",
  brand: "",
  category: "",
  articleType: "",
  vendorName: "",
  supplierSku: "",
  contactEmail: "",
  unitCostInr: null,
  hsnCode: "",
  gstRate: null,
  supplierGstin: "",
  supplierState: "",
  leadTimeDays: null,
  paymentTerms: "",
  incoterms: "",
  moq: null,
  packSize: null,
  revision: null,
};

export default function SupplierMappingsPage() {
  const [mappings, setMappings] = useState<SupplierMapping[] | null>(null);
  const [summary, setSummary] = useState<MappingSummary>({ total: 0, ready: 0, incomplete: 0, unmapped: 0 });
  const [filterOptions, setFilterOptions] = useState<MappingFilters>({ brands: [], categories: [], vendors: [] });
  const [pagination, setPagination] = useState<MappingPagination>({ page: 1, limit: 50, total: 0, totalPages: 0 });
  const [permissions, setPermissions] = useState({ canEdit: false, canImport: false, canExport: false });
  const [latestPlan, setLatestPlan] = useState<LatestPlan | null>(null);
  const [view, setView] = useState<MappingView>("all");
  const [search, setSearch] = useState("");
  const [serverSearch, setServerSearch] = useState("");
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState("");
  const [supplier, setSupplier] = useState("");
  const [page, setPage] = useState(1);
  const [refreshing, setRefreshing] = useState(false);
  const [editor, setEditor] = useState<{ mode: "create" | "edit" | "view"; id: string | null; draft: MappingDraft } | null>(null);
  const [pendingImport, setPendingImport] = useState<File | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const importRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef("");

  async function load(signal?: AbortSignal) {
    setRefreshing(true);
    const query = new URLSearchParams({ page: String(page), limit: "25" });
    if (serverSearch) query.set("q", serverSearch);
    if (view !== "all") query.set("status", view === "ready" ? "mapped" : view);
    if (brand) query.set("brand", brand);
    if (category) query.set("category", category);
    if (supplier) query.set("vendor", supplier);
    try {
      const mappingResponse = await fetch(`/api/vendor-mappings?${query}`, { cache: "no-store", signal });
      const result = await mappingResponse.json().catch(() => ({}));
      if (!mappingResponse.ok) throw new Error(result.error || "Supplier mappings could not be loaded.");
      const rows = Array.isArray(result.mappings) ? result.mappings : [];
      setMappings(rows.map(normaliseMapping));
      setSummary({
        total: Number(result.summary?.total ?? 0),
        ready: Number(result.summary?.ready ?? result.summary?.mapped ?? 0),
        incomplete: Number(result.summary?.incomplete ?? 0),
        unmapped: Number(result.summary?.unmapped ?? 0),
      });
      setFilterOptions({
        brands: stringArray(result.filters?.brands),
        categories: stringArray(result.filters?.categories),
        vendors: stringArray(result.filters?.vendors),
      });
      setPagination({
        page: Number(result.pagination?.page ?? page),
        limit: Number(result.pagination?.limit ?? 25),
        total: Number(result.pagination?.total ?? rows.length),
        totalPages: Number(result.pagination?.totalPages ?? (rows.length ? 1 : 0)),
      });
      setPermissions({
        canEdit: Boolean(result.permissions?.canEdit),
        canImport: Boolean(result.permissions?.canImport),
        canExport: Boolean(result.permissions?.canExport),
      });
      setLatestPlan(result.latestPlan ? {
        id: String(result.latestPlan.id),
        label: String(result.latestPlan.label || "Latest planning run"),
        status: String(result.latestPlan.status || "uploaded"),
        createdAt: result.latestPlan.createdAt ?? null,
      } : null);
      setError("");
    } finally {
      if (!signal?.aborted) setRefreshing(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1);
      setServerSearch(search.trim());
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch(nextError => {
      if ((nextError as Error)?.name !== "AbortError") setError(errorText(nextError));
    });
    return () => controller.abort();
  }, [serverSearch, view, brand, category, supplier, page]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const editorOpen = Boolean(editor);
  useEffect(() => {
    if (!editorOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => closeRef.current?.focus());
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busyRef.current) {
        setEditor(null);
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = closeRef.current?.closest<HTMLElement>('[role="dialog"]');
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [editorOpen]);

  const enriched = useMemo(() => (mappings ?? []).map(mapping => ({
    mapping,
    state: mappingState(mapping),
    issues: readinessIssues(mapping),
  })), [mappings]);

  const counts = { all: summary.total, ready: summary.ready, incomplete: summary.incomplete, unmapped: summary.unmapped };
  const visible = enriched;

  const filtersActive = Boolean(search || brand || category || supplier);
  const choices = { brands: filterOptions.brands, categories: filterOptions.categories, suppliers: filterOptions.vendors };

  function openMapping(mapping: SupplierMapping) {
    setError("");
    setMessage("");
    setEditor({ mode: permissions.canEdit ? "edit" : "view", id: mapping.id, draft: toDraft(mapping) });
  }

  function startCreate() {
    setError("");
    setMessage("");
    setEditor({ mode: "create", id: null, draft: { ...emptyDraft } });
  }

  async function saveMapping(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || editor.mode === "view") return;
    const invalid = validationErrors(editor.draft, editor.mode);
    if (invalid.length) {
      setError(invalid.join(" "));
      return;
    }
    setBusy("save");
    setError("");
    setMessage("");
    try {
      if (editor.mode === "edit" && editor.draft.revision === null) throw new Error("This mapping has no revision number. Reload the sheet before editing it.");
      const response = await fetch(editor.mode === "create" ? "/api/vendor-mappings" : `/api/vendor-mappings/${encodeURIComponent(editor.id || "")}`, {
        method: editor.mode === "create" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mappingPayload(editor.draft, editor.mode)),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "The supplier mapping could not be saved.");
      await load();
      setEditor(null);
      setMessage(result.message || `${editor.draft.styleId} was saved. Its readiness status has been recalculated.`);
    } catch (nextError) {
      setError(errorText(nextError));
    } finally {
      setBusy("");
    }
  }

  async function importMappings() {
    if (!pendingImport) return;
    setBusy("import");
    setError("");
    setMessage("");
    try {
      const formData = new FormData();
      formData.append("file", pendingImport);
      const response = await fetch("/api/vendor-mappings/import", { method: "POST", body: formData });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "The mapping sheet could not be imported.");
      await load();
      const importSummary = result.summary ?? {};
      const changed = Number(importSummary.created ?? 0) + Number(importSummary.updated ?? 0);
      const accepted = Number(importSummary.acceptedRows ?? changed);
      const duplicates = Number(importSummary.duplicateRowsCollapsed ?? 0);
      setMessage(`Import complete. ${formatIndianNumber(accepted)} row${accepted === 1 ? "" : "s"} accepted; ${formatIndianNumber(changed)} mapping${changed === 1 ? "" : "s"} changed${duplicates ? `; ${formatIndianNumber(duplicates)} duplicate row${duplicates === 1 ? " was" : "s were"} collapsed` : ""}.`);
      setPendingImport(null);
      if (importRef.current) importRef.current.value = "";
    } catch (nextError) {
      setError(errorText(nextError));
    } finally {
      setBusy("");
    }
  }

  async function syncLatestPlan() {
    if (!latestPlan) {
      setError("Create or upload a plan before bringing styles into the mapping sheet.");
      return;
    }
    setBusy("sync");
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/vendor-mappings/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId: latestPlan.id }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Plan styles could not be brought into the mapping sheet.");
      const inserted = Number(result.summary?.inserted ?? 0);
      const existing = Number(result.summary?.alreadyPresent ?? 0);
      setMessage(result.message || `${formatIndianNumber(inserted)} missing relationship${inserted === 1 ? " was" : "s were"} added; ${formatIndianNumber(existing)} existing mapping${existing === 1 ? " was" : "s were"} left unchanged.`);
      if (page === 1) await load();
      else setPage(1);
    } catch (nextError) {
      setError(errorText(nextError));
    } finally {
      setBusy("");
    }
  }

  if (!mappings && !error) return <LoadingState>Checking supplier mappings and PO readiness…</LoadingState>;
  if (!mappings) return <EmptyState title="Supplier mapping is unavailable" icon="alert"><p>{error}</p><button className="btn-secondary" onClick={() => { setError(""); void load().catch(nextError => setError(errorText(nextError))); }}>Try again</button></EmptyState>;

  return <div>
    <PageIntro
      eyebrow="Commercial master data"
      title="Vendor–supplier mapping"
      description="Connect each Myntra Style ID to its supplier and INR cost so planners can create a draft PO. Add tax, contact and delivery details here or complete them before the PO is sent."
      actions={<div className="mapping-page-actions">
        {permissions.canEdit && <button className="btn-secondary" type="button" onClick={syncLatestPlan} disabled={Boolean(busy) || !latestPlan} title={latestPlan ? `Add missing relationships from ${latestPlan.label}; existing mappings stay unchanged` : "Create or upload a plan first"}><Icon name="refresh"/>{busy === "sync" ? "Bringing in styles…" : "Bring in plan styles"}</button>}
        {permissions.canExport && <a className="btn-secondary" href="/api/vendor-mappings/export?format=xlsx"><Icon name="download"/>Export sheet</a>}
        {permissions.canImport && <>
          <input ref={importRef} className="sr-only" type="file" accept=".csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" onChange={event => setPendingImport(event.target.files?.[0] || null)}/>
          <button className="btn-secondary" type="button" onClick={() => importRef.current?.click()} disabled={Boolean(busy)}><Icon name="upload"/>Import sheet</button>
        </>}
        {permissions.canEdit && <button className="btn-primary" type="button" onClick={startCreate}><Icon name="plus"/>Add mapping</button>}
      </div>}
    />

    {error && <StatusMessage type="error">{error}</StatusMessage>}
    {message && <StatusMessage>{message}</StatusMessage>}
    {!permissions.canEdit && <StatusMessage type="warning">You have read-only access. A planner or administrator can change supplier mappings.</StatusMessage>}

    {latestPlan && <div className="mapping-plan-source"><span><Icon name="database"/></span><div><strong>Latest source plan: {latestPlan.label}</strong><p>Bring in missing Style ID and supplier relationships from this plan at any time. Existing mappings are never overwritten.</p></div><small>{formatDateTime(latestPlan.createdAt)}</small></div>}

    {pendingImport && <section className="mapping-import-banner" aria-live="polite">
      <span className="mapping-import-icon"><Icon name="upload"/></span>
      <div><strong>Ready to import {pendingImport.name}</strong><span>CSV and XLSX sheets are checked row by row. Valid rows are applied; rejected rows are returned with a clear reason.</span></div>
      <button className="btn-secondary" type="button" onClick={() => { setPendingImport(null); if (importRef.current) importRef.current.value = ""; }} disabled={busy === "import"}>Cancel</button>
      <button className="btn-primary" type="button" onClick={importMappings} disabled={busy === "import"}>{busy === "import" ? "Checking rows…" : "Import mappings"}</button>
    </section>}

    <section className="mapping-explainer" aria-label="How supplier mapping works">
      <div><span>1</span><p><strong>Map the relationship</strong>Choose a supplier for each Myntra Style ID.</p></div>
      <div><span>2</span><p><strong>Complete buying terms</strong>Add INR cost, tax identity, lead time and order rules.</p></div>
      <div><span>3</span><p><strong>Create, then complete</strong>A real supplier and positive INR NLC make a draft possible. Dispatch checks remain visible until sending.</p></div>
    </section>

    <div className="mapping-kpis">
      <MetricCard label="Style relationships" value={counts.all} detail="Active and historical mapping records" icon="package"/>
      <MetricCard label="Dispatch details complete" value={counts.ready} detail="Supplier, tax, contact and order fields complete" tone="positive" icon="check"/>
      <MetricCard label="Needs details" value={counts.incomplete} detail="May be draft-ready; remaining fields are shown per row" tone={counts.incomplete ? "warning" : "positive"} icon="alert"/>
      <MetricCard label="Unmapped styles" value={counts.unmapped} detail="No supplier relationship is assigned" tone={counts.unmapped ? "critical" : "positive"} icon="replenishment"/>
    </div>

    <section className="panel mapping-sheet" aria-busy={refreshing}>
      <div className="mapping-tabs"><Segment value={view} onChange={value => { setView(value); setPage(1); }} label="Mapping readiness" options={[
        { value: "all", label: "All", count: counts.all },
        { value: "ready", label: "Dispatch complete", count: counts.ready },
        { value: "incomplete", label: "Needs details", count: counts.incomplete },
        { value: "unmapped", label: "Unmapped", count: counts.unmapped },
      ]}/></div>

      <div className="mapping-filter-row">
        <label className="mapping-search"><span className="sr-only">Search supplier mappings</span><Icon name="search"/><input className="field" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search Style ID, product, supplier or supplier SKU…"/></label>
        <label><span>Brand</span><select className="field" value={brand} onChange={event => { setBrand(event.target.value); setPage(1); }}><option value="">All brands</option>{choices.brands.map(value => <option key={value}>{value}</option>)}</select></label>
        <label><span>Category</span><select className="field" value={category} onChange={event => { setCategory(event.target.value); setPage(1); }}><option value="">All categories</option>{choices.categories.map(value => <option key={value}>{value}</option>)}</select></label>
        <label><span>Supplier</span><select className="field" value={supplier} onChange={event => { setSupplier(event.target.value); setPage(1); }}><option value="">All suppliers</option>{choices.suppliers.map(value => <option key={value}>{value}</option>)}</select></label>
        {filtersActive && <button className="btn-secondary" type="button" onClick={() => { setSearch(""); setServerSearch(""); setBrand(""); setCategory(""); setSupplier(""); setPage(1); }}>Reset</button>}
      </div>

      <div className="mapping-result-summary" aria-live="polite"><span><strong>{formatIndianNumber(pagination.total)}</strong> mappings match this view</span><span><strong>{pageStart(pagination)}–{pageEnd(pagination)}</strong> shown on this page</span><span>{refreshing ? "Updating results…" : "Readiness is recalculated after every edit or import."}</span></div>

      <div className="desktop-table-wrap mapping-table-wrap"><table className="data-table mapping-table"><caption>Vendor and supplier mapping sheet</caption><thead><tr><th scope="col">Myntra style</th><th scope="col">Readiness</th><th scope="col">Supplier relationship</th><th scope="col">Commercial terms</th><th scope="col">Tax identity</th><th scope="col">Ordering rules</th><th scope="col">Updated</th><th scope="col"><span className="sr-only">Open mapping</span></th></tr></thead><tbody>{visible.map(({ mapping, state, issues }) => <tr key={mapping.id} className={`mapping-row state-${state}`}>
        <th scope="row"><button className="mapping-style-button" type="button" onClick={() => openMapping(mapping)}><strong>{mapping.productName || "Product name not available"}</strong><span>{mapping.styleId}</span><small>{[mapping.brand, mapping.category || mapping.articleType].filter(Boolean).join(" · ") || "Catalogue details unavailable"}</small></button></th>
        <td><ReadinessBadge state={state} draftReady={mappingDraftReady(mapping)}/>{issues.length > 0 && <small className="mapping-issue-copy">{issues[0]}{issues.length > 1 ? ` +${issues.length - 1} more` : ""}</small>}</td>
        <td><strong>{mapping.vendorName || "Not assigned"}</strong><small>{mapping.supplierSku ? `Supplier SKU ${mapping.supplierSku}` : "Supplier SKU missing"}</small><small>{mapping.contactEmail || "Contact email missing"}</small></td>
        <td><strong>{mapping.unitCostInr !== null ? formatINR(mapping.unitCostInr) : "NLC missing"}</strong><small>{mapping.paymentTerms || "Payment terms missing"}</small><small>{mapping.incoterms ? `Incoterms ${mapping.incoterms}` : "Incoterms missing"}</small></td>
        <td><strong>{mapping.hsnCode ? `HSN ${mapping.hsnCode}` : "HSN missing"}</strong><small>{mapping.gstRate !== null ? `${mapping.gstRate}% GST` : "GST rate missing"}</small><small>{mapping.supplierGstin || "GSTIN missing"}</small></td>
        <td><strong>{mapping.leadTimeDays !== null ? `${formatIndianNumber(mapping.leadTimeDays)} day lead time` : "Lead time missing"}</strong><small>MOQ {mapping.moq ?? "—"} · Pack {mapping.packSize ?? "—"}</small></td>
        <td>{formatDateTime(mapping.updatedAt)}<small>Revision {mapping.revision ?? "—"}</small></td>
        <td><button className="row-open" type="button" aria-label={`${permissions.canEdit ? "Edit" : "View"} mapping for ${mapping.styleId}`} onClick={() => openMapping(mapping)}><Icon name="chevronRight"/></button></td>
      </tr>)}</tbody></table></div>

      <div className="mobile-card-list mapping-mobile-list">{visible.map(({ mapping, state, issues }) => <article className="mapping-card" key={mapping.id}>
        <div className="mapping-card-head"><div><strong>{mapping.productName || mapping.styleId}</strong><span>{mapping.styleId} · {mapping.brand || "Brand not set"}</span></div><ReadinessBadge state={state} draftReady={mappingDraftReady(mapping)}/></div>
        <div className="mapping-card-supplier"><span>Supplier</span><strong>{mapping.vendorName || "Not assigned"}</strong><small>{mapping.supplierSku || "Supplier SKU missing"}</small></div>
        <dl><div><dt>NLC</dt><dd>{mapping.unitCostInr !== null ? formatINR(mapping.unitCostInr) : "Missing"}</dd></div><div><dt>Lead time</dt><dd>{mapping.leadTimeDays !== null ? `${mapping.leadTimeDays} days` : "Missing"}</dd></div><div><dt>MOQ / pack</dt><dd>{mapping.moq ?? "—"} / {mapping.packSize ?? "—"}</dd></div><div><dt>GST</dt><dd>{mapping.gstRate !== null ? `${mapping.gstRate}%` : "Missing"}</dd></div></dl>
        {issues.length > 0 && <p><Icon name="alert"/>{issues[0]}{issues.length > 1 ? ` +${issues.length - 1} more` : ""}</p>}
        <button type="button" className="mapping-card-open" onClick={() => openMapping(mapping)}>{permissions.canEdit ? "Edit mapping" : "View mapping"}<Icon name="chevronRight"/></button>
      </article>)}</div>

      {!visible.length && !refreshing && (summary.total === 0 && !filtersActive && view === "all" ? <div className="mapping-empty"><Icon name="package"/><h3>Start the mapping sheet from your latest plan</h3><p>{latestPlan ? `StyleFlow can add every missing style relationship from “${latestPlan.label}” without changing future edits.` : "Create or upload a plan first, then return here to bring in its styles."}</p>{permissions.canEdit && latestPlan ? <button className="btn-primary" type="button" onClick={syncLatestPlan} disabled={busy === "sync"}><Icon name="refresh"/>{busy === "sync" ? "Bringing in styles…" : "Bring in plan styles"}</button> : <button className="btn-secondary" type="button" onClick={() => window.location.assign("/")}>Build a plan</button>}</div> : <div className="mapping-empty"><Icon name="filter"/><h3>No mappings match this view</h3><p>Reset the filters or choose another readiness status.</p><button className="btn-secondary" type="button" onClick={() => { setView("all"); setSearch(""); setServerSearch(""); setBrand(""); setCategory(""); setSupplier(""); setPage(1); }}>Show all mappings</button></div>)}
      {pagination.totalPages > 1 && <nav className="mapping-pagination" aria-label="Supplier mapping pages">
        <span>Page <strong>{pagination.page}</strong> of <strong>{pagination.totalPages}</strong></span>
        <div><button className="btn-secondary" type="button" disabled={refreshing || page <= 1} onClick={() => changePage(page - 1, setPage)}>Previous</button><button className="btn-secondary" type="button" disabled={refreshing || page >= pagination.totalPages} onClick={() => changePage(page + 1, setPage)}>Next</button></div>
      </nav>}
    </section>

    <details className="mapping-import-guide"><summary>Columns accepted in the import sheet</summary><div><p><strong>Required relationship:</strong> Style ID and supplier name.</p><p><strong>Commercial readiness:</strong> Supplier SKU, email, unit cost in INR, HSN, GST rate, GSTIN, state, lead time, payment terms, Incoterms, MOQ and pack size.</p><p><strong>Safe updates:</strong> Existing Style IDs are revisioned and duplicate rows are collapsed. {permissions.canExport && <><a href="/api/vendor-mappings/export?format=xlsx&template=1">Download a blank XLSX template.</a>{" "}<a href="/api/demo-files/supplier_mappings?download=1">Download the 80% complete demo CSV.</a></>}</p></div></details>

    {editor && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setEditor(null); }}>
      <section className="modal-card modal-wide mapping-editor" role="dialog" aria-modal="true" aria-labelledby="mapping-editor-title">
        <div className="modal-head"><div><p className="eyebrow">{editor.mode === "create" ? "New supplier relationship" : editor.mode === "edit" ? "Edit commercial master" : "Commercial master details"}</p><h2 id="mapping-editor-title">{editor.mode === "create" ? "Add a vendor–supplier mapping" : editor.draft.styleId}</h2><p>{editor.mode === "view" ? "Review the supplier and buying terms used for PO readiness." : "Save the relationship now; StyleFlow will show any remaining readiness gaps after the update."}</p></div><button ref={closeRef} className="icon-button" type="button" aria-label="Close supplier mapping" onClick={() => setEditor(null)}><Icon name="close"/></button></div>
        <form onSubmit={saveMapping}>
          <div className="modal-body mapping-editor-body">
            {error && <StatusMessage type="error">{error}</StatusMessage>}
            <MappingReadinessPreview draft={editor.draft}/>
            <fieldset><legend>Style and supplier relationship</legend><p>Identify the Myntra style and the legal supplier relationship.</p><div className="mapping-field-grid">
              <DraftField label="Myntra Style ID" value={editor.draft.styleId} required disabled={editor.mode !== "create"} onChange={value => setDraft(setEditor, { styleId: value })}/>
              <DraftField label="Product name" value={editor.draft.productName} disabled={editor.mode === "view"} onChange={value => setDraft(setEditor, { productName: value })}/>
              <DraftField label="Brand" value={editor.draft.brand} disabled={editor.mode === "view"} onChange={value => setDraft(setEditor, { brand: value })}/>
              <DraftField label="Category" value={editor.draft.category} disabled={editor.mode === "view"} onChange={value => setDraft(setEditor, { category: value })}/>
              <DraftField label="Article type" value={editor.draft.articleType} disabled={editor.mode === "view"} onChange={value => setDraft(setEditor, { articleType: value })}/>
              <DraftField label="Supplier name" value={editor.draft.vendorName} disabled={editor.mode === "view"} onChange={value => setDraft(setEditor, { vendorName: value })}/>
              <DraftField label="Supplier SKU" value={editor.draft.supplierSku} disabled={editor.mode === "view"} onChange={value => setDraft(setEditor, { supplierSku: value })}/>
              <DraftField label="Supplier contact email" value={editor.draft.contactEmail} type="email" disabled={editor.mode === "view"} onChange={value => setDraft(setEditor, { contactEmail: value })}/>
            </div></fieldset>

            <fieldset><legend>INR cost and tax identity</legend><p>These values make the PO commercially and tax ready.</p><div className="mapping-field-grid mapping-field-grid-3">
              <DraftNumber label="Unit cost / NLC" value={editor.draft.unitCostInr} prefix="₹" min={0.01} step={0.01} disabled={editor.mode === "view"} onChange={value => setDraft(setEditor, { unitCostInr: value })}/>
              <DraftField label="HSN code" value={editor.draft.hsnCode} inputMode="numeric" disabled={editor.mode === "view"} onChange={value => setDraft(setEditor, { hsnCode: value.replace(/\D/g, "").slice(0, 8) })}/>
              <DraftNumber label="GST rate" value={editor.draft.gstRate} suffix="%" min={0} max={100} step={0.01} disabled={editor.mode === "view"} onChange={value => setDraft(setEditor, { gstRate: value })}/>
              <DraftField label="Supplier GSTIN" value={editor.draft.supplierGstin} maxLength={15} disabled={editor.mode === "view"} onChange={value => setDraft(setEditor, { supplierGstin: value.toUpperCase() })}/>
              <DraftField label="Supplier state" value={editor.draft.supplierState} disabled={editor.mode === "view"} onChange={value => setDraft(setEditor, { supplierState: value })}/>
            </div></fieldset>

            <fieldset><legend>Ordering and delivery rules</legend><p>Planning uses these constraints to turn a recommendation into an executable order.</p><div className="mapping-field-grid mapping-field-grid-3">
              <DraftNumber label="Lead time" value={editor.draft.leadTimeDays} suffix="days" min={0} step={1} disabled={editor.mode === "view"} onChange={value => setDraft(setEditor, { leadTimeDays: value })}/>
              <DraftNumber label="Minimum order quantity" value={editor.draft.moq} min={1} step={1} disabled={editor.mode === "view"} onChange={value => setDraft(setEditor, { moq: value })}/>
              <DraftNumber label="Pack size" value={editor.draft.packSize} min={1} step={1} disabled={editor.mode === "view"} onChange={value => setDraft(setEditor, { packSize: value })}/>
              <DraftField label="Payment terms" value={editor.draft.paymentTerms} placeholder="e.g. Net 30 days" disabled={editor.mode === "view"} onChange={value => setDraft(setEditor, { paymentTerms: value })}/>
              <DraftField label="Incoterms" value={editor.draft.incoterms} placeholder="e.g. DAP" disabled={editor.mode === "view"} onChange={value => setDraft(setEditor, { incoterms: value.toUpperCase() })}/>
            </div></fieldset>
          </div>
          <div className="modal-footer"><button className="btn-secondary" type="button" onClick={() => setEditor(null)}>{editor.mode === "view" ? "Close" : "Cancel"}</button>{editor.mode !== "view" && <button className="btn-primary" type="submit" disabled={busy === "save"}>{busy === "save" ? "Saving and checking…" : "Save mapping"}</button>}</div>
        </form>
      </section>
    </div>}
  </div>;
}

function ReadinessBadge({ state, draftReady = false }: { state: MappingState; draftReady?: boolean }) {
  const label = state === "ready" ? "Dispatch complete" : draftReady ? "Draft ready" : state === "unmapped" ? "Supplier missing" : "Needs draft details";
  return <span className={`mapping-status mapping-status-${state}`}><span aria-hidden="true"/>{label}</span>;
}

function MappingReadinessPreview({ draft }: { draft: MappingDraft }) {
  const provisional = normaliseMapping({ id: "preview", ...draft });
  const state = mappingState(provisional);
  const issues = readinessIssues(provisional);
  const draftReady = mappingDraftReady(provisional);
  return <div className={`mapping-readiness-preview mapping-preview-${state}`}><ReadinessBadge state={state} draftReady={draftReady}/><div><strong>{state === "ready" ? "Supplier details are complete for dispatch" : draftReady ? "Draft ready · dispatch details remain" : "Add supplier and positive INR NLC to create a draft"}</strong><span>{issues.length ? issues.join(" · ") : "Supplier identity, INR cost, tax details and order rules are complete. Final PO approval and buyer checks still apply."}</span></div></div>;
}

function DraftField({ label, value, onChange, disabled, required, type = "text", placeholder, inputMode, maxLength }: { label: string; value: string; onChange: (value: string) => void; disabled?: boolean; required?: boolean; type?: string; placeholder?: string; inputMode?: "numeric"; maxLength?: number }) {
  return <label><span className="field-label">{label}{required ? " *" : ""}</span><input className="field" type={type} value={value} disabled={disabled} required={required} placeholder={placeholder} inputMode={inputMode} maxLength={maxLength} onChange={event => onChange(event.target.value)}/></label>;
}

function DraftNumber({ label, value, onChange, disabled, prefix, suffix, min, max, step }: { label: string; value: number | null; onChange: (value: number | null) => void; disabled?: boolean; prefix?: string; suffix?: string; min?: number; max?: number; step?: number }) {
  return <label><span className="field-label">{label}</span><div className={`mapping-number-field ${prefix ? "has-prefix" : ""}`}><input className="field" type="number" value={value ?? ""} disabled={disabled} min={min} max={max} step={step} onChange={event => onChange(event.target.value === "" ? null : Number(event.target.value))}/>{prefix && <span className="mapping-number-prefix">{prefix}</span>}{suffix && <span className="mapping-number-suffix">{suffix}</span>}</div></label>;
}

function setDraft(setEditor: React.Dispatch<React.SetStateAction<{ mode: "create" | "edit" | "view"; id: string | null; draft: MappingDraft } | null>>, values: Partial<MappingDraft>) {
  setEditor(current => current ? { ...current, draft: { ...current.draft, ...values } } : current);
}

function normaliseMapping(raw: any): SupplierMapping {
  return {
    id: String(raw.id ?? raw.mappingId ?? raw.mapping_id ?? raw.styleId ?? raw.style_id ?? ""),
    styleId: text(raw.styleId ?? raw.style_id),
    productName: text(raw.productName ?? raw.product_name ?? raw.model ?? raw.description),
    brand: text(raw.brand),
    category: text(raw.category),
    articleType: text(raw.articleType ?? raw.article_type),
    vendorName: text(raw.vendorName ?? raw.vendor_name ?? raw.vendor ?? raw.supplierName ?? raw.supplier_name),
    supplierSku: text(raw.supplierSku ?? raw.supplier_sku),
    contactEmail: text(raw.contactEmail ?? raw.contact_email ?? raw.supplierEmail ?? raw.supplier_email),
    unitCostInr: optionalNumber(raw.unitCostInr ?? raw.unit_cost_inr ?? raw.nlc ?? raw.unitCost ?? raw.unit_cost),
    hsnCode: text(raw.hsnCode ?? raw.hsn_code ?? raw.hsn),
    gstRate: optionalNumber(raw.gstRate ?? raw.gst_rate ?? raw.gst),
    supplierGstin: text(raw.supplierGstin ?? raw.supplier_gstin ?? raw.gstin),
    supplierState: text(raw.supplierState ?? raw.supplier_state ?? raw.state),
    leadTimeDays: optionalNumber(raw.leadTimeDays ?? raw.lead_time_days ?? raw.leadTime ?? raw.lead_time),
    paymentTerms: text(raw.paymentTerms ?? raw.payment_terms),
    incoterms: text(raw.incoterms),
    moq: optionalNumber(raw.moq),
    packSize: optionalNumber(raw.packSize ?? raw.pack_size),
    updatedAt: raw.updatedAt ?? raw.updated_at ?? null,
    revision: optionalNumber(raw.revision),
    serverStatus: text(raw.readinessStatus ?? raw.readiness_status ?? raw.status),
    serverReady: typeof raw.readiness?.ready === "boolean" ? raw.readiness.ready : null,
    serverIssues: Array.isArray(raw.readiness?.issues ?? raw.readinessIssues ?? raw.readiness_issues ?? raw.issues) ? (raw.readiness?.issues ?? raw.readinessIssues ?? raw.readiness_issues ?? raw.issues).map(String) : [],
  };
}

function toDraft(mapping: SupplierMapping): MappingDraft {
  const { styleId, productName, brand, category, articleType, vendorName, supplierSku, contactEmail, unitCostInr, hsnCode, gstRate, supplierGstin, supplierState, leadTimeDays, paymentTerms, incoterms, moq, packSize, revision } = mapping;
  return { styleId, productName, brand, category, articleType, vendorName, supplierSku, contactEmail, unitCostInr, hsnCode, gstRate, supplierGstin, supplierState, leadTimeDays, paymentTerms, incoterms, moq, packSize, revision };
}

function mappingPayload(draft: MappingDraft, mode: "create" | "edit" | "view") {
  return {
    ...(mode === "create" ? { styleId: draft.styleId.trim() } : {}),
    productName: draft.productName.trim(),
    brand: draft.brand.trim(),
    category: draft.category.trim(),
    articleType: draft.articleType.trim(),
    vendor: draft.vendorName.trim(),
    supplierSku: draft.supplierSku.trim(),
    supplierEmail: draft.contactEmail.trim(),
    nlc: draft.unitCostInr,
    hsnCode: draft.hsnCode.trim(),
    gstRate: draft.gstRate,
    supplierGstin: draft.supplierGstin.trim().toUpperCase(),
    supplierState: draft.supplierState.trim(),
    leadTimeDays: draft.leadTimeDays,
    paymentTerms: draft.paymentTerms.trim(),
    incoterms: draft.incoterms.trim().toUpperCase(),
    moq: draft.moq,
    packSize: draft.packSize,
    ...(draft.revision !== null ? { expectedRevision: draft.revision } : {}),
  };
}

function mappingState(mapping: SupplierMapping): MappingState {
  if (!mapping.vendorName || mapping.serverStatus === "unmapped") return "unmapped";
  if (mapping.serverReady === true) return "ready";
  if (mapping.serverReady === false || mapping.serverStatus === "incomplete") return "incomplete";
  if (["ready", "po_ready", "complete"].includes(mapping.serverStatus) && !readinessIssues(mapping).length) return "ready";
  return readinessIssues(mapping).length ? "incomplete" : "ready";
}

function mappingDraftReady(mapping: SupplierMapping) {
  return Boolean(mapping.vendorName.trim()) && mapping.unitCostInr !== null && Number.isFinite(mapping.unitCostInr) && mapping.unitCostInr > 0;
}

function readinessIssues(mapping: SupplierMapping) {
  if (mapping.serverIssues.length) return mapping.serverIssues;
  const issues: string[] = [];
  if (!mapping.vendorName) issues.push("Supplier not assigned");
  if (!mapping.supplierSku) issues.push("Supplier SKU missing");
  if (!mapping.contactEmail) issues.push("Supplier email missing");
  if (mapping.unitCostInr === null || mapping.unitCostInr <= 0) issues.push("Positive INR cost missing");
  if (!/^\d{4,8}$/.test(mapping.hsnCode)) issues.push("Valid HSN missing");
  if (mapping.gstRate === null || mapping.gstRate < 0 || mapping.gstRate > 100) issues.push("GST rate missing");
  if (!gstinValid(mapping.supplierGstin)) issues.push("Valid supplier GSTIN missing");
  if (!mapping.supplierState) issues.push("Supplier state missing");
  if (mapping.leadTimeDays === null || !Number.isSafeInteger(mapping.leadTimeDays) || mapping.leadTimeDays < 0) issues.push("Lead time missing");
  if (!positiveWhole(mapping.moq)) issues.push("MOQ missing");
  if (!positiveWhole(mapping.packSize)) issues.push("Pack size missing");
  return issues;
}

function validationErrors(draft: MappingDraft, mode: "create" | "edit" | "view") {
  const errors: string[] = [];
  if (!draft.styleId.trim()) errors.push("Style ID is required.");
  if (draft.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.contactEmail)) errors.push("Enter a valid supplier email.");
  if (draft.hsnCode && !/^\d{4,8}$/.test(draft.hsnCode)) errors.push("HSN must contain 4–8 digits.");
  if (draft.supplierGstin && !gstinValid(draft.supplierGstin)) errors.push("Supplier GSTIN must be a valid 15-character Indian GSTIN.");
  if (draft.gstRate !== null && (draft.gstRate < 0 || draft.gstRate > 100)) errors.push("GST rate must be between 0 and 100.");
  if (draft.leadTimeDays !== null && (!Number.isSafeInteger(draft.leadTimeDays) || draft.leadTimeDays < 0)) errors.push("Lead time must be a whole number of zero days or more.");
  for (const [label, value] of [["MOQ", draft.moq], ["Pack size", draft.packSize]] as const) if (value !== null && !positiveWhole(value)) errors.push(`${label} must be a positive whole number.`);
  if (draft.unitCostInr !== null && (!Number.isFinite(draft.unitCostInr) || draft.unitCostInr <= 0)) errors.push("Unit cost must be greater than ₹0.");
  return errors;
}

function gstinValid(value: string) {
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[A-Z0-9]$/.test(value.trim().toUpperCase());
}

function positiveWhole(value: number | null) {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function pageStart(pagination: MappingPagination) {
  return pagination.total ? (pagination.page - 1) * pagination.limit + 1 : 0;
}

function pageEnd(pagination: MappingPagination) {
  return Math.min(pagination.total, pagination.page * pagination.limit);
}

function changePage(nextPage: number, setPage: React.Dispatch<React.SetStateAction<number>>) {
  setPage(nextPage);
  window.requestAnimationFrame(() => document.querySelector(".mapping-sheet")?.scrollIntoView({ block: "start" }));
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}
