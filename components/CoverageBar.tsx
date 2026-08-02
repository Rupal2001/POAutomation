"use client";

interface Props {
  daysOnHand: number | null;
  coverageDays: number;
  compact?: boolean;
}

export default function CoverageBar({ daysOnHand, coverageDays, compact = false }: Props) {
  if (daysOnHand === null) return <span className="coverage-empty">No demand history</span>;

  const scaleMax = Math.max(coverageDays * 1.6, daysOnHand);
  const pct = Math.max(0, Math.min(1, daysOnHand / scaleMax)) * 100;
  const targetPct = Math.min(100, (coverageDays / scaleMax) * 100);
  const risk = daysOnHand < coverageDays * 0.33 ? "critical" : daysOnHand < coverageDays * 0.8 ? "low" : daysOnHand > coverageDays * 1.5 ? "excess" : "healthy";
  const label = ({ critical: "Urgent", low: "Low cover", healthy: "On target", excess: "Excess cover" } as const)[risk];

  return <div className={`coverage-meter coverage-${risk} ${compact ? "coverage-compact" : ""}`}>
    <div className="coverage-label"><strong>{Math.max(0, daysOnHand).toFixed(0)} days</strong><span>{label}</span></div>
    <div className="coverage-track" role="meter" aria-label={`${Math.max(0, daysOnHand).toFixed(0)} days of cover, ${label.toLowerCase()}, target ${coverageDays} days`} aria-valuemin={0} aria-valuemax={scaleMax} aria-valuenow={Math.max(0, daysOnHand)}>
      <div className="coverage-value" style={{ width: `${pct}%` }}/>
      <div className="coverage-target" style={{ left: `${targetPct}%` }}/>
    </div>
    {!compact && <small>{coverageDays}-day target</small>}
  </div>;
}
