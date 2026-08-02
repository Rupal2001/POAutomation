"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import Icon from "@/components/Icon";
import StatusBadge from "@/components/StatusBadge";
import { EmptyState, LoadingState, MetricCard, PageIntro, Segment, StatusMessage } from "@/components/Ui";
import { formatCompactINR, formatDate, formatIndianNumber } from "@/lib/format";
import { canonicalIsoCalendarDate, todayInIndia } from "@/lib/po-readiness";

type StatusView = "active" | "needs_action" | "draft" | "pending_approval" | "approved" | "issued" | "received" | "cancelled";
type QueuePermissions = { canApprove: boolean; canReturnToDraft: boolean };
type QueueOrder = Record<string, any> & { id: string; po_number: string; status: string; revision: number; permissions?: QueuePermissions };
type QueueUser = { id: string; displayName: string; role: string };
type RowDecision = { order: QueueOrder; action: "approved" | "draft"; note: string };

export default function PurchaseOrdersPage() {
  const [orders, setOrders] = useState<QueueOrder[] | null>(null);
  const [currentUser, setCurrentUser] = useState<QueueUser | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<StatusView>("active");
  const [search, setSearch] = useState("");
  const [supplier, setSupplier] = useState("");
  const [fc, setFc] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [createdMessage, setCreatedMessage] = useState(false);
  const [actionNotice, setActionNotice] = useState("");
  const [decision, setDecision] = useState<RowDecision | null>(null);
  const [decisionError, setDecisionError] = useState("");
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);

  async function loadOrders() {
    const response = await fetch("/api/purchase-orders", { cache: "no-store" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Could not load purchase orders.");
    setOrders(result.purchaseOrders);
    setCurrentUser(result.currentUser ?? null);
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("status") as StatusView | null;
    if (requested && ["active","draft","pending_approval","approved","issued","received","cancelled"].includes(requested)) setStatus(requested);
    setCreatedMessage(params.get("created") === "1");
    loadOrders().catch(nextError => setError(nextError.message));
  }, []);

  useEffect(() => {
    if (!decision) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyOrderId) setDecision(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [decision, busyOrderId]);

  const visible = useMemo(() => (orders ?? []).filter(order => {
    const textMatch = !search || `${order.po_number} ${order.vendor} ${order.warehouse} ${(order.lines || []).map((line:any)=>line.sku).join(" ")}`.toLowerCase().includes(search.toLowerCase());
    const statusMatch = status === "active"
      ? !["cancelled","received","closed"].includes(order.status)
      : status === "needs_action"
        ? ["draft","pending_approval"].includes(order.status)
        : status === "received"
          ? ["received","closed"].includes(order.status)
          : order.status === status;
    const isOverdue = overdue(order);
    return textMatch && statusMatch && (!supplier || order.vendor === supplier) && (!fc || order.warehouse === fc) && (!overdueOnly || isOverdue);
  }).sort(sortOrders), [orders, search, status, supplier, fc, overdueOnly]);

  function openDecision(order: QueueOrder, action: RowDecision["action"]) {
    setDecision({ order, action, note: "" });
    setDecisionError("");
    setActionNotice("");
  }

  async function confirmDecision() {
    if (!decision) return;
    if (decision.action === "draft" && !decision.note.trim()) {
      setDecisionError("Explain why this PO is being returned so the planner has a clear audit trail.");
      return;
    }
    setBusyOrderId(decision.order.id);
    setDecisionError("");
    try {
      const response = await fetch(`/api/purchase-orders/${decision.order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: decision.order.revision,
          action: decision.action,
          ...(decision.action === "draft" ? { note: decision.note.trim() } : {}),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "The approval action could not be completed.");
      setOrders(current => current?.map(order => order.id === decision.order.id
        ? { ...order, status: result.status, revision: Number(result.revision) }
        : order) ?? null);
      const message = decision.action === "approved"
        ? `${decision.order.po_number} was approved. The server recorded the approver and audit event.`
        : `${decision.order.po_number} was returned to draft with your reason.`;
      setDecision(null);
      setActionNotice(message);
      try {
        await loadOrders();
      } catch {
        setActionNotice(`${message} Reload the queue to refresh any other changes.`);
      }
    } catch (nextError) {
      setDecisionError(nextError instanceof Error ? nextError.message : "The approval action could not be completed.");
    } finally {
      setBusyOrderId(null);
    }
  }

  if (error) return <EmptyState title="Purchase orders are unavailable" icon="alert"><p>{error}</p></EmptyState>;
  if (!orders) return <LoadingState>Loading the purchase-order decision queue…</LoadingState>;

  const awaiting = orders.filter(order => ["draft","pending_approval"].includes(order.status));
  const committed = orders.filter(order => ["approved","issued","partially_received"].includes(order.status));
  const late = orders.filter(overdue);
  const countFor = (value: StatusView) => value === "active" ? orders.filter(order => !["cancelled","received","closed"].includes(order.status)).length : value === "needs_action" ? awaiting.length : value === "received" ? orders.filter(order => ["received","closed"].includes(order.status)).length : orders.filter(order => order.status === value).length;
  const supplierChoices = unique(orders.filter(order => status === "cancelled" ? order.status === "cancelled" : order.status !== "cancelled").map(order => order.vendor));

  return <div>
    <PageIntro eyebrow="Buying operations" title="Purchase orders" description="Review drafts, approve spend, confirm orders sent to suppliers and record deliveries. Each stage shows whether money is proposed or committed." actions={<Link className="btn-primary" href="/"><Icon name="plus"/>Build a replenishment plan</Link>}/>
    {createdMessage && <StatusMessage>Draft purchase orders were created. Nothing has been sent to suppliers.</StatusMessage>}
    {actionNotice && <StatusMessage>{actionNotice}</StatusMessage>}

    <div className="po-kpis">
      <MetricCard label="Needs a decision" value={awaiting.length} detail={`${formatCompactINR(sum(awaiting,"total"))} in draft or approval—not committed`} tone={awaiting.length ? "warning" : "positive"} icon="alert"/>
      <MetricCard label="Committed investment" value={formatCompactINR(sum(committed,"total"))} detail={`${committed.length} approved, sent or part-received POs`} tone="brand" icon="shield"/>
      <MetricCard label="Sent and in transit" value={orders.filter(order=>["issued","partially_received"].includes(order.status)).length} detail={`${formatIndianNumber(orders.filter(order=>["issued","partially_received"].includes(order.status)).reduce((total,order)=>total+units(order),0))} ordered units`} icon="truck"/>
      <MetricCard label="Overdue receipts" value={late.length} detail={`${formatCompactINR(sum(late,"total"))} needs supplier follow-up`} tone={late.length ? "critical" : "positive"} icon="calendar"/>
    </div>

    <section className="panel overflow-hidden po-queue-panel">
      <div className="po-view-tabs"><Segment value={status} onChange={value=>{setStatus(value);setSupplier("")}} label="Purchase order view" options={[{value:"active",label:"Active",count:countFor("active")},{value:"needs_action",label:"Needs my action",count:countFor("needs_action")},{value:"draft",label:"Draft",count:countFor("draft")},{value:"pending_approval",label:"Waiting approval",count:countFor("pending_approval")},{value:"approved",label:"Approved",count:countFor("approved")},{value:"issued",label:"Sent",count:countFor("issued")},{value:"received",label:"Received",count:countFor("received")},{value:"cancelled",label:"Cancelled history",count:countFor("cancelled")}]}/></div>
      <div className="po-filter-row">
        <label className="po-search"><span className="sr-only">Search purchase orders</span><Icon name="search"/><input className="field" placeholder="Search PO, supplier, SKU or FC…" value={search} onChange={event=>setSearch(event.target.value)}/></label>
        <label><span>Supplier</span><select className="field" value={supplier} onChange={event=>setSupplier(event.target.value)}><option value="">All suppliers</option>{supplierChoices.map(value=><option key={value}>{value}</option>)}</select></label>
        <label><span>Fulfilment centre</span><select className="field" value={fc} onChange={event=>setFc(event.target.value)}><option value="">All FCs</option>{unique(orders.map(order=>order.warehouse)).map(value=><option key={value} value={value}>{friendlyFc(value)}</option>)}</select></label>
        <label className="overdue-toggle"><input type="checkbox" checked={overdueOnly} onChange={event=>setOverdueOnly(event.target.checked)}/><span>Overdue only</span></label>
        {(search||supplier||fc||overdueOnly)&&<button className="btn-secondary" onClick={()=>{setSearch("");setSupplier("");setFc("");setOverdueOnly(false)}}>Reset</button>}
      </div>
      <div className="workbench-result-summary"><span><strong>{visible.length}</strong> POs shown</span><span><strong>{formatCompactINR(sum(visible,"total"))}</strong> total value in this view</span></div>

      <div className="desktop-table-wrap"><table className="data-table po-table"><caption>Myntra purchase order decision queue</caption><thead><tr><th scope="col">PO and next action</th><th scope="col">Supplier and FC</th><th scope="col">Status</th><th scope="col">Receipt progress</th><th scope="col">Expected receipt</th><th scope="col" className="text-right">PO value</th><th scope="col">Decision</th></tr></thead><tbody>{visible.map(order=>{
        const ordered=units(order);const received=receivedUnits(order);const lateOrder=overdue(order);const progress=ordered?received/ordered*100:0;
        return <tr key={order.id}><th scope="row"><Link className="po-link" href={`/purchase-orders/${order.id}`}>{order.po_number}</Link><strong className="po-next-action">{nextAction(order.status)}</strong><small>Created {formatDate(order.created_at)}</small></th><td><strong>{order.vendor}</strong><small>{friendlyFc(order.warehouse)} · {order.lines?.length||0} line{order.lines?.length===1?"":"s"}</small></td><td><StatusBadge status={order.status}/></td><td><div className="receipt-progress"><div role="progressbar" aria-label={`${received} of ${ordered} units received`} aria-valuemin={0} aria-valuemax={ordered} aria-valuenow={received}><span style={{width:`${progress}%`}}/></div><span>{formatIndianNumber(received)} / {formatIndianNumber(ordered)} units</span></div></td><td><strong className={lateOrder?"critical-copy":""}>{formatDate(order.expected_delivery_date)}</strong>{lateOrder&&<small className="critical-copy">{daysLate(order)} days overdue</small>}</td><td className="numeric-cell"><strong>{formatCompactINR(order.total)}</strong><small>{order.currency}</small></td><td><QueueRowActions order={order} busy={busyOrderId===order.id} onDecision={openDecision}/></td></tr>;
      })}</tbody></table></div>

      <div className="mobile-card-list po-mobile-list">{visible.map(order=>{
        const ordered=units(order);const received=receivedUnits(order);const lateOrder=overdue(order);
        return <article className="po-card" key={order.id}><Link className="po-card-link" href={`/purchase-orders/${order.id}`}><div className="po-card-top"><span className="record-id">{order.po_number}</span><StatusBadge status={order.status}/></div><h3>{order.vendor}</h3><p>{friendlyFc(order.warehouse)} · {order.lines?.length||0} lines</p><div className="po-card-action"><span>Next action</span><strong>{nextAction(order.status)}</strong></div><dl><div><dt>Value</dt><dd>{formatCompactINR(order.total)}</dd></div><div><dt>Expected</dt><dd className={lateOrder?"critical-copy":""}>{formatDate(order.expected_delivery_date)}</dd></div><div><dt>Received</dt><dd>{formatIndianNumber(received)} / {formatIndianNumber(ordered)}</dd></div></dl><div className="receipt-progress"><div role="progressbar" aria-label={`${received} of ${ordered} units received`} aria-valuemin={0} aria-valuemax={ordered} aria-valuenow={received}><span style={{width:`${ordered?received/ordered*100:0}%`}}/></div></div></Link>{hasQueueActions(order)&&<div className="po-card-decisions"><QueueDecisionButtons order={order} busy={busyOrderId===order.id} onDecision={openDecision}/></div>}</article>;
      })}</div>
      {!visible.length&&<div className="workbench-empty"><Icon name="purchaseOrder"/><h3>No purchase orders match this view</h3><p>Reset filters or choose another status.</p><button className="btn-secondary" onClick={()=>{setStatus("active");setSearch("");setSupplier("");setFc("");setOverdueOnly(false)}}>Show active POs</button></div>}
    </section>

    {decision&&<div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!busyOrderId)setDecision(null)}}><section className="modal-card po-queue-decision-modal" role="dialog" aria-modal="true" aria-labelledby="queue-decision-title"><div className="modal-head"><div><p className="eyebrow">Purchase-order decision</p><h2 id="queue-decision-title">{decision.action==="approved"?`Approve ${decision.order.po_number}?`:`Return ${decision.order.po_number} to draft?`}</h2><p>{decision.action==="approved"?`${formatCompactINR(decision.order.total)} will move into approved investment.`:"The planner can edit and resubmit it after addressing your reason."}</p></div><button className="icon-button" type="button" aria-label="Close approval dialog" disabled={Boolean(busyOrderId)} onClick={()=>setDecision(null)}><Icon name="close"/></button></div><div className="modal-body">{decisionError&&<StatusMessage type="error">{decisionError}</StatusMessage>}{decision.action==="approved"&&isSelfApproval(decision.order,currentUser)&&<StatusMessage type="warning">You created this PO. Approving it yourself will be recorded as a self-approval in the audit trail.</StatusMessage>}{decision.action==="draft"&&<label><span className="field-label">Reason for returning (required)</span><textarea className="field min-h-24" autoFocus maxLength={4000} value={decision.note} onChange={event=>{setDecision({...decision,note:event.target.value});setDecisionError("")}} placeholder="Explain what the planner must correct before resubmitting…"/></label>}</div><div className="modal-footer"><button className="btn-secondary" type="button" disabled={Boolean(busyOrderId)} onClick={()=>setDecision(null)}>Cancel</button><button className={decision.action==="approved"?"btn-primary":"btn-secondary"} type="button" autoFocus={decision.action==="approved"} disabled={Boolean(busyOrderId)||(decision.action==="draft"&&!decision.note.trim())} onClick={confirmDecision}>{busyOrderId?"Saving…":decision.action==="approved"?"Confirm approval":"Return to draft"}</button></div></section></div>}
  </div>;
}

function QueueRowActions({order,busy,onDecision}:{order:QueueOrder;busy:boolean;onDecision:(order:QueueOrder,action:RowDecision["action"])=>void}) {
  return <div className="po-row-actions">{hasQueueActions(order)&&<QueueDecisionButtons order={order} busy={busy} onDecision={onDecision}/>}<Link className="row-open" aria-label={`Open ${order.po_number}`} href={`/purchase-orders/${order.id}`}><Icon name="chevronRight"/></Link></div>;
}

function QueueDecisionButtons({order,busy,onDecision}:{order:QueueOrder;busy:boolean;onDecision:(order:QueueOrder,action:RowDecision["action"])=>void}) {
  return <div className="po-decision-buttons">{order.permissions?.canApprove&&<button type="button" className="btn-primary po-decision-button" disabled={busy} onClick={()=>onDecision(order,"approved")}><Icon name="check"/>Approve</button>}{order.permissions?.canReturnToDraft&&<button type="button" className="btn-secondary po-decision-button" disabled={busy} onClick={()=>onDecision(order,"draft")}><Icon name="refresh"/>Return</button>}</div>;
}

function hasQueueActions(order:QueueOrder){return order.status==="pending_approval"&&Boolean(order.permissions?.canApprove||order.permissions?.canReturnToDraft)}
function isSelfApproval(order:QueueOrder,user:QueueUser|null){return Boolean(user&&(order.created_by_user_id?order.created_by_user_id===user.id:order.created_by===user.displayName))}
function units(order:any){return(order.lines||[]).reduce((total:number,line:any)=>total+Number(line.quantity||0),0)}
function receivedUnits(order:any){return(order.lines||[]).reduce((total:number,line:any)=>total+Number(line.receivedQty||0),0)}
function sum(rows:any[],field:string){return rows.reduce((total,row)=>total+Number(row[field]||0),0)}
function overdue(order:any){const due=canonicalIsoCalendarDate(order.expected_delivery_date);return Boolean(due&&due<todayInIndia()&&["issued","partially_received"].includes(order.status))}
function daysLate(order:any){const due=canonicalIsoCalendarDate(order.expected_delivery_date);if(!due)return 0;return Math.max(0,Math.round((Date.parse(`${todayInIndia()}T00:00:00Z`)-Date.parse(`${due}T00:00:00Z`))/86_400_000))}
function nextAction(status:string){return({draft:"Complete and submit for approval",pending_approval:"Approve or return with a reason",approved:"Confirm the PO was sent",issued:"Track supplier receipt",partially_received:"Record remaining delivery",received:"Close after invoice checks",closed:"No action required",cancelled:"No action required"}as Record<string,string>)[status]||"Review order"}
function unique(values:string[]){return[...new Set(values.filter(Boolean))].sort()}
function friendlyFc(value:string){return({BLR_FC:"Bengaluru FC",DEL_FC:"Delhi FC",MUM_FC:"Mumbai FC",KOL_FC:"Kolkata FC"}as Record<string,string>)[value]||value.replaceAll("_"," ")}
function sortOrders(a:any,b:any){const rank=(order:any)=>overdue(order)?5:order.status==="pending_approval"?4:order.status==="draft"?3:order.status==="approved"?2:order.status==="issued"?1:0;return rank(b)-rank(a)||new Date(b.updated_at).getTime()-new Date(a.updated_at).getTime()}
