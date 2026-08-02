"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import Icon from "@/components/Icon";
import { Definition, EmptyState, InfoNote, LoadingState, MetricCard, PageIntro, SectionHeader } from "@/components/Ui";
import { formatBias, formatDate, formatIndianNumber, formatPct } from "@/lib/format";

export default function ForecastPage() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [technical, setTechnical] = useState(false);

  useEffect(() => {
    fetch("/api/forecast").then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setData(result);
    }).catch(nextError => setError(nextError.message));
  }, []);

  const rows = useMemo(() => (data?.rows ?? []).filter((row: any) => {
    const textMatch = !query || [row.sku,row.styleId,row.productName,row.brand,row.category,row.warehouse].join(" ").toLowerCase().includes(query.toLowerCase());
    const decision = forecastDecision(row);
    return textMatch && (!status || decision.key === status);
  }), [data, query, status]);

  if (error) return <EmptyState title="Forecast health is unavailable" icon="alert"><p>{error}</p></EmptyState>;
  if (!data) return <LoadingState>Testing forecast methods against recent actual demand…</LoadingState>;
  if (!data.batch) return <EmptyState title="No forecast has been tested yet" icon="forecast"><p>Build a replenishment plan to compare forecasting methods against known sales.</p><Link className="btn-primary" href="/">Create the first plan</Link></EmptyState>;

  const summary = data.summary;
  return <div>
    <PageIntro
      eyebrow="Forecast health"
      title="Can we trust this forecast?"
      description={<>Each SKU and fulfilment centre was tested against recent known demand. Review large errors or a consistent high/low tendency before buying. Data through <strong>{formatDate(data.batch.dataAsOf)}</strong>.</>}
      actions={<Link className="btn-primary" href={`/results/${data.batch.id}`}><Icon name="arrowRight"/>Review latest recommendations</Link>}
    />

    <div className="forecast-kpis">
      <MetricCard label="Typical forecast error" value={formatPct(summary.wmape)} detail="Difference from actual demand · lower is better" tone={(summary.wmape ?? 100) <= 25 ? "positive" : "warning"} icon="target"/>
      <MetricCard label="Historical match" value={formatPct(summary.accuracy)} detail={`${summary.evaluatedRows} SKU/FC forecasts tested`} tone={(summary.accuracy ?? 0) >= 75 ? "positive" : "warning"} icon="forecast"/>
      <MetricCard label="Forecast tendency" value={formatBias(summary.bias)} detail="Portfolio direction: high or low" tone={Math.abs(summary.bias ?? 100) <= 10 ? "positive" : "warning"} icon="replenishment"/>
      <MetricCard label="Ready for automatic drafts" value={`${summary.readyForAutomation} / ${data.rows.length}`} detail="Eligible for drafts only—not approval or sending" tone="brand" icon="shield"/>
    </div>

    <div className="forecast-signal-strip">
      <Signal icon="database" value={formatIndianNumber(summary.stockoutCorrectedDays)} title="Unavailable sales days excluded" detail="Zero sales during known stockouts did not suppress demand."/>
      <Signal icon="calendar" value={formatIndianNumber(summary.promotionAdjustedDays)} title="Promotion days normalised" detail="Historic campaign spikes were removed from the everyday baseline."/>
      <Signal icon="history" value={formatIndianNumber(summary.dataLatencyDays)} title="Latest data gap in days" detail={summary.dataLatencyDays ? "Newer sales are needed for a current plan." : "Sales data reaches the planning date."}/>
    </div>

    <InfoNote title="Accuracy and data quality are different">
      <p><strong>Forecast match</strong> tells you how well the model predicted recent demand. <strong>Data grade</strong> tells you whether there was enough complete, in-stock history. A long history can still produce a poor forecast.</p>
      {data.batch.settings?.calculationMethod === "style_drr_cover_v1" && <p><strong>For New PO plans, this forecast is supporting evidence only.</strong> The approved order quantity continues to use sales ÷ unique selling days as DRR; the model rate and range shown here never replace that formula.</p>}
    </InfoNote>

    <div className="forecast-grid">
      <section className="panel overflow-hidden">
        <SectionHeader title="Accuracy distribution" description="Number of SKU/FC forecasts in each historical-match band."/>
        <div className="accuracy-bands">
          {summary.bands.map((band: any, index: number) => <div key={band.label} className={`accuracy-band band-${index}`}><div><strong>{band.label}</strong><span>{band.count} forecasts</span></div><div className="band-track"><span style={{ width: `${data.rows.length ? band.count / data.rows.length * 100 : 0}%` }}/></div><em>{data.rows.length ? (band.count / data.rows.length * 100).toFixed(0) : 0}%</em></div>)}
        </div>
      </section>

      <section className="panel overflow-hidden">
        <SectionHeader title="Model mix" description="Auto mode chooses a champion or an ensemble only when backtests support it."/>
        <div className="model-mix">
          {summary.models.map((model: any) => <div key={model.model}><div><strong>{model.model}</strong><span>{model.count} forecasts · {model.share.toFixed(0)}%</span></div><div><span style={{ width: `${model.share}%` }}/></div></div>)}
        </div>
      </section>
    </div>

    <section className="panel overflow-hidden forecast-scorecard">
      <div className="toolbar forecast-toolbar">
        <div><h2 className="section-title">Forecast review queue</h2><p className="section-description">Start with “Review forecast”; open technical detail only when needed.</p></div>
        <div className="forecast-filters">
          <label><span className="sr-only">Search forecasts</span><div className="field-with-icon"><Icon name="search"/><input className="field" placeholder="Search product, SKU or FC…" value={query} onChange={event => setQuery(event.target.value)}/></div></label>
          <label><span className="sr-only">Forecast decision</span><select className="field" value={status} onChange={event => setStatus(event.target.value)}><option value="">All decisions</option><option value="ready">Reliable enough to use</option><option value="review">Review forecast</option><option value="blocked">Do not automate</option></select></label>
          <label className="technical-toggle"><input type="checkbox" checked={technical} onChange={event => setTechnical(event.target.checked)}/><span>Show technical detail</span></label>
        </div>
      </div>

      <div className="desktop-table-wrap"><table className="data-table forecast-table"><caption>Forecast health by Myntra fashion SKU and fulfilment centre</caption><thead><tr><th scope="col">Product</th><th scope="col">Decision</th><th scope="col" className="text-right">Historical match</th><th scope="col">Forecast tendency</th><th scope="col">Data grade</th>{technical && <><th scope="col">Selected method</th><th scope="col" className="text-right"><Definition term="WAPE">Demand-weighted absolute forecast error. Lower is better.</Definition></th></>}<th scope="col" className="text-right">Forecast evidence / day</th></tr></thead><tbody>{rows.map((row: any) => {
        const decision = forecastDecision(row);
        return <tr key={`${row.warehouse}-${row.sku}`}><th scope="row"><div className="product-cell"><strong>{row.productName || `${row.brand} · ${row.category}`}</strong><span>{row.brand} · {row.size || "One size"} · {friendlyFc(row.warehouse)}</span><small>{row.sku}</small></div></th><td><span className={`decision-badge decision-${decision.key}`}><Icon name={decision.key === "ready" ? "check" : "alert"}/>{decision.label}</span></td><td className="numeric-cell"><strong>{formatPct(row.forecastAccuracy)}</strong><small>{row.backtestDays} test days</small></td><td><strong className={Math.abs(row.forecastBias || 0) > 15 ? "text-urgent" : ""}>{formatBias(row.forecastBias)}</strong></td><td><DataGrade row={row}/></td>{technical && <><td><strong>{row.forecastModelLabel}</strong><small className="cell-subtext">{row.forecastSelectionStrategy || "Best recent test result"}</small></td><td className="numeric-cell">{formatPct(row.forecastWmape)}</td></>}<td className="numeric-cell"><strong>{row.forecastDailyRate ?? row.dailyRunRate}</strong><small>{row.forecastLowerBound}–{row.forecastUpperBound} expected</small></td></tr>;
      })}</tbody></table></div>

      <div className="mobile-card-list forecast-mobile-list">{rows.map((row: any) => { const decision=forecastDecision(row); return <article key={`${row.warehouse}-${row.sku}`} className="forecast-card"><div className="forecast-card-head"><div><h3>{row.productName || `${row.brand} · ${row.category}`}</h3><p>{row.size || "One size"} · {friendlyFc(row.warehouse)}</p></div><span className={`decision-badge decision-${decision.key}`}>{decision.label}</span></div><dl><div><dt>Historical match</dt><dd>{formatPct(row.forecastAccuracy)}</dd></div><div><dt>Tendency</dt><dd>{formatBias(row.forecastBias)}</dd></div><div><dt>Data grade</dt><dd>{gradeLabel(row.forecastQuality)}</dd></div><div><dt>Forecast evidence/day</dt><dd>{row.forecastDailyRate ?? row.dailyRunRate}</dd></div></dl>{technical && <details><summary>Technical detail</summary><p>{row.forecastModelLabel} · WAPE {formatPct(row.forecastWmape)} · {row.backtestDays} test days</p><p>{row.forecastQualityReasons?.join(" ")}</p></details>}</article>; })}</div>
      {!rows.length && <div className="empty-copy text-center">No forecasts match these filters. Clear the search or choose all decisions.</div>}
    </section>

    <details className="method-guide">
      <summary>How the forecasting methods work</summary>
      <div><Method name="Full-history average">Uses average daily demand across the selected reliable history.</Method><Method name="Recent moving average">Gives recent in-stock demand more relevance.</Method><Method name="Weekday seasonal">Learns systematic weekday and weekend differences.</Method><Method name="Local trend">Extends a recent rise or fall, with limits to reduce runaway forecasts.</Method><Method name="Croston intermittent">Designed for long-tail products with many zero-demand days.</Method><Method name="Evidence-weighted ensemble">Combines the two strongest methods only when holdout tests improve.</Method></div>
    </details>
  </div>;
}

function Signal({ icon, value, title, detail }: { icon: "database"|"calendar"|"history"; value: string; title: string; detail: string }) { return <article><span><Icon name={icon}/></span><div><strong>{value}</strong><h2>{title}</h2><p>{detail}</p></div></article>; }
function DataGrade({ row }: { row: any }) { return <div className="data-grade"><span className={`grade-${row.forecastQuality}`}>{row.forecastQuality === "high" ? "A" : row.forecastQuality === "medium" ? "B" : "C"}</span><div><strong>{gradeLabel(row.forecastQuality)}</strong><small>{row.forecastConfidenceScore ? `${row.forecastConfidenceScore}/100 evidence score` : `${row.stockoutDaysInHistory || 0} unavailable days`}</small></div></div>; }
function gradeLabel(quality: string) { return quality === "high" ? "Strong evidence" : quality === "medium" ? "Some data gaps" : "Limited evidence"; }
function forecastDecision(row: any) { if (row.exceptions?.some((exception: any) => exception.severity === "critical") || row.forecastQuality === "low") return { key: "blocked", label: "Do not automate" }; if ((row.forecastAccuracy ?? 0) < 70 || Math.abs(row.forecastBias || 0) > 20) return { key: "review", label: "Review forecast" }; return { key: "ready", label: "Reliable enough to use" }; }
function friendlyFc(value: string) { return ({ BLR_FC: "Bengaluru FC", DEL_FC: "Delhi FC", MUM_FC: "Mumbai FC", KOL_FC: "Kolkata FC" } as Record<string,string>)[value] || value.replaceAll("_", " "); }
function Method({ name, children }: { name: string; children: React.ReactNode }) { return <article><h3>{name}</h3><p>{children}</p></article>; }
