import { describe, expect, it } from "vitest";
import { forecastDemand } from "./forecast";

const history = (days: number, value: (index: number, weekday: number) => number) => Array.from({ length: days }, (_, index) => {
  const date = new Date(Date.UTC(2026, 0, index + 1));
  return { date: date.toISOString().slice(0, 10), unitsSold: value(index, date.getUTCDay()) };
});

describe("fashion demand forecasting", () => {
  it("auto-selects an accurate model using unseen holdout days", () => {
    const result = forecastDemand(history(98, (_, weekday) => [0, 6].includes(weekday) ? 4 : 20), "auto", 98);
    expect(result.model).toBe("seasonal");
    expect(result.accuracy).toBeGreaterThan(0.95);
    expect(result.backtestDays).toBeGreaterThan(10);
  });

  it("reduces net demand for cancellations and recoverable returns", () => {
    const rows = history(60, () => 10).map(row => ({ ...row, returnsQty: 2, cancellationsQty: 1 }));
    const result = forecastDemand(rows, "average", 60, 0, 0.8);
    expect(result.dailyRate).toBeCloseTo(7.4, 3);
    expect(result.returnRate).toBeCloseTo(0.2, 3);
    expect(result.cancellationRate).toBeCloseTo(0.1, 3);
  });

  it("censors stockout days rather than treating them as zero demand", () => {
    const rows = history(60, () => 12).map((row, index) => ({ ...row, unitsSold: index >= 20 && index < 30 ? 0 : 12, inStock: !(index >= 20 && index < 30) }));
    const result = forecastDemand(rows, "average", 60);
    expect(result.stockoutDays).toBe(10);
    expect(result.dailyRate).toBeCloseTo(12, 2);
  });

  it("separates explicit stockouts from a delayed source snapshot", () => {
    const result = forecastDemand(history(30, () => 12), "average", 60, 0, 0.8, "2026-02-02");
    expect(result.stockoutDays).toBe(0);
    expect(result.dataLatencyDays).toBe(3);
    expect(result.observedDays).toBe(30);
    expect(result.dailyRate).toBeCloseTo(12, 2);
    expect(result.qualityReasons.join(" ")).toMatch(/data latency/i);
  });

  it("keeps planned campaign uplift separate and explainable", () => {
    const result = forecastDemand(history(60, () => 10), "average", 60, 50);
    expect(result.baseDailyRate).toBeCloseTo(10, 2);
    expect(result.dailyRate).toBeCloseTo(15, 2);
    expect(result.promotionUplift).toBe(0.5);
  });

  it("anchors history to the planning date and rejects future leakage", () => {
    const rows = [...history(40, () => 10), { date: "2026-12-31", unitsSold: 10000 }];
    const result = forecastDemand(rows, "average", 40, 0, 0.8, "2026-02-09");
    expect(result.dailyRate).toBeCloseTo(10, 2);
    expect(result.historyDays).toBe(40);
  });

  it("does not award high confidence when a long history has poor holdout accuracy and bias", () => {
    const rows = history(120, index => index < 90 ? 5 : 55);
    const result = forecastDemand(rows, "average", 120);
    expect(result.historyDays).toBe(120);
    expect(result.wmape).toBeGreaterThan(0.4);
    expect(Math.abs(result.bias!)).toBeGreaterThan(0.25);
    expect(result.quality).toBe("low");
    expect(result.confidenceScore).toBeLessThan(50);
    expect(result.qualityReasons.join(" ")).toMatch(/error|bias/i);
  });

  it("de-spikes repeated promotions before estimating organic demand", () => {
    const rows = history(120, index => [30, 31, 32, 60, 61, 62, 90, 91, 92].includes(index) ? 30 : 10)
      .map((row, index) => ({ ...row, isPromotion: [30, 31, 32, 60, 61, 62, 90, 91, 92].includes(index) }));
    const result = forecastDemand(rows, "average", 120);
    expect(result.baseDailyRate).toBeCloseTo(10, 1);
    expect(result.observedPromotionUplift).toBeCloseTo(2, 1);
    expect(result.promotionAdjustedDays).toBe(9);
  });

  it("exposes additive holdout totals for a true portfolio WAPE", () => {
    const result = forecastDemand(history(98, index => 10 + (index % 5)), "recent", 98);
    expect(result.backtestActualUnits).toBeGreaterThan(0);
    expect(result.backtestForecastUnits).toBeGreaterThan(0);
    expect(result.forecastErrorRmse).toBeGreaterThanOrEqual(0);
    expect(result.backtestAbsoluteErrorUnits / result.backtestActualUnits).toBeCloseTo(result.wmape!, 10);
    expect(result.backtestSignedErrorUnits / result.backtestActualUnits).toBeCloseTo(result.bias!, 10);
  });

  it("reports why auto chose a champion or a causally validated blend", () => {
    const rows = history(140, (index, weekday) => 8 + index * 0.08 + ([0, 6].includes(weekday) ? 7 : 0));
    const result = forecastDemand(rows, "auto", 140);
    expect(["champion", "ensemble"]).toContain(result.selectionStrategy);
    expect(result.contributors.length).toBeGreaterThan(0);
    expect(result.contributors.reduce((sum, contributor) => sum + contributor.weight, 0)).toBeCloseTo(1, 8);
    expect(result.modelLabel.length).toBeGreaterThan(5);
  });

  it("selects the causal ensemble when it materially beats every single champion", () => {
    const rows = history(140, (index, weekday) => 10 + index * 0.05 + ([0, 6].includes(weekday) ? 5 : 0));
    const result = forecastDemand(rows, "auto", 140);
    expect(result.selectionStrategy).toBe("ensemble");
    expect(result.modelLabel).toMatch(/Validated blend/);
    expect(result.contributors.length).toBeGreaterThan(1);
    expect(result.wmape).toBeLessThan(Math.min(...result.contributors.map(contributor => contributor.wmape ?? Infinity)));
  });

  it("honours an explicitly requested intermittent model on dense history", () => {
    const result = forecastDemand(history(70, () => 10), "croston", 70);
    expect(result.model).toBe("croston");
    expect(result.selectionStrategy).toBe("fixed");
    expect(result.contributors).toHaveLength(1);
  });
});
