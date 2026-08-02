import { useId, type ReactNode } from "react";
import Icon, { IconName } from "./Icon";

export function PageIntro({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description: ReactNode;
  actions?: ReactNode;
}) {
  return <header className="page-header">
    <div className="min-w-0">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h1 className="page-title">{title}</h1>
      <div className="page-subtitle">{description}</div>
    </div>
    {actions && <div className="page-actions">{actions}</div>}
  </header>;
}

export function MetricCard({
  label,
  value,
  detail,
  tone = "neutral",
  icon,
  explanation,
}: {
  label: string;
  value: ReactNode;
  detail: ReactNode;
  tone?: "neutral" | "positive" | "warning" | "critical" | "brand";
  icon?: IconName;
  explanation?: string;
}) {
  return <article className={`metric-card metric-${tone}`} aria-label={`${label}: ${typeof value === "string" || typeof value === "number" ? value : ""}`}>
    <div className="metric-card-top">
      <span className="metric-label">{label}</span>
      {icon && <span className="metric-icon" aria-hidden="true"><Icon name={icon}/></span>}
    </div>
    <strong className="metric-value">{value}</strong>
    <div className="metric-detail">{detail}</div>
    {explanation && <p className="metric-explanation">{explanation}</p>}
  </article>;
}

export function SectionHeader({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return <div className="panel-head">
    <div>
      <h2 className="section-title">{title}</h2>
      {description && <p className="section-description">{description}</p>}
    </div>
    {action}
  </div>;
}

export function LoadingState({ children = "Loading…" }: { children?: ReactNode }) {
  return <div className="loading-state" role="status" aria-live="polite" aria-busy="true">
    <span className="loading-spinner" aria-hidden="true"/>
    <span>{children}</span>
  </div>;
}

export function EmptyState({
  title,
  children,
  action,
  icon = "package",
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  icon?: IconName;
}) {
  return <div className="empty-state">
    <span className="empty-state-icon"><Icon name={icon}/></span>
    <h1>{title}</h1>
    <div>{children}</div>
    {action && <div className="mt-5 flex justify-center">{action}</div>}
  </div>;
}

export function InfoNote({ title, children, tone = "brand" }: { title: string; children: ReactNode; tone?: "brand" | "warning" | "neutral" }) {
  return <aside className={`info-note info-note-${tone}`}>
    <span className="info-note-icon"><Icon name={tone === "warning" ? "alert" : "info"}/></span>
    <div><h3>{title}</h3><div>{children}</div></div>
  </aside>;
}

export function Definition({ term, children }: { term: string; children: ReactNode }) {
  const tooltipId = useId();
  return <span className="definition" tabIndex={0} aria-describedby={tooltipId}>
    <span>{term}</span>
    <span id={tooltipId} role="tooltip" className="definition-popover">{children}</span>
  </span>;
}

export function Segment<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; count?: number }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return <div className="segmented-control" role="group" aria-label={label}>
    {options.map(option => <button
      type="button"
      key={option.value}
      className={value === option.value ? "active" : ""}
      aria-pressed={value === option.value}
      onClick={() => onChange(option.value)}
    >{option.label}{option.count !== undefined && <span>{option.count}</span>}</button>)}
  </div>;
}

export function StatusMessage({ children, type = "success" }: { children: ReactNode; type?: "success" | "error" | "warning" }) {
  return <div className={`status-message status-message-${type}`} role={type === "error" ? "alert" : "status"}>
    <Icon name={type === "success" ? "check" : "alert"}/><span>{children}</span>
  </div>;
}
