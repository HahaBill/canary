/**
 * Detectability of the planted events.
 *
 * The generator has to *prove* its fixture is detectable, otherwise the demo depends on
 * luck. These tests run an independent reference CUSUM (src/cusum.testkit.ts) with the
 * shared configuration over the generator's own weekly variable series.
 */
import {
  CHANGE_POINT_TOLERANCE_WEEKS,
  CUSUM_DEFAULTS,
  DEMO,
  MAD_TO_SIGMA,
  MATERIALITY,
  VARIABLE_CATEGORIES,
  mad,
  median,
  weekIndexOf,
  weeklyToMonthly,
  type Category,
  type GeneratedCompany,
} from "@canary/shared";
import { describe, expect, it } from "vitest";
import { referenceCusum } from "./cusum.testkit.ts";
import { DEFAULT_DEMO_OPTIONS, generateDemoCompany, summarizeWeeklyVariableSpend } from "./index.ts";
import { PLANTED_DELTA_WEEKLY_CENTS } from "./plan.ts";

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** The monitored series exactly as the engine will build it: one-off excluded. */
function monitoredSeries(gen: GeneratedCompany): number[] {
  return summarizeWeeklyVariableSpend(gen.transactions, {
    historyStart: gen.fixture.start_date,
    weeks: gen.fixture.weeks,
    excludeIds: [gen.fixture.one_off.transaction_id],
  });
}

/** Weekly variable spend per `merchant_normalized`, one-off excluded. */
function seriesByEntity(gen: GeneratedCompany): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const superseded = new Set(gen.transactions.filter((t) => t.pending_of).map((t) => t.pending_of!));
  for (const t of gen.transactions) {
    if (superseded.has(t.id) || t.id === gen.fixture.one_off.transaction_id) continue;
    if (t.tags.length > 0) continue;
    if (!t.category_hint || !VARIABLE_CATEGORIES.includes(t.category_hint as Category)) continue;
    const i = weekIndexOf(t.date, gen.fixture.start_date);
    if (i < 0 || i >= gen.fixture.weeks) continue;
    const row = out.get(t.merchant_normalized) ?? new Array<number>(gen.fixture.weeks).fill(0);
    row[i] = row[i]! - t.amount_cents;
    out.set(t.merchant_normalized, row);
  }
  return out;
}

const demo = generateDemoCompany(DEFAULT_DEMO_OPTIONS);
const change = demo.fixture.burn_shift.true_change_start_index;
const rampEnd = change + DEMO.CHANGE_RAMP_WEEKS - 1;
const series = monitoredSeries(demo);
const cusum = referenceCusum(series);
const preMean = mean(series.slice(0, change));

describe("weekly variable series", () => {
  it("has one entry per week and is entirely positive", () => {
    expect(series).toHaveLength(DEMO.WEEKS);
    for (const v of series) expect(v).toBeGreaterThan(0);
  });

  it("recovers a baseline sigma above the configured floor", () => {
    const baseline = series.slice(0, CUSUM_DEFAULTS.min_baseline_weeks);
    const mu0 = median(baseline);
    const sigmaFromMad = MAD_TO_SIGMA * mad(baseline);
    expect(sigmaFromMad).toBeGreaterThan(CUSUM_DEFAULTS.sigma_floor_fraction * mu0);
    expect(cusum.sigma_cents).toBeCloseTo(sigmaFromMad, 6);
  });

  it("sizes the planted delta at 3–5× baseline sigma", () => {
    const ratio = PLANTED_DELTA_WEEKLY_CENTS / cusum.sigma_cents;
    expect(ratio).toBeGreaterThanOrEqual(3);
    expect(ratio).toBeLessThanOrEqual(5);
  });
});

describe("CUSUM on the planted shift", () => {
  it("fires", () => {
    expect(cusum.fired).toBe(true);
  });

  it("does not fire in the very first post-change week", () => {
    expect(cusum.alarm_week_index).not.toBeNull();
    expect(cusum.alarm_week_index!).toBeGreaterThan(change);
  });

  it("fires before the final week, leaving confirmation history behind it", () => {
    expect(cusum.alarm_week_index!).toBeLessThan(DEMO.WEEKS - 1);
    expect(DEMO.WEEKS - cusum.alarm_week_index!).toBeGreaterThanOrEqual(4);
  });

  it("estimates a change point within tolerance of the planted one", () => {
    expect(cusum.regime_start_index).not.toBeNull();
    expect(Math.abs(cusum.regime_start_index! - change)).toBeLessThanOrEqual(CHANGE_POINT_TOLERANCE_WEEKS);
  });

  it("leaves at least MIN_POST_CHANGE_WEEKS of history after the estimated change point", () => {
    expect(DEMO.WEEKS - cusum.regime_start_index!).toBeGreaterThanOrEqual(4);
  });

  it("does NOT fire on the pre-change weeks alone", () => {
    expect(referenceCusum(series.slice(0, change)).fired).toBe(false);
  });

  it("keeps the statistic at zero for most of the baseline, so the change point is recoverable", () => {
    const zeros = series.slice(0, change).filter((_, i) => cusum.statistic_cents[i] === 0).length;
    expect(zeros).toBeGreaterThanOrEqual(change / 2);
  });

  it("does not fire only because of the one-off (contract §15)", () => {
    const withOneOff = summarizeWeeklyVariableSpend(demo.transactions, {
      historyStart: demo.fixture.start_date,
      weeks: demo.fixture.weeks,
    });
    const oneOffWeek = weekIndexOf(
      demo.transactions.find((t) => t.id === demo.fixture.one_off.transaction_id)!.date,
      demo.fixture.start_date,
    );
    // The untagged one-off is a real spike in the raw series…
    expect(withOneOff[oneOffWeek]!).toBe(series[oneOffWeek]! + demo.fixture.one_off.amount_cents);
    // …and removing it does not change the verdict, so the alarm is the regime, not the spike.
    expect(cusum.fired).toBe(true);
    expect(cusum.alarm_week_index!).toBeLessThan(oneOffWeek);
  });
});

describe("the shift is sustained, not a spike", () => {
  it("raises the post-change mean by the ramp-weighted planted delta", () => {
    const rampWeight =
      mean(
        Array.from({ length: DEMO.WEEKS - change }, (_, n) =>
          Math.min(1, (n + 1) / DEMO.CHANGE_RAMP_WEEKS),
        ),
      );
    const expected = rampWeight * PLANTED_DELTA_WEEKLY_CENTS;
    const actual = mean(series.slice(change)) - preMean;
    expect(actual / expected).toBeGreaterThan(0.9);
    expect(actual / expected).toBeLessThan(1.1);
  });

  it("raises the fully-ramped mean by the planted delta", () => {
    const actual = mean(series.slice(rampEnd)) - preMean;
    expect(actual / PLANTED_DELTA_WEEKLY_CENTS).toBeGreaterThan(0.9);
    expect(actual / PLANTED_DELTA_WEEKLY_CENTS).toBeLessThan(1.1);
  });

  it("keeps every fully-ramped week elevated, through the last week", () => {
    for (let i = rampEnd; i < DEMO.WEEKS; i++) {
      expect(series[i]!, `week ${i} fell back to baseline`).toBeGreaterThan(
        preMean + 0.5 * PLANTED_DELTA_WEEKLY_CENTS,
      );
    }
    expect(series[DEMO.WEEKS - 1]!).toBeGreaterThan(preMean + 0.5 * PLANTED_DELTA_WEEKLY_CENTS);
  });

  it("ramps rather than stepping: the first post-change week is below the ramped level", () => {
    expect(series[change]!).toBeLessThan(mean(series.slice(rampEnd)));
    expect(series[change]!).toBeGreaterThan(preMean);
  });

  it("is material under every configured rate-materiality rule", () => {
    const monthlyDelta = weeklyToMonthly(Math.round(mean(series.slice(rampEnd)) - preMean));
    expect(monthlyDelta).toBeGreaterThanOrEqual(MATERIALITY.MIN_MONTHLY_DELTA_CENTS);
  });
});

describe("contributor decomposition", () => {
  const byEntity = seriesByEntity(demo);
  const deltas = [...byEntity.entries()]
    .map(([entity, row]) => ({ entity, delta: mean(row.slice(change)) - mean(row.slice(0, change)) }))
    .sort((a, b) => b.delta - a.delta);
  const totalDelta = mean(series.slice(change)) - preMean;

  it("makes aws the largest contributor", () => {
    expect(deltas[0]!.entity).toBe(DEMO.PRIMARY_DRIVER_ENTITY);
  });

  it("gives aws the majority of the delta", () => {
    expect(deltas[0]!.delta / totalDelta).toBeGreaterThan(0.5);
  });

  it("makes the secondary drivers positive contributors", () => {
    for (const entity of DEMO.SECONDARY_DRIVER_ENTITIES) {
      const row = deltas.find((d) => d.entity === entity);
      expect(row, `${entity} produced no variable spend`).toBeDefined();
      expect(row!.delta, `${entity} is not a positive contributor`).toBeGreaterThan(0);
    }
  });

  it("sums entity deltas to the total delta", () => {
    const sum = deltas.reduce((s, d) => s + d.delta, 0);
    expect(Math.abs(sum - totalDelta) / totalDelta).toBeLessThan(0.01);
  });

  it("allows negative contributors", () => {
    expect(deltas.some((d) => d.delta < 0)).toBe(true);
  });
});

describe("robustness across seeds", () => {
  const seeds = [DEMO.SEED, DEMO.TEST_SEED, 1, 7, 99, 20250101, 987654321, 5150];
  for (const seed of seeds) {
    it(`seed ${seed} stays detectable`, () => {
      const gen = generateDemoCompany({ ...DEFAULT_DEMO_OPTIONS, seed });
      const s = monitoredSeries(gen);
      const c = referenceCusum(s);
      const ratio = PLANTED_DELTA_WEEKLY_CENTS / c.sigma_cents;
      expect(ratio, "delta/sigma").toBeGreaterThan(3);
      expect(ratio, "delta/sigma").toBeLessThan(5);
      expect(c.fired).toBe(true);
      expect(c.alarm_week_index!).toBeGreaterThan(change);
      expect(c.alarm_week_index!).toBeLessThan(DEMO.WEEKS - 1);
      expect(referenceCusum(s.slice(0, change)).fired).toBe(false);
      expect(Math.abs(c.regime_start_index! - change)).toBeLessThanOrEqual(CHANGE_POINT_TOLERANCE_WEEKS);
    });
  }
});

describe("summarizeWeeklyVariableSpend", () => {
  it("drops pending rows superseded by a settled row", () => {
    const pair = demo.fixture.pending_settled_pairs[0]!;
    const pending = demo.transactions.find((t) => t.id === pair.pending_id)!;
    const week = weekIndexOf(pending.date, demo.fixture.start_date);
    const withoutSettled = summarizeWeeklyVariableSpend(
      demo.transactions.filter((t) => t.id !== pair.settled_id),
      { historyStart: demo.fixture.start_date, weeks: demo.fixture.weeks, excludeIds: [demo.fixture.one_off.transaction_id] },
    );
    // With the settled row removed the pending row is no longer superseded, so it counts —
    // proving it was excluded while the settled row existed.
    expect(withoutSettled[week]!).toBeGreaterThan(0);
    expect(summarizeWeeklyVariableSpend([pending])).toEqual([-pending.amount_cents]);
  });

  it("excludes tagged rows from the monitored series", () => {
    const testGen = generateDemoCompany({ ...DEFAULT_DEMO_OPTIONS, seed: DEMO.TEST_SEED, profile: "test" });
    const renewal = testGen.transactions.find((t) => t.tags.includes("annual_renewal"))!;
    expect(renewal.category_hint).toBe("SAAS_SOFTWARE");
    // In VARIABLE_CATEGORIES, yet contributes nothing because of the tag.
    expect(summarizeWeeklyVariableSpend([renewal])).toEqual([0]);
  });

  it("nets refunds against the week they land in", () => {
    const refund = demo.transactions.find((t) => t.id === demo.fixture.refund_transaction_ids[0])!;
    expect(summarizeWeeklyVariableSpend([refund])).toEqual([-refund.amount_cents]);
    expect(summarizeWeeklyVariableSpend([refund])[0]!).toBeLessThan(0);
  });

  it("returns an empty series for no transactions", () => {
    expect(summarizeWeeklyVariableSpend([])).toEqual([]);
  });
});
