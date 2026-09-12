import { CHANGE_POINT_TOLERANCE_WEEKS, CUSUM_DEFAULTS, DEMO, MAD_TO_SIGMA, mad, median } from "@canary/shared";
import { describe, expect, it } from "vitest";
import { ewma, runCusum } from "./cusum.ts";
import { buildWeeks } from "./test-helpers.ts";

describe("runCusum", () => {
  it("fires on a planted step and puts the new regime at the planted week", () => {
    const weeks = buildWeeks({ changeAt: DEMO.CHANGE_START_INDEX });
    const result = runCusum(weeks);

    expect(result.fired).toBe(true);
    expect(result.alarm_week_index).not.toBeNull();
    // The alarm must land before the final week so the demo has post-change data.
    expect(result.alarm_week_index!).toBeLessThan(weeks.length - 1);

    // `estimated_change_point_index` is the last OLD-regime week; the new regime
    // starts at index + 1, and that is the date users see.
    const regimeStart = result.estimated_change_point_index! + 1;
    expect(Math.abs(regimeStart - DEMO.CHANGE_START_INDEX)).toBeLessThanOrEqual(1);
    expect(result.estimated_change_point_week_start).toBe(weeks[regimeStart]!.week_start);
    expect(result.alarm_week_start).toBe(weeks[result.alarm_week_index!]!.week_start);

    expect(result.detection_lag_weeks).toBe(result.alarm_week_index! - regimeStart);
    expect(result.detection_lag_weeks!).toBeGreaterThanOrEqual(0);
    expect(result.detection_lag_weeks!).toBeLessThanOrEqual(CHANGE_POINT_TOLERANCE_WEEKS);
    expect(result.post_change_weeks).toBe(weeks.length - regimeStart);
  });

  it("reports pre/post rates and a delta that agree with the segment means", () => {
    const weeks = buildWeeks();
    const result = runCusum(weeks);
    const regimeStart = result.estimated_change_point_index! + 1;
    const series = weeks.map((w) => w.variable_spend_cents);
    const mean = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);

    expect(result.pre_change_rate_weekly_cents).toBe(mean(series.slice(0, regimeStart)));
    expect(result.post_change_rate_weekly_cents).toBe(mean(series.slice(regimeStart)));
    expect(result.delta_weekly_cents).toBe(result.post_change_rate_weekly_cents! - result.pre_change_rate_weekly_cents!);
    expect(result.delta_weekly_cents!).toBeGreaterThan(0);
    for (const value of [result.pre_change_rate_weekly_cents!, result.post_change_rate_weekly_cents!, result.delta_weekly_cents!]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it("derives sigma, k and h from the baseline weeks and config only", () => {
    const weeks = buildWeeks();
    const result = runCusum(weeks);
    const baseline = weeks.slice(0, CUSUM_DEFAULTS.min_baseline_weeks).map((w) => w.variable_spend_cents);
    const mu0 = median(baseline);
    const sigma = Math.max(MAD_TO_SIGMA * mad(baseline), CUSUM_DEFAULTS.sigma_floor_fraction * mu0);

    expect(result.baseline_weeks).toBe(CUSUM_DEFAULTS.min_baseline_weeks);
    expect(result.baseline_median_cents).toBe(Math.round(mu0));
    expect(result.sigma_cents).toBe(Math.round(sigma));
    expect(result.k_cents).toBe(Math.round(CUSUM_DEFAULTS.k_factor * sigma));
    expect(result.h_cents).toBe(Math.round(CUSUM_DEFAULTS.h_multiplier * sigma));
    expect(result.config).toEqual(CUSUM_DEFAULTS);
  });

  it("keeps the statistic running after the alarm and never lets it go negative", () => {
    const weeks = buildWeeks();
    const result = runCusum(weeks);

    expect(result.statistic_cents).toHaveLength(weeks.length);
    expect(Math.min(...result.statistic_cents)).toBeGreaterThanOrEqual(0);
    // No reset: after a sustained shift the statistic keeps climbing.
    const after = result.statistic_cents.slice(result.alarm_week_index!);
    for (let i = 1; i < after.length; i++) expect(after[i]!).toBeGreaterThan(after[i - 1]!);
    expect(result.statistic_cents.every((v) => Number.isInteger(v))).toBe(true);
  });

  it("detects a ramped shift a week or so late but still lands the change point", () => {
    const weeks = buildWeeks({ rampWeeks: DEMO.CHANGE_RAMP_WEEKS, noiseFraction: 0.15 });
    const result = runCusum(weeks);

    expect(result.fired).toBe(true);
    expect(result.detection_lag_weeks!).toBeGreaterThan(0);
    expect(result.alarm_week_index!).toBeLessThan(weeks.length - 1);
    const regimeStart = result.estimated_change_point_index! + 1;
    expect(Math.abs(regimeStart - DEMO.CHANGE_START_INDEX)).toBeLessThanOrEqual(CHANGE_POINT_TOLERANCE_WEEKS);
  });

  it("does not fire on pure noise", () => {
    const result = runCusum(buildWeeks({ changeAt: null, noiseFraction: 0.05 }));

    expect(result.fired).toBe(false);
    expect(result.alarm_week_index).toBeNull();
    expect(result.estimated_change_point_index).toBeNull();
    expect(result.estimated_change_point_week_start).toBeNull();
    expect(result.pre_change_rate_weekly_cents).toBeNull();
    expect(result.post_change_rate_weekly_cents).toBeNull();
    expect(result.delta_weekly_cents).toBeNull();
    expect(result.detection_lag_weeks).toBeNull();
    expect(result.post_change_weeks).toBeNull();
    // The statistic is still returned for the chart.
    expect(result.statistic_cents).toHaveLength(DEMO.WEEKS);
    expect(Math.max(...result.statistic_cents)).toBeLessThanOrEqual(result.h_cents);
  });

  it("fires on a raw single-week spike but not once that spike is winsorized out", () => {
    const spike = { index: 14, amount: 1_800_000, entity: "figma" };
    const raw = runCusum(buildWeeks({ changeAt: null, spike }));
    const winsorized = runCusum(buildWeeks({ changeAt: null, spike: { ...spike, excluded: true } }));

    expect(raw.fired).toBe(true);
    expect(raw.alarm_week_index).toBe(spike.index);

    // Same spend, but the engine moved it to excluded_from_monitoring_cents
    // because the one-off detector tagged it — so CUSUM must stay quiet.
    expect(winsorized.fired).toBe(false);
    expect(winsorized.statistic_cents[spike.index]).toBe(0);
  });

  it("refuses to fire without enough baseline weeks", () => {
    const weeks = buildWeeks({ weeks: CUSUM_DEFAULTS.min_baseline_weeks - 1, changeAt: null });
    const result = runCusum(weeks);

    expect(result.fired).toBe(false);
    expect(result.baseline_weeks).toBe(weeks.length);
    expect(result.statistic_cents).toEqual(weeks.map(() => 0));
  });

  it("refuses to fire when the baseline has no spend to deviate from", () => {
    const result = runCusum(buildWeeks({ base: { aws: 0 }, step: { aws: 500_000 }, noiseFraction: 0, fixedCents: 0 }));

    expect(result.sigma_cents).toBe(0);
    expect(result.fired).toBe(false);
  });

  it("honours config overrides and falls back to defaults for the rest", () => {
    const weeks = buildWeeks();
    const tight = runCusum(weeks, { h_multiplier: 1 });
    const loose = runCusum(weeks, { h_multiplier: 40 });
    const unreachable = runCusum(weeks, { h_multiplier: 1_000 });

    expect(tight.config.h_multiplier).toBe(1);
    expect(tight.config.k_factor).toBe(CUSUM_DEFAULTS.k_factor);
    expect(tight.h_cents).toBeLessThan(loose.h_cents);
    // A higher decision interval only delays the alarm; it never moves it earlier.
    expect(loose.alarm_week_index!).toBeGreaterThan(tight.alarm_week_index!);
    expect(unreachable.fired).toBe(false);
  });

  it("uses the FIRST weeks as the baseline, so a late shift cannot contaminate it", () => {
    const early = buildWeeks({ changeAt: 2 });
    const late = buildWeeks({ changeAt: 14 });

    // Same generator, same noise: only the shift moves. The late series keeps a
    // clean baseline, so it has the larger normalized signal.
    expect(runCusum(late).baseline_median_cents).toBeLessThan(runCusum(early).baseline_median_cents);
    expect(runCusum(late).fired).toBe(true);
    expect(runCusum(late).estimated_change_point_index! + 1).toBe(14);
  });

  it("is deterministic", () => {
    expect(runCusum(buildWeeks())).toEqual(runCusum(buildWeeks()));
  });

  it("handles an empty series", () => {
    const result = runCusum([]);
    expect(result.fired).toBe(false);
    expect(result.statistic_cents).toEqual([]);
  });
});

describe("ewma", () => {
  it("smooths towards the series and keeps the same length", () => {
    const values = [100, 200, 300, 400];
    const smoothed = ewma(values, 0.5);

    expect(smoothed).toEqual([100, 150, 225, 313]);
    expect(smoothed).toHaveLength(values.length);
    expect(smoothed.every((v) => Number.isInteger(v))).toBe(true);
  });

  it("returns the series unchanged at alpha 1 and flat at a tiny alpha", () => {
    const values = [500, 900, 100];
    expect(ewma(values, 1)).toEqual(values);
    expect(ewma(values, 0.0001)).toEqual([500, 500, 500]);
    expect(ewma([], 0.3)).toEqual([]);
  });

  it("rejects an alpha outside (0, 1]", () => {
    expect(() => ewma([1, 2], 0)).toThrow();
    expect(() => ewma([1, 2], 1.5)).toThrow();
  });
});
