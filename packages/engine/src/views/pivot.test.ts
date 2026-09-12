import { describe, expect, it } from "vitest";
import { SAMPLE_CLOSING_CASH_CENTS, SAMPLE_EXPECTED, SAMPLE_TRANSACTIONS } from "@canary/shared/fixtures";
import { sumCents, type LedgerPivot, type PivotRow, type PivotSection } from "@canary/shared";
import { buildSampleLedger, tx } from "../test-support.ts";
import { buildDemoLedger } from "./demo-ledger.testkit.ts";
import { pivotCell, pivotLedger } from "./pivot.ts";

const SECTIONS: PivotSection[] = [
  "REVENUE",
  "VARIABLE_SPEND",
  "FIXED_SPEND",
  "ONE_OFF",
  "NET_BURN",
  "FINANCING_AND_TRANSFERS",
  "CASH_END",
];

function row(pivot: LedgerPivot, id: string): PivotRow {
  const found = pivot.rows.find((r) => r.id === id);
  if (!found) throw new Error(`row ${id} not in pivot (have ${pivot.rows.map((r) => r.id).join(", ")})`);
  return found;
}

function cells(pivot: LedgerPivot, id: string): number[] {
  return row(pivot, id).cells.map((c) => c.amount_cents);
}

describe("pivotLedger — shape", () => {
  const ledger = buildSampleLedger();
  const pivot = pivotLedger(ledger, { granularity: "week" });

  it("emits one column per calendar week of history", () => {
    expect(pivot.periods.map((p) => p.key)).toEqual(["2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07"]);
    expect(pivot.periods.map((p) => p.end)).toEqual(["2026-08-23", "2026-08-30", "2026-09-06", "2026-09-13"]);
    expect(pivot.periods.every((p) => !p.partial)).toBe(true);
    expect(pivot.periods.every((p) => !p.post_change)).toBe(true);
    expect(pivot.weeks_of_history).toBe(4);
    expect(pivot.regime_start).toBeNull();
    expect(pivot.history_start).toBe(ledger.history_start);
    expect(pivot.history_end).toBe(ledger.history_end);
  });

  it("emits the seven sections in contract order, always", () => {
    expect(pivot.rows.filter((r) => r.level === 0).map((r) => r.section)).toEqual(SECTIONS);
    for (const r of pivot.rows.filter((r) => r.level === 0)) {
      expect(r.id).toBe(`section:${r.section}`);
      expect(r.parent_id).toBeUndefined();
    }
  });

  it("nests category rows under sections and vendor rows under categories", () => {
    const aws = row(pivot, "vendor:VARIABLE_SPEND:CLOUD_INFRASTRUCTURE:aws");
    expect(aws.level).toBe(2);
    expect(aws.entity).toBe("aws");
    expect(aws.category).toBe("CLOUD_INFRASTRUCTURE");
    expect(aws.label).toBe("AWS");
    expect(aws.parent_id).toBe("category:VARIABLE_SPEND:CLOUD_INFRASTRUCTURE");
    expect(row(pivot, aws.parent_id!).parent_id).toBe("section:VARIABLE_SPEND");
    expect(row(pivot, "category:VARIABLE_SPEND:CLOUD_INFRASTRUCTURE").label).toBe("Cloud infrastructure");
  });

  it("gives every row a unique id and one cell per period", () => {
    const ids = pivot.rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of pivot.rows) expect(r.cells).toHaveLength(pivot.periods.length);
  });

  it("keeps every parent_id resolvable", () => {
    const ids = new Set(pivot.rows.map((r) => r.id));
    for (const r of pivot.rows) {
      if (r.parent_id !== undefined) expect(ids.has(r.parent_id)).toBe(true);
    }
  });

  it("is byte-identical across runs", () => {
    const again = pivotLedger(buildSampleLedger(), { granularity: "week" });
    expect(JSON.stringify(again)).toBe(JSON.stringify(pivot));
  });
});

describe("pivotLedger — sections agree with the weekly buckets", () => {
  const ledger = buildSampleLedger({ oneOffTransactionIds: ["t018"] });
  const pivot = pivotLedger(ledger, { granularity: "week" });

  it("matches variable / fixed / one-off / revenue / net burn week by week", () => {
    expect(cells(pivot, "section:VARIABLE_SPEND")).toEqual(ledger.weeks.map((w) => w.variable_spend_cents));
    expect(cells(pivot, "section:FIXED_SPEND")).toEqual(ledger.weeks.map((w) => w.fixed_spend_cents));
    expect(cells(pivot, "section:ONE_OFF")).toEqual(ledger.weeks.map((w) => w.excluded_from_monitoring_cents));
    expect(cells(pivot, "section:REVENUE")).toEqual(ledger.weeks.map((w) => w.operating_inflow_cents));
    expect(cells(pivot, "section:NET_BURN")).toEqual(ledger.weeks.map((w) => w.net_burn_cents));
  });

  it("reproduces the fixture's hand-verified burn totals", () => {
    const spend = ["section:VARIABLE_SPEND", "section:FIXED_SPEND", "section:ONE_OFF"];
    expect(sumCents(spend.map((id) => row(pivot, id).total_cents))).toBe(SAMPLE_EXPECTED.gross_operating_burn_cents);
    expect(row(pivot, "section:REVENUE").total_cents).toBe(SAMPLE_EXPECTED.operating_inflow_cents);
    expect(row(pivot, "section:NET_BURN").total_cents).toBe(SAMPLE_EXPECTED.net_burn_cents);
  });

  it("moves the tagged row out of variable spend into ONE_OFF, keeping burn whole", () => {
    const untagged = pivotLedger(buildSampleLedger(), { granularity: "week" });
    expect(row(untagged, "section:ONE_OFF").total_cents).toBe(0);
    expect(row(pivot, "vendor:ONE_OFF:CLOUD_INFRASTRUCTURE:aws").total_cents).toBe(1_600_000);
    expect(row(pivot, "vendor:VARIABLE_SPEND:CLOUD_INFRASTRUCTURE:aws").total_cents).toBe(1_200_000);
    expect(row(pivot, "section:NET_BURN").total_cents).toBe(row(untagged, "section:NET_BURN").total_cents);
  });
});

describe("pivotLedger — the sheet adds up", () => {
  const ledger = buildSampleLedger();
  const pivot = pivotLedger(ledger, { granularity: "week" });

  it("sums vendors to their category and categories to their section, per period", () => {
    for (const section of pivot.rows.filter((r) => r.level === 0)) {
      if (section.section === "NET_BURN" || section.section === "CASH_END") continue;
      const categories = pivot.rows.filter((r) => r.level === 1 && r.parent_id === section.id);
      for (let i = 0; i < pivot.periods.length; i++) {
        expect(sumCents(categories.map((c) => c.cells[i]!.amount_cents))).toBe(section.cells[i]!.amount_cents);
        for (const category of categories) {
          const vendors = pivot.rows.filter((r) => r.level === 2 && r.parent_id === category.id);
          if (vendors.length === 0) continue;
          expect(sumCents(vendors.map((v) => v.cells[i]!.amount_cents))).toBe(category.cells[i]!.amount_cents);
        }
      }
    }
  });

  it("keeps total_cents = Σ cells for every flow row", () => {
    for (const r of pivot.rows) {
      if (r.section === "CASH_END") continue;
      expect(r.total_cents).toBe(sumCents(r.cells.map((c) => c.amount_cents)));
    }
  });

  it("annualizes flow rows and never balance or financing rows", () => {
    const variable = row(pivot, "section:VARIABLE_SPEND");
    expect(variable.annualized_cents).toBe(Math.round((variable.total_cents / 4) * 52));
    expect(row(pivot, "section:NET_BURN").annualized_cents).not.toBeNull();
    expect(row(pivot, "section:CASH_END").annualized_cents).toBeNull();
    expect(row(pivot, "section:FINANCING_AND_TRANSFERS").annualized_cents).toBeNull();
    expect(row(pivot, "category:FINANCING_AND_TRANSFERS:INTERNAL_TRANSFER").annualized_cents).toBeNull();
  });

  it("counts transactions per cell without counting dropped rows", () => {
    const datadog = row(pivot, "vendor:VARIABLE_SPEND:SAAS_SOFTWARE:datadog");
    // t014 (pending) and t015 (settled) both land in week 2; only one is money.
    expect(datadog.cells[2]).toEqual({
      amount_cents: 220_000,
      transaction_count: 1,
      flags: ["pending_dropped"],
    });
  });
});

describe("pivotLedger — financing and transfers", () => {
  const ledger = buildSampleLedger();
  const pivot = pivotLedger(ledger, { granularity: "week" });

  it("nets both legs of an internal transfer to zero in the period that holds them", () => {
    const transfers = row(pivot, "category:FINANCING_AND_TRANSFERS:INTERNAL_TRANSFER");
    expect(transfers.label).toBe("Internal transfers");
    expect(transfers.cells[0]).toEqual({ amount_cents: 0, transaction_count: 2, flags: [] });
    expect(transfers.total_cents).toBe(0);
  });

  it("nets both legs of a card settlement to zero", () => {
    const settlements = row(pivot, "category:FINANCING_AND_TRANSFERS:CARD_SETTLEMENT");
    expect(settlements.label).toBe("Card settlements");
    expect(settlements.cells[1]).toEqual({ amount_cents: 0, transaction_count: 2, flags: [] });
    expect(settlements.total_cents).toBe(0);
  });

  it("keeps financing signed, out of burn, and free of vendor rows", () => {
    const financing = row(pivot, "category:FINANCING_AND_TRANSFERS:FINANCING");
    expect(financing.cells[2]!.amount_cents).toBe(SAMPLE_EXPECTED.financing_net_cents);
    expect(pivot.rows.filter((r) => r.section === "FINANCING_AND_TRANSFERS" && r.level === 2)).toEqual([]);
    // Financing changes cash but never burn.
    expect(row(pivot, "section:NET_BURN").cells[2]!.amount_cents).toBe(ledger.weeks[2]!.net_burn_cents);
  });

  it("orders the informational rows Financing → Internal transfers → Card settlements", () => {
    expect(
      pivot.rows.filter((r) => r.section === "FINANCING_AND_TRANSFERS" && r.level === 1).map((r) => r.label),
    ).toEqual(["Financing", "Internal transfers", "Card settlements"]);
  });
});

describe("pivotLedger — cell flags", () => {
  it("flags a refund and lets the cell go negative", () => {
    const pivot = pivotLedger(buildSampleLedger(), { granularity: "week" });
    const upwork = row(pivot, "vendor:VARIABLE_SPEND:CONTRACTORS:upwork");
    expect(upwork.cells[1]!.amount_cents).toBe(300_000);
    expect(upwork.cells[2]).toEqual({ amount_cents: -50_000, transaction_count: 1, flags: ["refund"] });
    expect(row(pivot, "category:VARIABLE_SPEND:CONTRACTORS").cells[2]!.flags).toEqual(["refund"]);
  });

  it("flags needs-review spend where the classifier could not decide", () => {
    const pivot = pivotLedger(buildSampleLedger({ omitClassificationIds: ["t012"] }), { granularity: "week" });
    const unknown = row(pivot, "vendor:VARIABLE_SPEND:NEEDS_REVIEW:ashby");
    expect(unknown.cells[1]).toEqual({ amount_cents: 150_000, transaction_count: 1, flags: ["needs_review"] });
    expect(row(pivot, "section:VARIABLE_SPEND").cells[1]!.flags).toContain("needs_review");
  });

  it("flags annual renewals in the ONE_OFF section", () => {
    const transactions = [
      ...SAMPLE_TRANSACTIONS,
      tx({
        id: "zoom1",
        account_id: "chk",
        date: "2026-08-19",
        amount_cents: -960_000,
        merchant_raw: "ZOOM.US ANNUAL PLAN",
        merchant_normalized: "zoom",
        description: "Annual plan renewal",
        flow_type: "OPERATING_OUTFLOW",
        tags: ["annual_renewal"],
        category_hint: "SAAS_SOFTWARE",
      }),
    ];
    const pivot = pivotLedger(buildSampleLedger({ transactions }), { granularity: "week" });
    expect(row(pivot, "vendor:ONE_OFF:SAAS_SOFTWARE:zoom").cells[0]).toEqual({
      amount_cents: 960_000,
      transaction_count: 1,
      flags: ["one_off", "annual_renewal"],
    });
  });

  it("emits flags in canonical order", () => {
    const pivot = pivotLedger(buildSampleLedger({ oneOffTransactionIds: ["t016"] }), { granularity: "week" });
    // A refund tagged one-off raises both, always one_off first.
    expect(row(pivot, "vendor:ONE_OFF:CONTRACTORS:upwork").cells[2]!.flags).toEqual(["one_off", "refund"]);
  });
});

describe("pivotLedger — CASH_END", () => {
  const ledger = buildSampleLedger();
  const pivot = pivotLedger(ledger, { granularity: "week" });
  const cash = row(pivot, "section:CASH_END");

  it("ends on the bank-reported closing balance", () => {
    expect(cash.cells[cash.cells.length - 1]!.amount_cents).toBe(SAMPLE_CLOSING_CASH_CENTS);
    expect(cash.cells[cash.cells.length - 1]!.amount_cents).toBe(
      ledger.reconciliation.reported_closing_balance_cents,
    );
  });

  it("walks forward from the opening balance, one running total per period", () => {
    let running = ledger.reconciliation.opening_balance_cents;
    for (const [i, period] of pivot.periods.entries()) {
      running =
        ledger.reconciliation.opening_balance_cents +
        sumCents(
          ledger.transactions.filter((t) => t.counts_in_cash && t.date <= period.end).map((t) => t.amount_cents),
        );
      expect(cash.cells[i]!.amount_cents).toBe(running);
    }
    expect(running).toBe(SAMPLE_CLOSING_CASH_CENTS);
  });

  it("reports the ending balance as its total and never annualizes it", () => {
    expect(cash.total_cents).toBe(SAMPLE_CLOSING_CASH_CENTS);
    expect(cash.annualized_cents).toBeNull();
  });
});

describe("pivotLedger — month granularity", () => {
  it("clips the first and last month to history and flags them partial", () => {
    const pivot = pivotLedger(buildSampleLedger(), { granularity: "month" });
    expect(pivot.periods).toEqual([
      { key: "2026-08", start: "2026-08-17", end: "2026-08-31", partial: true, post_change: false },
      { key: "2026-09", start: "2026-09-01", end: "2026-09-13", partial: true, post_change: false },
    ]);
  });

  it("keeps the section identities that do not depend on the week grid", () => {
    const ledger = buildSampleLedger();
    const pivot = pivotLedger(ledger, { granularity: "month" });
    const weekly = pivotLedger(ledger, { granularity: "week" });
    for (const id of ["section:REVENUE", "section:VARIABLE_SPEND", "section:FIXED_SPEND", "section:NET_BURN"]) {
      expect(row(pivot, id).total_cents).toBe(row(weekly, id).total_cents);
    }
    expect(row(pivot, "section:CASH_END").total_cents).toBe(SAMPLE_CLOSING_CASH_CENTS);
  });

  it("annualizes from weeks of history, not from the number of months", () => {
    const pivot = pivotLedger(buildSampleLedger(), { granularity: "month" });
    const variable = row(pivot, "section:VARIABLE_SPEND");
    expect(pivot.weeks_of_history).toBe(4);
    expect(variable.annualized_cents).toBe(Math.round((variable.total_cents / 4) * 52));
  });
});

describe("pivotLedger — regime tinting", () => {
  it("tints weeks from the regime start onward", () => {
    const pivot = pivotLedger(buildSampleLedger(), { granularity: "week", regimeStart: "2026-08-31" });
    expect(pivot.periods.map((p) => p.post_change)).toEqual([false, false, true, true]);
    expect(pivot.regime_start).toBe("2026-08-31");
  });

  it("normalizes a mid-week regime start to its Monday", () => {
    const pivot = pivotLedger(buildSampleLedger(), { granularity: "week", regimeStart: "2026-09-02" });
    expect(pivot.regime_start).toBe("2026-08-31");
    expect(pivot.periods.map((p) => p.post_change)).toEqual([false, false, true, true]);
  });

  it("tints the month that contains the regime start", () => {
    const pivot = pivotLedger(buildSampleLedger(), { granularity: "month", regimeStart: "2026-08-31" });
    expect(pivot.periods.map((p) => p.post_change)).toEqual([true, true]);
  });

  it("links vendor rows to the incident they drive", () => {
    const pivot = pivotLedger(buildSampleLedger(), {
      granularity: "week",
      incidentByEntity: { aws: "inc_1" },
    });
    expect(row(pivot, "vendor:VARIABLE_SPEND:CLOUD_INFRASTRUCTURE:aws").incident_id).toBe("inc_1");
    expect(row(pivot, "vendor:FIXED_SPEND:PAYROLL:gusto_payroll").incident_id).toBeUndefined();
    expect(row(pivot, "section:VARIABLE_SPEND").incident_id).toBeUndefined();
  });
});

describe("pivotLedger — ordering", () => {
  const pivot = pivotLedger(buildDemoLedger().ledger, { granularity: "week" });

  it("sorts categories by total spend, biggest first", () => {
    const totals = pivot.rows
      .filter((r) => r.level === 1 && r.section === "VARIABLE_SPEND")
      .map((r) => r.total_cents);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
    expect(pivot.rows.filter((r) => r.level === 1 && r.section === "VARIABLE_SPEND")[0]!.category).toBe(
      "CLOUD_INFRASTRUCTURE",
    );
  });

  it("sorts vendors within a category, biggest first", () => {
    const contractors = pivot.rows.filter(
      (r) => r.level === 2 && r.parent_id === "category:VARIABLE_SPEND:CONTRACTORS",
    );
    expect(contractors.map((r) => r.total_cents)).toEqual(
      [...contractors.map((r) => r.total_cents)].sort((a, b) => b - a),
    );
  });
});

describe("pivotLedger — demo ledger identities", () => {
  const { demo, ledger } = buildDemoLedger();
  const regimeStart = demo.fixture.burn_shift.true_change_start_week;
  const pivot = pivotLedger(ledger, { granularity: "week", regimeStart });

  it("covers the generator's 20 weeks", () => {
    expect(pivot.periods).toHaveLength(demo.fixture.weeks);
    expect(pivot.periods[0]!.key).toBe(demo.fixture.start_date);
    expect(pivot.history_end).toBe(demo.fixture.end_date);
    expect(pivot.periods.every((p) => !p.partial)).toBe(true);
  });

  it("reproduces the CUSUM input series exactly", () => {
    expect(cells(pivot, "section:VARIABLE_SPEND")).toEqual(ledger.weeks.map((w) => w.variable_spend_cents));
    expect(cells(pivot, "section:FIXED_SPEND")).toEqual(ledger.weeks.map((w) => w.fixed_spend_cents));
    expect(cells(pivot, "section:ONE_OFF")).toEqual(ledger.weeks.map((w) => w.excluded_from_monitoring_cents));
    expect(cells(pivot, "section:REVENUE")).toEqual(ledger.weeks.map((w) => w.operating_inflow_cents));
    expect(cells(pivot, "section:NET_BURN")).toEqual(ledger.weeks.map((w) => w.net_burn_cents));
  });

  it("reproduces per-entity variable spend week by week", () => {
    for (const [i, week] of ledger.weeks.entries()) {
      for (const [entity, amount] of Object.entries(week.variable_by_entity)) {
        const vendorRows = pivot.rows.filter((r) => r.section === "VARIABLE_SPEND" && r.entity === entity);
        expect(sumCents(vendorRows.map((r) => r.cells[i]!.amount_cents))).toBe(amount);
      }
    }
  });

  it("sums vendors to categories to sections in every one of the 20 weeks", () => {
    for (const section of pivot.rows.filter((r) => r.level === 0)) {
      if (section.section === "NET_BURN" || section.section === "CASH_END") continue;
      const categories = pivot.rows.filter((r) => r.level === 1 && r.parent_id === section.id);
      for (let i = 0; i < pivot.periods.length; i++) {
        expect(sumCents(categories.map((c) => c.cells[i]!.amount_cents))).toBe(section.cells[i]!.amount_cents);
      }
    }
  });

  it("lands on the sandbox bank's closing balance", () => {
    const cash = row(pivot, "section:CASH_END");
    expect(cash.cells[cash.cells.length - 1]!.amount_cents).toBe(
      ledger.reconciliation.reported_closing_balance_cents,
    );
    expect(ledger.reconciliation.matches).toBe(true);
  });

  it("isolates the planted one-off in the ONE_OFF section", () => {
    const oneOff = row(pivot, `vendor:ONE_OFF:SAAS_SOFTWARE:${demo.fixture.one_off.entity}`);
    expect(oneOff.total_cents).toBe(demo.fixture.one_off.amount_cents);
    expect(oneOff.cells.flatMap((c) => c.flags)).toEqual(["one_off"]);
    // The vendor still has its ordinary monthly seats in variable spend.
    expect(row(pivot, `vendor:VARIABLE_SPEND:SAAS_SOFTWARE:${demo.fixture.one_off.entity}`).total_cents)
      .toBeGreaterThan(0);
  });

  it("marks the superseded pending row on the cell it would have hit", () => {
    const pair = demo.fixture.pending_settled_pairs[0]!;
    const pending = ledger.transactions.find((t) => t.id === pair.pending_id)!;
    expect(pending.dropped).toBe(true);
    const vendorRow = pivot.rows.find(
      (r) => r.level === 2 && r.entity === pending.merchant_normalized && r.section === "VARIABLE_SPEND",
    )!;
    const index = pivot.periods.findIndex((p) => p.start <= pending.date && pending.date <= p.end);
    expect(vendorRow.cells[index]!.flags).toContain("pending_dropped");
  });

  it("tints the post-change weeks the detector confirmed", () => {
    expect(pivot.periods.filter((p) => p.post_change)).toHaveLength(
      demo.fixture.weeks - demo.fixture.burn_shift.true_change_start_index,
    );
    expect(pivot.periods[demo.fixture.burn_shift.true_change_start_index]!.key).toBe(regimeStart);
  });

  it("splits the 20 weeks into the months the history touches", () => {
    const months = pivotLedger(ledger, { granularity: "month", regimeStart });
    expect(months.periods.map((p) => p.key)).toEqual(["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
    expect(months.periods.map((p) => p.partial)).toEqual([true, false, false, false, false, true]);
    expect(months.periods[0]).toMatchObject({ start: demo.fixture.start_date, end: "2026-04-30" });
    expect(months.periods[5]).toMatchObject({ start: "2026-09-01", end: demo.fixture.end_date });
    // Every dollar is still in the sheet, just in six columns instead of twenty.
    for (const id of ["section:VARIABLE_SPEND", "section:FIXED_SPEND", "section:ONE_OFF", "section:REVENUE"]) {
      expect(row(months, id).total_cents).toBe(row(pivot, id).total_cents);
    }
    expect(row(months, "section:CASH_END").total_cents).toBe(
      ledger.reconciliation.reported_closing_balance_cents,
    );
  });
});

describe("pivotLedger — messy statements (test profile)", () => {
  const { ledger } = buildDemoLedger({ profile: "test" });
  const pivot = pivotLedger(ledger, { granularity: "week" });

  it("still reproduces the weekly buckets when the statement is messy", () => {
    expect(cells(pivot, "section:VARIABLE_SPEND")).toEqual(ledger.weeks.map((w) => w.variable_spend_cents));
    expect(cells(pivot, "section:FIXED_SPEND")).toEqual(ledger.weeks.map((w) => w.fixed_spend_cents));
    expect(cells(pivot, "section:ONE_OFF")).toEqual(ledger.weeks.map((w) => w.excluded_from_monitoring_cents));
    expect(cells(pivot, "section:NET_BURN")).toEqual(ledger.weeks.map((w) => w.net_burn_cents));
  });

  it("keeps a vendor cell negative when the credit is bigger than the charge", () => {
    const linear = row(pivot, "vendor:VARIABLE_SPEND:SAAS_SOFTWARE:linear");
    const negative = linear.cells.filter((c) => c.amount_cents < 0);
    expect(negative).not.toHaveLength(0);
    for (const cell of negative) expect(cell.flags).toContain("refund");
  });

  it("puts the annual renewal in ONE_OFF, out of the monitored series", () => {
    const zoom = row(pivot, "vendor:ONE_OFF:SAAS_SOFTWARE:zoom");
    expect(zoom.total_cents).toBeGreaterThan(0);
    expect(zoom.cells.flatMap((c) => c.flags)).toEqual(["one_off", "annual_renewal"]);
    expect(pivot.rows.some((r) => r.id === "vendor:VARIABLE_SPEND:SAAS_SOFTWARE:zoom")).toBe(false);
  });

  it("shows the orphan transfer leg instead of assuming it netted", () => {
    const transfers = row(pivot, "category:FINANCING_AND_TRANSFERS:INTERNAL_TRANSFER");
    expect(transfers.total_cents).not.toBe(0);
    expect(ledger.reconciliation.unpaired_transfer_legs).toBeGreaterThan(0);
  });

  it("still lands on the reported closing balance", () => {
    const cash = row(pivot, "section:CASH_END");
    expect(cash.cells[cash.cells.length - 1]!.amount_cents).toBe(
      ledger.reconciliation.reported_closing_balance_cents,
    );
  });
});

describe("pivotCell", () => {
  const ledger = buildSampleLedger();

  it("lists the transactions behind a vendor cell, dropped rows included", () => {
    const detail = pivotCell(ledger, "vendor:VARIABLE_SPEND:SAAS_SOFTWARE:datadog", "2026-08-31", "week");
    expect(detail.row_id).toBe("vendor:VARIABLE_SPEND:SAAS_SOFTWARE:datadog");
    expect(detail.period_key).toBe("2026-08-31");
    expect(detail.transactions.map((t) => [t.id, t.dropped])).toEqual([
      ["t014", true],
      ["t015", false],
    ]);
    expect(detail.transactions[1]).toMatchObject({
      date: "2026-09-02",
      merchant_raw: "DATADOG",
      amount_cents: -220_000,
      flow_type: "OPERATING_OUTFLOW",
      category: "SAAS_SOFTWARE",
      tags: [],
    });
  });

  it("sorts by date then id", () => {
    const detail = pivotCell(ledger, "section:VARIABLE_SPEND", "2026-08-17", "week");
    const keys = detail.transactions.map((t) => `${t.date}:${t.id}`);
    expect(keys).toEqual([...keys].sort());
  });

  it("rolls up to category and section rows", () => {
    const vendor = pivotCell(ledger, "vendor:VARIABLE_SPEND:CONTRACTORS:upwork", "2026-08-31", "week");
    const category = pivotCell(ledger, "category:VARIABLE_SPEND:CONTRACTORS", "2026-08-31", "week");
    const section = pivotCell(ledger, "section:VARIABLE_SPEND", "2026-08-31", "week");
    expect(vendor.transactions.map((t) => t.id)).toEqual(["t016"]);
    expect(category.transactions.map((t) => t.id)).toEqual(["t016"]);
    expect(section.transactions.map((t) => t.id)).toContain("t015");
    expect(section.transactions.length).toBeGreaterThan(category.transactions.length);
  });

  it("agrees with the cell it explains", () => {
    const pivot = pivotLedger(ledger, { granularity: "week" });
    for (const [i, period] of pivot.periods.entries()) {
      for (const r of pivot.rows.filter((r) => r.level === 2)) {
        const detail = pivotCell(ledger, r.id, period.key, "week");
        const live = detail.transactions.filter((t) => !t.dropped);
        expect(live).toHaveLength(r.cells[i]!.transaction_count);
        const signed = live.map((t) => (r.section === "REVENUE" ? t.amount_cents : -t.amount_cents));
        expect(sumCents(signed)).toBe(r.cells[i]!.amount_cents);
      }
    }
  });

  it("explains NET_BURN with operating rows only", () => {
    const detail = pivotCell(ledger, "section:NET_BURN", "2026-08-31", "week");
    const ids = detail.transactions.map((t) => t.id);
    expect(ids).toContain("t013"); // payroll
    expect(ids).toContain("t016"); // refund
    expect(ids).not.toContain("t017"); // financing
  });

  it("explains CASH_END with the movements inside the period", () => {
    const detail = pivotCell(ledger, "section:CASH_END", "2026-08-31", "week");
    expect(detail.transactions.map((t) => t.id)).toEqual(["t013", "t015", "t016", "t017"]);
    // Card-account rows never moved cash.
    expect(detail.transactions.every((t) => t.id !== "t011")).toBe(true);
  });

  it("works on month keys", () => {
    const detail = pivotCell(ledger, "vendor:VARIABLE_SPEND:CLOUD_INFRASTRUCTURE:aws", "2026-09", "month");
    expect(detail.transactions.map((t) => t.id)).toEqual(["t018"]);
  });

  it("rejects unknown rows and periods loudly", () => {
    expect(() => pivotCell(ledger, "vendor:VARIABLE_SPEND:CLOUD_INFRASTRUCTURE:aws", "2026-07-06", "week")).toThrow(
      /Unknown week period/,
    );
    expect(() => pivotCell(ledger, "nonsense", "2026-08-17", "week")).toThrow(/Unknown pivot section/);
    expect(() => pivotCell(ledger, "vendor:VARIABLE_SPEND:NOT_A_CATEGORY:aws", "2026-08-17", "week")).toThrow(
      /Unknown category/,
    );
    expect(() => pivotCell(ledger, "vendor:VARIABLE_SPEND", "2026-08-17", "week")).toThrow(/Unknown pivot row id/);
  });
});
