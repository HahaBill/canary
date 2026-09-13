import { CHANGE_POINT_TOLERANCE_WEEKS, CUSUM_DEFAULTS, DEMO, MAD_TO_SIGMA, mad, median } from "@canary/shared";
import { describe, expect, it } from "vitest";
import { NO_PRE_CHANGE_SEGMENT, ewma, runCusum } from "./cusum.ts";
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

/**
 * Cases the demo series never produces. Each one is a contract §6 clause that
 * had no test: the alarm landing on the final week, the "statistic never
 * returned to zero" sentinel, the sigma floor carrying the whole estimate, and
 * a dead week inside the series.
 */
describe("runCusum — edge cases outside the demo path", () => {
  /** A flat series with one large week. Baseline MAD is 0, so sigma is the floor. */
  const flatWithSpike = (index: number, amount = 765_000) =>
    buildWeeks({ changeAt: null, noiseFraction: 0, spike: { index, amount } });

  it("fires on the final week and reports a post-change rate from very few weeks", () => {
    const weeks = buildWeeks({ changeAt: DEMO.WEEKS - 1, noiseFraction: 0.03, step: { aws: 2_000_000 } });
    const result = runCusum(weeks);
    const last = weeks.length - 1;
    const regimeStart = result.estimated_change_point_index! + 1;
    const post = weeks.slice(regimeStart).map((w) => w.variable_spend_cents);

    expect(result.fired).toBe(true);
    expect(result.alarm_week_index).toBe(last);
    expect(result.estimated_change_point_index!).toBeLessThan(last);
    // The whole post-change segment is one or two weeks, so everything the
    // incident says about "the new rate" rests on that tiny sample. Nothing in
    // the detector refuses to publish it — MIN_POST_CHANGE_WEEKS guards the burn
    // window, not the narrative. See docs/AGENT_BEHAVIOR.md.
    expect(result.post_change_weeks).toBe(weeks.length - regimeStart);
    expect(result.post_change_weeks!).toBeLessThanOrEqual(2);
    expect(result.post_change_rate_weekly_cents).toBe(Math.round(post.reduce((a, b) => a + b, 0) / post.length));
    expect(result.detection_lag_weeks).toBe(last - regimeStart);
    expect(Number.isInteger(result.pre_change_rate_weekly_cents!)).toBe(true);
  });

  it("reports no pre-change segment when the statistic never returned to zero before the alarm", () => {
    // Week 0 is double the flat level, so the statistic clears h immediately and
    // there is no earlier zero to point at.
    const weeks = flatWithSpike(0);
    const result = runCusum(weeks);

    expect(result.fired).toBe(true);
    expect(result.alarm_week_index).toBe(0);
    expect(result.estimated_change_point_index).toBe(NO_PRE_CHANGE_SEGMENT);
    // An unknown pre-change rate stays null rather than becoming a misleading zero.
    expect(result.pre_change_rate_weekly_cents).toBeNull();
    expect(result.delta_weekly_cents).toBeNull();
    // The date still resolves: the elevated regime covers the whole series.
    expect(result.estimated_change_point_week_start).toBe(weeks[0]!.week_start);
    expect(result.post_change_weeks).toBe(DEMO.WEEKS);
  });

  it("falls back to the sigma floor when the baseline has no dispersion", () => {
    const weeks = flatWithSpike(0);
    const result = runCusum(weeks);
    const flatLevel = weeks[1]!.variable_spend_cents;

    // MAD of an identical baseline is 0, so sigma is entirely the config floor.
    expect(result.baseline_median_cents).toBe(flatLevel);
    expect(result.sigma_cents).toBe(Math.round(CUSUM_DEFAULTS.sigma_floor_fraction * flatLevel));
    expect(result.h_cents).toBe(Math.round(CUSUM_DEFAULTS.h_multiplier * result.sigma_cents));
  });

  it("tolerates a +10% week on a flat baseline at h=6σ, but not a +14% one", () => {
    // With MAD = 0 the floor is the whole σ estimate, so one week alarms on its
    // own as soon as it exceeds floor × (h + k) ≈ 13% of the median. Raising h
    // from 4σ to 6σ moved that bar from 9% to 13% — a real gain this test used
    // to document as a failure. The floor fraction is still a live threshold
    // decision (proposal 1 in docs/ALFREDO-LOGIC-AUDIT.md): at a 5% floor the
    // one-week bar would sit near 33%, out of reach of any plausible blip.
    const spiked = (amount: number) =>
      runCusum(buildWeeks({ changeAt: null, noiseFraction: 0, spike: { index: 9, amount } }));

    expect(spiked(76_500).fired).toBe(false); // +10% of the $7,650 flat level
    const bigger = spiked(107_100); // +14%
    expect(bigger.fired).toBe(true);
    expect(bigger.alarm_week_index).toBe(9);
  });

  it("survives an all-zero week in the baseline and in the monitored window", () => {
    const zeroed = (index: number) =>
      buildWeeks({ changeAt: DEMO.CHANGE_START_INDEX }).map((w, i) =>
        i === index ? { ...w, variable_spend_cents: 0, variable_by_entity: {}, variable_by_category: {} } : w,
      );

    const inBaseline = runCusum(zeroed(3));
    expect(inBaseline.sigma_cents).toBeGreaterThan(0);
    expect(inBaseline.fired).toBe(true);
    expect(inBaseline.statistic_cents.every((s) => s >= 0)).toBe(true);

    const inWindow = runCusum(zeroed(DEMO.CHANGE_START_INDEX + 2));
    expect(inWindow.fired).toBe(true);
    expect(inWindow.statistic_cents.every((s) => s >= 0)).toBe(true);
  });

  it("tolerates a negative week (a refund larger than that week's charges)", () => {
    const weeks = buildWeeks({ changeAt: DEMO.CHANGE_START_INDEX }).map((w, i) =>
      i === 12 ? { ...w, variable_spend_cents: -50_000 } : w,
    );
    const result = runCusum(weeks);

    // The statistic floors at zero, so a credit week cannot push it negative.
    expect(result.statistic_cents.every((s) => s >= 0)).toBe(true);
    expect(result.statistic_cents).toHaveLength(weeks.length);
  });
});

/**
 * A growing company is the case a level-only CUSUM gets wrong, and it is not an
 * edge case — it is most startups. Spend above a flat baseline every week adds
 * up, so the statistic climbs on the growth itself and alarms on a company that
 * is simply getting bigger as planned.
 */
describe("runCusum — a company that is growing", () => {
  /** Scale week `i` by (1 + rate)^i, keeping entity shares intact. */
  const growing = (weeklyRate: number, options: Parameters<typeof buildWeeks>[0] = {}) =>
    buildWeeks({ changeAt: null, ...options }).map((week, i) => {
      const factor = Math.pow(1 + weeklyRate, i);
      const scale = (cents: number) => Math.round(cents * factor);
      return {
        ...week,
        variable_spend_cents: scale(week.variable_spend_cents),
        variable_by_entity: Object.fromEntries(Object.entries(week.variable_by_entity).map(([k, v]) => [k, scale(v)])),
      };
    });

  /** 3%/month — an ordinary seed-stage trajectory, not a crisis. */
  const STEADY = 0.03 / 4.345;

  it("does not alarm on ordinary growth", () => {
    const result = runCusum(growing(STEADY));

    expect(result.fired).toBe(false);
    // It recognised the growth rather than ignoring it.
    expect(result.baseline_slope_weekly_cents).toBeGreaterThan(0);
  });

  it("WOULD have alarmed without the trend, which is the bug this prevents", () => {
    // z = Infinity makes no slope believable, reproducing the old level-only
    // behaviour on the identical series.
    const levelOnly = runCusum(growing(STEADY), { trend_significance_z: Number.POSITIVE_INFINITY });

    expect(levelOnly.baseline_slope_weekly_cents).toBe(0);
    expect(levelOnly.fired).toBe(true);
    // And it fires early and permanently: growth never stops exceeding a fixed median.
    expect(levelOnly.alarm_week_index!).toBeLessThan(DEMO.WEEKS / 2);
  });

  it("stays quiet through fast growth too", () => {
    // 2%/week is a company roughly tripling its spend over a year.
    expect(runCusum(growing(0.02)).fired).toBe(false);
  });

  it("still catches a real shift on top of growth", () => {
    const rate = STEADY;
    const changeAt = DEMO.CHANGE_START_INDEX;
    const withShift = growing(rate).map((week, i) =>
      i < changeAt ? week : { ...week, variable_spend_cents: week.variable_spend_cents + 600_000 },
    );
    const result = runCusum(withShift);

    expect(result.fired).toBe(true);
    const regimeStart = result.estimated_change_point_index! + 1;
    expect(Math.abs(regimeStart - changeAt)).toBeLessThanOrEqual(CHANGE_POINT_TOLERANCE_WEEKS);
    // Growth alone was not the signal: the detector knew what to expect.
    expect(result.baseline_slope_weekly_cents).toBeGreaterThan(0);
  });

  it("refuses to believe a slope that noise alone could produce", () => {
    // A flat series with ordinary noise must be reported as flat. Trusting a
    // noise-driven slope would bend the line every later week is judged against.
    const flat = runCusum(buildWeeks({ changeAt: null, noiseFraction: 0.07 }));
    expect(flat.baseline_slope_weekly_cents).toBe(0);
    expect(flat.fired).toBe(false);
  });

  it("leaves a flat company's numbers exactly as they were", () => {
    // The demo series is flat, so the trend must change nothing about it.
    const weeks = buildWeeks();
    const result = runCusum(weeks);
    const levelOnly = runCusum(weeks, { trend_significance_z: Number.POSITIVE_INFINITY });

    expect(result.baseline_slope_weekly_cents).toBe(0);
    expect(result.sigma_cents).toBe(levelOnly.sigma_cents);
    expect(result.alarm_week_index).toBe(levelOnly.alarm_week_index);
    expect(result.estimated_change_point_index).toBe(levelOnly.estimated_change_point_index);
  });
});
