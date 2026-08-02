"use client";

import Link from "next/link";
import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import Icon, { IconName } from "@/components/Icon";
import { EmptyState, LoadingState, PageIntro, SectionHeader, StatusMessage } from "@/components/Ui";
import { formatDate, formatDateTime, formatIndianNumber, formatINR } from "@/lib/format";

type AutomationRule = {
  enabled: boolean;
  cadence: "manual" | "daily" | "weekly";
  run_hour_ist: number | string;
  auto_create_drafts: boolean;
  approval_threshold: number | string;
  event_name: string | null;
  promotion_uplift_pct: number | string;
  last_run_at: string | null;
  last_run_status: string | null;
  updated_at: string;
};

type Source = {
  key: "sales" | "inventory" | "openPos" | "vendorMaster";
  label: string;
  status: "ready" | "attention" | "missing";
  rows: number;
  detail: string;
  freshness: string;
  blocking: boolean;
};

type AutomationData = {
  rule: AutomationRule | null;
  latestBatch: null | {
    id: string;
    label: string | null;
    status: string;
    createdAt: string;
    dataAsOf: string | null;
    ageDays: number | null;
  };
  sources: Source[];
  safety: { canRun: boolean; canAutoDraft: boolean; blockingReasons: string[] };
  scheduler: { connected: boolean; environment: "local" | "deployment" };
};

const sourceIcons: Record<Source["key"], IconName> = {
  sales: "forecast",
  inventory: "package",
  openPos: "truck",
  vendorMaster: "database",
};

export default function AutomationPage() {
  const [data, setData] = useState<AutomationData | null>(null);
  const [draft, setDraft] = useState<AutomationRule | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"saving" | "running" | "">("");

  async function load() {
    const response = await fetch("/api/automation", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load data controls.");
    const normalizedRule = result.rule ? normalizeRule(result.rule) : null;
    const normalized = { ...result, rule: normalizedRule } as AutomationData;
    setData(normalized);
    setDraft(normalizedRule);
    return normalized;
  }

  useEffect(() => {
    load().catch(nextError => setError(nextError instanceof Error ? nextError.message : "Could not load data controls."));
  }, []);

  const dirty = useMemo(() => Boolean(data?.rule && draft && settingsKey(data.rule) !== settingsKey(draft)), [data?.rule, draft]);
  const eventNeedsName = Number(draft?.promotion_uplift_pct ?? 0) > 0 && !draft?.event_name?.trim();
  const scheduleActive = Boolean(data?.scheduler.connected && data.rule?.enabled && data.rule?.cadence !== "manual");

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setBusy("saving");
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/automation", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: draft.enabled,
          cadence: draft.cadence,
          runHourIst: Number(draft.run_hour_ist),
          autoCreateDrafts: draft.auto_create_drafts,
          approvalThreshold: Number(draft.approval_threshold),
          eventName: draft.event_name,
          promotionUpliftPct: Number(draft.promotion_uplift_pct),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save configuration.");
      const normalizedRule = normalizeRule(result.rule);
      setDraft(normalizedRule);
      setData(current => current ? { ...current, rule: normalizedRule } : current);
      setMessage(data?.scheduler.connected
        ? "Configuration saved. The connected scheduler can now use these controls."
        : "Configuration saved. Background scheduling is still not connected; use Run planning now locally.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not save configuration.");
    } finally {
      setBusy("");
    }
  }

  async function run() {
    setBusy("running");
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/automation/run", { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Planning run failed.");
      setMessage(`New plan created with ${formatIndianNumber(result.recommendations)} recommendations. ${result.message}`);
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Planning run failed.");
    } finally {
      setBusy("");
    }
  }

  if (error && !data) return <EmptyState title="Data controls are unavailable" icon="alert"><p>{error}</p><details><summary>Developer check</summary><code>npm run db:init</code></details></EmptyState>;
  if (!data || !draft) return <LoadingState>Checking source data and saved controls…</LoadingState>;

  const runDisabledReason = !data.latestBatch
    ? "Upload a snapshot first."
    : dirty ? "Save or reset the changes shown below before running."
      : data.safety.blockingReasons[0] ?? "";

  return <div className="automation-page">
    <PageIntro
      eyebrow="Data operations"
      title="Data health & automation"
      description={<>Check what the planner will use, run a new version safely, and prepare a schedule for deployment. A planning run <strong>never sends a supplier PO</strong>.</>}
      actions={<button className="btn-primary" type="button" onClick={run} disabled={Boolean(busy) || dirty || !data.safety.canRun} aria-describedby={runDisabledReason ? "run-disabled-reason" : undefined}><Icon name="play"/>{busy === "running" ? "Creating a new plan…" : "Run planning now"}</button>}
    />

    {!data.scheduler.connected && <StatusMessage type="warning"><strong>Background scheduling is not connected.</strong> Saving “daily” or “weekly” here does not start a job {data.scheduler.environment === "local" ? "on this computer" : "in this deployment"}. Use <strong>Run planning now</strong> until the deployment scheduler is connected.</StatusMessage>}
    {scheduleActive && data.rule && <StatusMessage><strong>Background scheduling is connected.</strong> The saved {data.rule.cadence} configuration is eligible to run at {hourLabel(data.rule.run_hour_ist)}.</StatusMessage>}
    {error && <StatusMessage type="error">{error}</StatusMessage>}
    {message && <StatusMessage>{message}</StatusMessage>}
    {runDisabledReason && <p id="run-disabled-reason" className="automation-run-note"><Icon name="info"/>{runDisabledReason}</p>}

    <section className="panel automation-sources" aria-labelledby="source-health-heading">
      <SectionHeader
        title="Source readiness"
        description={data.latestBatch
          ? <>Measured from <strong>{data.latestBatch.label || "latest snapshot"}</strong>, using data through <strong>{formatDate(data.latestBatch.dataAsOf)}</strong>.</>
          : "No source snapshot has been uploaded yet."}
        action={<Link className="btn-secondary" href="/"><Icon name={data.latestBatch ? "refresh" : "upload"}/>{data.latestBatch ? "Replace data" : "Upload data"}</Link>}
      />
      <div className="source-readiness-grid">
        {data.sources.map(source => <article key={source.key} className={`source-health-card source-${source.status}`}>
          <div className="source-health-top">
            <span className="source-health-icon"><Icon name={sourceIcons[source.key]}/></span>
            <span className={`source-health-status status-${source.status}`}><span aria-hidden="true"/>{source.status === "ready" ? "Ready" : source.status === "attention" ? "Check" : "Missing"}</span>
          </div>
          <h3>{source.label}</h3>
          <strong>{formatIndianNumber(source.rows)} rows</strong>
          <p>{source.detail}</p>
          <small>{source.freshness}</small>
        </article>)}
      </div>
      {data.latestBatch && <div className="snapshot-footnote"><Icon name="calendar"/><span>Snapshot uploaded {formatDateTime(data.latestBatch.createdAt)}. Planning always creates a new version; the source snapshot is not overwritten.</span></div>}
    </section>

    <div className="automation-layout">
      <form className="panel automation-controls" onSubmit={save}>
        <SectionHeader title="Planning controls" description="These saved values are used by both manual and connected scheduled runs." action={dirty ? <span className="unsaved-pill">Unsaved changes</span> : <span className="saved-pill"><Icon name="check"/>Saved</span>}/>
        <fieldset disabled={Boolean(busy)}>
          <legend className="sr-only">Automation planning controls</legend>
          <div className="automation-form-grid">
            <Field label="Run cadence" help={draft.cadence === "weekly" ? "The weekday is chosen in the deployment scheduler." : draft.cadence === "manual" ? "Nothing runs in the background." : "Eligible to run once per day after connection."}>
              <select className="field" value={draft.cadence} onChange={event => setDraft({ ...draft, cadence: event.target.value as AutomationRule["cadence"], enabled: event.target.value === "manual" ? false : draft.enabled })}>
                <option value="manual">Manual only</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly (day set at deployment)</option>
              </select>
            </Field>
            <Field label="Preferred run time" help="Shown and stored in India Standard Time.">
              <select className="field" value={String(draft.run_hour_ist)} onChange={event => setDraft({ ...draft, run_hour_ist: Number(event.target.value) })}>
                {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
              </select>
            </Field>
            <Field label="Upcoming Myntra event" help="Leave blank for normal demand; for example, End of Reason Sale.">
              <input className="field" maxLength={120} placeholder="No event adjustment" value={draft.event_name || ""} onChange={event => setDraft({ ...draft, event_name: event.target.value })}/>
            </Field>
            <Field label="Planned event uplift" help="A scenario assumption, not a guaranteed increase.">
              <div className="input-with-suffix"><input className="field" type="number" min="0" max="500" step="1" value={draft.promotion_uplift_pct} aria-invalid={eventNeedsName} onChange={event => setDraft({ ...draft, promotion_uplift_pct: event.target.value })}/><span>%</span></div>
              {eventNeedsName && <small className="field-error">Name the event to explain this uplift.</small>}
            </Field>
            <Field label="Senior approval threshold" help={`${formatINR(draft.approval_threshold)} or more needs a Senior Approver or Admin.`}>
              <div className="input-with-prefix"><span>₹</span><input className="field" type="number" min="0" max="1000000000" step="10000" value={draft.approval_threshold} onChange={event => setDraft({ ...draft, approval_threshold: event.target.value })}/></div>
            </Field>
          </div>

          <div className="automation-switches">
            <label className="automation-switch-card">
              <input type="checkbox" checked={draft.enabled} disabled={Boolean(busy) || draft.cadence === "manual"} onChange={event => setDraft({ ...draft, enabled: event.target.checked })}/>
              <span><strong>Allow the connected scheduler to use this cadence</strong><small>{data.scheduler.connected ? "The scheduler connection is present." : "Saved as configuration only; no background job is connected yet."}</small></span>
            </label>
            <label className="automation-switch-card">
              <input type="checkbox" checked={draft.auto_create_drafts} onChange={event => setDraft({ ...draft, auto_create_drafts: event.target.checked })}/>
              <span><strong>Create only qualifying draft POs after a run</strong><small>Low-quality forecasts, missing INR costs, critical exceptions and products with active POs are excluded.</small></span>
            </label>
            {draft.auto_create_drafts && !data.safety.canAutoDraft && <div className="automation-inline-warning"><Icon name="alert"/><span>Automatic drafts will be skipped until every source vendor has an INR cost in the commercial master. Planning can still run.</span></div>}
          </div>
        </fieldset>
        <div className="automation-form-footer">
          <span>{dirty ? "Run now is paused so the plan cannot use different settings from those shown." : `Last saved ${formatDateTime(draft.updated_at)}`}</span>
          <div><button className="btn-secondary" type="button" disabled={!dirty || Boolean(busy)} onClick={() => setDraft(data.rule)}>Reset</button><button className="btn-primary" type="submit" disabled={!dirty || Boolean(busy) || eventNeedsName}>{busy === "saving" ? "Saving…" : "Save configuration"}</button></div>
        </div>
      </form>

      <aside className="automation-side-stack">
        <section className="panel automation-run-card">
          <SectionHeader title="Last planning run" description="The audit result of the most recent manual or scheduled run."/>
          <dl>
            <SummaryRow label="Status" value={draft.last_run_status ? friendlyStatus(draft.last_run_status) : "Never run"}/>
            <SummaryRow label="Completed" value={formatDateTime(draft.last_run_at)}/>
            <SummaryRow label="Forecast policy" value="Best model on unseen history"/>
            <SummaryRow label="Supplier POs sent" value="Never automatically"/>
          </dl>
        </section>

        <section className="panel automation-guardrails">
          <SectionHeader title="What the safeguards do" description="Plain-language limits for every run."/>
          <ol>
            <Guardrail icon="history" title="Preserve the evidence">Each run is a new plan version, so the prior recommendation stays available for comparison.</Guardrail>
            <Guardrail icon="target" title="Test before selecting">Models are compared on historical days they did not train on.</Guardrail>
            <Guardrail icon="shield" title="Keep humans in control">Automatic output can only be a draft. Submit, approve and issue remain separate human steps.</Guardrail>
            <Guardrail icon="purchaseOrder" title="Avoid active duplicates">A SKU, supplier and FC already covered by a live PO is not drafted again.</Guardrail>
          </ol>
        </section>
      </aside>
    </div>
  </div>;
}

function Field({ label, help, children }: { label: string; help: ReactNode; children: ReactNode }) {
  return <label className="automation-field"><span className="field-label">{label}</span>{children}<span className="field-help">{help}</span></label>;
}

function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function Guardrail({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return <li><span><Icon name={icon}/></span><div><strong>{title}</strong><p>{children}</p></div></li>;
}

function settingsKey(rule: AutomationRule) {
  return JSON.stringify({
    enabled: rule.enabled,
    cadence: rule.cadence,
    hour: Number(rule.run_hour_ist),
    drafts: rule.auto_create_drafts,
    threshold: Number(rule.approval_threshold),
    event: rule.event_name?.trim() || "",
    uplift: Number(rule.promotion_uplift_pct),
  });
}

function normalizeRule(rule: AutomationRule): AutomationRule {
  return {
    ...rule,
    run_hour_ist: Number(rule.run_hour_ist),
    approval_threshold: Number(rule.approval_threshold),
    promotion_uplift_pct: Number(rule.promotion_uplift_pct),
  };
}

function hourLabel(value: number | string) {
  const hour = Math.max(0, Math.min(23, Number(value) || 0));
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", hour12: true, timeZone: "Asia/Kolkata" }).format(new Date(Date.UTC(2026, 0, 1, hour - 6, 30))) + " IST";
}

function friendlyStatus(value: string) {
  return value.replaceAll("_", " ").replace(/^./, character => character.toUpperCase());
}
