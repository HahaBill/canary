import { MATERIALITY, SEVERITY_THRESHOLDS, weeklyToMonthly } from "@canary/shared";
import { describe, expect, it } from "vitest";
import {
  ONE_OFF_MATERIALITY_RULES,
  RATE_MATERIALITY_RULES,
  evaluateOneOffMateriality,
  evaluateRateMateriality,
  runwayImpactMonths,
  severityFromRunwayImpact,
} from "./materiality.ts";
import { makeBurn } from "./test-helpers.ts";

/** $400K/month gross: big enough that the share-of-burn rule stays quiet. */
const LARGE_BURN = { monthly_gross_burn_cents: 40_000_000, runway_months: 14.3 };
/** $40K/month gross: small enough that a modest delta is 5%+ of burn. */
const SMALL_BURN = { monthly_gross_burn_cents: 4_000_000, runway_months: 14.3 };

describe("evaluateRateMateriality", () => {
  it("fires on the absolute monthly delta alone", () => {
    const delta = 120_000; // $1,200/week → $5,200/month
    const verdict = evaluateRateMateriality(delta, makeBurn(LARGE_BURN), makeBurn(LARGE_BURN));

    expect(weeklyToMonthly(delta)).toBeGreaterThanOrEqual(MATERIALITY.MIN_MONTHLY_DELTA_CENTS);
    expect(verdict.material).toBe(true);
    expect(verdict.rules_triggered).toEqual([RATE_MATERIALITY_RULES.MIN_MONTHLY_DELTA_CENTS]);
    expect(verdict.values.monthly_delta_cents).toBe(weeklyToMonthly(delta));
    expect(verdict.values.delta_weekly_cents).toBe(delta);
  });

  it("fires on the share of monthly gross burn alone", () => {
    const delta = 60_000; // $600/week → $2,600/month, under the absolute floor
    const verdict = evaluateRateMateriality(delta, makeBurn(SMALL_BURN), makeBurn(SMALL_BURN));

    expect(weeklyToMonthly(delta)).toBeLessThan(MATERIALITY.MIN_MONTHLY_DELTA_CENTS);
    expect(verdict.material).toBe(true);
    expect(verdict.rules_triggered).toEqual([RATE_MATERIALITY_RULES.MIN_BURN_PERCENT]);
    expect(verdict.values.burn_percent_threshold_cents).toBe(Math.round(MATERIALITY.MIN_BURN_PERCENT * SMALL_BURN.monthly_gross_burn_cents));
    expect(verdict.values.share_of_monthly_gross_burn!).toBeGreaterThanOrEqual(MATERIALITY.MIN_BURN_PERCENT);
  });

  it("fires on runway impact alone", () => {
    const verdict = evaluateRateMateriality(10_000, makeBurn(LARGE_BURN), makeBurn({ ...LARGE_BURN, runway_months: 13.7 }));

    expect(weeklyToMonthly(10_000)).toBeLessThan(MATERIALITY.MIN_MONTHLY_DELTA_CENTS);
    expect(verdict.material).toBe(true);
    expect(verdict.rules_triggered).toEqual([RATE_MATERIALITY_RULES.MIN_RUNWAY_IMPACT_MONTHS]);
    // Rounded to the one decimal runwayMonths reports, so 0.6 is not 0.5999…
    expect(verdict.values.runway_impact_months).toBe(0.6);
  });

  it("records every rule when several fire", () => {
    const verdict = evaluateRateMateriality(500_000, makeBurn(SMALL_BURN), makeBurn({ ...SMALL_BURN, runway_months: 11 }));

    expect(verdict.rules_triggered).toEqual([
      RATE_MATERIALITY_RULES.MIN_MONTHLY_DELTA_CENTS,
      RATE_MATERIALITY_RULES.MIN_BURN_PERCENT,
      RATE_MATERIALITY_RULES.MIN_RUNWAY_IMPACT_MONTHS,
    ]);
  });

  it("is immaterial when no rule fires", () => {
    const verdict = evaluateRateMateriality(10_000, makeBurn(LARGE_BURN), makeBurn(LARGE_BURN));

    expect(verdict.material).toBe(false);
    expect(verdict.rules_triggered).toEqual([]);
    expect(verdict.values.runway_impact_months).toBe(0);
  });

  it("is immaterial when spending fell", () => {
    expect(evaluateRateMateriality(-400_000, makeBurn(SMALL_BURN), makeBurn(SMALL_BURN)).material).toBe(false);
  });

  it("handles a null delta and null runways without throwing", () => {
    const nullDelta = evaluateRateMateriality(null, makeBurn(LARGE_BURN), makeBurn({ ...LARGE_BURN, runway_months: 10 }));
    expect(nullDelta.rules_triggered).toEqual([RATE_MATERIALITY_RULES.MIN_RUNWAY_IMPACT_MONTHS]);
    expect(nullDelta.values.monthly_delta_cents).toBeUndefined();

    const notBurning = evaluateRateMateriality(120_000, makeBurn({ ...LARGE_BURN, runway_months: null }), makeBurn({ ...LARGE_BURN, runway_months: null }));
    expect(notBurning.rules_triggered).toEqual([RATE_MATERIALITY_RULES.MIN_MONTHLY_DELTA_CENTS]);
    expect(notBurning.values.runway_impact_months).toBeUndefined();
  });

  it("skips the share-of-burn rule against a zero burn baseline", () => {
    const verdict = evaluateRateMateriality(10_000, makeBurn({ monthly_gross_burn_cents: 0 }), makeBurn({ monthly_gross_burn_cents: 0 }));

    expect(verdict.material).toBe(false);
    expect(verdict.values.burn_percent_threshold_cents).toBeUndefined();
  });
});

describe("evaluateOneOffMateriality", () => {
  it("fires on the absolute amount alone", () => {
    const verdict = evaluateOneOffMateriality(MATERIALITY.MIN_ONE_OFF_AMOUNT_CENTS, makeBurn({ monthly_gross_burn_cents: 100_000_000 }));

    expect(verdict.material).toBe(true);
    expect(verdict.rules_triggered).toEqual([ONE_OFF_MATERIALITY_RULES.MIN_ONE_OFF_AMOUNT_CENTS]);
  });

  it("fires on the share of monthly gross burn alone", () => {
    const verdict = evaluateOneOffMateriality(400_000, makeBurn({ monthly_gross_burn_cents: 10_000_000 }));

    expect(400_000).toBeLessThan(MATERIALITY.MIN_ONE_OFF_AMOUNT_CENTS);
    expect(verdict.material).toBe(true);
    expect(verdict.rules_triggered).toEqual([ONE_OFF_MATERIALITY_RULES.MIN_ONE_OFF_BURN_PERCENT]);
  });

  it("is immaterial for a small payment against a large burn", () => {
    const verdict = evaluateOneOffMateriality(100_000, makeBurn({ monthly_gross_burn_cents: 100_000_000 }));

    expect(verdict.material).toBe(false);
    expect(verdict.rules_triggered).toEqual([]);
    expect(verdict.values.amount_cents).toBe(100_000);
  });

  it("uses the magnitude of a signed amount and tolerates zero burn", () => {
    expect(evaluateOneOffMateriality(-1_800_000, makeBurn()).material).toBe(true);
    const zeroBurn = evaluateOneOffMateriality(100_000, makeBurn({ monthly_gross_burn_cents: 0 }));
    expect(zeroBurn.material).toBe(false);
    expect(zeroBurn.values.share_of_monthly_gross_burn).toBeUndefined();
  });
});

describe("runwayImpactMonths and severity", () => {
  it("is null-safe and rounds to one decimal", () => {
    expect(runwayImpactMonths(14.3, 13.7)).toBe(0.6);
    expect(runwayImpactMonths(null, 13.7)).toBeNull();
    expect(runwayImpactMonths(14.3, null)).toBeNull();
  });

  it("maps runway impact to severity via config thresholds", () => {
    expect(severityFromRunwayImpact(SEVERITY_THRESHOLDS.HIGH_RUNWAY_IMPACT_MONTHS)).toBe("HIGH");
    expect(severityFromRunwayImpact(SEVERITY_THRESHOLDS.HIGH_RUNWAY_IMPACT_MONTHS - 0.1)).toBe("MEDIUM");
    expect(severityFromRunwayImpact(SEVERITY_THRESHOLDS.MEDIUM_RUNWAY_IMPACT_MONTHS)).toBe("MEDIUM");
    expect(severityFromRunwayImpact(SEVERITY_THRESHOLDS.MEDIUM_RUNWAY_IMPACT_MONTHS - 0.1)).toBe("LOW");
    expect(severityFromRunwayImpact(null)).toBe("LOW");
  });
});
