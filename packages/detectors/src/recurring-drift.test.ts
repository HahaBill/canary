import { addDays, formatUsdWhole, weeklyToMonthly } from "@canary/shared";
import { describe, expect, it } from "vitest";
import { runCusum } from "./cusum.ts";
import { decomposeContributors } from "./decompose.ts";
import { attachDriftSignals, buildIncidents } from "./incidents.ts";
import { RECURRING_DRIFT, detectRecurringDrift } from "./recurring-drift.ts";
import { buildWeeks, makeBurn, makeLedger, makeTx } from "./test-helpers.ts";

const BURN = makeBurn();
const FIRST = "2026-05-11";

/** Monthly charges to one vendor, 28 days apart. */
function monthly(entity: string, amounts: number[], first = FIRST, tags: string[] = []) {
  return amounts.map((amount, i) =>
    makeTx({
      id: `${entity}_${i}`,
      date: addDays(first, i * 28),
      amount_cents: -amount,
      merchant_normalized: entity,
      ...(tags.length > 0 ? { tags: tags as never } : {}),
    }),
  );
}

const ledgerOf = (...rows: ReturnType<typeof monthly>[]) => makeLedger(rows.flat(), buildWeeks());
const driftFor = (entity: string, rows: ReturnType<typeof monthly>) =>
  detectRecurringDrift(ledgerOf(rows), BURN).find((d) => d.entity === entity) ?? null;

describe("detectRecurringDrift", () => {
  // The shape PRD §29 describes: a subscription creeping up month over month.
  // No single charge is anomalous next to the one before it.
  const CREEPING = [368_800, 387_700, 463_200, 608_200, 602_600];

  it("catches a subscription that creeps up, which no single-payment rule can see", () => {
    const drift = driftFor("datadog", monthly("datadog", CREEPING))!;

    expect(drift.charge_count).toBe(5);
    // Earlier half vs later half: no single invoice can move both medians.
    expect(drift.early_median_cents).toBe(378_250);
    expect(drift.late_median_cents).toBe(602_600);
    expect(drift.delta_per_charge_cents).toBe(224_350);
    expect(drift.increase_fraction).toBeCloseTo(0.593, 3);
    expect(drift.is_drifting).toBe(true);
    expect(drift.first_charge_date).toBe(FIRST);
    expect(drift.last_charge_date).toBe(addDays(FIRST, 4 * 28));
  });

  it("is invisible to the one-off rule it complements", () => {
    // Every charge is well under 3x the running median, so no payment in this
    // series would ever trip the vendor-relative one-off detector.
    const sorted = [...CREEPING].sort((a, b) => a - b);
    const seriesMedian = sorted[Math.floor(sorted.length / 2)]!;
    expect(Math.max(...CREEPING) / seriesMedian).toBeLessThan(3);
  });

  it("expresses the drift per charge and per month, never as a weekly rate", () => {
    const drift = driftFor("datadog", monthly("datadog", CREEPING))!;
    const weekly = Math.round(drift.delta_per_charge_cents * drift.charges_per_week);

    // Contributor decomposition already owns the weekly rate around the change
    // point. This detector reports what the invoice says.
    expect(drift.estimated_monthly_delta_cents).toBe(weeklyToMonthly(weekly));
    expect(drift.charges_per_week).toBeCloseTo(4 / 16, 2);
  });

  it("stays quiet on a flat vendor", () => {
    expect(driftFor("wework", monthly("wework", [1_100_000, 1_100_000, 1_100_000, 1_100_000, 1_100_000]))).toBeNull();
  });

  it("stays quiet on a noisy vendor with no trend", () => {
    expect(driftFor("google_ads", monthly("google_ads", [155_300, 186_600, 160_000, 195_600, 166_000]))).toBeNull();
  });

  it("stays quiet on a single spike, because one invoice cannot move both medians", () => {
    // The classic false positive: one big month among flat ones.
    expect(driftFor("figma", monthly("figma", [119_000, 112_800, 113_400, 117_000, 1_382_700, 118_200]))).toBeNull();
  });

  it("needs more than a couple of charges before it will call anything a trend", () => {
    const three = driftFor("apple", monthly("apple", [147_500, 200_000, 300_000]));
    expect(RECURRING_DRIFT.MIN_CHARGES).toBe(4);
    expect(three).toBeNull();

    const four = driftFor("apple", monthly("apple", [147_500, 150_000, 300_000, 310_000]));
    expect(four?.is_drifting).toBe(true);
  });

  it("ignores a big percentage rise that costs almost nothing", () => {
    // A $9 seat going to $18 is +100% and not worth a founder's attention.
    expect(driftFor("linear", monthly("linear", [900, 900, 1_800, 1_800]))).toBeNull();
  });

  it("ignores charges tagged one_off or annual_renewal, as the monitored series does", () => {
    const rows = [
      ...monthly("zoom", [100_000, 100_000, 100_000, 100_000]),
      ...monthly("zoom", [960_000], addDays(FIRST, 4 * 28), ["annual_renewal"]),
    ];
    expect(driftFor("zoom", rows)).toBeNull();
  });

  it("keeps needs_review charges, which are still real spend", () => {
    const rows = monthly("miguel_santos", [200_000, 210_000, 400_000, 420_000], FIRST, ["needs_review"]);
    expect(driftFor("miguel_santos", rows)?.is_drifting).toBe(true);
  });

  it("watches fixed categories too — rent rising 40% is exactly the point", () => {
    const rows = monthly("wework", [1_100_000, 1_100_000, 1_600_000, 1_650_000]);
    expect(driftFor("wework", rows)?.is_drifting).toBe(true);
  });

  it("ignores refunds, which would otherwise hide a rise", () => {
    const rows = [
      ...monthly("datadog", CREEPING),
      makeTx({
        id: "datadog_credit",
        date: addDays(FIRST, 5 * 28),
        amount_cents: 500_000,
        merchant_normalized: "datadog",
        flow_type: "REFUND",
      }),
    ];
    const drift = driftFor("datadog", rows)!;
    expect(drift.charge_count).toBe(5);
  });

  it("does not divide by a vendor that has never been charged", () => {
    expect(() => detectRecurringDrift(ledgerOf(monthly("ghost", [0, 0, 0, 0])), BURN)).not.toThrow();
    expect(driftFor("ghost", monthly("ghost", [0, 0, 0, 0]))).toBeNull();
  });

  it("is deterministic", () => {
    const ledger = ledgerOf(monthly("datadog", CREEPING));
    expect(detectRecurringDrift(ledger, BURN)).toEqual(detectRecurringDrift(ledger, BURN));
  });
});

describe("attachDriftSignals — contract §10 grouping", () => {
  const weeks = buildWeeks();
  const cusum = runCusum(weeks);
  const contributors = decomposeContributors(weeks, cusum);
  const changePoint = cusum.estimated_change_point_week_start!;

  /** Datadog is a contributor to the rate shift AND a drifting subscription. */
  const driftRows = monthly("datadog", [368_800, 387_700, 463_200, 608_200, 602_600], changePoint);

  function incidentsFor(rows = driftRows) {
    const ledger = makeLedger(rows, weeks);
    const incidents = buildIncidents({
      ledger,
      cusum,
      contributors,
      oneOffs: [],
      burnBefore: makeBurn({ monthly_gross_burn_cents: 10_000_000, runway_months: 25 }),
      burnAfter: makeBurn({ monthly_gross_burn_cents: 10_000_000, runway_months: 22 }),
      existing: [],
      now: "2026-09-12T17:00:00.000Z",
    });
    return { incidents, drifts: detectRecurringDrift(ledger, BURN) };
  }

  it("folds a drifting contributor into the existing incident instead of raising a second alert", () => {
    const { incidents, drifts } = incidentsFor();
    const after = attachDriftSignals(incidents, drifts);

    // One problem, one incident (PRD §4).
    expect(after).toHaveLength(incidents.length);
    expect(after.filter((i) => i.type === "BURN_RATE_SHIFT")).toHaveLength(1);

    const shift = after.find((i) => i.type === "BURN_RATE_SHIFT")!;
    const drift = drifts.find((d) => d.entity === "datadog")!;
    const signal = shift.child_signals.find((s) => s.entity === "datadog")!;

    expect(signal.description).toContain(formatUsdWhole(drift.early_median_cents));
    expect(signal.description).toContain(formatUsdWhole(drift.late_median_cents));
    // The rate the decomposition computed is untouched.
    expect(signal.delta_weekly_cents).toBe(incidents.find((i) => i.type === "BURN_RATE_SHIFT")!.child_signals.find((s) => s.entity === "datadog")!.delta_weekly_cents);
  });

  it("adds the drift as OBSERVED evidence, never as a claim about why", () => {
    const { incidents, drifts } = incidentsFor();
    const shift = attachDriftSignals(incidents, drifts).find((i) => i.type === "BURN_RATE_SHIFT")!;
    const added = shift.evidence.filter((e) => e.text.includes("charging more each cycle"));

    expect(added).toHaveLength(1);
    expect(added[0]!.kind).toBe("OBSERVED");
    expect(added[0]!.text).not.toMatch(/https?:\/\//);
    // Reports the rise; never asserts a reason for it.
    expect(added[0]!.text).not.toMatch(/because|due to|caused/i);
  });

  it("leaves contributors and every published rate untouched", () => {
    const { incidents, drifts } = incidentsFor();
    const before = incidents.find((i) => i.type === "BURN_RATE_SHIFT")!;
    const after = attachDriftSignals(incidents, drifts).find((i) => i.type === "BURN_RATE_SHIFT")!;

    expect(after.contributors).toEqual(before.contributors);
    expect(after.financial_impact).toEqual(before.financial_impact);
    expect(after.severity).toBe(before.severity);
    expect(after.summary).toBe(before.summary);
  });

  it("does not join a drift that finished before the regime started", () => {
    // Same vendor, but every charge lands well before the change point.
    const old = monthly("datadog", [368_800, 387_700, 463_200, 608_200], "2026-01-05");
    const { incidents } = incidentsFor();
    const drifts = detectRecurringDrift(makeLedger(old, weeks), BURN);
    const after = attachDriftSignals(incidents, drifts);

    expect(after).toEqual(incidents);
  });

  it("does not join a drifting vendor that is not a contributor", () => {
    const { incidents } = incidentsFor();
    const stranger = detectRecurringDrift(
      makeLedger(monthly("acme_widgets", [200_000, 210_000, 400_000, 420_000], changePoint), weeks),
      BURN,
    );

    expect(stranger).toHaveLength(1);
    // Returned to the caller, but it creates no incident: IncidentType has no
    // member for a standalone drift, and inventing one would double-alert.
    expect(attachDriftSignals(incidents, stranger)).toEqual(incidents);
  });

  it("is a no-op when nothing drifted", () => {
    const { incidents } = incidentsFor();
    expect(attachDriftSignals(incidents, [])).toBe(incidents);
  });

  it("is deterministic", () => {
    const { incidents, drifts } = incidentsFor();
    expect(attachDriftSignals(incidents, drifts)).toEqual(attachDriftSignals(incidents, drifts));
  });
});
