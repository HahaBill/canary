/**
 * Weekly bucketing — the CUSUM input surface.
 *
 * One bucket per calendar week from `historyStart` to `historyEnd` inclusive,
 * zero-filled for weeks with no activity. Integer cents throughout.
 */
import {
  FIXED_CATEGORIES,
  addDays,
  weekEnd,
  weekIndexOf,
  weekStart,
  weekStartsEndingAt,
  type Category,
  type Cents,
  type ISODate,
  type LedgerTransaction,
  type WeeklyBucket,
} from "@canary/shared";

/** Tags that keep a row in burn but out of the monitored variable series. */
const MONITORING_EXCLUDED_TAGS = ["one_off", "annual_renewal"] as const;

function emptyBucket(week_start: ISODate, week_index: number): WeeklyBucket {
  return {
    week_start,
    week_end: addDays(week_start, 6),
    week_index,
    variable_spend_cents: 0,
    fixed_spend_cents: 0,
    excluded_from_monitoring_cents: 0,
    total_operating_outflow_cents: 0,
    operating_inflow_cents: 0,
    net_burn_cents: 0,
    variable_by_entity: {},
    variable_by_category: {},
    transaction_count: 0,
  };
}

/** Positive for spend, negative for refunds — transactions are signed the other way. */
function spendEffect(tx: LedgerTransaction): Cents {
  return -tx.amount_cents;
}

function isMonitoringExcluded(tx: LedgerTransaction): boolean {
  return MONITORING_EXCLUDED_TAGS.some((t) => tx.tags.includes(t));
}

/** Rebuild a record with sorted keys so output is byte-identical for any input order. */
function sortKeys<K extends string>(rec: Record<string, Cents>): Partial<Record<K, Cents>> {
  const out: Record<string, Cents> = {};
  for (const k of Object.keys(rec).sort()) out[k] = rec[k]!;
  return out as Partial<Record<K, Cents>>;
}

/**
 * Bucket ledger rows into calendar weeks.
 *
 * Only non-dropped rows are considered. `counts_in_burn` rows land in
 * fixed / excluded / variable (in that precedence order); OPERATING_INFLOW
 * rows land in `operating_inflow_cents`; every other non-burn row (transfers,
 * card settlements, financing) contributes nothing but is still counted in
 * `transaction_count`. Card purchases bucket by their own date, never by the
 * date of the settlement that covers them.
 *
 * `transaction_count` is the number of non-dropped rows dated inside the week.
 */
export function buildWeeklyBuckets(
  ledgerTransactions: LedgerTransaction[],
  historyStart: ISODate,
  historyEnd: ISODate,
): WeeklyBucket[] {
  const firstMonday = weekStart(historyStart);
  const lastSunday = weekEnd(historyEnd);
  const weekCount = weekIndexOf(lastSunday, firstMonday) + 1;
  if (weekCount < 1) return [];

  const starts = weekStartsEndingAt(lastSunday, weekCount);
  const buckets = starts.map((ws, i) => emptyBucket(ws, i));
  // Accumulate in plain records, then sort keys once per bucket.
  const entityAcc = buckets.map(() => ({}) as Record<string, Cents>);
  const categoryAcc = buckets.map(() => ({}) as Record<string, Cents>);

  for (const tx of ledgerTransactions) {
    if (tx.dropped) continue;
    const i = weekIndexOf(tx.date, firstMonday);
    const bucket = buckets[i];
    if (!bucket) continue;
    bucket.transaction_count += 1;

    if (tx.flow_type === "OPERATING_INFLOW") {
      bucket.operating_inflow_cents += tx.amount_cents;
      continue;
    }
    if (!tx.counts_in_burn) continue;

    const spend = spendEffect(tx);
    if (FIXED_CATEGORIES.includes(tx.category)) {
      bucket.fixed_spend_cents += spend;
    } else if (isMonitoringExcluded(tx)) {
      bucket.excluded_from_monitoring_cents += spend;
    } else {
      bucket.variable_spend_cents += spend;
      const entities = entityAcc[i]!;
      const categories = categoryAcc[i]!;
      entities[tx.merchant_normalized] = (entities[tx.merchant_normalized] ?? 0) + spend;
      categories[tx.category] = (categories[tx.category] ?? 0) + spend;
    }
  }

  return buckets.map((b, i) => ({
    ...b,
    total_operating_outflow_cents:
      b.variable_spend_cents + b.fixed_spend_cents + b.excluded_from_monitoring_cents,
    net_burn_cents:
      b.variable_spend_cents +
      b.fixed_spend_cents +
      b.excluded_from_monitoring_cents -
      b.operating_inflow_cents,
    variable_by_entity: sortKeys(entityAcc[i]!) as Record<string, Cents>,
    variable_by_category: sortKeys<Category>(categoryAcc[i]!),
  }));
}
