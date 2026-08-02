export type ForecastModel = "auto" | "average" | "recent" | "weighted" | "seasonal" | "trend" | "croston";

type BaseForecastModel = Exclude<ForecastModel, "auto">;

export interface ForecastSalesRow {
  date: string;
  unitsSold: number;
  returnsQty?: number;
  cancellationsQty?: number;
  isPromotion?: boolean;
  inStock?: boolean;
}

export interface ForecastContributor {
  model: BaseForecastModel;
  label: string;
  weight: number;
  wmape: number | null;
  bias: number | null;
}

export interface ForecastResult {
  dailyRate: number;
  baseDailyRate: number;
  /** Champion model. For an ensemble this remains the strongest contributor for backward compatibility. */
  model: BaseForecastModel;
  modelLabel: string;
  selectionStrategy: "fixed" | "champion" | "ensemble";
  contributors: ForecastContributor[];
  wmape: number | null;
  accuracy: number | null;
  bias: number | null;
  /** Additive 90% empirical prediction interval for one day. */
  lowerBound: number;
  upperBound: number;
  deviation: number;
  forecastErrorRmse: number;
  returnRate: number;
  cancellationRate: number;
  /** Backward-compatible effective uplift: planned uplift when supplied, otherwise observed uplift. */
  promotionUplift: number;
  observedPromotionUplift: number;
  plannedPromotionUplift: number;
  promotionDays: number;
  promotionAdjustedDays: number;
  stockoutDays: number;
  dataLatencyDays: number;
  historyDays: number;
  observedDays: number;
  quality: "high" | "medium" | "low";
  confidenceScore: number;
  qualityReasons: string[];
  backtestDays: number;
  /** Add these across SKU/FC rows to calculate a true portfolio WAPE. */
  backtestActualUnits: number;
  backtestForecastUnits: number;
  backtestAbsoluteErrorUnits: number;
  backtestSignedErrorUnits: number;
}

interface DayValue {
  dateMs: number;
  weekday: number;
  actual: number | null;
  promotion: boolean;
  gross: number;
  returns: number;
  cancellations: number;
  censoredReason: "stockout" | "latency" | null;
}

interface BacktestPoint {
  actual: number;
  forecast: number;
}

interface BacktestResult {
  wmape: number | null;
  accuracy: number | null;
  bias: number | null;
  count: number;
  residuals: number[];
  actualUnits: number;
  forecastUnits: number;
  absoluteErrorUnits: number;
  signedErrorUnits: number;
}

const DAY = 86_400_000;
const labels: Record<BaseForecastModel, string> = {
  average: "Full-history average",
  recent: "28-day moving average",
  weighted: "Recency weighted",
  seasonal: "Day-of-week seasonal",
  trend: "Local linear trend",
  croston: "Croston intermittent",
};

const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const quantile = (values: number[], q: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position); const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};
const finite = (values: (number | null)[]) => values.filter((v): v is number => v !== null && Number.isFinite(v));
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function predict(history: DayValue[], model: BaseForecastModel, targetWeekday: number): number {
  const usable = history.filter(d => d.actual !== null);
  if (!usable.length) return 0;
  if (model === "average") return mean(usable.map(d => d.actual!));
  if (model === "recent") return mean(usable.slice(-28).map(d => d.actual!));
  if (model === "weighted") {
    const recent = usable.slice(-56); const denominator = recent.reduce((sum, _, i) => sum + i + 1, 0);
    return recent.reduce((sum, d, i) => sum + d.actual! * (i + 1), 0) / denominator;
  }
  if (model === "seasonal") {
    const sameDay = usable.filter(d => d.weekday === targetWeekday).slice(-8).map(d => d.actual!);
    return sameDay.length >= 2 ? mean(sameDay) : mean(usable.slice(-28).map(d => d.actual!));
  }
  if (model === "trend") {
    const recent = usable.slice(-56); const n = recent.length;
    if (n < 7) return mean(recent.map(d => d.actual!));
    const xMean = (n - 1) / 2; const yMean = mean(recent.map(d => d.actual!));
    let numerator = 0; let denominator = 0;
    recent.forEach((d, i) => { numerator += (i - xMean) * (d.actual! - yMean); denominator += (i - xMean) ** 2; });
    const slope = denominator ? numerator / denominator : 0;
    return clamp(yMean + slope * (n + 0.5 - xMean), 0, Math.max(...recent.map(d => d.actual!)) * 2.5 + 1);
  }
  // Croston's method for intermittent fashion sizes / long-tail styles.
  let demand = 0; let interval = 1; let lastNonZero = 0; const alpha = 0.2;
  usable.forEach((d, index) => {
    if (d.actual! <= 0) return;
    const gap = Math.max(1, index - lastNonZero); lastNonZero = index;
    demand = demand === 0 ? d.actual! : alpha * d.actual! + (1 - alpha) * demand;
    interval = interval === 1 && index === 0 ? 1 : alpha * gap + (1 - alpha) * interval;
  });
  return demand / Math.max(1, interval);
}

/**
 * Estimate promotion lift against preceding organic days only. Weekday-matched
 * medians remove most weekly seasonality and the median limits campaign spikes.
 * This function is called separately at every rolling backtest origin, so a
 * target campaign can never teach the model its own uplift.
 */
function historicalPromoUplift(days: DayValue[]) {
  const ratios: number[] = [];
  days.forEach((day, index) => {
    if (!day.promotion || day.actual === null) return;
    const prior = days.slice(Math.max(0, index - 84), index).filter(d => !d.promotion && d.actual !== null);
    const weekdayMatched = prior.filter(d => d.weekday === day.weekday).map(d => d.actual!);
    const fallback = prior.slice(-28).map(d => d.actual!);
    const baselineValues = weekdayMatched.length >= 3 ? weekdayMatched : fallback;
    const baseline = median(baselineValues);
    if (baseline > 0 && baselineValues.length >= 3) ratios.push(clamp(day.actual / baseline - 1, 0, 3));
  });
  return ratios.length >= 3 ? median(ratios) : 0;
}

function prepareHistory(days: DayValue[]) {
  const uplift = historicalPromoUplift(days);
  const organic = finite(days.filter(d => !d.promotion).map(d => d.actual));
  const centre = median(organic);
  const mad = median(organic.map(value => Math.abs(value - centre)));
  // A zero-MAD series is common for fixtures and staple products. The fallback
  // still allows natural variation while preventing an unexplained promo spike.
  const upper = centre + Math.max(centre, 4 * 1.4826 * mad);
  let adjustedDays = 0;
  const normalized = days.map(day => {
    if (!day.promotion || day.actual === null) return day;
    const deSpiked = day.actual / (1 + uplift);
    const robust = organic.length >= 7 ? Math.min(deSpiked, upper) : deSpiked;
    if (Math.abs(robust - day.actual) > 0.001) adjustedDays++;
    return { ...day, actual: robust };
  });
  return { normalized, uplift, adjustedDays };
}

function summarize(points: BacktestPoint[]): BacktestResult {
  const actualUnits = points.reduce((sum, point) => sum + Math.abs(point.actual), 0);
  const forecastUnits = points.reduce((sum, point) => sum + point.forecast, 0);
  const absoluteErrorUnits = points.reduce((sum, point) => sum + Math.abs(point.forecast - point.actual), 0);
  const signedErrorUnits = points.reduce((sum, point) => sum + point.forecast - point.actual, 0);
  const residuals = points.map(point => point.forecast - point.actual);
  if (!points.length || actualUnits === 0) {
    return { wmape: null, accuracy: null, bias: null, count: points.length, residuals, actualUnits, forecastUnits, absoluteErrorUnits, signedErrorUnits };
  }
  const wmape = absoluteErrorUnits / actualUnits;
  return {
    wmape,
    accuracy: clamp(1 - wmape, 0, 1),
    bias: signedErrorUnits / actualUnits,
    count: points.length,
    residuals,
    actualUnits,
    forecastUnits,
    absoluteErrorUnits,
    signedErrorUnits,
  };
}

function blendWeights(candidates: BaseForecastModel[], history: Map<BaseForecastModel, BacktestPoint[]>) {
  const raw = candidates.map(model => {
    const score = summarize(history.get(model) ?? []);
    // The floor prevents one short, perfect run from taking the whole blend.
    return { model, raw: score.wmape === null ? 1 : 1 / Math.max(0.08, score.wmape) };
  });
  const total = raw.reduce((sum, item) => sum + item.raw, 0) || 1;
  return new Map(raw.map(item => [item.model, item.raw / total]));
}

function rollingBacktest(days: DayValue[], candidates: BaseForecastModel[]) {
  const holdout = Math.min(42, Math.max(14, Math.floor(days.length * 0.2)));
  const start = days.length - holdout;
  const modelPoints = new Map<BaseForecastModel, BacktestPoint[]>(candidates.map(model => [model, []]));
  const ensemblePoints: BacktestPoint[] = [];
  if (start < 28) return { modelPoints, ensemblePoints };

  for (let i = start; i < days.length; i++) {
    const actual = days[i].actual;
    if (actual === null) continue;
    const prepared = prepareHistory(days.slice(0, i));
    const forecasts = new Map<BaseForecastModel, number>();
    for (const model of candidates) {
      let value = predict(prepared.normalized, model, days[i].weekday);
      if (days[i].promotion) value *= 1 + prepared.uplift;
      forecasts.set(model, value);
    }

    // Causal online blend: weights for this target use only earlier holdout
    // errors, never the target actual. This makes its reported WAPE auditable.
    const weights = blendWeights(candidates, modelPoints);
    const blended = candidates.reduce((sum, model) => sum + forecasts.get(model)! * weights.get(model)!, 0);
    ensemblePoints.push({ actual, forecast: blended });
    for (const model of candidates) modelPoints.get(model)!.push({ actual, forecast: forecasts.get(model)! });
  }
  return { modelPoints, ensemblePoints };
}

function qualityAssessment(historyDays: number, observedDays: number, stockoutDays: number, dataLatencyDays: number, result: BacktestResult) {
  const stockoutShare = stockoutDays / Math.max(1, historyDays);
  const accuracyComponent = (result.accuracy ?? 0) * 45;
  const biasComponent = (1 - Math.min(1, Math.abs(result.bias ?? 1))) * 20;
  const validationComponent = Math.min(1, result.count / 21) * 15;
  const historyComponent = Math.min(1, observedDays / 84) * 10;
  const availabilityComponent = (1 - Math.min(1, stockoutShare / 0.3)) * 10;
  let confidenceScore = Math.round(clamp(accuracyComponent + biasComponent + validationComponent + historyComponent + availabilityComponent, 0, 100));
  // Confidence is a decision gate, not an average that can let excellent data
  // volume hide a badly performing model.
  if (result.wmape === null) confidenceScore = Math.min(confidenceScore, 35);
  else if (result.wmape > 0.55) confidenceScore = Math.min(confidenceScore, 40);
  else if (result.wmape > 0.4) confidenceScore = Math.min(confidenceScore, 49);
  if (result.bias !== null && Math.abs(result.bias) > 0.35) confidenceScore = Math.min(confidenceScore, 45);
  const reasons: string[] = [];
  if (observedDays < 56) reasons.push(`Only ${observedDays} observed demand days; 56+ are preferred.`);
  if (result.count < 14) reasons.push(`Only ${result.count} usable holdout days; 14+ are preferred.`);
  if (result.wmape === null) reasons.push("Holdout WAPE is unavailable because evaluated demand was zero or insufficient.");
  else if (result.wmape > 0.4) reasons.push(`Holdout error is high at ${Math.round(result.wmape * 100)}% WAPE.`);
  else if (result.wmape > 0.25) reasons.push(`Holdout error is moderate at ${Math.round(result.wmape * 100)}% WAPE.`);
  if (result.bias !== null && Math.abs(result.bias) > 0.25) reasons.push(`Forecast bias is material at ${Math.round(result.bias * 100)}%.`);
  else if (result.bias !== null && Math.abs(result.bias) > 0.15) reasons.push(`Forecast bias needs monitoring at ${Math.round(result.bias * 100)}%.`);
  if (stockoutShare > 0.25) reasons.push(`${Math.round(stockoutShare * 100)}% of calendar days were stockout-censored.`);
  else if (stockoutShare > 0.1) reasons.push(`${Math.round(stockoutShare * 100)}% of calendar days were stockout-censored.`);
  if (dataLatencyDays > 0) reasons.push(`${dataLatencyDays} most recent day(s) have no source snapshot yet and were excluded as data latency.`);

  const high = observedDays >= 56 && result.count >= 14 && result.wmape !== null && result.wmape <= 0.25
    && result.bias !== null && Math.abs(result.bias) <= 0.15 && stockoutShare <= 0.1 && confidenceScore >= 75;
  const medium = observedDays >= 28 && result.count >= 7 && result.wmape !== null && result.wmape <= 0.55
    && result.bias !== null && Math.abs(result.bias) <= 0.35 && stockoutShare <= 0.25 && confidenceScore >= 50;
  return { quality: high ? "high" as const : medium ? "medium" as const : "low" as const, confidenceScore, qualityReasons: reasons };
}

function emptyResult(requested: ForecastModel): ForecastResult {
  const model = requested === "auto" ? "average" : requested;
  return {
    dailyRate: 0, baseDailyRate: 0, model, modelLabel: labels[model], selectionStrategy: requested === "auto" ? "champion" : "fixed",
    contributors: [{ model, label: labels[model], weight: 1, wmape: null, bias: null }], wmape: null, accuracy: null, bias: null,
    lowerBound: 0, upperBound: 0, deviation: 0, forecastErrorRmse: 0, returnRate: 0, cancellationRate: 0, promotionUplift: 0,
    observedPromotionUplift: 0, plannedPromotionUplift: 0, promotionDays: 0, promotionAdjustedDays: 0, stockoutDays: 0, dataLatencyDays: 0,
    historyDays: 0, observedDays: 0, quality: "low", confidenceScore: 0, qualityReasons: ["No valid demand history was supplied."],
    backtestDays: 0, backtestActualUnits: 0, backtestForecastUnits: 0, backtestAbsoluteErrorUnits: 0, backtestSignedErrorUnits: 0,
  };
}

export function forecastDemand(rows: ForecastSalesRow[], requested: ForecastModel, lookbackDays?: number | null, plannedPromotionUpliftPct = 0, returnRecoveryRate = 0.8, asOfDate?: string): ForecastResult {
  const asOfMs = asOfDate ? Date.parse(`${asOfDate}T00:00:00Z`) : null;
  const valid = rows.map(row => ({ ...row, dateMs: Date.parse(`${row.date}T00:00:00Z`) }))
    .filter(row => Number.isFinite(row.dateMs) && (asOfMs === null || row.dateMs <= asOfMs));
  if (!valid.length) return emptyResult(requested);

  const lastObservedDate = Math.max(...valid.map(row => row.dateMs)); const maxDate = asOfMs ?? lastObservedDate;
  const rawMin = Math.min(...valid.map(row => row.dateMs));
  const minDate = lookbackDays ? Math.max(rawMin, maxDate - (lookbackDays - 1) * DAY) : rawMin;
  const byDate = new Map<number, { gross: number; returns: number; cancellations: number; promotion: boolean; inStock: boolean }>();
  for (const row of valid) {
    if (row.dateMs < minDate) continue;
    const existing = byDate.get(row.dateMs) ?? { gross: 0, returns: 0, cancellations: 0, promotion: false, inStock: true };
    existing.gross += Number.isFinite(row.unitsSold) ? Math.max(0, row.unitsSold) : 0;
    existing.returns += Number.isFinite(row.returnsQty) ? Math.max(0, row.returnsQty!) : 0;
    existing.cancellations += Number.isFinite(row.cancellationsQty) ? Math.max(0, row.cancellationsQty!) : 0;
    existing.promotion ||= Boolean(row.isPromotion); existing.inStock &&= row.inStock !== false; byDate.set(row.dateMs, existing);
  }

  const historyDays = Math.max(1, Math.round((maxDate - minDate) / DAY) + 1); const days: DayValue[] = [];
  for (let i = 0; i < historyDays; i++) {
    const dateMs = minDate + i * DAY;
    // Days after the final supplied observation are unknown/censored, not zero.
    const supplied = byDate.get(dateMs);
    const raw = supplied ?? { gross: 0, returns: 0, cancellations: 0, promotion: false, inStock: dateMs <= lastObservedDate };
    const effective = Math.max(0, raw.gross - raw.cancellations - raw.returns * clamp(returnRecoveryRate, 0, 1));
    const censoredReason = !supplied && dateMs > lastObservedDate ? "latency" : raw.inStock ? null : "stockout";
    days.push({ dateMs, weekday: new Date(dateMs).getUTCDay(), actual: censoredReason === null ? effective : null, promotion: raw.promotion, gross: raw.gross, returns: raw.returns, cancellations: raw.cancellations, censoredReason });
  }

  const prepared = prepareHistory(days);
  const observedPromoUplift = prepared.uplift;
  const candidates: BaseForecastModel[] = ["average", "recent", "weighted", "seasonal", "trend"];
  const usableValues = finite(prepared.normalized.map(day => day.actual));
  const zeroShare = usableValues.filter(value => value === 0).length / Math.max(1, usableValues.length);
  if (zeroShare >= 0.35) candidates.push("croston");
  if (requested !== "auto" && !candidates.includes(requested)) candidates.push(requested);
  const tested = rollingBacktest(days, candidates);
  const scored = candidates.map(model => ({ model, result: summarize(tested.modelPoints.get(model) ?? []) }));
  const champion = scored.filter(score => score.result.wmape !== null).sort((a, b) => a.result.wmape! - b.result.wmape!)[0] ?? scored[0];
  const ensembleResult = summarize(tested.ensemblePoints);
  const finalWeights = blendWeights(candidates, tested.modelPoints);
  // Use a blend only when causal rolling-origin results improve the champion by
  // at least 3%. Otherwise the simpler, more explainable champion wins.
  const ensembleWins = requested === "auto" && ensembleResult.count >= 14 && ensembleResult.wmape !== null
    && champion.result.wmape !== null && ensembleResult.wmape <= champion.result.wmape * 0.97;
  const selectedModel = requested === "auto" ? champion.model : requested;
  const selectedResult = requested === "auto"
    ? (ensembleWins ? ensembleResult : champion.result)
    : (scored.find(score => score.model === requested)?.result ?? summarize([]));
  const selectionStrategy = requested === "auto" ? (ensembleWins ? "ensemble" as const : "champion" as const) : "fixed" as const;
  const selectedWeights = ensembleWins ? finalWeights : new Map<BaseForecastModel, number>([[selectedModel, 1]]);
  const contributors = [...selectedWeights.entries()].filter(([, weight]) => weight >= 0.005)
    .map(([model, weight]) => {
      const result = scored.find(score => score.model === model)!.result;
      return { model, label: labels[model], weight, wmape: result.wmape, bias: result.bias };
    }).sort((a, b) => b.weight - a.weight);

  const nextWeek = Array.from({ length: 7 }, (_, index) => {
    const weekday = new Date(maxDate + (index + 1) * DAY).getUTCDay();
    return [...selectedWeights.entries()].reduce((sum, [model, weight]) => sum + predict(prepared.normalized, model, weekday) * weight, 0);
  });
  const baseDailyRate = mean(nextWeek); const manualUplift = Math.max(0, plannedPromotionUpliftPct) / 100;
  const dailyRate = baseDailyRate * (1 + manualUplift);
  const values = finite(prepared.normalized.map(day => day.actual));
  const deviation = Math.sqrt(mean(values.map(value => (value - mean(values)) ** 2)));
  const forecastErrorRmse = selectedResult.residuals.length ? Math.sqrt(mean(selectedResult.residuals.map(residual => residual ** 2))) : deviation;
  const empiricalError = selectedResult.residuals.length ? quantile(selectedResult.residuals.map(Math.abs), 0.9) : 1.645 * deviation;
  const scaledError = empiricalError * (1 + manualUplift);
  const gross = days.reduce((sum, day) => sum + day.gross, 0);
  const stockoutDays = days.filter(day => day.censoredReason === "stockout").length;
  const dataLatencyDays = days.filter(day => day.censoredReason === "latency").length;
  const observedDays = days.filter(day => day.actual !== null).length;
  const assessment = qualityAssessment(historyDays, observedDays, stockoutDays, dataLatencyDays, selectedResult);
  const modelLabel = ensembleWins
    ? `Validated blend · ${contributors.slice(0, 2).map(contributor => labels[contributor.model]).join(" + ")}`
    : labels[selectedModel];
  return {
    dailyRate, baseDailyRate, model: selectedModel, modelLabel, selectionStrategy, contributors,
    wmape: selectedResult.wmape, accuracy: selectedResult.accuracy, bias: selectedResult.bias,
    lowerBound: Math.max(0, dailyRate - scaledError), upperBound: dailyRate + scaledError, deviation, forecastErrorRmse,
    returnRate: gross ? days.reduce((sum, day) => sum + day.returns, 0) / gross : 0,
    cancellationRate: gross ? days.reduce((sum, day) => sum + day.cancellations, 0) / gross : 0,
    promotionUplift: manualUplift || observedPromoUplift, observedPromotionUplift: observedPromoUplift,
    plannedPromotionUplift: manualUplift, promotionDays: days.filter(day => day.promotion).length,
    promotionAdjustedDays: prepared.adjustedDays, stockoutDays, dataLatencyDays, historyDays, observedDays,
    ...assessment, backtestDays: selectedResult.count, backtestActualUnits: selectedResult.actualUnits,
    backtestForecastUnits: selectedResult.forecastUnits, backtestAbsoluteErrorUnits: selectedResult.absoluteErrorUnits,
    backtestSignedErrorUnits: selectedResult.signedErrorUnits,
  };
}
