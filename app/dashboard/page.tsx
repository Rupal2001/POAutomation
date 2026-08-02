"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import Icon from "@/components/Icon";
import StatusBadge from "@/components/StatusBadge";
import { EmptyState, LoadingState, MetricCard, PageIntro, SectionHeader, Segment, StatusMessage } from "@/components/Ui";
import { formatBias, formatCompactINR, formatDate, formatDateTime, formatIndianNumber, formatPct } from "@/lib/format";

type View = "executive" | "planner";

export default function DashboardPage() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("executive");
  const [category, setCategory] = useState("");
  const [fc, setFc] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("view") === "planner") setView("planner");
    if (params.get("category")) setCategory(params.get("category")!);
    if (params.get("fc")) setFc(params.get("fc")!);
    fetch("/api/dashboard").then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setData(result);
    }).catch(nextError => setError(nextError.message));
  }, []);

  const planning = data?.planning;
  const filteredItems = useMemo(() => (planning?.items ?? []).filter((item: any) => (!category || item.category === category) && (!fc || item.warehouse === fc)), [planning, category, fc]);
  const filtered = useMemo(() => summarizeItems(filteredItems), [filteredItems]);

  if (error) return <EmptyState title="The overview is unavailable" icon="alert"><p>{error}</p><details className="mt-3 text-left"><summary>Developer details</summary><code>npm run db:init</code></details></EmptyState>;
  if (!data) return <LoadingState>Preparing today&apos;s buying decisions…</LoadingState>;
  if (!planning) return <EmptyState title="No replenishment plan yet" icon="replenishment"><p>Explore the Myntra catalogue demo with synthetic operations, or upload current data to create the first explained recommendation set.</p><Link className="btn-primary" href="/">Create the first plan</Link></EmptyState>;

  const summary = data.summary;
  const atRiskShare = planning.totalLines ? planning.atRiskLines / planning.totalLines * 100 : 0;
  const staleDays = Math.max(0, Math.floor((Date.now() - new Date(`${planning.dataAsOf}T00:00:00+05:30`).getTime()) / 86_400_000));
  const showStale = staleDays > 2;

  return <div>
    <PageIntro
      eyebrow="Myntra fashion supply"
      title={view === "executive" ? "Business inventory brief" : "What needs attention today"}
      description={<>Latest plan uses data through <strong>{formatDate(planning.dataAsOf)}</strong>. {view === "executive" ? "See cash exposure, availability risk and the decisions that need leadership attention." : "Start with urgent stock gaps, then review safe buying recommendations and approvals."}</>}
      actions={<><Segment value={view} onChange={setView} label="Dashboard audience" options={[{ value: "executive", label: "Executive view" }, { value: "planner", label: "Planner view" }]}/><Link href="/" className="btn-primary"><Icon name="plus"/>New plan</Link></>}
    />

    {showStale && <StatusMessage type="warning">This plan uses data from {formatDate(planning.dataAsOf)} ({staleDays} days ago). Upload a newer snapshot before placing new orders.</StatusMessage>}

    {view === "executive" ? <ExecutiveView data={data} planning={planning} atRiskShare={atRiskShare}/> : <PlannerView data={data} planning={planning} category={category} setCategory={setCategory} fc={fc} setFc={setFc} items={filteredItems} summary={filtered}/>}
  </div>;
}

function ExecutiveView({ data, planning, atRiskShare }: { data: any; planning: any; atRiskShare: number }) {
  const summary = data.summary;
  const topRisk = planning.categories?.slice().sort((a: any, b: any) => b.gmvRisk - a.gmvRisk)[0];
  return <>
    <section className="decision-brief">
      <header className="decision-brief-head">
        <div className="decision-brief-title">
          <span className="decision-brief-icon" aria-hidden="true"><Icon name="target"/></span>
          <div>
            <p>Executive decision brief</p>
            <h2>{planning.atRiskLines ? `${planning.atRiskLines} inventory positions need attention` : "Inventory risk is currently controlled"}</h2>
            <span>A leadership snapshot of availability exposure and proposed cash—not booked spend until approval.</span>
          </div>
        </div>
        <Link href="/dashboard?view=planner" className="btn-secondary">Review planner actions <Icon name="arrowRight"/></Link>
      </header>
      <div className="decision-brief-grid">
        <article className="decision-brief-insight decision-brief-risk">
          <span>Availability exposure</span>
          <strong>{formatCompactINR(planning.estimatedGmvAtRisk)}</strong>
          <p>{planning.atRiskLines} of {planning.totalLines} SKU/FC positions ({atRiskShare.toFixed(0)}%) may run out before normal supply arrives.</p>
        </article>
        <article className="decision-brief-insight decision-brief-investment">
          <span>Proposed investment</span>
          <strong>{formatCompactINR(planning.proposedValue)}</strong>
          <p><b>{formatCompactINR(planning.readyValue)}</b> is currently clear of urgent forecast, supplier and pricing blocks.</p>
        </article>
        <article className="decision-brief-insight decision-brief-watch">
          <span>Largest watchpoint</span>
          <strong>{topRisk?.category || "No concentration"}</strong>
          <p>{topRisk ? "This category carries the highest estimated availability exposure. " : "No category concentration is available yet. "}{formatBias(planning.forecastBias) === "Balanced" ? "Portfolio forecasts are broadly balanced." : `Forecasts are tending ${formatBias(planning.forecastBias)}.`}</p>
        </article>
      </div>
    </section>

    <div className="executive-metrics">
      <MetricCard label="Estimated GMV exposure" value={formatCompactINR(planning.estimatedGmvAtRisk)} detail={`${planning.atRiskLines} of ${planning.totalLines} SKU/FC positions · estimate, not guaranteed loss`} tone={planning.atRiskLines ? "critical" : "positive"} icon="alert"/>
      <MetricCard label="Proposed investment" value={formatCompactINR(planning.proposedValue)} detail={`${formatIndianNumber(planning.proposedUnits)} units · before approval and GST`} tone="brand" icon="rupee"/>
      <MetricCard label="Awaiting a decision" value={formatCompactINR(summary.awaiting_value)} detail={`${summary.awaiting_decision} draft or approval-stage POs`} tone={Number(summary.awaiting_decision) ? "warning" : "neutral"} icon="purchaseOrder"/>
      <MetricCard label="Committed investment" value={formatCompactINR(summary.committed_value)} detail={`${summary.committed_orders} approved, sent or part-received POs`} tone="neutral" icon="shield"/>
    </div>

    <div className="executive-grid">
      <section className="panel overflow-hidden">
        <SectionHeader title="Investment by stage" description="Proposed planning need and existing PO workflow are shown separately to prevent double counting." action={<Link href="/purchase-orders" className="text-link">Open POs <Icon name="arrowRight"/></Link>}/>
        <div className="investment-stages">
          <InvestmentStage label="System proposed" value={planning.proposedValue} count={`${planning.totalLines} recommendations`} tone="proposed"/>
          <InvestmentStage label="Safe to draft" value={planning.readyValue} count={`${planning.readyLines} lines passed safeguards`} tone="ready"/>
          <InvestmentStage label="Awaiting decision" value={data.summary.awaiting_value} count={`${data.summary.awaiting_decision} existing POs`} tone="waiting"/>
          <InvestmentStage label="Committed" value={data.summary.committed_value} count={`${data.summary.committed_orders} existing POs`} tone="committed"/>
        </div>
      </section>

      <section className="panel overflow-hidden">
        <SectionHeader title="Forecast reliability" description="Demand-weighted results from recent holdout tests." action={<Link href="/forecast" className="text-link">Inspect models <Icon name="arrowRight"/></Link>}/>
        <div className="reliability-block">
          <div className="reliability-gauge" style={{ "--score": `${Math.max(0, Math.min(100, planning.forecastAccuracy || 0))}%` } as React.CSSProperties}><strong>{formatPct(planning.forecastAccuracy)}</strong><span>historical match</span></div>
          <dl><div><dt>Typical forecast error</dt><dd>{formatPct(planning.forecastWmape)}</dd></div><div><dt>Forecast tendency</dt><dd>{formatBias(planning.forecastBias)}</dd></div><div><dt>Price coverage</dt><dd>{formatPct(planning.dataQuality.priceCoverage)}</dd></div></dl>
        </div>
      </section>
    </div>

    <div className="executive-grid executive-grid-wide">
      <section className="panel overflow-hidden">
        <SectionHeader title="Category investment and risk" description="Bar length is proposed spend share; forecast match is labelled separately."/>
        <div className="category-portfolio">
          {planning.categories.map((item: any) => <Link key={item.category} href={`/dashboard?view=planner&category=${encodeURIComponent(item.category)}`} className="category-row">
            <div className="category-row-title"><strong>{item.category}</strong><span>{item.styles} styles · {item.risk} urgent</span></div>
            <div className="category-row-value"><strong>{formatCompactINR(item.value)}</strong><span>{item.spendShare.toFixed(0)}% of plan</span></div>
            <div className="category-bar" aria-label={`${item.spendShare.toFixed(1)} percent of proposed investment`}><span style={{ width: `${item.spendShare}%` }}/></div>
            <div className="category-row-accuracy"><span>Forecast match</span><strong>{formatPct(item.accuracy)}</strong></div>
          </Link>)}
        </div>
      </section>

      <section className="panel overflow-hidden">
        <SectionHeader title="Leadership decisions" description="Ranked by estimated commercial impact."/>
        <div className="decision-list">
          {planning.exceptions.slice(0, 5).map((item: any, index: number) => <Link key={item.code} href={`/results/${planning.id}?risk=${encodeURIComponent(item.code)}`}>
            <span className={`decision-rank ${index < 2 ? "critical" : ""}`}>{index + 1}</span>
            <div><strong>{friendlyException(item.code)}</strong><p>{exceptionAction(item.code)}</p></div>
            <div className="decision-impact"><strong>{item.impact ? formatCompactINR(item.impact) : `${item.count}`}</strong><span>{item.impact ? "estimated impact" : "affected lines"}{item.earliestDate ? ` · by ${formatDate(item.earliestDate)}` : ""}</span></div>
            <Icon name="chevronRight"/>
          </Link>)}
        </div>
      </section>
    </div>

    <DataHealth planning={planning}/>
  </>;
}

function PlannerView({ data, planning, category, setCategory, fc, setFc, items, summary }: any) {
  const activeFilter = Boolean(category || fc);
  const priorities = items.slice().sort(sortUrgency).slice(0, 8);
  return <>
    <section className="filter-bar" aria-label="Plan filters">
      <div><Icon name="filter"/><strong>Plan scope</strong></div>
      <label><span>Category</span><select className="field" value={category} onChange={event => setCategory(event.target.value)}><option value="">All categories</option>{planning.categories.map((item: any) => <option key={item.category}>{item.category}</option>)}</select></label>
      <label><span>Fulfilment centre</span><select className="field" value={fc} onChange={event => setFc(event.target.value)}><option value="">All FCs</option>{planning.fulfilmentCentres.map((item: any) => <option key={item.warehouse} value={item.warehouse}>{friendlyFc(item.warehouse)}</option>)}</select></label>
      <div className="filter-result"><strong>{items.length}</strong><span>lines in view</span></div>
      {activeFilter && <button className="btn-secondary" onClick={() => { setCategory(""); setFc(""); }}>Reset filters</button>}
    </section>

    <div className="planner-metrics">
      <MetricCard label="Likely to run out before supply" value={summary.risk} detail={`${summary.riskStyles} affected styles in this view`} tone={summary.risk ? "critical" : "positive"} icon="alert"/>
      <MetricCard label="Suggested purchasing" value={formatCompactINR(summary.value)} detail={`${formatIndianNumber(summary.units)} units before GST`} tone="brand" icon="rupee"/>
      <MetricCard label="Ready to order" value={summary.ready} detail={`${items.length - summary.ready} lines need review or no order`} tone="positive" icon="check"/>
      <MetricCard label="Historical forecast match" value={formatPct(summary.accuracy)} detail="Demand-weighted for this view" tone={(summary.accuracy || 0) >= 75 ? "positive" : "warning"} icon="target"/>
    </div>

    <div className="planner-grid">
      <section className="panel overflow-hidden">
        <SectionHeader title="Planner action queue" description="Urgent stock gaps first, then highest-value recommendations." action={<Link href={`/results/${planning.id}`} className="text-link">Open full plan <Icon name="arrowRight"/></Link>}/>
        <div className="planner-actions">
          {priorities.map((item: any) => {
            const critical = item.exceptions?.some((exception: any) => exception.severity === "critical");
            const first = item.exceptions?.[0];
            return <Link key={`${item.warehouse}-${item.sku}`} href={`/results/${planning.id}?q=${encodeURIComponent(item.sku)}`}>
              <span className={`action-indicator ${critical ? "critical" : item.suggestedPoQty > 0 ? "warning" : "neutral"}`}><Icon name={critical ? "alert" : item.suggestedPoQty > 0 ? "replenishment" : "check"}/></span>
              <div className="action-product"><strong>{item.productName || `${item.brand} · ${item.styleId || item.sku}`}</strong><span>{item.brand} · {item.size || "One size"} · {friendlyFc(item.warehouse)}</span></div>
              <div className="action-why"><strong>{first ? friendlyException(first.code) : "No issue found"}</strong><span>{first ? exceptionAction(first.code) : "Recommendation is clear for review."}</span></div>
              <div className="action-value"><strong>{item.suggestedPoQty ? `${formatIndianNumber(item.suggestedPoQty)} units` : "No order"}</strong><span>{formatCompactINR(item.estimatedValue || 0)}</span></div>
              <Icon name="chevronRight"/>
            </Link>;
          })}
          {!priorities.length && <div className="empty-copy">No products match these filters. Reset filters to see the full plan.</div>}
        </div>
      </section>

      <section className="panel overflow-hidden">
        <SectionHeader title="PO decisions" description="Drafts and approvals are not yet committed." action={<Link href="/purchase-orders" className="text-link">Open queue <Icon name="arrowRight"/></Link>}/>
        <div className="po-decision-list">
          {["draft","pending_approval","approved","issued"].map(status => {
            const item = data.byStatus.find((row: any) => row.status === status);
            return <Link key={status} href={`/purchase-orders?status=${status}`}><StatusBadge status={status}/><div><strong>{item?.count || 0} POs</strong><span>{formatCompactINR(item?.value || 0)}</span></div><Icon name="chevronRight"/></Link>;
          })}
        </div>
        <div className="automation-summary"><span className={`status-dot ${data.automation?.enabled ? "" : "inactive"}`}/><div><strong>{data.automation?.enabled ? "Automation configured" : "Manual planning mode"}</strong><span>{data.automation?.enabled ? "Scheduling begins only after deployment is connected." : "Run plans manually; no background schedule is active."}</span></div><Link href="/automation">Review settings</Link></div>
      </section>
    </div>

    <RecentOrders orders={data.recentOrders}/>
    <DataHealth planning={planning}/>
  </>;
}

function RecentOrders({ orders }: { orders: any[] }) {
  return <section className="panel overflow-hidden mt-5">
    <SectionHeader title="Recent purchase orders" description="Existing PO workflow records, shown separately from the proposed plan." action={<Link href="/purchase-orders" className="text-link">All POs <Icon name="arrowRight"/></Link>}/>
    <div className="desktop-table-wrap"><table className="data-table"><caption>Recent Myntra purchase orders</caption><thead><tr><th scope="col">PO number</th><th scope="col">Supplier and FC</th><th scope="col">Status</th><th scope="col">Expected receipt</th><th scope="col" className="text-right">Value</th></tr></thead><tbody>{orders.map(order => <tr key={order.id}><th scope="row"><Link className="po-link" href={`/purchase-orders/${order.id}`}>{order.po_number}</Link><small>Created {formatDate(order.created_at)}</small></th><td><strong>{order.vendor}</strong><small>{friendlyFc(order.warehouse)}</small></td><td><StatusBadge status={order.status}/></td><td>{formatDate(order.expected_delivery_date)}</td><td className="numeric-cell">{formatCompactINR(order.total)}</td></tr>)}</tbody></table></div>
    <div className="mobile-card-list">{orders.map(order => <Link key={order.id} href={`/purchase-orders/${order.id}`} className="mobile-record-card"><div><span className="record-id">{order.po_number}</span><StatusBadge status={order.status}/></div><h3>{order.vendor}</h3><dl><div><dt>FC</dt><dd>{friendlyFc(order.warehouse)}</dd></div><div><dt>Expected</dt><dd>{formatDate(order.expected_delivery_date)}</dd></div><div><dt>Value</dt><dd>{formatCompactINR(order.total)}</dd></div></dl></Link>)}</div>
  </section>;
}

function DataHealth({ planning }: { planning: any }) {
  return <section className="data-health-strip">
    <div><span className="data-health-icon"><Icon name="database"/></span><div><strong>Data used for this decision</strong><span>Snapshot through {formatDate(planning.dataAsOf)} · Plan saved {formatDateTime(planning.createdAt)}</span></div></div>
    <dl><div><dt>Sales records</dt><dd>{formatIndianNumber(planning.dataQuality.salesRows)}</dd></div><div><dt>Inventory positions</dt><dd>{formatIndianNumber(planning.dataQuality.inventoryRows)}</dd></div><div><dt>Incoming PO lines</dt><dd>{formatIndianNumber(planning.dataQuality.openPoRows)}</dd></div><div><dt>Priced recommendations</dt><dd>{formatPct(planning.dataQuality.priceCoverage)}</dd></div></dl>
  </section>;
}

function InvestmentStage({ label, value, count, tone }: { label: string; value: number; count: string; tone: string }) {
  return <div className={`investment-stage stage-${tone}`}><span>{label}</span><strong>{formatCompactINR(value)}</strong><small>{count}</small></div>;
}

function summarizeItems(items: any[]) {
  const weighted = items.filter(item => typeof item.forecastAccuracy === "number").map(item => ({ value: item.forecastAccuracy, weight: Math.max(1, item.dailyRunRate || 0) }));
  const weight = weighted.reduce((total, item) => total + item.weight, 0);
  const critical = items.filter(item => item.exceptions?.some((exception: any) => exception.severity === "critical"));
  return {
    risk: critical.length,
    riskStyles: new Set(critical.map(item => item.styleId || item.sku)).size,
    value: items.reduce((total, item) => total + Number(item.estimatedValue || 0), 0),
    units: items.reduce((total, item) => total + Number(item.suggestedPoQty || 0), 0),
    ready: items.filter(item => item.poReady === true).length,
    accuracy: weight ? weighted.reduce((total, item) => total + item.value * item.weight, 0) / weight : null,
  };
}

function sortUrgency(a: any, b: any) {
  const severity = (item: any) => item.exceptions?.some((exception: any) => exception.severity === "critical") ? 3 : item.exceptions?.some((exception: any) => exception.severity === "warning") ? 2 : item.suggestedPoQty > 0 ? 1 : 0;
  return severity(b) - severity(a) || Number(b.estimatedGmvAtRisk || b.estimatedValue || 0) - Number(a.estimatedGmvAtRisk || a.estimatedValue || 0);
}

function friendlyFc(value: string) { return ({ BLR_FC: "Bengaluru FC", DEL_FC: "Delhi FC", MUM_FC: "Mumbai FC", KOL_FC: "Kolkata FC" } as Record<string,string>)[value] || value.replaceAll("_", " "); }
function friendlyException(code: string) { const key = exceptionKey(code); return ({ STOCKOUT_BEFORE_RECEIPT: "Stock may run out before supply arrives", BACKORDERS: "Customer orders are waiting", LOW_FORECAST_ACCURACY: "Forecast needs review", HIGH_RETURNS: "Returns are unusually high", LATE_SUPPLY: "Incoming stock arrives too late", MISSING_PRICE: "Supplier cost is missing", MISSING_VENDOR: "Supplier mapping required", MISSING_SUPPLIER: "Supplier mapping required", MISSING_COMMERCIAL_DATA: "Supplier terms are incomplete", MOQ_OVERSTOCK: "Supplier minimum creates excess", LOW_DATA_QUALITY: "Demand history has gaps", EXCESS_INVENTORY: "Inventory is above target", END_OF_LIFE: "End-of-life stock needs control" } as Record<string,string>)[key] || key.replaceAll("_", " ").toLowerCase(); }
function exceptionAction(code: string) { const key = exceptionKey(code); return ({ STOCKOUT_BEFORE_RECEIPT: "Approve a transfer or expedite plan before the gap.", BACKORDERS: "Protect allocation and confirm supplier action.", LOW_FORECAST_ACCURACY: "Review the event, trend and buying quantity.", HIGH_RETURNS: "Check fit, quality and return assumptions before buying.", LATE_SUPPLY: "Confirm a faster ETA or replacement source.", MISSING_PRICE: "Add a valid INR cost before a draft can be created.", MISSING_VENDOR: "Map an approved supplier before creating a PO.", MISSING_SUPPLIER: "Map an approved supplier before creating a PO.", MISSING_COMMERCIAL_DATA: "Complete the supplier cost, tax and ordering terms.", MOQ_OVERSTOCK: "Decide whether the minimum order is commercially justified.", LOW_DATA_QUALITY: "Validate availability and recent sales history.", EXCESS_INVENTORY: "Pause buying or plan markdown/redistribution.", END_OF_LIFE: "Suppress replenishment and clear residual stock." } as Record<string,string>)[key] || "Open the recommendation and record a decision."; }
function exceptionKey(code: string) { return String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, ""); }
