import { describe, expect, it } from "vitest";
import {
  SCENARIO_LABEL,
  runwayMonths,
  speakMonths,
  speakUsd,
  weeklyToAnnual,
  weeklyToMonthly,
  type BurnSummary,
} from "@canary/shared";
import { computeBurn } from "./burn.ts";
import { simulateCostChange } from "./whatif.ts";
import { buildSampleLedger } from "./test-support.ts";

/**
 * Hand-built summary chosen so the −20% aws scenario reproduces the worked
 * example in docs/WORKSTREAMS.md exactly.
 */
const BURN: BurnSummary = {
  burn_window_start: "2026-07-06",
  burn_window_end: "2026-09-13",
  burn_window_reason: "POST_CHANGE_SEGMENT",
  weeks_in_window: 10,
  weekly_gross_burn_cents: 4_000_000,
  weekly_operating_inflow_cents: 769_231,
  weekly_net_burn_cents: 3_230_769,
  weekly_variable_spend_cents: 570_000,
  weekly_fixed_spend_cents: 3_430_000,
  monthly_gross_burn_cents: weeklyToMonthly(4_000_000),
  monthly_net_burn_cents: 14_000_000,
  available_operating_cash_cents: 197_345_000,
  runway_months: runwayMonths(197_345_000, 14_000_000),
  weekly_variable_by_entity: { aws: 450_000, upwork: 120_000 },
};

describe("simulateCostChange — arithmetic", () => {
  const result = simulateCostChange(BURN, { entity: "aws", percentage: -20 });

  it("scales the entity's weekly spend and monthlyizes the delta", () => {
    expect(result.current_weekly_cents).toBe(450_000);
    expect(result.hypothetical_weekly_cents).toBe(360_000);
    expect(result.current_monthly_cents).toBe(weeklyToMonthly(450_000));
    expect(result.hypothetical_monthly_cents).toBe(weeklyToMonthly(360_000));
    expect(result.delta_monthly_cents).toBe(-390_000);
    expect(result.delta_annualized_cents).toBe(weeklyToAnnual(-90_000));
  });

  it("reduces monthly burn by exactly weeklyToMonthly(round(0.2 × weekly))", () => {
    const expectedSaving = weeklyToMonthly(Math.round(0.2 * 450_000));
    expect(result.delta_monthly_cents).toBe(-expectedSaving);
    expect(result.current_burn_monthly_cents).toBe(BURN.monthly_net_burn_cents);
    expect(result.scenario_burn_monthly_cents).toBe(
      BURN.monthly_net_burn_cents - expectedSaving,
    );
  });

  it("extends runway", () => {
    expect(result.current_runway_months).toBe(14.1);
    expect(result.scenario_runway_months).toBe(14.5);
    expect(result.scenario_runway_months! > result.current_runway_months!).toBe(true);
    expect(result.runway_delta_months).toBe(0.4);
    expect(result.scenario_runway_months).toBe(
      runwayMonths(BURN.available_operating_cash_cents, result.scenario_burn_monthly_cents),
    );
  });

  it("stores integer cents only", () => {
    for (const v of [
      result.current_weekly_cents,
      result.current_monthly_cents,
      result.hypothetical_weekly_cents,
      result.hypothetical_monthly_cents,
      result.delta_monthly_cents,
      result.delta_annualized_cents,
      result.current_burn_monthly_cents,
      result.scenario_burn_monthly_cents,
    ]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("always labels the result as a scenario estimate", () => {
    expect(result.label).toBe(SCENARIO_LABEL);
    expect(simulateCostChange(BURN, { entity: "nope", percentage: 50 }).label).toBe(
      SCENARIO_LABEL,
    );
  });

  it("rounds a fractional scaling to whole cents", () => {
    const odd = simulateCostChange(
      { ...BURN, weekly_variable_by_entity: { aws: 333 } },
      { entity: "aws", percentage: -20 },
    );
    expect(odd.hypothetical_weekly_cents).toBe(266); // round(266.4)
  });

  it("is pure — it does not mutate the summary", () => {
    const snapshot = JSON.stringify(BURN);
    simulateCostChange(BURN, { entity: "aws", percentage: -35 });
    expect(JSON.stringify(BURN)).toBe(snapshot);
  });
});

describe("simulateCostChange — speech", () => {
  it("reproduces the worked example from the spec", () => {
    const result = simulateCostChange(BURN, { entity: "aws", percentage: -20 });
    expect(result.speech.summary).toBe(
      "If aws were twenty percent lower, monthly burn would fall by about thirty-nine hundred dollars and runway would extend to about fourteen and a half months.",
    );
    expect(result.speech.delta_monthly).toBe(speakUsd(390_000));
    expect(result.speech.scenario_runway).toBe(speakMonths(14.5));
  });

  it("says burn rises and runway shortens for an increase", () => {
    const result = simulateCostChange(BURN, { entity: "aws", percentage: 20 });
    expect(result.delta_monthly_cents).toBe(390_000);
    expect(result.scenario_runway_months! < result.current_runway_months!).toBe(true);
    expect(result.speech.summary).toContain("twenty percent higher");
    expect(result.speech.summary).toContain("monthly burn would rise by");
    expect(result.speech.summary).toContain("runway would shorten to");
  });

  it("says nothing changes at 0%", () => {
    const result = simulateCostChange(BURN, { entity: "aws", percentage: 0 });
    expect(result.delta_monthly_cents).toBe(0);
    expect(result.scenario_burn_monthly_cents).toBe(BURN.monthly_net_burn_cents);
    expect(result.runway_delta_months).toBe(0);
    expect(result.speech.summary).toContain("monthly burn would not change");
    expect(result.speech.summary).toContain("runway would stay at");
  });

  it("handles a scenario that stops the burn entirely", () => {
    const result = simulateCostChange(
      { ...BURN, monthly_net_burn_cents: 300_000 },
      { entity: "aws", percentage: -100 },
    );
    expect(result.hypothetical_weekly_cents).toBe(0);
    expect(result.delta_monthly_cents).toBe(weeklyToMonthly(-450_000));
    expect(result.scenario_burn_monthly_cents).toBeLessThan(0);
    expect(result.scenario_runway_months).toBe(null);
    expect(result.runway_delta_months).toBe(null);
    expect(result.speech.summary).toContain("no longer be burning cash");
  });
});

describe("simulateCostChange — unknown entity", () => {
  const result = simulateCostChange(BURN, { entity: "not_a_vendor", percentage: -20 });

  it("returns zeros and changes nothing, without throwing", () => {
    expect(result.entity).toBe("not_a_vendor");
    expect(result.current_weekly_cents).toBe(0);
    expect(result.current_monthly_cents).toBe(0);
    expect(result.hypothetical_weekly_cents).toBe(0);
    expect(result.hypothetical_monthly_cents).toBe(0);
    expect(result.delta_monthly_cents).toBe(0);
    expect(result.delta_annualized_cents).toBe(0);
    expect(result.scenario_burn_monthly_cents).toBe(BURN.monthly_net_burn_cents);
    expect(result.scenario_runway_months).toBe(BURN.runway_months);
    expect(result.runway_delta_months).toBe(0);
    expect(result.speech.summary).toContain("monthly burn would not change");
  });
});

describe("simulateCostChange — driven by the engine", () => {
  const ledger = buildSampleLedger();
  const burn = computeBurn(ledger, { regimeStartWeekIndex: null });
  const result = simulateCostChange(burn, { entity: "aws", percentage: -20 });

  it("reads its current spend from computeBurn, not the request", () => {
    expect(burn.weekly_variable_by_entity["aws"]).toBe(700_000);
    expect(result.current_weekly_cents).toBe(700_000);
    expect(result.hypothetical_weekly_cents).toBe(560_000);
    expect(result.delta_monthly_cents).toBe(-weeklyToMonthly(140_000));
  });

  it("reports no runway when the scenario turns net burn negative", () => {
    expect(result.scenario_burn_monthly_cents).toBeLessThan(0);
    expect(result.scenario_runway_months).toBe(null);
    expect(result.speech.scenario_runway).toBe("not currently burning cash");
  });
});
