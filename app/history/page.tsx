"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Icon from "@/components/Icon";
import StatusBadge from "@/components/StatusBadge";
import { EmptyState, LoadingState, MetricCard, PageIntro } from "@/components/Ui";
import { formatBias, formatCompactINR, formatDate, formatDateTime, formatIndianNumber, formatPct } from "@/lib/format";

export default function HistoryPage() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => { fetch("/api/batches").then(async response => { const result=await response.json(); if(!response.ok)throw new Error(result.error);setRows(result.batches); }).catch(nextError=>setError(nextError.message)); }, []);
  const visible = useMemo(() => (rows ?? []).filter(row => (!search || `${row.label} ${row.id} ${row.trigger_type}`.toLowerCase().includes(search.toLowerCase())) && (!status || row.status === status) && (!from || new Date(row.created_at) >= new Date(`${from}T00:00:00`))), [rows,search,status,from]);
  const compared = selected.map(id => rows?.find(row=>row.id===id)).filter(Boolean);

  if(error)return<EmptyState title="Plan history is unavailable" icon="alert"><p>{error}</p></EmptyState>;
  if(!rows)return<LoadingState>Loading saved planning decisions…</LoadingState>;
  if(!rows.length)return<EmptyState title="No saved plans yet" icon="history"><p>Build a plan to create the first traceable recommendation record.</p><Link className="btn-primary" href="/">Create a plan</Link></EmptyState>;
  const latest=rows[0];

  function toggle(id:string){setSelected(current=>current.includes(id)?current.filter(value=>value!==id):current.length<2?[...current,id]:[current[1],id])}

  return <div>
    <PageIntro eyebrow="Planning governance" title="Plan history" description="See which data and assumptions produced each recommendation, which POs were created, and how results changed between runs." actions={<Link href="/" className="btn-primary"><Icon name="plus"/>New planning run</Link>}/>
    <div className="history-kpis"><MetricCard label="Saved plan versions" value={rows.length} detail="Archived versions remain traceable" icon="history"/><MetricCard label="Latest proposed investment" value={formatCompactINR(latest.recommended_value)} detail={`${formatIndianNumber(latest.recommended_units)} units`} tone="brand" icon="rupee"/><MetricCard label="Latest forecast match" value={formatPct(latest.forecast_accuracy)} detail={`${formatPct(latest.forecast_wmape)} typical error`} tone={Number(latest.forecast_accuracy)>=75?"positive":"warning"} icon="target"/><MetricCard label="POs created from latest plan" value={latest.po_count} detail="Draft through received stages" icon="purchaseOrder"/></div>

    {compared.length===2&&<section className="compare-panel"><div className="compare-head"><div><p className="eyebrow">Run comparison</p><h2>What changed?</h2></div><button className="btn-secondary" onClick={()=>setSelected([])}>Clear comparison</button></div><div className="compare-runs"><RunLabel row={compared[1]}/><span><Icon name="arrowRight"/></span><RunLabel row={compared[0]}/></div><div className="compare-metrics"><CompareMetric label="Proposed value" oldValue={Number(compared[1].recommended_value)} newValue={Number(compared[0].recommended_value)} format={formatCompactINR}/><CompareMetric label="Recommended units" oldValue={Number(compared[1].recommended_units)} newValue={Number(compared[0].recommended_units)} format={value=>formatIndianNumber(value)}/><CompareMetric label="Urgent issues" oldValue={Number(compared[1].critical_rows)} newValue={Number(compared[0].critical_rows)} format={String}/><CompareMetric label="Forecast match" oldValue={Number(compared[1].forecast_accuracy)} newValue={Number(compared[0].forecast_accuracy)} format={value=>formatPct(value)}/></div></section>}

    <section className="panel overflow-hidden history-panel">
      <div className="history-toolbar"><div><h2 className="section-title">Saved planning records</h2><p className="section-description">Select two complete runs to compare their decisions.</p></div><div className="history-filters"><label className="history-search"><span className="sr-only">Search plans</span><Icon name="search"/><input className="field" value={search} onChange={event=>setSearch(event.target.value)} placeholder="Search plan name or ID…"/></label><label><span>Created from</span><input className="field" type="date" value={from} onChange={event=>setFrom(event.target.value)}/></label><label><span>Status</span><select className="field" value={status} onChange={event=>setStatus(event.target.value)}><option value="">All statuses</option><option value="generated">Plan ready</option><option value="uploaded">Data uploaded</option><option value="archived">Archived</option></select></label>{(search||from||status)&&<button className="btn-secondary" onClick={()=>{setSearch("");setFrom("");setStatus("")}}>Reset</button>}</div></div>
      <div className="workbench-result-summary"><span><strong>{visible.length}</strong> plan versions shown</span><span><strong>{selected.length} / 2</strong> selected to compare</span></div>
      <div className="desktop-table-wrap"><table className="data-table history-table"><caption>Saved planning run history</caption><thead><tr><th scope="col">Compare</th><th scope="col">Plan and data date</th><th scope="col">Status</th><th scope="col" className="text-right">Sales records</th><th scope="col" className="text-right">Proposed units</th><th scope="col" className="text-right">Proposed value</th><th scope="col" className="text-right">Forecast match</th><th scope="col" className="text-right">Urgent issues</th><th scope="col" className="text-right">POs</th><th scope="col"><span className="sr-only">Review</span></th></tr></thead><tbody>{visible.map(row=><tr key={row.id}><td><input aria-label={`Compare ${row.label||row.id}`} type="checkbox" disabled={!selected.includes(row.id)&&selected.length>=2} checked={selected.includes(row.id)} onChange={()=>toggle(row.id)}/></td><th scope="row"><Link href={`/results/${row.id}`}><strong>{row.label||"Unnamed planning run"}</strong><span>{row.trigger_type||"Planner run"} · {row.coverage_days}-day plan</span><small>Data through {formatDate(row.data_as_of)} · saved {formatDateTime(row.created_at)}</small></Link></th><td><StatusBadge status={row.status}/></td><td className="numeric-cell">{formatIndianNumber(row.sales_rows)}</td><td className="numeric-cell">{formatIndianNumber(row.recommended_units)}</td><td className="numeric-cell"><strong>{formatCompactINR(row.recommended_value)}</strong></td><td className="numeric-cell"><strong>{formatPct(row.forecast_accuracy)}</strong><small>{formatBias(row.forecast_bias)}</small></td><td className={`numeric-cell ${Number(row.critical_rows)>0?"critical-copy":""}`}>{row.critical_rows}</td><td className="numeric-cell">{row.po_count}</td><td><Link className="row-open" aria-label={`Review ${row.label||row.id}`} href={`/results/${row.id}`}><Icon name="chevronRight"/></Link></td></tr>)}</tbody></table></div>
      <div className="mobile-card-list history-mobile-list">{visible.map(row=><article className="history-card" key={row.id}><div className="history-card-top"><label><input type="checkbox" disabled={!selected.includes(row.id)&&selected.length>=2} checked={selected.includes(row.id)} onChange={()=>toggle(row.id)}/><span>Compare</span></label><StatusBadge status={row.status}/></div><Link href={`/results/${row.id}`}><h3>{row.label||"Unnamed planning run"}</h3><p>{formatDateTime(row.created_at)} · data through {formatDate(row.data_as_of)}</p><dl><div><dt>Proposed</dt><dd>{formatCompactINR(row.recommended_value)}</dd></div><div><dt>Units</dt><dd>{formatIndianNumber(row.recommended_units)}</dd></div><div><dt>Forecast match</dt><dd>{formatPct(row.forecast_accuracy)}</dd></div><div><dt>Urgent</dt><dd className={Number(row.critical_rows)>0?"critical-copy":""}>{row.critical_rows}</dd></div></dl><span className="history-review">Review plan <Icon name="arrowRight"/></span></Link></article>)}</div>
      {!visible.length&&<div className="workbench-empty"><Icon name="history"/><h3>No saved plans match</h3><p>Reset the filters to see the full history.</p><button className="btn-secondary" onClick={()=>{setSearch("");setFrom("");setStatus("")}}>Reset filters</button></div>}
    </section>
  </div>;
}

function RunLabel({row}:{row:any}){return<div><strong>{row.label||"Planning run"}</strong><span>{formatDateTime(row.created_at)}</span></div>}
function CompareMetric({label,oldValue,newValue,format}:{label:string;oldValue:number;newValue:number;format:(value:number)=>string}){const delta=newValue-oldValue;return<div><span>{label}</span><strong>{format(newValue)}</strong><small className={delta>0?"delta-up":delta<0?"delta-down":""}>{delta===0?"No change":`${delta>0?"+":""}${format(delta)} versus earlier`}</small></div>}
