/**
 * Weekly variable-spend summary derived from `category_hint`.
 *
 * FOR GENERATOR SELF-VERIFICATION ONLY. `category_hint` is generator ground truth, so this
 * must never appear in the pipeline path — the engine builds the real series from
 * classified categories in `WeeklyBucket.variable_spend_cents`. This exists so the
 * generator can prove its own planted shift is detectable without depending on
 * @canary/engine or @canary/detectors.
 *
 * It reproduces the engine's bucketing rules for variable spend:
 *   - only categories in `VARIABLE_CATEGORIES`
 *   - pending rows superseded by a settled row are dropped
 *   - rows tagged `one_off` / `annual_renewal` are excluded from monitoring
 *   - refunds (positive amounts carrying the vendor's category) net against the week
 *   - card purchases bucket on their own date, not the settlement date
 */
import {
  VARIABLE_CATEGORIES,
  weekIndexOf,
  weekStart,
  type Cents,
  type ISODate,
  type Transaction,
} from "@canary/shared";

export interface SummarizeOptions {
  /** Monday of week 0. Defaults to the week containing the earliest transaction. */
  historyStart?: ISODate;
  /** Number of weeks to emit. Defaults to the span covered by the transactions. */
  weeks?: number;
  /** Transaction ids to leave out entirely (e.g. the planted, still-untagged one-off). */
  excludeIds?: Iterable<string>;
}

const EXCLUDED_TAGS = ["one_off", "annual_renewal"] as const;

export function summarizeWeeklyVariableSpend(txns: Transaction[], opts: SummarizeOptions = {}): Cents[] {
  if (txns.length === 0) return [];
  const excluded = new Set(opts.excludeIds ?? []);
  const superseded = new Set(txns.filter((t) => t.pending_of).map((t) => t.pending_of!));

  const monitored = txns.filter(
    (t) =>
      !excluded.has(t.id) &&
      !superseded.has(t.id) &&
      !t.tags.some((tag) => EXCLUDED_TAGS.includes(tag as (typeof EXCLUDED_TAGS)[number])) &&
      t.category_hint !== undefined &&
      VARIABLE_CATEGORIES.includes(t.category_hint),
  );

  const start = opts.historyStart ?? weekStart(txns.reduce((min, t) => (t.date < min ? t.date : min), txns[0]!.date));
  const lastIndex = txns.reduce((max, t) => Math.max(max, weekIndexOf(t.date, start)), 0);
  const weeks = opts.weeks ?? lastIndex + 1;

  const series = new Array<Cents>(weeks).fill(0);
  for (const t of monitored) {
    const i = weekIndexOf(t.date, start);
    if (i < 0 || i >= weeks) continue;
    // Outflows are negative, refunds positive → `-amount` accumulates a positive
    // magnitude and nets refunds in one step.
    series[i] = series[i]! - t.amount_cents;
  }
  return series;
}
