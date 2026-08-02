"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import Icon, { type IconName } from "@/components/Icon";
import { EmptyState, LoadingState, MetricCard, PageIntro, SectionHeader, StatusMessage } from "@/components/Ui";
import { formatCompactINR, formatDate, formatIndianNumber } from "@/lib/format";

type DashboardResponse = {
  summary: Record<string, string | number>;
  byStatus: Array<{ status: string; count: number; value: string | number }>;
  planning: null | {
    id: string;
    label: string | null;
    dataAsOf: string;
    totalLines: number;
    proposedUnits: number;
    proposedValue: number;
    readyLines: number;
    readyValue: number;
    items: Array<{
      sku: string;
      styleId?: string;
      productName?: string;
      suggestedPoQty: number;
      estimatedValue?: number;
      poReady: boolean;
      exceptions?: Array<{ code: string; severity: string }>;
    }>;
  };
};

type AutomationResponse = {
  latestBatch: null | { id: string; label: string | null; dataAsOf: string | null; ageDays: number | null };
  sources: Array<{ key: string; label: string; status: "ready" | "attention" | "missing"; rows: number; detail: string; freshness: string }>;
  safety: { canRun: boolean; canAutoDraft: boolean; blockingReasons: string[] };
  scheduler: { connected: boolean; environment: string };
};

type MappingResponse = {
  summary: { total: number; mapped: number; incomplete: number; unmapped: number; styles: number; vendors: number };
};

type PageData = { dashboard: DashboardResponse; automation: AutomationResponse; mappings: MappingResponse };

export default function ReadinessPage() {
  const [data, setData] = useState<PageData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      requestJson<DashboardResponse>("/api/dashboard", controller.signal),
      requestJson<AutomationResponse>("/api/automation", controller.signal),
      requestJson<MappingResponse>("/api/vendor-mappings?page=1&limit=1", controller.signal),
    ]).then(([dashboard, automation, mappings]) => setData({ dashboard, automation, mappings }))
      .catch(nextError => {
        if ((nextError as Error).name !== "AbortError") setError(nextError instanceof Error ? nextError.message : "The control tower could not be loaded.");
      });
    return () => controller.abort();
  }, []);

  const model = useMemo(() => data ? buildReadinessModel(data) : null, [data]);

  if (error) return <EmptyState title="Planning readiness is unavailable" icon="alert" action={<button className="btn-secondary" onClick={() => window.location.reload()}>Try again</button>}><p>{error}</p><p className="mt-3">If this is a new installation, run <code>npm run db:init</code> and reload the page.</p></EmptyState>;
  if (!data || !model) return <LoadingState>Checking data, mappings, recommendations and purchase orders…</LoadingState>;
  if (!data.dashboard.planning) return <EmptyState title="Create a plan to open the control tower" icon="target" action={<Link className="btn-primary" href="/">Build the first plan</Link>}><p>The control tower begins tracking readiness after the first workbook upload or connected-data plan.</p></EmptyState>;

  const { dashboard, automation, mappings } = data;
  const planning = dashboard.planning!;

  return <div>
    <PageIntro
      eyebrow="Operations control tower"
      title="Planning readiness"
      description={<>One view of the gates between source data and a received purchase order. Latest plan: <strong>{planning.label || "Untitled plan"}</strong>, using data through <strong>{formatDate(planning.dataAsOf)}</strong>.</>}
      actions={<><Link className="btn-secondary" href="/supplier-mappings"><Icon name="package"/>Supplier mappings</Link><Link className="btn-primary" href="/"><Icon name="plus"/>New plan</Link></>}
    />

    <section className={`readiness-hero readiness-${model.overallTone}`} aria-labelledby="readiness-state-title">
      <span className="readiness-hero-icon" aria-hidden="true"><Icon name={model.overallTone === "ready" ? "check" : "alert"}/></span>
      <div>
        <p>Current operating state</p>
        <h2 id="readiness-state-title">{model.overallTitle}</h2>
        <span>{model.overallDescription}</span>
      </div>
      <div className="readiness-gate-score"><strong>{model.clearGates} / {model.gates.length}</strong><span>gates clear</span></div>
    </section>

    {automation.latestBatch?.ageDays !== null && Number(automation.latestBatch?.ageDays) > 7 && <StatusMessage type="warning">The source snapshot is {formatIndianNumber(Number(automation.latestBatch?.ageDays))} days old. Refresh it before treating recommendations as a new buying decision.</StatusMessage>}

    <div className="readiness-metrics">
      <MetricCard label="Actionable recommendations" value={formatIndianNumber(model.positiveLines)} detail={`${formatIndianNumber(model.positiveUnits)} units · ${formatCompactINR(model.positiveValue)}`} tone="brand" icon="replenishment"/>
      <MetricCard label="Draft-ready recommendations" value={formatIndianNumber(model.readyLines)} detail={`${formatIndianNumber(model.blockedLines)} positive line${model.blockedLines === 1 ? "" : "s"} still blocked`} tone={model.blockedLines ? "warning" : "positive"} icon="check"/>
      <MetricCard label="Waiting for approval" value={formatIndianNumber(model.pendingApproval)} detail={`${formatCompactINR(model.pendingApprovalValue)} awaiting an approval decision`} tone={model.pendingApproval ? "warning" : "positive"} icon="shield"/>
      <MetricCard label="Open delivery follow-up" value={formatIndianNumber(model.inTransit)} detail={`${formatIndianNumber(model.overdue)} overdue PO${model.overdue === 1 ? "" : "s"}`} tone={model.overdue ? "critical" : model.inTransit ? "neutral" : "positive"} icon="truck"/>
    </div>

    <div className="readiness-grid">
      <section className="panel readiness-actions-panel">
        <SectionHeader title="What needs attention next" description="Only unresolved actions are shown, ordered from source quality to execution."/>
        <div className="readiness-action-list">
          {model.actions.map(action => <Link href={action.href} key={action.key} className={`readiness-action readiness-action-${action.tone}`}>
            <span className="readiness-action-icon"><Icon name={action.icon}/></span>
            <div><span>{action.label}</span><strong>{action.title}</strong><p>{action.detail}</p></div>
            <span className="readiness-action-value">{action.value}</span>
            <Icon name="chevronRight"/>
          </Link>)}
          {!model.actions.length && <div className="readiness-clear"><Icon name="check"/><div><strong>No immediate blocker is open</strong><p>The current data, mappings and workflow queues are clear. Continue monitoring demand and receipts.</p></div></div>}
        </div>
      </section>

      <section className="panel readiness-gates-panel">
        <SectionHeader title="Decision gates" description="Each gate has one owner and one clear definition of done."/>
        <ol className="readiness-gates">
          {model.gates.map((gate, index) => <li key={gate.key} className={`gate-${gate.state}`}>
            <span className="readiness-gate-number">{index + 1}</span>
            <div><span>{gate.owner}</span><strong>{gate.title}</strong><p>{gate.detail}</p></div>
            <span className="readiness-gate-state"><Icon name={gate.state === "ready" ? "check" : gate.state === "blocked" ? "alert" : "info"}/>{gate.state === "ready" ? "Clear" : gate.state === "blocked" ? "Blocked" : "Review"}</span>
          </li>)}
        </ol>
      </section>
    </div>

    <section className="panel readiness-source-panel">
      <SectionHeader title="Source and mapping health" description="Counts describe the saved planning snapshot; the mapping master is maintained independently and applied with provenance." action={<Link className="text-link" href="/automation">Open data controls <Icon name="arrowRight"/></Link>}/>
      <div className="readiness-source-grid">
        {automation.sources.map(source => <article key={source.key} className={`readiness-source source-${source.status}`}>
          <span className="readiness-source-icon"><Icon name={source.key === "vendorMaster" ? "package" : "database"}/></span>
          <div><span>{source.status === "ready" ? "Ready" : source.status === "missing" ? "Missing" : "Needs review"}</span><strong>{source.label}</strong><p>{source.detail}</p><small>{source.freshness}</small></div>
          <strong>{formatIndianNumber(source.rows)}</strong>
        </article>)}
        <article className={`readiness-source source-${mappings.summary.incomplete || mappings.summary.unmapped ? "attention" : "ready"}`}>
          <span className="readiness-source-icon"><Icon name="package"/></span>
          <div><span>{mappings.summary.incomplete || mappings.summary.unmapped ? "Needs review" : "Ready"}</span><strong>In-app supplier mapping master</strong><p>{formatIndianNumber(mappings.summary.mapped)} fully complete, {formatIndianNumber(mappings.summary.incomplete)} needing additional details and {formatIndianNumber(mappings.summary.unmapped)} without a supplier.</p><small>{formatIndianNumber(mappings.summary.vendors)} suppliers across {formatIndianNumber(mappings.summary.styles)} styles</small></div>
          <strong>{formatIndianNumber(mappings.summary.total)}</strong>
        </article>
      </div>
    </section>
  </div>;
}

async function requestJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Could not load ${url}.`);
  return result as T;
}

function buildReadinessModel(data: PageData) {
  const planning = data.dashboard.planning;
  const items = planning?.items ?? [];
  const positive = items.filter(item => Number(item.suggestedPoQty) > 0);
  const ready = positive.filter(item => item.poReady);
  const blocked = positive.filter(item => !item.poReady);
  const status = (name: string) => data.dashboard.byStatus.find(item => item.status === name);
  const count = (name: string) => Number(status(name)?.count ?? 0);
  const value = (name: string) => Number(status(name)?.value ?? 0);
  const pendingApproval = count("pending_approval");
  const approved = count("approved");
  const inTransit = count("issued") + count("partially_received");
  const overdue = Number(data.dashboard.summary.overdue_orders ?? 0);
  const mappings = data.mappings.summary;

  const actions: ReadinessAction[] = [];
  if (!data.automation.safety.canRun) actions.push({ key: "source", label: "Data owner", title: "Refresh or correct the planning snapshot", detail: data.automation.safety.blockingReasons.join(" ") || "The source data does not pass the planning gate.", value: `${data.automation.safety.blockingReasons.length} blocker${data.automation.safety.blockingReasons.length === 1 ? "" : "s"}`, href: "/automation", icon: "database", tone: "critical" });
  if (blocked.length) actions.push({ key: "mapping", label: "Planner / commercial owner", title: "Resolve blocked positive recommendations", detail: "Open the plan to add a real supplier and positive INR NLC for the draft, or correct the stated source-data blocker. Tax and dispatch details can be completed on the draft.", value: `${formatIndianNumber(blocked.length)} lines`, href: planning ? `/results/${planning.id}` : "/supplier-mappings", icon: "package", tone: "warning" });
  if (mappings.incomplete || mappings.unmapped) actions.push({ key: "master", label: "Commercial master owner", title: "Complete the supplier mapping master", detail: "Add supplier and positive INR NLC for drafting; complete HSN/GST, tax identity and ordering rules before dispatch.", value: `${formatIndianNumber(mappings.incomplete + mappings.unmapped)} mappings`, href: "/supplier-mappings", icon: "package", tone: "warning" });
  if (pendingApproval) actions.push({ key: "approval", label: "Approver", title: "Review purchase orders waiting for approval", detail: "Self-approval is allowed with a visible warning and audit record; high-value orders may require a senior approver.", value: `${formatIndianNumber(pendingApproval)} POs`, href: "/purchase-orders?status=pending_approval", icon: "shield", tone: "warning" });
  if (approved) actions.push({ key: "dispatch", label: "Buyer", title: "Send approved purchase orders", detail: "Preview the supplier email and confirm all tax, address and delivery fields before dispatch.", value: `${formatIndianNumber(approved)} POs`, href: "/purchase-orders?status=approved", icon: "purchaseOrder", tone: "neutral" });
  if (overdue) actions.push({ key: "overdue", label: "Receiver / buyer", title: "Escalate overdue supplier receipts", detail: "Confirm the supplier ETA, record delivery evidence, or update the PO exception trail.", value: `${formatIndianNumber(overdue)} overdue`, href: "/purchase-orders?overdue=1", icon: "truck", tone: "critical" });
  else if (inTransit) actions.push({ key: "receipt", label: "Receiver", title: "Monitor and record incoming deliveries", detail: "Capture GRN, invoice reference, receipt date and line quantities when stock arrives.", value: `${formatIndianNumber(inTransit)} open`, href: "/purchase-orders?status=issued", icon: "truck", tone: "neutral" });

  const gates: ReadinessGate[] = [
    { key: "data", owner: "Data owner", title: "Current and complete source snapshot", detail: data.automation.safety.canRun ? "Sell-out, inventory and inbound supply pass the current planning gate." : data.automation.safety.blockingReasons[0] || "Source data needs attention.", state: data.automation.safety.canRun ? "ready" : "blocked" },
    { key: "commercial", owner: "Planner / commercial owner", title: "Supplier and draft readiness", detail: blocked.length ? `${formatIndianNumber(blocked.length)} positive recommendation${blocked.length === 1 ? " still needs" : "s still need"} a real supplier, positive INR NLC or source-data correction.` : "Every positive recommendation has the supplier and INR NLC needed for a draft.", state: blocked.length ? "blocked" : "ready" },
    { key: "approval", owner: "Independent approver", title: "Maker–checker decision", detail: pendingApproval ? `${formatIndianNumber(pendingApproval)} PO${pendingApproval === 1 ? " is" : "s are"} waiting for approval.` : "No purchase order is waiting in the approval queue.", state: pendingApproval ? "review" : "ready" },
    { key: "execution", owner: "Buyer and receiver", title: "Supplier dispatch and receipt", detail: overdue ? `${formatIndianNumber(overdue)} in-transit PO${overdue === 1 ? " is" : "s are"} overdue.` : inTransit ? `${formatIndianNumber(inTransit)} PO${inTransit === 1 ? " is" : "s are"} awaiting receipt follow-up.` : approved ? `${formatIndianNumber(approved)} approved PO${approved === 1 ? " is" : "s are"} ready for dispatch.` : "No overdue delivery action is open.", state: overdue ? "blocked" : approved || inTransit ? "review" : "ready" },
  ];
  const clearGates = gates.filter(gate => gate.state === "ready").length;
  const blockedGates = gates.filter(gate => gate.state === "blocked").length;
  const reviewGates = gates.filter(gate => gate.state === "review").length;
  return {
    positiveLines: positive.length,
    positiveUnits: positive.reduce((sum, item) => sum + Number(item.suggestedPoQty || 0), 0),
    positiveValue: positive.reduce((sum, item) => sum + Number(item.estimatedValue || 0), 0),
    readyLines: ready.length,
    blockedLines: blocked.length,
    pendingApproval,
    pendingApprovalValue: value("pending_approval"),
    inTransit,
    overdue,
    actions,
    gates,
    clearGates,
    overallTone: blockedGates ? "blocked" as const : reviewGates ? "review" as const : "ready" as const,
    overallTitle: blockedGates ? "Resolve blockers before the next commitment" : reviewGates ? "Human decisions are waiting" : "The operating gates are clear",
    overallDescription: blockedGates
      ? `${blockedGates} gate${blockedGates === 1 ? " is" : "s are"} blocked${reviewGates ? `; ${reviewGates} more need${reviewGates === 1 ? "s" : ""} review` : ""}.`
      : reviewGates
        ? `${reviewGates} gate${reviewGates === 1 ? " needs" : "s need"} an owner decision; no blocking data issue is open.`
        : "Source data, commercial mapping, approval and receipt gates have no open exception.",
  };
}

type ReadinessAction = { key: string; label: string; title: string; detail: string; value: string; href: string; icon: IconName; tone: "neutral" | "warning" | "critical" };
type ReadinessGate = { key: string; owner: string; title: string; detail: string; state: "ready" | "review" | "blocked" };
