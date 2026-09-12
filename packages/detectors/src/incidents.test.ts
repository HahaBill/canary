import {
  DEMO,
  EVIDENCE_KINDS,
  INCIDENT_DEDUP_WEEKS,
  daysBetween,
  formatUsdWhole,
  weeklyToAnnual,
  weeklyToMonthly,
  type BurnSummary,
  type Incident,
  type LedgerTransaction,
} from "@canary/shared";
import { describe, expect, it } from "vitest";
import { runCusum } from "./cusum.ts";
import { decomposeContributors } from "./decompose.ts";
import { buildIncidents } from "./incidents.ts";
import { detectOneOffs } from "./one-off.ts";
import { RATE_MATERIALITY_RULES } from "./materiality.ts";
import { BASE_WEEKLY, makeBurn, makeLedger, makeTx, priorPayments, buildWeeks, type SeriesOptions } from "./test-helpers.ts";

const NOW = "2026-09-12T17:00:00.000Z";
const LATER = "2026-09-19T17:00:00.000Z";
const NOTIFIED_AT = "2026-09-12T17:05:00.000Z";

/** $100K/month gross, 25.0 months of runway before the shift. */
const BURN_BEFORE = makeBurn({ monthly_gross_burn_cents: 10_000_000, runway_months: 25 });
const BURN_AFTER = makeBurn({ monthly_gross_burn_cents: 10_000_000, runway_months: 22, burn_window_reason: "POST_CHANGE_SEGMENT" });

/** One payment per contributor so `categoriesByEntity` can label them. */
const ENTITY_ROWS: LedgerTransaction[] = Object.keys(BASE_WEEKLY).map((entity, i) =>
  makeTx({ id: `${entity}_row`, date: "2026-09-07", amount_cents: -(BASE_WEEKLY[entity] ?? 0) - i, merchant_normalized: entity }),
);

/** datadog is both a rate-shift contributor AND the vendor of a one-off. */
const ONE_OFF_ROWS: LedgerTransaction[] = [
  ...priorPayments("datadog", [4_200_00, 4_500_00, 4_800_00], "2026-08-01"),
  makeTx({ id: "datadog_spike", date: "2026-09-05", amount_cents: -1_800_000, merchant_normalized: "datadog" }),
];

function scenario(options: SeriesOptions = {}, extraRows: LedgerTransaction[] = ONE_OFF_ROWS) {
  const weeks = buildWeeks(options);
  const cusum = runCusum(weeks);
  const contributors = decomposeContributors(weeks, cusum);
  const ledger = makeLedger([...ENTITY_ROWS, ...extraRows], weeks);
  const oneOffs = detectOneOffs(ledger, BURN_AFTER);
  return { weeks, cusum, contributors, ledger, oneOffs };
}

function build(
  options: SeriesOptions = {},
  extra: { existing?: Incident[]; now?: string; burnBefore?: BurnSummary; burnAfter?: BurnSummary; rows?: LedgerTransaction[] } = {},
): Incident[] {
  const { cusum, contributors, ledger, oneOffs } = scenario(options, extra.rows ?? ONE_OFF_ROWS);
  return buildIncidents({
    ledger,
    cusum,
    contributors,
    oneOffs,
    burnBefore: extra.burnBefore ?? BURN_BEFORE,
    burnAfter: extra.burnAfter ?? BURN_AFTER,
    existing: extra.existing ?? [],
    now: extra.now ?? NOW,
  });
}

describe("buildIncidents", () => {
  it("builds one burn incident from a fired, material CUSUM alarm", () => {
    const { cusum } = scenario();
    const incident = build().find((i) => i.type === "BURN_RATE_SHIFT")!;

    expect(incident.id).toMatch(/^inc_[0-9a-f]{8}$/);
    expect(incident.entity).toBe("aws");
    expect(incident.status).toBe("OPEN");
    expect(incident.first_detected).toBe(NOW);
    expect(incident.last_updated).toBe(NOW);
    expect(incident.last_notified).toBeNull();
    expect(incident.estimated_change_point).toBe(cusum.estimated_change_point_week_start);
    expect(incident.alarm_date).toBe(cusum.alarm_week_start);
    expect(incident.detection.cusum).toEqual(cusum);
    expect(incident.summary).toContain("aws");
    expect(incident.summary).toContain(formatUsdWhole(cusum.post_change_rate_weekly_cents!));
  });

  it("quantifies impact and severity from the delta and the two burn windows", () => {
    const { cusum } = scenario();
    const incident = build().find((i) => i.type === "BURN_RATE_SHIFT")!;
    const delta = cusum.delta_weekly_cents!;

    expect(incident.financial_impact).toEqual({
      delta_weekly_cents: delta,
      delta_monthly_cents: weeklyToMonthly(delta),
      delta_annualized_cents: weeklyToAnnual(delta),
      runway_before_months: 25,
      runway_after_months: 22,
      runway_impact_months: 3,
    });
    expect(incident.severity).toBe("HIGH");
    expect(incident.materiality.rules_triggered).toEqual([
      RATE_MATERIALITY_RULES.MIN_MONTHLY_DELTA_CENTS,
      RATE_MATERIALITY_RULES.MIN_BURN_PERCENT,
      RATE_MATERIALITY_RULES.MIN_RUNWAY_IMPACT_MONTHS,
    ]);
  });

  it("takes severity from runway impact alone", () => {
    const medium = build({}, { burnAfter: makeBurn({ monthly_gross_burn_cents: 10_000_000, runway_months: 24.4 }) });
    const low = build({}, { burnAfter: makeBurn({ monthly_gross_burn_cents: 10_000_000, runway_months: 24.8 }) });

    expect(medium.find((i) => i.type === "BURN_RATE_SHIFT")!.severity).toBe("MEDIUM");
    expect(low.find((i) => i.type === "BURN_RATE_SHIFT")!.severity).toBe("LOW");
  });

  it("folds the other positive contributors into child signals instead of new incidents", () => {
    const incidents = build();
    const incident = incidents.find((i) => i.type === "BURN_RATE_SHIFT")!;

    expect(incidents.filter((i) => i.type === "BURN_RATE_SHIFT")).toHaveLength(1);
    expect(incident.child_signals.map((c) => c.entity).sort()).toEqual(["ashby", "datadog"]);
    expect(incident.child_signals.map((c) => c.entity)).not.toContain("aws");
    expect(incident.child_signals.every((c) => c.delta_weekly_cents > 0)).toBe(true);
    expect(incident.child_signals[0]!.category).not.toBeNull();
    // No contributor spawns a second BURN_RATE_SHIFT for itself.
    for (const entity of ["datadog", "ashby", "upwork"]) {
      expect(incidents.filter((i) => i.type === "BURN_RATE_SHIFT" && i.entity === entity)).toHaveLength(0);
    }
  });

  it("labels contributors with the category recovered from the ledger", () => {
    const incident = build().find((i) => i.type === "BURN_RATE_SHIFT")!;
    const byEntity = Object.fromEntries(incident.contributors.map((c) => [c.entity, c.category]));

    expect(byEntity.aws).toBe("CLOUD_INFRASTRUCTURE");
    expect(byEntity.upwork).toBe("CONTRACTORS");
    expect(incident.contributors.map((c) => c.entity)[0]).toBe("aws");
  });

  it("keeps a material one-off standalone even when its vendor is a contributor", () => {
    const incidents = build();
    const oneOff = incidents.find((i) => i.type === "ONE_OFF_VENDOR_PAYMENT")!;
    const burn = incidents.find((i) => i.type === "BURN_RATE_SHIFT")!;

    expect(incidents).toHaveLength(2);
    expect(oneOff.entity).toBe("datadog");
    expect(burn.contributors.map((c) => c.entity)).toContain("datadog");
    expect(oneOff.severity).toBe("MEDIUM");
    expect(oneOff.estimated_change_point).toBeNull();
    expect(oneOff.alarm_date).toBe("2026-09-05");
    expect(oneOff.financial_impact.one_off_amount_cents).toBe(1_800_000);
    expect(oneOff.financial_impact.delta_weekly_cents).toBeNull();
    expect(oneOff.contributors).toEqual([]);
    expect(oneOff.child_signals).toEqual([]);
    expect(oneOff.detection.one_off?.transaction_id).toBe("datadog_spike");
    expect(oneOff.summary).toContain(formatUsdWhole(1_800_000));
  });

  it("ignores one-offs that are new-vendor or immaterial", () => {
    const twoPriors = [
      ...priorPayments("datadog", [4_200_00, 4_500_00], "2026-08-01"),
      makeTx({ id: "datadog_spike", date: "2026-09-05", amount_cents: -1_800_000, merchant_normalized: "datadog" }),
    ];
    const small = [
      ...priorPayments("datadog", [1_000, 1_000, 1_000], "2026-08-01"),
      makeTx({ id: "datadog_small", date: "2026-09-05", amount_cents: -210_000, merchant_normalized: "datadog" }),
    ];

    expect(build({}, { rows: twoPriors }).filter((i) => i.type === "ONE_OFF_VENDOR_PAYMENT")).toHaveLength(0);
    expect(build({}, { rows: small }).filter((i) => i.type === "ONE_OFF_VENDOR_PAYMENT")).toHaveLength(0);
  });

  it("creates no burn incident when CUSUM did not fire", () => {
    const incidents = build({ changeAt: null, noiseFraction: 0.05 });

    expect(incidents.filter((i) => i.type === "BURN_RATE_SHIFT")).toHaveLength(0);
    expect(incidents.filter((i) => i.type === "ONE_OFF_VENDOR_PAYMENT")).toHaveLength(1);
  });

  it("creates no burn incident when a real shift is immaterial", () => {
    const bigBurn = makeBurn({ monthly_gross_burn_cents: 40_000_000, runway_months: 14.3 });
    const { cusum } = scenario({ step: { aws: 100_000 } });
    const incidents = build({ step: { aws: 100_000 } }, { burnBefore: bigBurn, burnAfter: bigBurn });

    expect(cusum.fired).toBe(true);
    expect(weeklyToMonthly(cusum.delta_weekly_cents!)).toBeLessThan(500_000);
    expect(incidents.filter((i) => i.type === "BURN_RATE_SHIFT")).toHaveLength(0);
  });

  it("only emits OBSERVED and DETECTED evidence, built from computed numbers", () => {
    const { cusum } = scenario();
    const incidents = build();
    const incident = incidents.find((i) => i.type === "BURN_RATE_SHIFT")!;

    for (const item of incidents.flatMap((i) => i.evidence)) {
      expect(["OBSERVED", "DETECTED"]).toContain(item.kind);
      expect(EVIDENCE_KINDS).toContain(item.kind);
    }

    const observed = incident.evidence.filter((e) => e.kind === "OBSERVED");
    const detected = incident.evidence.filter((e) => e.kind === "DETECTED");
    const top = incident.contributors[0]!;

    expect(observed[0]!.text).toContain("aws");
    expect(observed[0]!.text).toContain(formatUsdWhole(top.pre_rate_weekly_cents));
    expect(observed[0]!.text).toContain(formatUsdWhole(top.post_rate_weekly_cents));
    expect(observed[0]!.text).toContain(cusum.estimated_change_point_week_start!);
    expect(detected).toHaveLength(1);
    expect(detected[0]!.text).toContain(cusum.alarm_week_start!);
    expect(detected[0]!.text).toContain(formatUsdWhole(cusum.k_cents));
    expect(detected[0]!.text).toContain(formatUsdWhole(cusum.h_cents));
    expect(detected[0]!.text).toContain(formatUsdWhole(cusum.sigma_cents));
    expect(detected[0]!.text).toContain(`baseline ${cusum.baseline_weeks} weeks`);
  });

  it("is deterministic, including ids", () => {
    expect(build()).toEqual(build());
  });
});

describe("incident dedup", () => {
  /**
   * No noise: every pre-change week sits exactly on the baseline median, so the
   * statistic is zero right up to the planted week and the estimated change
   * point lands on it exactly. That makes "drifted by one week" an exact
   * scenario rather than a property of one noise realization.
   */
  const FLAT: SeriesOptions = { noiseFraction: 0 };
  const at = (changeAt: number) => ({ ...FLAT, changeAt });

  it("lands the change point on the planted week when there is no noise", () => {
    const weeks = buildWeeks(at(DEMO.CHANGE_START_INDEX));
    const incident = build(at(DEMO.CHANGE_START_INDEX), { rows: [] })[0]!;

    expect(incident.estimated_change_point).toBe(weeks[DEMO.CHANGE_START_INDEX]!.week_start);
  });

  it("updates in place when the change point drifts inside the dedup window", () => {
    const stored: Incident = {
      ...build(at(DEMO.CHANGE_START_INDEX), { rows: [] }).find((i) => i.type === "BURN_RATE_SHIFT")!,
      status: "ACKNOWLEDGED",
      last_notified: NOTIFIED_AT,
    };
    const after = build(at(DEMO.CHANGE_START_INDEX + 1), { existing: [stored], now: LATER, rows: [] });
    const updated = after[0]!;

    expect(after).toHaveLength(1);
    expect(Math.abs(daysBetween(stored.estimated_change_point!, updated.estimated_change_point!)) / 7).toBe(1);
    expect(updated.id).toBe(stored.id);
    expect(updated.first_detected).toBe(stored.first_detected);
    expect(updated.status).toBe("ACKNOWLEDGED");
    expect(updated.last_notified).toBe(NOTIFIED_AT);
    expect(updated.last_updated).toBe(LATER);
    // Fresh numbers, not the stored ones.
    expect(updated.estimated_change_point).not.toBe(stored.estimated_change_point);
    expect(updated.detection.cusum).toEqual(scenario(at(DEMO.CHANGE_START_INDEX + 1)).cusum);
  });

  it("creates a second incident when the change point moves beyond the dedup window", () => {
    const stored = build(at(DEMO.CHANGE_START_INDEX), { rows: [] }).find((i) => i.type === "BURN_RATE_SHIFT")!;
    const far = DEMO.CHANGE_START_INDEX + INCIDENT_DEDUP_WEEKS + 2;
    const after = build(at(far), { existing: [stored], now: LATER, rows: [] });

    expect(Math.abs(daysBetween(stored.estimated_change_point!, after[1]!.estimated_change_point!)) / 7).toBeGreaterThan(INCIDENT_DEDUP_WEEKS);
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(stored);
    expect(after[1]!.id).not.toBe(stored.id);
    expect(after[1]!.first_detected).toBe(LATER);
  });

  it("keys one-off dedup on the transaction id", () => {
    const stored: Incident = {
      ...build().find((i) => i.type === "ONE_OFF_VENDOR_PAYMENT")!,
      status: "RESOLVED",
      last_notified: NOTIFIED_AT,
    };
    const after = build({}, { existing: [stored], now: LATER });
    const oneOffs = after.filter((i) => i.type === "ONE_OFF_VENDOR_PAYMENT");

    expect(oneOffs).toHaveLength(1);
    expect(oneOffs[0]!.id).toBe(stored.id);
    expect(oneOffs[0]!.status).toBe("RESOLVED");
    expect(oneOffs[0]!.last_updated).toBe(LATER);

    const secondPayment = [
      ...ONE_OFF_ROWS,
      makeTx({ id: "datadog_spike_2", date: "2026-09-08", amount_cents: -2_400_000, merchant_normalized: "datadog" }),
    ];
    const twoPayments = build({}, { existing: [stored], now: LATER, rows: secondPayment });
    const ids = twoPayments.filter((i) => i.type === "ONE_OFF_VENDOR_PAYMENT").map((i) => i.id);

    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(stored.id);
  });

  it("passes unmatched existing incidents through unchanged", () => {
    // Unrelated = a rate shift at a change point far outside the ±2-week dedup window.
    const unrelated: Incident = {
      ...build(at(DEMO.CHANGE_START_INDEX), { rows: [] }).find((i) => i.type === "BURN_RATE_SHIFT")!,
      id: "inc_deadbeef",
      entity: "gcp",
      estimated_change_point: "2025-11-03",
      status: "RESOLVED",
    };
    const after = build({}, { existing: [unrelated], now: LATER });

    expect(after[0]).toEqual(unrelated);
    expect(after).toHaveLength(3);
    expect(after.filter((i) => i.type === "BURN_RATE_SHIFT").map((i) => i.entity).sort()).toEqual(["aws", "gcp"]);
  });

  it("dedups a rate shift whose top contributor drifted (entity is not part of its identity)", () => {
    const stored: Incident = {
      ...build(at(DEMO.CHANGE_START_INDEX), { rows: [] }).find((i) => i.type === "BURN_RATE_SHIFT")!,
      id: "inc_drifted",
      entity: "datadog",
      status: "ACKNOWLEDGED",
    };
    const after = build({}, { existing: [stored], now: LATER });
    const shifts = after.filter((i) => i.type === "BURN_RATE_SHIFT");
    expect(shifts).toHaveLength(1);
    expect(shifts[0]!.id).toBe("inc_drifted");
    expect(shifts[0]!.entity).toBe("aws"); // refreshed to the current top contributor
    expect(shifts[0]!.status).toBe("ACKNOWLEDGED"); // lifecycle preserved
    expect(shifts[0]!.last_updated).toBe(LATER);
  });

  it("does not let one candidate claim two existing incidents", () => {
    const first = build(at(DEMO.CHANGE_START_INDEX), { rows: [] }).find((i) => i.type === "BURN_RATE_SHIFT")!;
    const nearDuplicate: Incident = { ...first, id: "inc_00000001" };
    const after = build(at(DEMO.CHANGE_START_INDEX), { existing: [first, nearDuplicate], now: LATER, rows: [] });

    expect(after).toHaveLength(2);
    expect(after.filter((i) => i.last_updated === LATER)).toHaveLength(1);
    expect(after[1]).toEqual(nearDuplicate);
  });
});
