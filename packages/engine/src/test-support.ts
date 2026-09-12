/**
 * Test-only helpers. Not exported from the package index and never used in a
 * production path — in particular `classificationsFromHints` reads
 * `category_hint`, which classification code must never do.
 */
import {
  SAMPLE_ACCOUNTS,
  SAMPLE_HISTORY_END,
  SAMPLE_HISTORY_START,
  SAMPLE_TRANSACTIONS,
} from "@canary/shared/fixtures";
import {
  addDays,
  weekStartsEndingAt,
  type BankAccount,
  type Cents,
  type ClassificationMap,
  type CompanyProfile,
  type ISODate,
  type Ledger,
  type Transaction,
  type WeeklyBucket,
} from "@canary/shared";
import { buildLedger } from "./ledger.ts";

export const SAMPLE_COMPANY: CompanyProfile = {
  name: "Sample Co",
  legal_name: "Sample Co, Inc.",
  description: "Engine unit-test fixture company.",
  stage: "Seed",
  headcount: 5,
  raised_cents: 0,
  bank_name: "Canary Sandbox Bank",
  as_of: SAMPLE_HISTORY_END,
  accounts: SAMPLE_ACCOUNTS,
};

/** Ground-truth classification map built from `category_hint`. Tests only. */
export function classificationsFromHints(
  transactions: Transaction[],
  omitIds: readonly string[] = [],
): ClassificationMap {
  const omit = new Set(omitIds);
  const map: ClassificationMap = {};
  for (const tx of transactions) {
    if (omit.has(tx.id) || tx.category_hint === undefined) continue;
    map[tx.id] = {
      transaction_id: tx.id,
      merchant_normalized: tx.merchant_normalized,
      category: tx.category_hint,
      method: "RULE",
      reason: "category_hint (test fixture)",
      supporting_signals: [{ source: "RULE", detail: "category_hint" }],
      confidence_level: "HIGH",
    };
  }
  return map;
}

export interface SampleLedgerOptions {
  transactions?: Transaction[];
  accounts?: BankAccount[];
  omitClassificationIds?: readonly string[];
  oneOffTransactionIds?: string[];
  historyStart?: ISODate;
  historyEnd?: ISODate;
}

export function buildSampleLedger(opts: SampleLedgerOptions = {}): Ledger {
  const transactions = opts.transactions ?? SAMPLE_TRANSACTIONS;
  const accounts = opts.accounts ?? SAMPLE_ACCOUNTS;
  return buildLedger({
    company: { ...SAMPLE_COMPANY, accounts },
    accounts,
    transactions,
    classifications: classificationsFromHints(transactions, opts.omitClassificationIds),
    oneOffTransactionIds: opts.oneOffTransactionIds,
    historyStart: opts.historyStart ?? SAMPLE_HISTORY_START,
    historyEnd: opts.historyEnd ?? SAMPLE_HISTORY_END,
  });
}

/** Minimal transaction builder with fixture defaults. */
export function tx(
  p: Omit<Transaction, "currency" | "source" | "tags" | "status"> &
    Partial<Pick<Transaction, "status" | "tags">>,
): Transaction {
  return { currency: "USD", source: "synthetic", status: "settled", tags: [], ...p };
}

export interface WeekSpec {
  variable?: Cents;
  fixed?: Cents;
  excluded?: Cents;
  inflow?: Cents;
  by_entity?: Record<string, Cents>;
}

/** Synthetic weekly series ending on `endDate`, for burn-window tests. */
export function makeWeeks(specs: WeekSpec[], endDate: ISODate = SAMPLE_HISTORY_END): WeeklyBucket[] {
  const starts = weekStartsEndingAt(endDate, specs.length);
  return starts.map((week_start, i) => {
    const s = specs[i]!;
    const variable = s.variable ?? 0;
    const fixed = s.fixed ?? 0;
    const excluded = s.excluded ?? 0;
    const inflow = s.inflow ?? 0;
    const total = variable + fixed + excluded;
    return {
      week_start,
      week_end: addDays(week_start, 6),
      week_index: i,
      variable_spend_cents: variable,
      fixed_spend_cents: fixed,
      excluded_from_monitoring_cents: excluded,
      total_operating_outflow_cents: total,
      operating_inflow_cents: inflow,
      net_burn_cents: total - inflow,
      variable_by_entity: s.by_entity ?? {},
      variable_by_category: {},
      transaction_count: 0,
    };
  });
}

/** A Ledger carrying only what `computeBurn` reads. */
export function makeLedger(weeks: WeeklyBucket[], accounts: BankAccount[] = SAMPLE_ACCOUNTS): Ledger {
  const first = weeks[0];
  const last = weeks[weeks.length - 1];
  return {
    company: { ...SAMPLE_COMPANY, accounts },
    accounts,
    transactions: [],
    weeks,
    reconciliation: {
      as_of: SAMPLE_HISTORY_END,
      opening_balance_cents: 0,
      opening_balance_reported: false,
      reported_closing_balance_cents: 0,
      computed_closing_balance_cents: 0,
      discrepancy_cents: 0,
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
    history_start: first ? first.week_start : SAMPLE_HISTORY_START,
    history_end: last ? last.week_end : SAMPLE_HISTORY_END,
  };
}
