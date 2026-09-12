/**
 * Recurring-charge drift detector (PRD §29 P1, contract §10).
 *
 * The one-off detector answers "was this payment unusual?". This one answers a
 * different question: "is this vendor quietly charging us more every cycle?".
 * A subscription that creeps from $3,700 to $6,000 over five months never
 * produces a single anomalous payment — every individual charge looks normal
 * next to the one before it — so the vendor-relative one-off rule can never see
 * it. CUSUM sees the aggregate effect but attributes it to a week, not a bill.
 *
 * Same shape as `one-off.ts`: walk the ledger in date order, group by
 * `merchant_normalized`, use only that vendor's own history, return results
 * sparsely (a vendor billing a flat amount produces nothing).
 *
 * THE UNIT MATTERS. This detector speaks in dollars **per charge**, not per
 * week. Contributor decomposition already reports a weekly rate around the
 * CUSUM change point; reporting a second weekly number here would read as a
 * contradiction. "$3,783 -> $6,026 per charge" is a different, complementary
 * fact — and it is the one a founder can act on, because it is what the invoice
 * says.
 *
 * Charges tagged `one_off` or `annual_renewal` are excluded, exactly as they
 * are from the CUSUM monitoring series: a single planted spike must not read as
 * a trend. `needs_review` rows are kept — an unclassified charge is still a
 * charge, and PRD §4 says nothing falls through silently.
 *
 * Fixed categories are deliberately NOT excluded. Rent rising 40% is precisely
 * the kind of recurring drift a founder needs to hear about.
 */
import {
  daysBetween,
  median,
  weeklyToMonthly,
  type BurnSummary,
  type Cents,
  type ISODate,
  type Ledger,
  type LedgerTransaction,
  type MaterialityVerdict,
} from "@canary/shared";
import { evaluateRateMateriality } from "./materiality.ts";

/**
 * Detector-local until `packages/shared` accepts them (see
 * docs/ALFREDO-LOGIC-AUDIT.md §6). Every threshold still lives in exactly one
 * place and is named the way the config constants are.
 */
export const RECURRING_DRIFT = {
  /**
   * Fewest charges that can show a trend rather than a blip. Four means at
   * least two before and two after the midpoint, so no single invoice can move
   * both medians.
   */
  MIN_CHARGES: 4,
  /** Only consider charges this recent. One quarter is a billing-cycle horizon. */
  LOOKBACK_WEEKS: 26,
  /** PRD §29: "a subscription that creeps up 40% over 3 months". */
  MIN_INCREASE_FRACTION: 0.4,
  /**
   * A 40% rise on a $9 seat is 40% of nothing. The drift must also be worth at
   * least this much a month before Canary says it out loud.
   */
  MIN_MONTHLY_DELTA_CENTS: 100_000,
} as const;

export interface RecurringDriftResult {
  entity: string;
  /** Charges inside the lookback that the comparison used. */
  charge_count: number;
  first_charge_date: ISODate;
  last_charge_date: ISODate;
  /** Median of the earlier half of the charges. Positive magnitude. */
  early_median_cents: Cents;
  /** Median of the later half. Positive magnitude. */
  late_median_cents: Cents;
  /** late − early. Positive when the vendor is charging more. */
  delta_per_charge_cents: Cents;
  /** delta / early. 0.4 = "40% more per charge". */
  increase_fraction: number;
  /** Observed cadence, used only to express the drift as a monthly figure. */
  charges_per_week: number;
  /** delta_per_charge × cadence, monthlyized. What the drift costs per month. */
  estimated_monthly_delta_cents: Cents;
  is_drifting: boolean;
  materiality: MaterialityVerdict;
}

export type DetectRecurringDrift = (ledger: Ledger, burn: BurnSummary) => RecurringDriftResult[];

export const detectRecurringDrift: DetectRecurringDrift = (ledger, burn) => {
  const cutoff = lookbackStart(ledger);
  const charges = ledger.transactions.filter((tx) => isRecurringCharge(tx, cutoff)).sort(byDateThenId);

  const byEntity = new Map<string, LedgerTransaction[]>();
  for (const tx of charges) {
    const group = byEntity.get(tx.merchant_normalized);
    if (group) group.push(tx);
    else byEntity.set(tx.merchant_normalized, [tx]);
  }

  const results: RecurringDriftResult[] = [];
  for (const group of byEntity.values()) {
    const result = evaluateVendor(group, burn);
    if (result) results.push(result);
  }

  // Largest drift first, then entity, so the order is total and stable.
  return results.sort((a, b) => b.delta_per_charge_cents - a.delta_per_charge_cents || (a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0));
};

/** Returns a result only when the vendor is actually drifting upward. */
function evaluateVendor(group: LedgerTransaction[], burn: BurnSummary): RecurringDriftResult | null {
  if (group.length < RECURRING_DRIFT.MIN_CHARGES) return null;

  const amounts = group.map((tx) => Math.abs(tx.amount_cents));
  const split = Math.floor(amounts.length / 2);
  const earlyMedian = Math.round(median(amounts.slice(0, split)));
  const lateMedian = Math.round(median(amounts.slice(split)));
  // A vendor that billed nothing has no rate to rise from.
  if (earlyMedian <= 0) return null;

  const deltaPerCharge = lateMedian - earlyMedian;
  const increaseFraction = deltaPerCharge / earlyMedian;

  const firstDate = group[0]!.date;
  const lastDate = group[group.length - 1]!.date;
  const spanWeeks = daysBetween(firstDate, lastDate) / 7;
  // Same-day charges are not a cadence; without a span there is no rate.
  if (spanWeeks <= 0) return null;

  const chargesPerWeek = (group.length - 1) / spanWeeks;
  const estimatedMonthlyDelta = weeklyToMonthly(Math.round(deltaPerCharge * chargesPerWeek));

  const isDrifting =
    increaseFraction >= RECURRING_DRIFT.MIN_INCREASE_FRACTION &&
    estimatedMonthlyDelta >= RECURRING_DRIFT.MIN_MONTHLY_DELTA_CENTS;
  if (!isDrifting) return null;

  return {
    entity: group[0]!.merchant_normalized,
    charge_count: group.length,
    first_charge_date: firstDate,
    last_charge_date: lastDate,
    early_median_cents: earlyMedian,
    late_median_cents: lateMedian,
    delta_per_charge_cents: deltaPerCharge,
    increase_fraction: Math.round(increaseFraction * 1000) / 1000,
    charges_per_week: Math.round(chargesPerWeek * 1000) / 1000,
    estimated_monthly_delta_cents: estimatedMonthlyDelta,
    is_drifting: true,
    // Reuses the rate-change rules so a drift is judged on the same scale as a
    // CUSUM shift. A drift below these thresholds is still returned — it just
    // never justifies interrupting anyone on its own.
    materiality: driftMateriality(estimatedMonthlyDelta, burn),
  };
}

/**
 * Rate materiality expects a weekly delta and two burn summaries. A drift has
 * no before/after runway of its own, so both sides are the current burn: only
 * the absolute and share-of-burn rules can fire, never the runway rule.
 */
function driftMateriality(estimatedMonthlyDelta: Cents, burn: BurnSummary): MaterialityVerdict {
  const weekly = Math.round(estimatedMonthlyDelta / (52 / 12));
  return evaluateRateMateriality(weekly, burn, burn);
}

/** The earliest date still inside the lookback window. */
function lookbackStart(ledger: Ledger): ISODate {
  const end = ledger.history_end;
  const start = ledger.history_start;
  const cutoffDays = RECURRING_DRIFT.LOOKBACK_WEEKS * 7;
  return daysBetween(start, end) <= cutoffDays ? start : shiftDays(end, -cutoffDays);
}

function shiftDays(date: ISODate, days: number): ISODate {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Settled operating outflows only, inside the lookback. Refunds are excluded
 * (an inflow against a vendor would drag a median down and hide a real rise),
 * as are one-offs and annual renewals — the same rows the engine keeps out of
 * the CUSUM monitoring series.
 */
function isRecurringCharge(tx: LedgerTransaction, cutoff: ISODate): boolean {
  if (tx.dropped || !tx.counts_in_burn || tx.flow_type !== "OPERATING_OUTFLOW") return false;
  if (tx.date < cutoff) return false;
  if (tx.tags.includes("one_off") || tx.tags.includes("annual_renewal")) return false;
  return tx.amount_cents < 0;
}

function byDateThenId(a: LedgerTransaction, b: LedgerTransaction): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
