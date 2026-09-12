import { describe, expect, it } from "vitest";
import { SAMPLE_HISTORY_END, SAMPLE_HISTORY_START } from "@canary/shared/fixtures";
import { sumCents } from "@canary/shared";
import { buildWeeklyBuckets } from "./buckets.ts";
import { buildSampleLedger, tx } from "./test-support.ts";

describe("buildWeeklyBuckets — sample fixture", () => {
  const weeks = buildSampleLedger().weeks;

  it("emits one bucket per calendar week of history", () => {
    expect(weeks).toHaveLength(4);
    expect(weeks.map((w) => w.week_start)).toEqual([
      "2026-08-17",
      "2026-08-24",
      "2026-08-31",
      "2026-09-07",
    ]);
    expect(weeks.map((w) => w.week_end)).toEqual([
      "2026-08-23",
      "2026-08-30",
      "2026-09-06",
      "2026-09-13",
    ]);
    expect(weeks.map((w) => w.week_index)).toEqual([0, 1, 2, 3]);
  });

  it("splits fixed, variable and inflow correctly", () => {
    expect(weeks[0]).toMatchObject({
      variable_spend_cents: 1_263_000,
      fixed_spend_cents: 450_000,
      excluded_from_monitoring_cents: 0,
      total_operating_outflow_cents: 1_713_000,
      operating_inflow_cents: 2_500_000,
      net_burn_cents: -787_000,
      transaction_count: 7,
    });
    expect(weeks[1]).toMatchObject({
      variable_spend_cents: 450_000,
      fixed_spend_cents: 800_000,
      total_operating_outflow_cents: 1_250_000,
      operating_inflow_cents: 0,
      net_burn_cents: 1_250_000,
      transaction_count: 5,
    });
    expect(weeks[2]).toMatchObject({
      variable_spend_cents: 170_000,
      fixed_spend_cents: 450_000,
      total_operating_outflow_cents: 620_000,
      net_burn_cents: 620_000,
      transaction_count: 4,
    });
    expect(weeks[3]).toMatchObject({
      variable_spend_cents: 1_600_000,
      fixed_spend_cents: 0,
      total_operating_outflow_cents: 1_600_000,
      operating_inflow_cents: 2_500_000,
      net_burn_cents: -900_000,
      transaction_count: 2,
    });
  });

  it("keeps total = variable + fixed + excluded and net = total − inflow", () => {
    for (const w of weeks) {
      expect(w.total_operating_outflow_cents).toBe(
        w.variable_spend_cents + w.fixed_spend_cents + w.excluded_from_monitoring_cents,
      );
      expect(w.net_burn_cents).toBe(w.total_operating_outflow_cents - w.operating_inflow_cents);
    }
  });

  it("keeps by_entity and by_category consistent with variable spend", () => {
    for (const w of weeks) {
      expect(sumCents(Object.values(w.variable_by_entity))).toBe(w.variable_spend_cents);
      expect(sumCents(Object.values(w.variable_by_category) as number[])).toBe(
        w.variable_spend_cents,
      );
    }
    expect(weeks[0]!.variable_by_category).toEqual({
      CLOUD_INFRASTRUCTURE: 1_200_000,
      MEALS: 18_000,
      SAAS_SOFTWARE: 45_000,
    });
    // Keys are sorted so the object serializes identically every run.
    expect(Object.keys(weeks[0]!.variable_by_entity)).toEqual(["aws", "doordash", "figma"]);
  });
});

describe("buildWeeklyBuckets — monitoring exclusions", () => {
  it("moves one-off tagged rows out of variable spend but keeps them in burn", () => {
    const base = buildSampleLedger();
    const tagged = buildSampleLedger({ oneOffTransactionIds: ["t018"] });
    const oneOff = tagged.transactions.find((t) => t.id === "t018")!;
    expect(oneOff.tags).toContain("one_off");
    expect(oneOff.counts_in_burn).toBe(true);
    expect(tagged.weeks[3]!.variable_spend_cents).toBe(0);
    expect(tagged.weeks[3]!.variable_by_entity["aws"]).toBeUndefined();
    expect(tagged.weeks[3]!.excluded_from_monitoring_cents).toBe(1_600_000);
    // Gross burn is untouched — only the monitored series changed.
    expect(tagged.weeks[3]!.total_operating_outflow_cents).toBe(
      base.weeks[3]!.total_operating_outflow_cents,
    );
  });

  it("treats annual_renewal the same way", () => {
    const transactions = [
      tx({
        id: "ar1",
        account_id: "chk",
        date: "2026-08-18",
        amount_cents: -900_000,
        merchant_raw: "HUBSPOT ANNUAL",
        merchant_normalized: "hubspot",
        description: "Annual renewal",
        flow_type: "OPERATING_OUTFLOW",
        tags: ["annual_renewal"],
        category_hint: "SAAS_SOFTWARE",
      }),
    ];
    const ledger = buildSampleLedger({ transactions });
    expect(ledger.weeks[0]!.variable_spend_cents).toBe(0);
    expect(ledger.weeks[0]!.excluded_from_monitoring_cents).toBe(900_000);
    expect(ledger.weeks[0]!.total_operating_outflow_cents).toBe(900_000);
  });
});

describe("buildWeeklyBuckets — empty weeks", () => {
  it("zero-fills weeks with no transactions", () => {
    const buckets = buildWeeklyBuckets([], SAMPLE_HISTORY_START, SAMPLE_HISTORY_END);
    expect(buckets).toHaveLength(4);
    for (const b of buckets) {
      expect(b).toMatchObject({
        variable_spend_cents: 0,
        fixed_spend_cents: 0,
        excluded_from_monitoring_cents: 0,
        total_operating_outflow_cents: 0,
        operating_inflow_cents: 0,
        net_burn_cents: 0,
        transaction_count: 0,
      });
      expect(b.variable_by_entity).toEqual({});
      expect(b.variable_by_category).toEqual({});
    }
  });

  it("zero-fills gaps between active weeks", () => {
    const transactions = [
      tx({
        id: "g1",
        account_id: "chk",
        date: "2026-08-18",
        amount_cents: -100_000,
        merchant_raw: "AWS",
        merchant_normalized: "aws",
        description: "",
        flow_type: "OPERATING_OUTFLOW",
        category_hint: "CLOUD_INFRASTRUCTURE",
      }),
      tx({
        id: "g2",
        account_id: "chk",
        date: "2026-09-08",
        amount_cents: -200_000,
        merchant_raw: "AWS",
        merchant_normalized: "aws",
        description: "",
        flow_type: "OPERATING_OUTFLOW",
        category_hint: "CLOUD_INFRASTRUCTURE",
      }),
    ];
    const weeks = buildSampleLedger({ transactions }).weeks;
    expect(weeks.map((w) => w.variable_spend_cents)).toEqual([100_000, 0, 0, 200_000]);
    expect(weeks.map((w) => w.transaction_count)).toEqual([1, 0, 0, 1]);
  });

  it("returns a single week when history spans one week", () => {
    expect(buildWeeklyBuckets([], "2026-09-07", "2026-09-13")).toHaveLength(1);
  });

  it("returns nothing when the range is inverted", () => {
    expect(buildWeeklyBuckets([], "2026-09-07", "2026-08-17")).toEqual([]);
  });

  it("ignores rows dated outside the history span", () => {
    const transactions = [
      tx({
        id: "old",
        account_id: "chk",
        date: "2026-07-01",
        amount_cents: -100_000,
        merchant_raw: "AWS",
        merchant_normalized: "aws",
        description: "",
        flow_type: "OPERATING_OUTFLOW",
        category_hint: "CLOUD_INFRASTRUCTURE",
      }),
    ];
    const ledger = buildSampleLedger({ transactions });
    expect(ledger.weeks).toHaveLength(4);
    expect(sumCents(ledger.weeks.map((w) => w.total_operating_outflow_cents))).toBe(0);
    expect(ledger.reconciliation.warnings.join(" ")).toContain("outside history");
    // Still cash-moving, so reconciliation stays exact.
    expect(ledger.reconciliation.matches).toBe(true);
  });
});
