import { describe, expect, it } from "vitest";
import {
  MIN_POST_CHANGE_WEEKS,
  TRAILING_WINDOW_WEEKS,
  runwayMonths,
  sumCents,
  weeklyToMonthly,
} from "@canary/shared";
import { SAMPLE_ACCOUNTS } from "@canary/shared/fixtures";
import { availableOperatingCashCents, computeBurn } from "./burn.ts";
import { buildSampleLedger, makeLedger, makeWeeks, type WeekSpec } from "./test-support.ts";

/** 20 weeks: flat 400_000/wk variable, stepping to 700_000/wk from index 10. */
const twentyWeeks: WeekSpec[] = Array.from({ length: 20 }, (_, i) => ({
  variable: i < 10 ? 400_000 : 700_000,
  fixed: 300_000,
  inflow: 1_000_000,
  by_entity: { aws: i < 10 ? 300_000 : 600_000, upwork: 100_000 },
}));

describe("computeBurn — window selection", () => {
  const ledger = makeLedger(makeWeeks(twentyWeeks));

  it("uses the trailing window when no regime change is confirmed", () => {
    const burn = computeBurn(ledger, { regimeStartWeekIndex: null });
    expect(burn.burn_window_reason).toBe("TRAILING_DEFAULT");
    expect(burn.weeks_in_window).toBe(TRAILING_WINDOW_WEEKS);
    expect(burn.burn_window_start).toBe(ledger.weeks[20 - TRAILING_WINDOW_WEEKS]!.week_start);
    expect(burn.burn_window_end).toBe(ledger.weeks[19]!.week_end);
  });

  it("uses the post-change segment once it is long enough", () => {
    const burn = computeBurn(ledger, { regimeStartWeekIndex: 10 });
    expect(burn.burn_window_reason).toBe("POST_CHANGE_SEGMENT");
    expect(burn.weeks_in_window).toBe(10);
    expect(burn.burn_window_start).toBe(ledger.weeks[10]!.week_start);
    expect(burn.weekly_variable_spend_cents).toBe(700_000);
  });

  it("uses exactly MIN_POST_CHANGE_WEEKS as the boundary", () => {
    const atBoundary = computeBurn(ledger, {
      regimeStartWeekIndex: 20 - MIN_POST_CHANGE_WEEKS,
    });
    expect(atBoundary.burn_window_reason).toBe("POST_CHANGE_SEGMENT");
    expect(atBoundary.weeks_in_window).toBe(MIN_POST_CHANGE_WEEKS);

    const belowBoundary = computeBurn(ledger, {
      regimeStartWeekIndex: 20 - MIN_POST_CHANGE_WEEKS + 1,
    });
    expect(belowBoundary.burn_window_reason).toBe("POST_CHANGE_INSUFFICIENT_FALLBACK_TRAILING");
    expect(belowBoundary.weeks_in_window).toBe(TRAILING_WINDOW_WEEKS);
  });

  it("falls back to trailing when the post-change segment is too short", () => {
    const burn = computeBurn(ledger, { regimeStartWeekIndex: 18 });
    expect(burn.burn_window_reason).toBe("POST_CHANGE_INSUFFICIENT_FALLBACK_TRAILING");
    expect(burn.weeks_in_window).toBe(TRAILING_WINDOW_WEEKS);
    expect(burn.burn_window_start).toBe(ledger.weeks[12]!.week_start);
    // Trailing 8 weeks are all post-change here.
    expect(burn.weekly_variable_spend_cents).toBe(700_000);
  });

  it("honours overridden window sizes", () => {
    const burn = computeBurn(ledger, {
      regimeStartWeekIndex: 18,
      trailingWindowWeeks: 4,
      minPostChangeWeeks: 2,
    });
    expect(burn.burn_window_reason).toBe("POST_CHANGE_SEGMENT");
    expect(burn.weeks_in_window).toBe(2);
  });

  it("clamps a regime index outside the series", () => {
    const negative = computeBurn(ledger, { regimeStartWeekIndex: -5 });
    expect(negative.burn_window_reason).toBe("POST_CHANGE_SEGMENT");
    expect(negative.weeks_in_window).toBe(20);
    const beyond = computeBurn(ledger, { regimeStartWeekIndex: 99 });
    expect(beyond.burn_window_reason).toBe("POST_CHANGE_INSUFFICIENT_FALLBACK_TRAILING");
  });

  it("never asks for more weeks than exist", () => {
    const short = makeLedger(makeWeeks(twentyWeeks.slice(0, 3)));
    const burn = computeBurn(short, { regimeStartWeekIndex: null });
    expect(burn.weeks_in_window).toBe(3);
    expect(burn.burn_window_reason).toBe("TRAILING_DEFAULT");
  });

  it("returns a zeroed summary for an empty series", () => {
    const empty = makeLedger([]);
    const burn = computeBurn(empty, { regimeStartWeekIndex: null });
    expect(burn.weeks_in_window).toBe(0);
    expect(burn.weekly_gross_burn_cents).toBe(0);
    expect(burn.monthly_net_burn_cents).toBe(0);
    expect(burn.runway_months).toBe(null);
    expect(burn.available_operating_cash_cents).toBe(60_000_000);
    expect(burn.weekly_variable_by_entity).toEqual({});
  });
});

describe("computeBurn — averages, cash and runway", () => {
  const ledger = makeLedger(makeWeeks(twentyWeeks));
  const burn = computeBurn(ledger, { regimeStartWeekIndex: 10 });

  it("averages the window in integer cents", () => {
    expect(burn.weekly_gross_burn_cents).toBe(1_000_000);
    expect(burn.weekly_operating_inflow_cents).toBe(1_000_000);
    expect(burn.weekly_net_burn_cents).toBe(0);
    expect(burn.weekly_variable_spend_cents).toBe(700_000);
    expect(burn.weekly_fixed_spend_cents).toBe(300_000);
    for (const v of [
      burn.weekly_gross_burn_cents,
      burn.weekly_net_burn_cents,
      burn.monthly_gross_burn_cents,
      burn.monthly_net_burn_cents,
      ...Object.values(burn.weekly_variable_by_entity),
    ]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("keeps gross − inflow = net and monthly = weekly × WEEKS_PER_MONTH", () => {
    expect(burn.weekly_gross_burn_cents - burn.weekly_operating_inflow_cents).toBe(
      burn.weekly_net_burn_cents,
    );
    expect(burn.monthly_gross_burn_cents).toBe(weeklyToMonthly(burn.weekly_gross_burn_cents));
    expect(burn.monthly_net_burn_cents).toBe(weeklyToMonthly(burn.weekly_net_burn_cents));
  });

  it("excludes card liability from available operating cash", () => {
    expect(availableOperatingCashCents(SAMPLE_ACCOUNTS)).toBe(60_000_000);
    expect(burn.available_operating_cash_cents).toBe(60_000_000);
  });

  it("returns null runway when net burn is not positive", () => {
    expect(burn.monthly_net_burn_cents).toBe(0);
    expect(burn.runway_months).toBe(null);
  });

  it("computes runway from monthly net burn", () => {
    const burning = computeBurn(
      makeLedger(makeWeeks(twentyWeeks.map((w) => ({ ...w, inflow: 0 })))),
      { regimeStartWeekIndex: 10 },
    );
    expect(burning.weekly_net_burn_cents).toBe(1_000_000);
    expect(burning.monthly_net_burn_cents).toBe(weeklyToMonthly(1_000_000));
    expect(burning.runway_months).toBe(
      runwayMonths(60_000_000, weeklyToMonthly(1_000_000)),
    );
  });

  it("averages entities over the window, counting absent weeks as zero", () => {
    // aws appears at 300_000 pre-change and 600_000 post-change.
    const full = computeBurn(ledger, { regimeStartWeekIndex: null, trailingWindowWeeks: 20 });
    expect(full.weekly_variable_by_entity["aws"]).toBe(450_000);
    expect(full.weekly_variable_by_entity["upwork"]).toBe(100_000);

    const sparse = makeLedger(
      makeWeeks([
        { variable: 100_000, by_entity: { figma: 100_000 } },
        { variable: 0, by_entity: {} },
        { variable: 0, by_entity: {} },
        { variable: 0, by_entity: {} },
      ]),
    );
    const burnSparse = computeBurn(sparse, { regimeStartWeekIndex: null });
    expect(burnSparse.weekly_variable_by_entity["figma"]).toBe(25_000);
  });

  it("keeps per-entity averages summing to weekly variable spend", () => {
    expect(sumCents(Object.values(burn.weekly_variable_by_entity))).toBe(
      burn.weekly_variable_spend_cents,
    );
  });
});

describe("computeBurn — sample fixture", () => {
  const ledger = buildSampleLedger();
  const burn = computeBurn(ledger, { regimeStartWeekIndex: null });

  it("uses the whole 4-week history when it is shorter than the trailing window", () => {
    expect(burn.weeks_in_window).toBe(4);
    expect(burn.burn_window_start).toBe("2026-08-17");
    expect(burn.burn_window_end).toBe("2026-09-13");
  });

  it("matches the hand-verified fixture totals", () => {
    expect(burn.weekly_gross_burn_cents).toBe(1_295_750); // 5_183_000 / 4
    expect(burn.weekly_operating_inflow_cents).toBe(1_250_000); // 5_000_000 / 4
    expect(burn.weekly_net_burn_cents).toBe(45_750); // 183_000 / 4
    expect(burn.weekly_variable_spend_cents).toBe(870_750); // 3_483_000 / 4
    expect(burn.weekly_fixed_spend_cents).toBe(425_000); // 1_700_000 / 4
    expect(burn.monthly_net_burn_cents).toBe(198_250);
    expect(burn.available_operating_cash_cents).toBe(60_000_000);
  });

  it("nets the refund into the aws/upwork entity averages", () => {
    expect(burn.weekly_variable_by_entity).toEqual({
      ashby: 37_500,
      aws: 700_000,
      datadog: 55_000,
      doordash: 4_500,
      figma: 11_250,
      upwork: 62_500, // (300_000 − 50_000) / 4
    });
  });
});
