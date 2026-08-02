"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import FileDrop from "@/components/FileDrop";
import Icon from "@/components/Icon";
import LiveDataPanel from "@/components/LiveDataPanel";
import { InfoNote, PageIntro, Segment, StatusMessage } from "@/components/Ui";

type SourceMode = "files" | "live";
type UploadMode = "workbook" | "separate";

export default function ReplenishmentPage() {
  const router = useRouter();
  const [sourceMode, setSourceMode] = useState<SourceMode>("files");
  const [uploadMode, setUploadMode] = useState<UploadMode>("workbook");
  const [workbook, setWorkbook] = useState<File | null>(null);
  const [sales, setSales] = useState<File | null>(null);
  const [inventory, setInventory] = useState<File | null>(null);
  const [openPos, setOpenPos] = useState<File | null>(null);
  const [styleDetails, setStyleDetails] = useState<File | null>(null);
  const [coverage, setCoverage] = useState(45);
  const [dohThreshold, setDohThreshold] = useState(80);
  const [label, setLabel] = useState("Myntra New PO · Style cover plan");
  const [busy, setBusy] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");

  const separateReady = Boolean(sales && inventory && openPos && styleDetails);
  const uploadReady = uploadMode === "workbook" ? Boolean(workbook) : separateReady;

  async function loadWorkbookDemo() {
    setDemoBusy(true);
    setError("");
    try {
      const response = await fetch("/api/demo-files/workbook");
      if (!response.ok) throw new Error("Could not load the methodology workbook.");
      const blob = await response.blob();
      setWorkbook(new File([blob], "Noise_113.xlsx", { type: blob.type }));
      setUploadMode("workbook");
      setLabel("NOISE headphones · June 2026 New PO plan");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the sample workbook.");
    } finally {
      setDemoBusy(false);
    }
  }

  async function generate(batchId: string) {
    setStage("Applying the documented DRR, DOH and PO-cover formula…");
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchId, coverageDays: coverage }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "The calculation could not be generated.");
    setStage("Opening the style recommendation queue…");
    router.push(`/results/${result.batchId}`);
  }

  async function runFiles() {
    if (!uploadReady) return;
    setBusy(true);
    setError("");
    setStage("Reading and validating every source before calculation…");
    try {
      const form = new FormData();
      if (uploadMode === "workbook" && workbook) form.set("planning_workbook", workbook);
      if (uploadMode === "separate") {
        form.set("sell_out", sales!);
        form.set("current_inventory", inventory!);
        form.set("open_purchase_orders", openPos!);
        form.set("style_details", styleDetails!);
      }
      form.set("coverageDays", String(coverage));
      form.set("dohThreshold", String(dohThreshold));
      form.set("forecastMethod", "auto");
      form.set("label", label);
      const response = await fetch("/api/upload", { method: "POST", body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The source files could not be imported.");
      await generate(result.batchId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The plan could not be built.");
      setBusy(false);
      setStage("");
    }
  }

  return <div>
    <PageIntro
      eyebrow="New PO methodology · Controlled planning"
      title="Build a style-level purchase plan"
      description="Use the approved DRR and stock-cover methodology with either uploaded source files or a connected planning snapshot. Every number keeps its source, assumptions and formula for review."
    />

    <section className="source-mode-card" aria-labelledby="source-mode-heading">
      <div><p className="eyebrow">Step 1 · Choose a source</p><h2 id="source-mode-heading">How should StyleFlow receive the planning data?</h2><p>Both routes produce the same immutable, auditable calculation snapshot.</p></div>
      <Segment<SourceMode> value={sourceMode} label="Planning data source" onChange={value => { setError(""); setSourceMode(value); }} options={[
        { value: "files", label: "Upload files" },
        { value: "live", label: "Live data connection" },
      ]}/>
    </section>

    {error && <StatusMessage type="error">{error}</StatusMessage>}

    <div className="industry-plan-grid">
      {sourceMode === "files" ? <section className="panel source-workspace">
          <div className="panel-head">
            <div><p className="step-kicker">File ingestion</p><h2 className="section-title">Upload one workbook or four separate sources</h2><p className="section-description">XLSX and CSV sources are detected, normalized and validated before anything is saved.</p></div>
            <button className="btn-secondary" type="button" onClick={loadWorkbookDemo} disabled={demoBusy}><Icon name="play"/>{demoBusy ? "Loading…" : "Use attached NOISE sample"}</button>
          </div>
          <Segment<UploadMode> value={uploadMode} label="File upload structure" onChange={setUploadMode} options={[
            { value: "workbook", label: "One bulk workbook" },
            { value: "separate", label: "Separate source files" },
          ]}/>

          {uploadMode === "workbook" ? <div className="bulk-upload-zone">
            <FileDrop
              label="Planning workbook"
              hint="Required sheets: sell-out, current inventory, open PO and style ID details. Maximum 15 MB."
              required file={workbook} onChange={setWorkbook}
              accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              extensions={[".xlsx", ".xlsm"]}
              chooseLabel="Choose XLSX workbook"
              templateHref="/api/demo-files/workbook?download=1"
            />
            <div className="detected-source-list" aria-label="Required workbook sheets">
              {["Sell-out history", "Current inventory", "Open purchase orders", "Style ID details / NLC"].map((item, index) => <span key={item}><b>{index + 1}</b>{item}</span>)}
            </div>
          </div> : <div className="source-grid methodology-source-grid">
            <SourceCard number="01" title="Sell-out history" detail="Defines the style universe, selling days and sales units.">
              <FileDrop label="Sell-out file" hint="order_Month, style_id, qty" required file={sales} onChange={setSales} accept=".csv,.xlsx,text/csv" extensions={[".csv", ".xlsx"]} chooseLabel="Choose CSV or XLSX" templateHref="/api/demo-files/new_po_sales?download=1"/>
            </SourceCard>
            <SourceCard number="02" title="Current inventory" detail="All matching inventory rows are summed by style ID.">
              <FileDrop label="Inventory file" hint="style_id, inv_units_q1" required file={inventory} onChange={setInventory} accept=".csv,.xlsx,text/csv" extensions={[".csv", ".xlsx"]} chooseLabel="Choose CSV or XLSX" templateHref="/api/demo-files/new_po_inventory?download=1"/>
            </SourceCard>
            <SourceCard number="03" title="Open purchase orders" detail="Every matching pending quantity reduces the new ask.">
              <FileDrop label="Open PO file" hint="style_id, pending_qty; vendor_name recommended" required file={openPos} onChange={setOpenPos} accept=".csv,.xlsx,text/csv" extensions={[".csv", ".xlsx"]} chooseLabel="Choose CSV or XLSX" templateHref="/api/demo-files/new_po_open_pos?download=1"/>
            </SourceCard>
            <SourceCard number="04" title="Style and supplier master" detail="Model, MRP, NLC and supplier mapping make a PO commercially usable.">
              <FileDrop label="Style details file" hint="Style Id, Model, MRP, NLC; Vendor and Contact_Email recommended" required file={styleDetails} onChange={setStyleDetails} accept=".csv,.xlsx,text/csv" extensions={[".csv", ".xlsx"]} chooseLabel="Choose CSV or XLSX" templateHref="/api/demo-files/new_po_styles?download=1"/>
            </SourceCard>
          </div>}

          <InfoNote title="Data safety before calculation" tone="neutral"><p>Repeated inventory and PO rows are aggregated—not deduplicated. Conflicting style-master values, invalid dates, missing columns and duplicate source files stop the import with a specific row-level error.</p></InfoNote>
      </section> : <LiveDataPanel
        coverageDays={coverage}
        dohThreshold={dohThreshold}
        label={label}
        onBusy={(isBusy, nextStage) => {
          setBusy(isBusy);
          setStage(nextStage || "");
        }}
        onError={setError}
      />}

      <aside className="panel methodology-control-panel">
        <div className="panel-head"><div><p className="step-kicker">Step 2 · Calculation controls</p><h2 className="section-title">Set the approved parameters</h2><p className="section-description">Defaults reproduce the supplied methodology.</p></div></div>
        <div className="form-stack">
          <label><span className="field-label">Plan name</span><input className="field" maxLength={160} value={label} onChange={event => setLabel(event.target.value)} placeholder="e.g. NOISE June New PO" disabled={busy}/></label>
          <div className="form-grid-2">
            <label><span className="field-label">PO cover days</span><div className="input-with-suffix"><input className="field" type="number" min="1" max="365" value={coverage} onChange={event => setCoverage(Number(event.target.value))} disabled={busy}/><span>days</span></div><small className="field-help">Used in DRR × cover days. Methodology default: 45.</small></label>
            <label><span className="field-label">DOH review threshold</span><div className="input-with-suffix"><input className="field" type="number" min="1" max="730" value={dohThreshold} onChange={event => setDohThreshold(Number(event.target.value))} disabled={busy}/><span>days</span></div><small className="field-help">Only DOH strictly below this value enters review. Default: 80.</small></label>
          </div>

          <section className="methodology-formula" aria-labelledby="formula-heading">
            <p className="eyebrow">Calculation source of truth</p>
            <h3 id="formula-heading">PO quantity ask</h3>
            <code>ROUND((Sales ÷ unique selling days) × {coverage} − inventory − open PO, 0)</code>
            <dl>
              <div><dt>DRR</dt><dd>Sales ÷ unique selling days</dd></div>
              <div><dt>DOH</dt><dd>Inventory ÷ DRR</dd></div>
              <div><dt>Eligibility</dt><dd>DOH &lt; {dohThreshold}</dd></div>
              <div><dt>Currency</dt><dd>INR only</dd></div>
            </dl>
          </section>

          {sourceMode === "files" ? <button className="btn-primary btn-large w-full" disabled={!uploadReady || busy || !label.trim()} onClick={runFiles} aria-busy={busy}>
            <Icon name={busy ? "refresh" : "arrowRight"}/>{busy ? stage : uploadReady ? "Validate files and calculate" : "Add the required source data"}
          </button> : <p className="methodology-live-action"><Icon name="info"/><span>Choose the exact connected data and build the plan from the panel. These assumptions are applied to that snapshot.</span></p>}
          <p className="methodology-assurance"><Icon name="shield"/>The calculation creates recommendations only. Supplier emails and issued POs always require separate review actions.</p>
        </div>
      </aside>
    </div>
  </div>;
}

function SourceCard({ number, title, detail, children }: { number: string; title: string; detail: string; children: React.ReactNode }) {
  return <article className="source-card"><div className="source-card-head"><span>{number}</span><div><h3>{title}</h3><p>{detail}</p></div></div>{children}</article>;
}
