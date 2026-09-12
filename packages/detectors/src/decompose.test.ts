import { CONTRIBUTOR_SUM_TOLERANCE, weeklyToMonthly } from "@canary/shared";
import { describe, expect, it } from "vitest";
import { runCusum } from "./cusum.ts";
import { decomposeContributors } from "./decompose.ts";
import { BASE_WEEKLY, STEP_WEEKLY, buildWeeks } from "./test-helpers.ts";

describe("decomposeContributors", () => {
  const weeks = buildWeeks();
  const cusum = runCusum(weeks);
  const contributors = decomposeContributors(weeks, cusum);

  it("covers every entity and sorts by dollar delta descending", () => {
    const entities = new Set(weeks.flatMap((w) => Object.keys(w.variable_by_entity)));
    expect(new Set(contributors.map((c) => c.entity))).toEqual(entities);

    const deltas = contributors.map((c) => c.delta_weekly_cents);
    expect([...deltas].sort((a, b) => b - a)).toEqual(deltas);
    expect(contributors[0]!.entity).toBe("aws");
  });

  it("sums to the CUSUM delta within rounding tolerance", () => {
    const sum = contributors.reduce((total, c) => total + c.delta_weekly_cents, 0);
    const delta = cusum.delta_weekly_cents!;

    // Each entity mean and each CUSUM rate is rounded independently, so allow a
    // cent per entity plus the two rates. Nothing is adjusted to force a match.
    expect(Math.abs(sum - delta)).toBeLessThanOrEqual(contributors.length + 2);
    expect(Math.abs(sum - delta)).toBeLessThanOrEqual(Math.abs(delta) * CONTRIBUTOR_SUM_TOLERANCE);
  });

  it("attributes most of the delta to the planted driver", () => {
    const aws = contributors.find((c) => c.entity === "aws")!;

    expect(aws.delta_weekly_cents).toBeGreaterThan(0);
    expect(aws.share_of_total_delta).toBeGreaterThan(0.5);
    expect(aws.delta_monthly_cents).toBe(weeklyToMonthly(aws.delta_weekly_cents));
    expect(aws.post_rate_weekly_cents - aws.pre_rate_weekly_cents).toBe(aws.delta_weekly_cents);
    // Pre/post rates sit around the planted levels (noise is ±3%).
    expect(Math.abs(aws.pre_rate_weekly_cents - BASE_WEEKLY.aws!)).toBeLessThan(BASE_WEEKLY.aws! * 0.05);
    expect(Math.abs(aws.delta_weekly_cents - STEP_WEEKLY.aws!)).toBeLessThan(STEP_WEEKLY.aws! * 0.05);
  });

  it("reports a flat entity as a near-zero contributor and leaves category to the ledger", () => {
    const upwork = contributors.find((c) => c.entity === "upwork")!;

    expect(Math.abs(upwork.delta_weekly_cents)).toBeLessThan(STEP_WEEKLY.aws! * 0.05);
    expect(upwork.category).toBeNull();
  });

  it("allows negative contributors", () => {
    const declining = buildWeeks({ step: { aws: 400_000, upwork: -150_000 }, noiseFraction: 0 });
    const result = decomposeContributors(declining, runCusum(declining));

    expect(result[0]!.entity).toBe("aws");
    expect(result[result.length - 1]!.entity).toBe("upwork");
    expect(result[result.length - 1]!.delta_weekly_cents).toBeLessThan(0);
    expect(result[result.length - 1]!.share_of_total_delta).toBeLessThan(0);
  });

  it("treats an entity that only appears after the change as starting from zero", () => {
    const newVendor = buildWeeks({ base: { aws: 400_000 }, step: { aws: 0, ashby: 300_000 }, noiseFraction: 0 });
    const weeksWithGap = newVendor.map((week, i) =>
      i < 10 ? { ...week, variable_by_entity: { aws: week.variable_by_entity.aws! } } : week,
    );
    const result = decomposeContributors(weeksWithGap, runCusum(weeksWithGap));
    const ashby = result.find((c) => c.entity === "ashby")!;

    expect(ashby.pre_rate_weekly_cents).toBe(0);
    expect(ashby.post_rate_weekly_cents).toBeGreaterThan(0);
  });

  it("returns nothing when CUSUM did not fire", () => {
    const quiet = buildWeeks({ changeAt: null, noiseFraction: 0.05 });
    expect(decomposeContributors(quiet, runCusum(quiet))).toEqual([]);
  });

  it("is deterministic", () => {
    expect(decomposeContributors(weeks, cusum)).toEqual(decomposeContributors(buildWeeks(), runCusum(buildWeeks())));
  });
});
