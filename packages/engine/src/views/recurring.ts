/**
 * Recurring-charge detection and projection (input to the cash calendar).
 *
 * Cadence comes from the observed gaps between a vendor's payment days —
 * nothing is assumed from the merchant name, and no model is asked. A series is
 * only projected when it is regular enough to be worth a founder's attention:
 * enough observations, a median gap that matches one of three cadences, and
 * most gaps close to it. `typical_amount_cents` is the MEDIAN, so one true-up
 * cannot inflate what Canary says to expect next month.
 *
 * These are ESTIMATEs in the evidence taxonomy: "expected · from history".
 */
import {
  addDays,
  compareISODate,
  daysBetween,
  median,
  type Category,
  type Cents,
  type ISODate,
  type LedgerTransaction,
  type ProjectRecurring,
  type RecurringSeries, RECURRING } from "@canary/shared";
import { addMonthsClamped, dayOfMonth } from "./periods.ts";

type Cadence = RecurringSeries["cadence"];

interface CadenceSpec {
  cadence: Cadence;
  /** Nominal period length in days. */
  days: number;
  /** Median-gap window that selects this cadence. */
  minMedianGap: number;
  maxMedianGap: number;
  /** How far an individual gap may sit from `days` and still count as on-cadence. */
  tolerance: number;
}

// All thresholds live in shared config (AGENTS.md rule: no hard-coded thresholds).
const CADENCES: readonly CadenceSpec[] = RECURRING.CADENCES;

const MONTHLY = CADENCES.find((c) => c.cadence === "monthly")!;

const MIN_ON_CADENCE_SHARE = RECURRING.MIN_ON_CADENCE_SHARE;
const DAY_OF_MONTH_TOLERANCE = RECURRING.DAY_OF_MONTH_TOLERANCE_DAYS;
const MIN_MONTHLY_FALLBACK_GAP = RECURRING.MIN_MONTHLY_FALLBACK_GAP_DAYS;
/** Guard against a pathological horizon; 5 years of weekly charges. */
const MAX_PROJECTED_DATES = 260;

interface Observation {
  date: ISODate;
  amount: Cents;
  category: Category;
}

export const projectRecurring: ProjectRecurring = (ledger, opts): RecurringSeries[] => {
  const minObservations = opts.minObservations ?? RECURRING.MIN_OBSERVATIONS;
  const byEntity = new Map<string, Observation[]>();

  for (const tx of ledger.transactions) {
    if (!isRecurringCandidate(tx)) continue;
    const list = byEntity.get(tx.merchant_normalized);
    if (list) list.push({ date: tx.date, amount: tx.amount_cents, category: tx.category });
    else byEntity.set(tx.merchant_normalized, [{ date: tx.date, amount: tx.amount_cents, category: tx.category }]);
  }

  const series: RecurringSeries[] = [];
  for (const entity of [...byEntity.keys()].sort()) {
    const detected = detectSeries(entity, byEntity.get(entity)!, ledger.history_end, opts.horizonEnd, minObservations);
    if (detected) series.push(detected);
  }

  // Biggest cash impact first; entity name breaks ties so the order is stable.
  return series.sort((a, b) => {
    const byAmount = Math.abs(b.typical_amount_cents) - Math.abs(a.typical_amount_cents);
    return byAmount !== 0 ? byAmount : a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0;
  });
};

/**
 * Operating spend and operating revenue recur; transfers, card settlements and
 * financing do not. A row tagged `one_off` is by definition not a recurrence —
 * dropping it also means a vendor whose only rows are one-offs never projects.
 */
function isRecurringCandidate(tx: LedgerTransaction): boolean {
  if (tx.dropped) return false;
  if (tx.tags.includes("one_off")) return false;
  return tx.counts_in_burn || tx.flow_type === "OPERATING_INFLOW";
}

function detectSeries(
  entity: string,
  observations: Observation[],
  historyEnd: ISODate,
  horizonEnd: ISODate,
  minObservations: number,
): RecurringSeries | null {
  const days = collapseToDays(observations);
  if (days.length < minObservations) return null;

  const dates = days.map((d) => d.date);
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1]!, dates[i]!));
  if (gaps.length === 0) return null;

  const spec = classifyCadence(dates, gaps);
  if (!spec) return null;
  const onCadence = gaps.filter((g) => Math.abs(g - spec.days) <= spec.tolerance).length;
  if (onCadence / gaps.length < MIN_ON_CADENCE_SHARE) return null;

  const lastSeen = dates[dates.length - 1]!;
  return {
    entity,
    category: dominantCategory(observations),
    cadence: spec.cadence,
    typical_amount_cents: Math.round(median(days.map((d) => d.amount))),
    observations: days.length,
    last_seen: lastSeen,
    next_dates: projectDates(spec.cadence, lastSeen, historyEnd, horizonEnd),
  };
}

/** One observation per day: two charges from the same vendor on one day are one event. */
function collapseToDays(observations: Observation[]): Array<{ date: ISODate; amount: Cents }> {
  const byDay = new Map<ISODate, Cents>();
  for (const o of observations) byDay.set(o.date, (byDay.get(o.date) ?? 0) + o.amount);
  return [...byDay.entries()]
    .map(([date, amount]) => ({ date, amount }))
    .sort((a, b) => compareISODate(a.date, b.date));
}

function classifyCadence(dates: ISODate[], gaps: number[]): CadenceSpec | null {
  const medianGap = median(gaps);
  for (const spec of CADENCES) {
    if (medianGap >= spec.minMedianGap && medianGap <= spec.maxMedianGap) return spec;
  }
  // "The 1st of every month" survives February and bank-holiday shifts even
  // when the median gap falls outside the monthly window.
  if (medianGap >= MIN_MONTHLY_FALLBACK_GAP && sameDayOfMonth(dates)) return MONTHLY;
  return null;
}

function sameDayOfMonth(dates: ISODate[]): boolean {
  const daysOfMonth = dates.map(dayOfMonth);
  const anchor = median(daysOfMonth);
  return daysOfMonth.every((d) => Math.abs(d - anchor) <= DAY_OF_MONTH_TOLERANCE);
}

/** Most frequent category for the entity; alphabetical on a tie. */
function dominantCategory(observations: Observation[]): Category {
  const counts = new Map<Category, number>();
  for (const o of observations) counts.set(o.category, (counts.get(o.category) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1))[0]![0];
}

/**
 * Step forward from the last observation. Dates inside history are stepped over
 * rather than emitted — a series that went quiet three weeks ago still projects
 * from its own cadence, not from a fabricated "now".
 */
function projectDates(cadence: Cadence, lastSeen: ISODate, historyEnd: ISODate, horizonEnd: ISODate): ISODate[] {
  const out: ISODate[] = [];
  const anchorDay = dayOfMonth(lastSeen);
  let cursor = lastSeen;
  for (let step = 1; step <= MAX_PROJECTED_DATES; step++) {
    cursor =
      cadence === "monthly"
        ? addMonthsClamped(lastSeen, step, anchorDay)
        : addDays(cursor, cadence === "weekly" ? 7 : 14);
    if (compareISODate(cursor, horizonEnd) > 0) break;
    if (compareISODate(cursor, historyEnd) > 0) out.push(cursor);
  }
  return out;
}