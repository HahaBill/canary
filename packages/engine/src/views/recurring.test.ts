import { describe, expect, it } from "vitest";
import { addDays, type Cents, type ISODate, type Ledger, type RecurringSeries, type Transaction } from "@canary/shared";
import { buildLedger } from "../ledger.ts";
import { classificationsFromHints, SAMPLE_COMPANY, tx } from "../test-support.ts";
import { SAMPLE_ACCOUNTS } from "@canary/shared/fixtures";
import { buildDemoLedger } from "./demo-ledger.testkit.ts";
import { projectRecurring } from "./recurring.ts";

/** A ledger over an arbitrary history window, for cadence experiments. */
function ledgerOf(transactions: Transaction[], historyStart: ISODate, historyEnd: ISODate): Ledger {
  return buildLedger({
    company: SAMPLE_COMPANY,
    accounts: SAMPLE_ACCOUNTS,
    transactions,
    classifications: classificationsFromHints(transactions),
    historyStart,
    historyEnd,
  });
}

interface ChargeSpec {
  entity?: string;
  dates: ISODate[];
  amount?: Cents;
  tags?: Transaction["tags"];
  flow_type?: Transaction["flow_type"];
}

function charges({ entity = "acme", dates, amount = -100_000, tags = [], flow_type = "OPERATING_OUTFLOW" }: ChargeSpec): Transaction[] {
  return dates.map((date, i) =>
    tx({
      id: `${entity}_${i}`,
      account_id: "chk",
      date,
      amount_cents: amount,
      merchant_raw: entity.toUpperCase(),
      merchant_normalized: entity,
      description: "",
      flow_type,
      tags,
      category_hint: flow_type === "OPERATING_INFLOW" ? "CUSTOMER_REVENUE" : "SAAS_SOFTWARE",
    }),
  );
}

function every(start: ISODate, step: number, count: number): ISODate[] {
  return Array.from({ length: count }, (_, i) => addDays(start, i * step));
}

function series(transactions: Transaction[], horizonEnd: ISODate, historyEnd = "2026-09-13"): RecurringSeries[] {
  return projectRecurring(ledgerOf(transactions, "2026-01-05", historyEnd), { horizonEnd });
}

describe("projectRecurring — cadence detection", () => {
  it("detects a weekly charge", () => {
    const [s] = series(charges({ dates: every("2026-08-03", 7, 6) }), "2026-10-04");
    expect(s).toMatchObject({ entity: "acme", cadence: "weekly", observations: 6, last_seen: "2026-09-07" });
    expect(s!.typical_amount_cents).toBe(-100_000);
  });

  it("detects a biweekly charge", () => {
    const [s] = series(charges({ dates: every("2026-07-06", 14, 5) }), "2026-10-04");
    expect(s).toMatchObject({ cadence: "biweekly", observations: 5, last_seen: "2026-08-31" });
  });

  it("detects a monthly charge", () => {
    const [s] = series(charges({ dates: ["2026-05-11", "2026-06-11", "2026-07-11", "2026-08-11", "2026-09-11"] }), "2026-11-30");
    expect(s).toMatchObject({ cadence: "monthly", observations: 5, last_seen: "2026-09-11" });
  });

  it("treats a same-day-of-month bill as monthly even when the gaps drift", () => {
    // The 31st of every month: gaps of 31, 28, 31, 30 — February pulls the median
    // out of the monthly window, but "the 31st" is unmistakable.
    const [s] = series(
      charges({ dates: ["2026-01-31", "2026-03-03", "2026-03-31", "2026-05-01", "2026-05-31"] }),
      "2026-11-30",
    );
    expect(s).toMatchObject({ cadence: "monthly", observations: 5 });
  });

  it("ignores an irregular vendor", () => {
    expect(series(charges({ dates: ["2026-06-02", "2026-06-19", "2026-07-30", "2026-08-01"] }), "2026-10-31")).toEqual([]);
  });

  it("ignores a vendor with too few observations", () => {
    expect(series(charges({ dates: every("2026-08-31", 7, 2) }), "2026-10-31")).toEqual([]);
    const three = charges({ dates: every("2026-08-24", 7, 3) });
    expect(series(three, "2026-10-31")).toHaveLength(1);
    expect(
      projectRecurring(ledgerOf(three, "2026-01-05", "2026-09-13"), { horizonEnd: "2026-10-31", minObservations: 4 }),
    ).toEqual([]);
  });

  it("tolerates a late payment but not a broken cadence", () => {
    // 7, 7, 9, 7 — one charge slipped two days.
    const tolerated = series(charges({ dates: ["2026-08-10", "2026-08-17", "2026-08-24", "2026-09-02", "2026-09-09"] }), "2026-10-04");
    expect(tolerated[0]).toMatchObject({ cadence: "weekly" });
    // 7, 14, 7, 21 — the median still says weekly, but only half the gaps agree.
    expect(series(charges({ dates: ["2026-07-06", "2026-07-13", "2026-07-27", "2026-08-03", "2026-08-24"] }), "2026-10-04")).toEqual([]);
  });

  it("collapses two charges on the same day into one observation", () => {
    const twice = charges({ dates: every("2026-08-03", 7, 6) }).concat(
      charges({ entity: "acme", dates: ["2026-08-03"], amount: -40_000 }).map((t) => ({ ...t, id: "acme_dup" })),
    );
    const [s] = series(twice, "2026-10-04");
    expect(s).toMatchObject({ cadence: "weekly", observations: 6 });
    // The doubled day is summed, the median is unmoved.
    expect(s!.typical_amount_cents).toBe(-100_000);
  });

  it("uses the median amount, so a true-up does not become the expectation", () => {
    const dates = every("2026-08-03", 7, 6);
    const spiky = charges({ dates }).map((t, i) => (i === 3 ? { ...t, amount_cents: -900_000 } : t));
    const [s] = series(spiky, "2026-10-04");
    expect(s!.typical_amount_cents).toBe(-100_000);
  });

  it("projects operating revenue too", () => {
    const [s] = series(charges({ entity: "stripe_payouts", dates: every("2026-08-03", 7, 6), amount: 1_340_000, flow_type: "OPERATING_INFLOW" }), "2026-09-30");
    expect(s).toMatchObject({ entity: "stripe_payouts", cadence: "weekly", category: "CUSTOMER_REVENUE" });
    expect(s!.typical_amount_cents).toBe(1_340_000);
  });

  it("never projects transfers, settlements or financing", () => {
    const financing = charges({ entity: "safe_financing", dates: every("2026-08-03", 7, 6), amount: 5_000_000, flow_type: "FINANCING" });
    expect(series(financing, "2026-09-30")).toEqual([]);
  });

  it("skips a vendor whose charges are all one-offs", () => {
    expect(series(charges({ dates: every("2026-08-03", 7, 6), tags: ["one_off"] }), "2026-10-04")).toEqual([]);
  });

  it("skips the dropped leg of a pending/settled pair", () => {
    const weekly = charges({ dates: every("2026-08-03", 7, 6) });
    const pending = tx({
      id: "acme_pending",
      account_id: "chk",
      date: "2026-09-06",
      amount_cents: -100_000,
      merchant_raw: "ACME",
      merchant_normalized: "acme",
      description: "",
      flow_type: "OPERATING_OUTFLOW",
      status: "pending",
      category_hint: "SAAS_SOFTWARE",
    });
    const settled = { ...weekly[5]!, id: "acme_settled", pending_of: "acme_pending" };
    const [s] = series([...weekly.slice(0, 5), pending, settled], "2026-10-04");
    expect(s).toMatchObject({ cadence: "weekly", observations: 6, last_seen: "2026-09-07" });
  });
});

describe("projectRecurring — projection", () => {
  it("steps from the last observation to the horizon and no further", () => {
    const [s] = series(charges({ dates: every("2026-08-03", 7, 6) }), "2026-10-04");
    // The next step after 2026-09-28 is 2026-10-05, one day past the horizon.
    expect(s!.next_dates).toEqual(["2026-09-14", "2026-09-21", "2026-09-28"]);
    expect(s!.next_dates.every((d) => d > "2026-09-13" && d <= "2026-10-04")).toBe(true);
  });

  it("returns nothing when the horizon is inside history", () => {
    const [s] = series(charges({ dates: every("2026-08-03", 7, 6) }), "2026-09-13");
    expect(s!.next_dates).toEqual([]);
  });

  it("steps over dates that fall inside history", () => {
    // Last seen three weeks before the end of history: the two dates that would
    // have landed inside history are stepped over, not invented.
    const [s] = series(charges({ dates: every("2026-07-27", 7, 4) }), "2026-09-27");
    expect(s!.last_seen).toBe("2026-08-17");
    expect(s!.next_dates).toEqual(["2026-09-14", "2026-09-21"]);
  });

  it("keeps the day of the month and clamps it to the month length", () => {
    const [s] = series(
      charges({ dates: ["2026-05-31", "2026-07-01", "2026-07-31", "2026-08-31"] }),
      "2027-01-31",
      "2026-09-13",
    );
    expect(s!.cadence).toBe("monthly");
    // September has 30 days, February 28 — the anchor day survives both.
    expect(s!.next_dates).toEqual([
      "2026-09-30",
      "2026-10-31",
      "2026-11-30",
      "2026-12-31",
      "2027-01-31",
    ]);
  });

  it("orders series by absolute typical amount, biggest first", () => {
    const small = charges({ entity: "linear", dates: every("2026-08-03", 7, 6), amount: -29_000 });
    const big = charges({ entity: "aws", dates: every("2026-08-04", 7, 6), amount: -948_000 });
    const revenue = charges({ entity: "stripe_payouts", dates: every("2026-08-05", 7, 6), amount: 1_307_000, flow_type: "OPERATING_INFLOW" });
    const detected = series([...small, ...big, ...revenue], "2026-09-30");
    expect(detected.map((s) => s.entity)).toEqual(["stripe_payouts", "aws", "linear"]);
  });

  it("is byte-identical across runs", () => {
    const txns = charges({ dates: every("2026-08-03", 7, 6) });
    expect(JSON.stringify(series(txns, "2026-10-31"))).toBe(JSON.stringify(series(txns, "2026-10-31")));
  });
});

describe("projectRecurring — demo ledger", () => {
  const { demo, ledger } = buildDemoLedger();
  const horizonEnd = "2026-10-31";
  const detected = projectRecurring(ledger, { horizonEnd });
  const byEntity = new Map(detected.map((s) => [s.entity, s]));

  it("finds the cadences the generator planted", () => {
    // Counts come from the span, not from a hard-coded 20 weeks: the demo
    // history is a year and the test fixture has to follow it.
    const weeks = demo.fixture.weeks;
    expect(byEntity.get("gusto_payroll")).toMatchObject({ cadence: "biweekly", category: "PAYROLL", observations: Math.floor(weeks / 2) });
    expect(byEntity.get("wework")).toMatchObject({ cadence: "monthly", category: "RENT" });
    expect(byEntity.get("wework")!.observations).toBeGreaterThanOrEqual(Math.floor(weeks / 5));
    expect(byEntity.get("aws")).toMatchObject({ cadence: "weekly", category: "CLOUD_INFRASTRUCTURE", observations: weeks });
    expect(byEntity.get("stripe_payouts")).toMatchObject({ cadence: "weekly", category: "CUSTOMER_REVENUE" });
    expect(byEntity.get("deel")).toMatchObject({ cadence: "biweekly" });
    expect(byEntity.get("datadog")).toMatchObject({ cadence: "monthly" });
  });

  it("agrees with the plan on sign and size", () => {
    // Payroll is the biggest single outflow; rent is exact; revenue is the only inflow.
    expect(byEntity.get("gusto_payroll")!.typical_amount_cents).toBeLessThan(-4_000_000);
    expect(byEntity.get("wework")!.typical_amount_cents).toBe(-1_100_000);
    expect(byEntity.get("stripe_payouts")!.typical_amount_cents).toBeGreaterThan(0);
    expect(detected.filter((s) => s.typical_amount_cents > 0).map((s) => s.entity)).toEqual(["stripe_payouts"]);
  });

  it("leaves irregular and one-off vendors alone", () => {
    // Sparse card spend, a single annual tax, and the transfer/settlement legs.
    for (const entity of ["united", "airbnb", "apple", "dell", "delaware_franchise_tax", "internal_transfer", "card_settlement", "doordash"]) {
      expect(byEntity.has(entity)).toBe(false);
    }
    // Ashby appears three times, 21 days apart — no cadence claims that.
    expect(byEntity.has("ashby")).toBe(false);
  });

  it("keeps the one-off out of its vendor's expectation", () => {
    const figma = byEntity.get(demo.fixture.one_off.entity)!;
    expect(figma.cadence).toBe("monthly");
    expect(Math.abs(figma.typical_amount_cents)).toBeLessThan(demo.fixture.one_off.amount_cents / 4);

    // Untagged, the true-up is just one odd payment among a year of monthly
    // ones, so the vendor is still recognisably monthly. Over a 20-week history
    // the same payment broke the cadence outright and no series was projected.
    // Either way the guarantee that matters holds: the projection is a median,
    // so a single true-up never becomes what Canary tells the founder to expect.
    const untagged = projectRecurring(buildDemoLedger({ tagOneOff: false }).ledger, { horizonEnd });
    const untaggedFigma = untagged.find((s) => s.entity === demo.fixture.one_off.entity);
    if (untaggedFigma) {
      expect(Math.abs(untaggedFigma.typical_amount_cents)).toBeLessThan(demo.fixture.one_off.amount_cents / 4);
    }
  });

  it("projects only dates after history and inside the horizon", () => {
    expect(detected.length).toBeGreaterThan(10);
    for (const s of detected) {
      expect(s.next_dates.length).toBeGreaterThan(0);
      expect(s.last_seen <= ledger.history_end).toBe(true);
      for (const d of s.next_dates) {
        expect(d > ledger.history_end).toBe(true);
        expect(d <= horizonEnd).toBe(true);
      }
      expect([...s.next_dates]).toEqual([...s.next_dates].sort());
    }
  });

  it("is byte-identical across runs", () => {
    expect(JSON.stringify(projectRecurring(buildDemoLedger().ledger, { horizonEnd }))).toBe(JSON.stringify(detected));
  });
});
