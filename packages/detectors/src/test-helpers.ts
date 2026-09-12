/**
 * Synthetic inputs for the detector tests. Not exported from the package.
 *
 * These build `WeeklyBucket` / `Ledger` / `BurnSummary` values by hand so the
 * tests never depend on @canary/generator or @canary/engine. Every figure here
 * is a test fixture — it must never reach the UI.
 */
import {
  COMPANY,
  DEMO,
  SANDBOX_ACCOUNTS,
  addDays,
  weekStartsEndingAt,
  weeklyToMonthly,
  type BurnSummary,
  type Category,
  type Cents,
  type ISODate,
  type Ledger,
  type LedgerTransaction,
  type WeeklyBucket,
} from "@canary/shared";

export const ENTITY_CATEGORIES: Record<string, Category> = {
  aws: "CLOUD_INFRASTRUCTURE",
  datadog: "SAAS_SOFTWARE",
  figma: "SAAS_SOFTWARE",
  ashby: "RECRUITING",
  upwork: "CONTRACTORS",
  doordash: "MEALS",
};

/** Baseline weekly variable spend per entity: $7,650/week in total. */
export const BASE_WEEKLY: Record<string, Cents> = {
  aws: 420_000,
  datadog: 55_000,
  ashby: 40_000,
  upwork: 250_000,
};

/** Post-change increment per entity: +$3,150/week, mostly aws. */
export const STEP_WEEKLY: Record<string, Cents> = {
  aws: 260_000,
  datadog: 30_000,
  ashby: 25_000,
};

export interface SeriesOptions {
  weeks?: number;
  endDate?: ISODate;
  /** First week of the new regime. `null` for a flat series. */
  changeAt?: number | null;
  /** Weeks over which the step ramps in. 1 = instant. */
  rampWeeks?: number;
  base?: Record<string, Cents>;
  step?: Record<string, Cents>;
  /** Deterministic noise amplitude as a fraction of each entity's baseline. */
  noiseFraction?: number;
  fixedCents?: Cents;
  inflowCents?: Cents;
  /** A single large week. `excluded` puts it where the engine puts a tagged one-off. */
  spike?: { index: number; amount: Cents; entity?: string; excluded?: boolean };
}

/**
 * A weekly series with an optional sustained step. `variable_by_entity` always
 * sums exactly to `variable_spend_cents`, as the engine guarantees.
 */
export function buildWeeks(options: SeriesOptions = {}): WeeklyBucket[] {
  const {
    weeks = DEMO.WEEKS,
    endDate = DEMO.END_DATE,
    changeAt = DEMO.CHANGE_START_INDEX,
    rampWeeks = 1,
    base = BASE_WEEKLY,
    step = STEP_WEEKLY,
    noiseFraction = 0.03,
    fixedCents = 3_000_000,
    inflowCents = 0,
    spike,
  } = options;

  const entities = [...new Set([...Object.keys(base), ...Object.keys(step)])].sort();

  return weekStartsEndingAt(endDate, weeks).map((week_start, index) => {
    const ramp = changeAt === null ? 0 : clamp01((index - changeAt + 1) / Math.max(1, rampWeeks));

    const variable_by_entity: Record<string, Cents> = {};
    for (let e = 0; e < entities.length; e++) {
      const entity = entities[e]!;
      const level = (base[entity] ?? 0) + Math.round(ramp * (step[entity] ?? 0));
      variable_by_entity[entity] = level + jitter(index, e, Math.round(noiseFraction * (base[entity] ?? 0)));
    }

    let excluded = 0;
    if (spike && spike.index === index) {
      if (spike.excluded) excluded = spike.amount;
      else {
        const entity = spike.entity ?? entities[0]!;
        variable_by_entity[entity] = (variable_by_entity[entity] ?? 0) + spike.amount;
      }
    }

    const variable = Object.values(variable_by_entity).reduce((a, b) => a + b, 0);
    const variable_by_category: Partial<Record<Category, Cents>> = {};
    for (const [entity, cents] of Object.entries(variable_by_entity)) {
      const category = ENTITY_CATEGORIES[entity] ?? "NEEDS_REVIEW";
      variable_by_category[category] = (variable_by_category[category] ?? 0) + cents;
    }

    const total = variable + fixedCents + excluded;
    return {
      week_start,
      week_end: addDays(week_start, 6),
      week_index: index,
      variable_spend_cents: variable,
      fixed_spend_cents: fixedCents,
      excluded_from_monitoring_cents: excluded,
      total_operating_outflow_cents: total,
      operating_inflow_cents: inflowCents,
      net_burn_cents: total - inflowCents,
      variable_by_entity,
      variable_by_category,
      transaction_count: entities.length,
    };
  });
}

/** Deterministic pseudo-noise in [-amplitude, amplitude]. */
function jitter(index: number, salt: number, amplitude: Cents): Cents {
  if (amplitude === 0) return 0;
  const hash = Math.imul((index + 1) ^ Math.imul(salt + 1, 0x9e3779b9), 0x85ebca6b) >>> 0;
  return Math.round(((hash % 2001) / 1000 - 1) * amplitude);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

type TxSeed = Pick<LedgerTransaction, "id" | "date" | "amount_cents" | "merchant_normalized"> & Partial<LedgerTransaction>;

export function makeTx(seed: TxSeed): LedgerTransaction {
  return {
    account_id: "chk",
    currency: "USD",
    merchant_raw: seed.merchant_normalized.toUpperCase(),
    description: "",
    flow_type: "OPERATING_OUTFLOW",
    status: "settled",
    source: "synthetic",
    tags: [],
    category: ENTITY_CATEGORIES[seed.merchant_normalized] ?? "NEEDS_REVIEW",
    classification_method: "RULE",
    counts_in_burn: true,
    counts_in_cash: true,
    dropped: false,
    ...seed,
  };
}

/** `n` payments to one vendor, one week apart, ending the day before `before`. */
export function priorPayments(entity: string, amounts: Cents[], firstDate: ISODate): LedgerTransaction[] {
  return amounts.map((amount, i) =>
    makeTx({
      id: `${entity}_prior_${i}`,
      date: addDays(firstDate, i * 7),
      amount_cents: -Math.abs(amount),
      merchant_normalized: entity,
    }),
  );
}

export function makeLedger(transactions: LedgerTransaction[], weeks: WeeklyBucket[] = []): Ledger {
  const dates = transactions.map((t) => t.date).sort();
  return {
    company: COMPANY,
    accounts: SANDBOX_ACCOUNTS,
    transactions,
    weeks,
    reconciliation: {
      as_of: dates[dates.length - 1] ?? DEMO.END_DATE,
      opening_balance_cents: 0,
      reported_closing_balance_cents: 0,
      computed_closing_balance_cents: 0,
      matches: true,
      internal_transfer_pairs: 0,
      unpaired_transfer_legs: 0,
      card_settlements: 0,
      card_purchases_covered: 0,
      unpaired_settlements: 0,
      pending_rows_dropped: 0,
      financing_net_cents: 0,
      refunds_netted_cents: 0,
      needs_review_count: 0,
      needs_review_outflow_cents: 0,
      warnings: [],
    },
    history_start: weeks[0]?.week_start ?? dates[0] ?? DEMO.END_DATE,
    history_end: weeks[weeks.length - 1]?.week_end ?? dates[dates.length - 1] ?? DEMO.END_DATE,
  };
}

/**
 * A BurnSummary with plausible defaults: $100K/month gross, $80K/month net,
 * $2.0M cash → 25.0 months of runway. Tests override what they exercise.
 */
export function makeBurn(overrides: Partial<BurnSummary> = {}): BurnSummary {
  const weeklyGross = 2_307_692;
  const weeklyInflow = 461_538;
  const weeklyNet = weeklyGross - weeklyInflow;
  return {
    burn_window_start: "2026-07-20",
    burn_window_end: DEMO.END_DATE,
    burn_window_reason: "TRAILING_DEFAULT",
    weeks_in_window: 8,
    weekly_gross_burn_cents: weeklyGross,
    weekly_operating_inflow_cents: weeklyInflow,
    weekly_net_burn_cents: weeklyNet,
    weekly_variable_spend_cents: 765_000,
    weekly_fixed_spend_cents: 1_542_692,
    monthly_gross_burn_cents: weeklyToMonthly(weeklyGross),
    monthly_net_burn_cents: weeklyToMonthly(weeklyNet),
    available_operating_cash_cents: 200_000_000,
    runway_months: 25,
    weekly_variable_by_entity: { ...BASE_WEEKLY },
    ...overrides,
  };
}
