"use client";

import { FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Icon from "./Icon";
import { formatDate, formatDateTime, formatIndianNumber } from "@/lib/format";

type FilterKey = "brands" | "styleIds" | "products" | "vendors" | "categories" | "articleTypes" | "warehouses";

type LiveOptions = Record<FilterKey, string[]> & {
  dateMin: string | null;
  dateMax: string | null;
};

type LiveConnectionResponse = {
  connection: {
    name: string;
    type?: string;
    status: string;
    sourceBatchId: string;
    sourceLabel?: string | null;
    sourceCreatedAt?: string | null;
    dataAsOf?: string | null;
  };
  counts: {
    salesRows: number;
    inventoryRows: number;
    openPoRows: number;
    styleMasterRows: number;
  };
  options: LiveOptions;
  semantics?: {
    date?: string;
    vendor?: string;
    warehouse?: string;
  };
  error?: string;
};

type LivePlanResponse = {
  batchId?: string;
  error?: string;
};

export interface LiveDataPanelProps {
  coverageDays: number;
  dohThreshold: number;
  label: string;
  onBusy: (busy: boolean, stage?: string) => void;
  onError: (message: string) => void;
}

const emptySelections = (): Record<FilterKey, string[]> => ({
  brands: [],
  styleIds: [],
  products: [],
  vendors: [],
  categories: [],
  articleTypes: [],
  warehouses: [],
});

const filterDefinitions: {
  key: FilterKey;
  label: string;
  singular: string;
  plural: string;
  allLabel: string;
  help: string;
  searchable?: boolean;
}[] = [
  { key: "brands", label: "Brand", singular: "brand", plural: "brands", allLabel: "All brands", help: "Choose one or more brands, or leave this as all brands." },
  { key: "categories", label: "Category", singular: "category", plural: "categories", allLabel: "All categories", help: "The broad merchandise group used in the source data." },
  { key: "articleTypes", label: "Article type", singular: "article type", plural: "article types", allLabel: "All article types", help: "Narrow the plan to a product type such as headphones or dresses." },
  { key: "products", label: "Product / model", singular: "product", plural: "products", allLabel: "All products and models", help: "Use product names when you know the model but not its Style ID.", searchable: true },
  { key: "styleIds", label: "Style ID", singular: "Style ID", plural: "Style IDs", allLabel: "All Style IDs", help: "Select exact Myntra styles. You can choose more than one.", searchable: true },
  { key: "vendors", label: "Supplier", singular: "supplier", plural: "suppliers", allLabel: "All eligible suppliers", help: "This chooses the commercial supplier rules; existing pending supply is still counted.", searchable: true },
  { key: "warehouses", label: "Warehouse", singular: "warehouse", plural: "warehouses", allLabel: "All warehouses", help: "Inventory and open orders will be limited to the selected locations." },
];

export default function LiveDataPanel({ coverageDays, dohThreshold, label, onBusy, onError }: LiveDataPanelProps) {
  const router = useRouter();
  const [data, setData] = useState<LiveConnectionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [planning, setPlanning] = useState(false);
  const [localError, setLocalError] = useState("");
  const [selections, setSelections] = useState<Record<FilterKey, string[]>>(emptySelections);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const onErrorRef = useRef(onError);
  const onBusyRef = useRef(onBusy);

  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => { onBusyRef.current = onBusy; }, [onBusy]);

  async function loadConnection(signal?: AbortSignal) {
    setLoading(true);
    setLocalError("");
    try {
      const response = await fetch("/api/data/live/options", { cache: "no-store", signal });
      const result = await response.json().catch(() => ({})) as Partial<LiveConnectionResponse>;
      if (!response.ok) throw new Error(result.error || "The connected data source could not be opened.");
      if (!result.connection?.sourceBatchId || !result.options || !result.counts) {
        throw new Error("The connected data source returned an incomplete planning snapshot.");
      }

      const normalised: LiveConnectionResponse = {
        connection: result.connection,
        counts: result.counts,
        semantics: result.semantics,
        options: {
          brands: stringArray(result.options.brands),
          styleIds: stringArray(result.options.styleIds),
          products: stringArray(result.options.products),
          vendors: stringArray(result.options.vendors),
          categories: stringArray(result.options.categories),
          articleTypes: stringArray(result.options.articleTypes),
          warehouses: stringArray(result.options.warehouses),
          dateMin: result.options.dateMin || null,
          dateMax: result.options.dateMax || null,
        },
      };
      setData(normalised);
      setSelections(emptySelections());
      setDateFrom(normalised.options.dateMin || "");
      setDateTo(normalised.options.dateMax || "");
      onErrorRef.current("");
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      const message = error instanceof Error ? error.message : "The connected data source could not be opened.";
      setData(null);
      setLocalError(message);
      onErrorRef.current(message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadConnection(controller.signal);
    return () => controller.abort();
  }, []);

  function toggle(key: FilterKey, value: string) {
    setSelections(current => {
      const exists = current[key].includes(value);
      return { ...current, [key]: exists ? current[key].filter(item => item !== value) : [...current[key], value] };
    });
  }

  function resetFilters() {
    setSelections(emptySelections());
    setDateFrom(data?.options.dateMin || "");
    setDateTo(data?.options.dateMax || "");
  }

  const activeFilterCount = useMemo(
    () => Object.values(selections).filter(values => values.length > 0).length,
    [selections],
  );
  const dateError = dateFrom && dateTo && dateFrom > dateTo ? "Start date cannot be after end date." : "";
  const assumptionsValid = Number.isInteger(coverageDays) && coverageDays >= 1 && coverageDays <= 365
    && Number.isFinite(dohThreshold) && dohThreshold > 0 && dohThreshold <= 730;

  async function buildPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data || planning || dateError || !assumptionsValid) return;
    setPlanning(true);
    setLocalError("");
    onErrorRef.current("");
    onBusyRef.current(true, "Creating a planning snapshot from your selections…");

    try {
      const planResponse = await fetch("/api/data/live/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceBatchId: data.connection.sourceBatchId,
          coverageDays,
          dohThreshold,
          label,
          filters: {
            ...selections,
            dateFrom: dateFrom || null,
            dateTo: dateTo || null,
          },
        }),
      });
      const planned = await planResponse.json().catch(() => ({})) as LivePlanResponse;
      if (!planResponse.ok || !planned.batchId) {
        throw new Error(planned.error || "The connected plan could not be created.");
      }

      onBusyRef.current(true, "Calculating DRR, stock cover and PO quantities…");
      const generateResponse = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId: planned.batchId, coverageDays }),
      });
      const generated = await generateResponse.json().catch(() => ({})) as { batchId?: string; error?: string };
      if (!generateResponse.ok || !generated.batchId) {
        throw new Error(generated.error || "The connected data was saved, but recommendations could not be calculated.");
      }

      onBusyRef.current(true, "Opening the recommendation review…");
      router.push(`/results/${generated.batchId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The connected plan could not be created.";
      setLocalError(message);
      onErrorRef.current(message);
    } finally {
      setPlanning(false);
      onBusyRef.current(false);
    }
  }

  if (loading) {
    return <section className="panel live-data-panel live-panel-state" aria-live="polite" aria-busy="true">
      <span className="loading-spinner" aria-hidden="true" />
      <div><strong>Opening the connected planning snapshot…</strong><span>Checking available dates, styles, suppliers and warehouses.</span></div>
    </section>;
  }

  if (!data) {
    return <section className="panel live-data-panel live-panel-state live-panel-error" role="alert">
      <span className="live-state-icon"><Icon name="alert" /></span>
      <div><strong>Live planning is not ready yet</strong><span>{localError || "No connected snapshot is available."}</span></div>
      <button className="btn-secondary" type="button" onClick={() => void loadConnection()}>Check again</button>
    </section>;
  }

  return <section className="panel live-data-panel" aria-labelledby="live-data-title">
    <header className="panel-head live-panel-head">
      <div>
        <p className="step-kicker">Connected source</p>
        <h2 className="section-title" id="live-data-title">Choose the data to use</h2>
        <p className="section-description">Start with all connected Myntra data, or tick the exact products, suppliers and locations for this plan.</p>
      </div>
      <span className="live-connected-pill"><span className="status-dot" aria-hidden="true" />Connected</span>
    </header>

    <div className="live-connection-strip">
      <span className="live-connection-icon"><Icon name="database" /></span>
      <div>
        <strong>{data.connection.name}</strong>
        <span>{data.connection.sourceLabel || "Latest planning snapshot"} · {data.connection.type || "Connected data"}</span>
      </div>
      <dl>
        <div><dt>Data as of</dt><dd>{formatDate(data.connection.dataAsOf || data.options.dateMax)}</dd></div>
        <div><dt>Snapshot saved</dt><dd>{formatDateTime(data.connection.sourceCreatedAt)}</dd></div>
      </dl>
    </div>

    <div className="live-source-counts" aria-label="Connected source row counts">
      <SourceCount label="Sell-out history" value={data.counts.salesRows} detail="demand rows" />
      <SourceCount label="Current inventory" value={data.counts.inventoryRows} detail="stock positions" />
      <SourceCount label="Pending supply" value={data.counts.openPoRows} detail="open PO rows" />
      <SourceCount label="Style & supplier master" value={data.counts.styleMasterRows} detail="commercial rows" />
    </div>

    <form onSubmit={buildPlan}>
      <div className="live-filter-intro">
        <div><Icon name="filter" /><span><strong>Empty selection means “include all”</strong><small>Ticking two or more choices includes any of those choices. You never need Command-click.</small></span></div>
        <button type="button" className="btn-secondary" disabled={!activeFilterCount && dateFrom === (data.options.dateMin || "") && dateTo === (data.options.dateMax || "")} onClick={resetFilters}>Reset to all data</button>
      </div>

      <fieldset className="live-period-fieldset">
        <legend>Sales period</legend>
        <p>{data.semantics?.date || "The selected period controls the selling days used to calculate daily run rate."}</p>
        <div className="live-date-grid">
          <label><span className="field-label">Start date</span><input className="field" type="date" min={data.options.dateMin || undefined} max={dateTo || data.options.dateMax || undefined} value={dateFrom} onChange={event => setDateFrom(event.target.value)} /></label>
          <label><span className="field-label">End date</span><input className="field" type="date" min={dateFrom || data.options.dateMin || undefined} max={data.options.dateMax || undefined} value={dateTo} onChange={event => setDateTo(event.target.value)} /></label>
          <div className="live-period-available"><span>Available history</span><strong>{formatDate(data.options.dateMin)} – {formatDate(data.options.dateMax)}</strong></div>
        </div>
        {dateError && <span className="field-error" role="alert">{dateError}</span>}
      </fieldset>

      <div className="live-filter-grid">
        {filterDefinitions.map(definition => {
          const { key, plural: _plural, ...filter } = definition;
          return <CheckboxFilter
            key={key}
            {...filter}
            help={key === "warehouses" ? (data.semantics?.warehouse || filter.help) : filter.help}
            options={data.options[key]}
            selected={selections[key]}
            onToggle={value => toggle(key, value)}
            onClear={() => setSelections(current => ({ ...current, [key]: [] }))}
            onSelect={values => setSelections(current => ({ ...current, [key]: values }))}
          />;
        })}
      </div>

      <div className="live-plan-scope" aria-live="polite">
        <div>
          <span className="live-scope-icon"><Icon name="target" /></span>
          <span><strong>{activeFilterCount ? `${activeFilterCount} specific filter${activeFilterCount === 1 ? "" : "s"} applied` : "Full connected product range"}</strong><small>{scopeDescription(selections)} · {dateFrom && dateTo ? `${formatDate(dateFrom)} to ${formatDate(dateTo)}` : "all available dates"}</small></span>
        </div>
        <dl>
          <div><dt>PO cover</dt><dd>{coverageDays} days</dd></div>
          <div><dt>DOH review threshold</dt><dd>{dohThreshold} days</dd></div>
        </dl>
      </div>

      {localError && <div className="status-message status-message-error live-submit-error" role="alert"><Icon name="alert" /><span>{localError}</span></div>}
      {!assumptionsValid && <div className="status-message status-message-error live-submit-error" role="alert"><Icon name="alert" /><span>Correct the PO cover and DOH assumptions before building this plan.</span></div>}

      <footer className="live-panel-footer">
        <span><Icon name="shield" />A new frozen snapshot will be saved. The connected source is not changed.</span>
        <button className="btn-primary btn-large" type="submit" disabled={planning || Boolean(dateError) || !assumptionsValid} aria-busy={planning}>
          <Icon name={planning ? "refresh" : "arrowRight"} />{planning ? "Building connected plan…" : "Build plan from connected data"}
        </button>
      </footer>
    </form>
  </section>;
}

function SourceCount({ label, value, detail }: { label: string; value: number; detail: string }) {
  return <article><span>{label}</span><strong>{formatIndianNumber(value)}</strong><small>{detail}</small></article>;
}

function CheckboxFilter({
  label,
  singular,
  allLabel,
  help,
  options,
  selected,
  searchable,
  onToggle,
  onClear,
  onSelect,
}: {
  label: string;
  singular: string;
  allLabel: string;
  help: string;
  options: string[];
  selected: string[];
  searchable?: boolean;
  onToggle: (value: string) => void;
  onClear: () => void;
  onSelect: (values: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const helpId = useId();
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("en-IN");
    return needle ? options.filter(option => option.toLocaleLowerCase("en-IN").includes(needle)) : options;
  }, [options, query]);
  const selectedVisible = visible.filter(option => selected.includes(option));
  const summary = !options.length ? "No values in snapshot" : !selected.length ? allLabel : selected.length === 1 ? displayValue(selected[0]) : `${selected.length} selected`;

  return <fieldset className="live-filter-card" aria-describedby={helpId}>
    <legend>{label}</legend>
    <details>
      <summary aria-label={`${label}: ${summary}`}><span>{summary}</span><Icon name="chevronRight" /></summary>
      <div className="live-filter-menu">
        {(searchable || options.length > 8) && <label className="live-option-search" htmlFor={searchId}><Icon name="search" /><span className="sr-only">Search {label}</span><input id={searchId} type="search" placeholder={`Find ${singular}…`} value={query} onChange={event => setQuery(event.target.value)} /></label>}
        <div className="live-filter-menu-actions">
          <span>{selected.length ? `${selected.length} of ${options.length} chosen` : `${options.length} available`}</span>
          <div>
            {visible.length > 0 && selectedVisible.length !== visible.length && <button type="button" onClick={() => onSelect([...new Set([...selected, ...visible])])}>Select shown</button>}
            {selected.length > 0 && <button type="button" onClick={onClear}>Clear</button>}
          </div>
        </div>
        <div className="live-option-list">
          {visible.map(option => <label key={option}><input type="checkbox" checked={selected.includes(option)} onChange={() => onToggle(option)} /><span><strong>{displayValue(option)}</strong>{label === "Style ID" && <small>Myntra style</small>}</span></label>)}
          {!visible.length && <p>{options.length ? "No values match your search." : "This field is not present in the connected snapshot."}</p>}
        </div>
      </div>
    </details>
    <p id={helpId}>{help}</p>
  </fieldset>;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => String(item ?? "").trim()).filter(Boolean) : [];
}

function displayValue(value: string) {
  if (["ALL_MYNTRA", "ALL"].includes(value)) return "All Myntra network";
  return value.replaceAll("_", " ");
}

function scopeDescription(selections: Record<FilterKey, string[]>) {
  const parts = filterDefinitions
    .map(definition => selections[definition.key].length
      ? `${selections[definition.key].length} ${selections[definition.key].length === 1 ? definition.singular : definition.plural}`
      : "")
    .filter(Boolean);
  return parts.length ? parts.join(" · ") : "All brands, styles, products, suppliers and warehouses";
}
