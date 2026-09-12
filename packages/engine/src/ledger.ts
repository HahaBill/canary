/**
 * Reconciliation engine (PRD §8, contract §1/§3).
 *
 * Turns raw bank rows + a classification map into a `Ledger`: pending/settled
 * dedup, flow-type normalization, transfer and card-settlement pairing,
 * financing/refund/needs-review handling, cash reconciliation against the bank
 * anchor, and weekly buckets.
 *
 * Every stored figure is integer cents. Nothing here reads the clock or
 * randomness: same input → byte-identical output.
 */
import {
  compareISODate,
  weekEnd,
  weekStart,
  type AccountType,
  type BuildLedger,
  type BuildLedgerInput,
  type Category,
  type Cents,
  type ClassificationMethod,
  type FlowType,
  type ISODate,
  type Ledger,
  type LedgerTransaction,
  type ReconciliationReport,
  type Transaction,
  type TransactionTag,
} from "@canary/shared";
import { buildWeeklyBuckets } from "./buckets.ts";

/**
 * A refund inherits the vendor's category so it nets against that vendor's
 * spend, but never one of these — they are non-operating, revenue, or the
 * REFUND placeholder itself.
 */
const NON_INHERITABLE_REFUND_CATEGORIES: readonly Category[] = [
  "REFUND",
  "FINANCING",
  "INTERNAL_TRANSFER",
  "CARD_SETTLEMENT",
  "CUSTOMER_REVENUE",
];

/** Flow types that never contribute to operating burn. */
const NON_BURN_FLOW_TYPES: readonly FlowType[] = [
  "INTERNAL_TRANSFER",
  "CARD_SETTLEMENT",
  "FINANCING",
  "OPERATING_INFLOW",
];

interface WorkingRow {
  tx: Transaction;
  category: Category;
  method: ClassificationMethod;
  tags: TransactionTag[];
  dropped: boolean;
  excluded_reason?: string;
  counts_in_burn: boolean;
  counts_in_cash: boolean;
  account_type: AccountType | null;
}

function compareByDateThenId(a: Transaction, b: Transaction): number {
  const byDate = compareISODate(a.date, b.date);
  if (byDate !== 0) return byDate;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function addTag(tags: TransactionTag[], tag: TransactionTag): TransactionTag[] {
  return tags.includes(tag) ? tags : [...tags, tag];
}

export const buildLedger: BuildLedger = (input: BuildLedgerInput): Ledger => {
  const { company, accounts, transactions, classifications } = input;
  const warnings: string[] = [];

  const accountTypeById = new Map<string, AccountType>();
  for (const a of accounts) accountTypeById.set(a.id, a.type);

  const byId = new Map<string, Transaction>();
  for (const tx of transactions) {
    if (byId.has(tx.id)) warnings.push(`Duplicate transaction id ${tx.id}; last row wins.`);
    byId.set(tx.id, tx);
  }

  const ordered = [...transactions].sort(compareByDateThenId);

  // --- 1. Pending/settled dedup ------------------------------------------
  // A pending row referenced by another row's `pending_of` is superseded.
  const supersededBy = new Map<string, string>();
  for (const tx of ordered) {
    if (!tx.pending_of) continue;
    const target = byId.get(tx.pending_of);
    if (!target) {
      warnings.push(`Transaction ${tx.id} references unknown pending row ${tx.pending_of}.`);
      continue;
    }
    if (target.status !== "pending") {
      warnings.push(
        `Transaction ${tx.id} references ${tx.pending_of} via pending_of but that row is ${target.status}; not dropped.`,
      );
      continue;
    }
    const first = supersededBy.get(tx.pending_of);
    if (first === undefined) supersededBy.set(tx.pending_of, tx.id);
    else warnings.push(`Pending row ${tx.pending_of} is superseded by both ${first} and ${tx.id}.`);
  }

  const oneOffIds = new Set(input.oneOffTransactionIds ?? []);
  const unknownAccountIds = new Set<string>();

  // --- 2. Classification + 8. cash flags ---------------------------------
  const rows: WorkingRow[] = ordered.map((tx) => {
    const supersedingId = supersededBy.get(tx.id);
    const dropped = tx.status === "pending" && supersedingId !== undefined;

    const classified = classifications[tx.id];
    const base = classified ? { category: classified.category, method: classified.method } : null;
    let category: Category;
    switch (tx.flow_type) {
      case "INTERNAL_TRANSFER":
        category = "INTERNAL_TRANSFER";
        break;
      case "CARD_SETTLEMENT":
        category = "CARD_SETTLEMENT";
        break;
      case "FINANCING":
        category = "FINANCING";
        break;
      case "OPERATING_INFLOW":
        category = base && base.category !== "NEEDS_REVIEW" ? base.category : "CUSTOMER_REVENUE";
        break;
      case "REFUND":
        // Placeholder; the vendor's category is resolved in the pass below.
        category = "REFUND";
        break;
      default:
        category = base ? base.category : "NEEDS_REVIEW";
        break;
    }
    const method = resolveMethod(base, category, tx.flow_type);

    let tags: TransactionTag[] = [...tx.tags];
    if (oneOffIds.has(tx.id)) tags = addTag(tags, "one_off");

    const accountType = accountTypeById.get(tx.account_id) ?? null;
    if (accountType === null) unknownAccountIds.add(tx.account_id);

    return {
      tx,
      category,
      method,
      tags,
      dropped,
      excluded_reason: dropped
        ? `Pending row superseded by settled transaction ${supersedingId}.`
        : undefined,
      counts_in_burn: dropped ? false : !NON_BURN_FLOW_TYPES.includes(tx.flow_type),
      // Cash = checking + savings. Card-account rows move a liability, not cash.
      counts_in_cash: dropped ? false : accountType !== "card",
      account_type: accountType,
    };
  });

  for (const id of [...unknownAccountIds].sort()) {
    warnings.push(`Transactions reference unknown account ${id}; treated as a cash account.`);
  }

  // --- 2b. Refund category inheritance -----------------------------------
  for (const row of rows) {
    if (row.tx.flow_type !== "REFUND") continue;
    const inherited = findVendorCategory(rows, row);
    if (inherited !== null) {
      row.category = inherited;
      row.method = "RULE";
    }
  }

  // needs_review tagging follows the resolved category/method, not the input.
  for (const row of rows) {
    if (row.category === "NEEDS_REVIEW" || row.method === "NEEDS_REVIEW") {
      row.tags = addTag(row.tags, "needs_review");
    }
  }

  const live = rows.filter((r) => !r.dropped);

  // --- 3. Internal transfers ---------------------------------------------
  let internalTransferPairs = 0;
  let unpairedTransferLegs = 0;
  const transferGroups = new Map<string, WorkingRow[]>();
  for (const row of live) {
    if (row.tx.flow_type !== "INTERNAL_TRANSFER") continue;
    const key = row.tx.transfer_pair_id;
    if (!key) {
      unpairedTransferLegs += 1;
      warnings.push(`Internal transfer ${row.tx.id} has no transfer_pair_id.`);
      continue;
    }
    const group = transferGroups.get(key);
    if (group) group.push(row);
    else transferGroups.set(key, [row]);
  }
  for (const key of [...transferGroups.keys()].sort()) {
    const legs = transferGroups.get(key)!;
    const sum = legs.reduce((s, l) => s + l.tx.amount_cents, 0);
    if (legs.length === 2 && sum === 0) {
      internalTransferPairs += 1;
      continue;
    }
    unpairedTransferLegs += legs.length;
    if (legs.length !== 2) {
      warnings.push(`Internal transfer pair ${key} has ${legs.length} leg(s); expected 2.`);
    }
    if (sum !== 0) {
      warnings.push(`Internal transfer pair ${key} legs sum to ${sum} cents; expected 0.`);
    }
  }

  // --- 4. Card settlements ------------------------------------------------
  let cardSettlements = 0;
  let cardPurchasesCovered = 0;
  let unpairedSettlements = 0;
  const settlementLegs = new Map<string, WorkingRow[]>();
  const coveredPurchases = new Map<string, WorkingRow[]>();
  for (const row of live) {
    const key = row.tx.settlement_pair_id;
    if (!key) continue;
    const target = row.tx.flow_type === "CARD_SETTLEMENT" ? settlementLegs : coveredPurchases;
    const group = target.get(key);
    if (group) group.push(row);
    else target.set(key, [row]);
  }
  const settlementIds = [...new Set([...settlementLegs.keys(), ...coveredPurchases.keys()])].sort();
  for (const key of settlementIds) {
    const legs = settlementLegs.get(key) ?? [];
    const purchases = coveredPurchases.get(key) ?? [];
    if (legs.length === 0) {
      unpairedSettlements += 1;
      warnings.push(
        `${purchases.length} card purchase(s) reference settlement ${key} but no CARD_SETTLEMENT row exists.`,
      );
      continue;
    }
    cardSettlements += 1;
    cardPurchasesCovered += purchases.length;

    const cashLegs = legs.filter((l) => l.account_type !== "card");
    const cardLegs = legs.filter((l) => l.account_type === "card");
    if (cashLegs.length !== 1 || cardLegs.length !== 1) {
      unpairedSettlements += 1;
      warnings.push(
        `Card settlement ${key} has ${cashLegs.length} cash leg(s) and ${cardLegs.length} card leg(s); expected 1 and 1.`,
      );
    } else {
      const legSum = cashLegs[0]!.tx.amount_cents + cardLegs[0]!.tx.amount_cents;
      if (legSum !== 0) {
        unpairedSettlements += 1;
        warnings.push(`Card settlement ${key} legs sum to ${legSum} cents; expected 0.`);
      }
    }
    // The settlement must exactly cover the purchases it claims.
    const cashLeg = cashLegs[0];
    if (cashLeg) {
      const covered = purchases.reduce((s, p) => s + Math.abs(p.tx.amount_cents), 0);
      const expected = Math.abs(cashLeg.tx.amount_cents);
      if (covered !== expected) {
        warnings.push(
          `Card settlement ${key} covers ${covered} cents of purchases but its cash leg is ${expected} cents.`,
        );
      }
    }
  }

  // --- 5/6/7. Financing, refunds, needs review ---------------------------
  let financingNet = 0;
  let refundsNetted = 0;
  let needsReviewCount = 0;
  let needsReviewOutflow = 0;
  for (const row of live) {
    if (row.tx.flow_type === "FINANCING") financingNet += row.tx.amount_cents;
    if (row.tx.flow_type === "REFUND") refundsNetted += Math.abs(row.tx.amount_cents);
    if (row.tags.includes("needs_review")) {
      needsReviewCount += 1;
      if (row.tx.amount_cents < 0) needsReviewOutflow += -row.tx.amount_cents;
    }
  }

  // --- History span -------------------------------------------------------
  const dates = ordered.map((t) => t.date);
  const minDate = dates.length ? dates[0]! : company.as_of;
  const maxDate = dates.length ? dates[dates.length - 1]! : company.as_of;
  const historyStartNorm = weekStart(input.historyStart ?? minDate);
  const historyEndNorm = weekEnd(input.historyEnd ?? maxDate);
  for (const row of live) {
    if (
      compareISODate(row.tx.date, historyStartNorm) < 0 ||
      compareISODate(row.tx.date, historyEndNorm) > 0
    ) {
      warnings.push(
        `Transaction ${row.tx.id} dated ${row.tx.date} falls outside history ${historyStartNorm}..${historyEndNorm} and is excluded from weekly buckets.`,
      );
    }
  }

  const ledgerTransactions: LedgerTransaction[] = rows.map(toLedgerTransaction);
  const weeks = buildWeeklyBuckets(ledgerTransactions, historyStartNorm, historyEndNorm);

  // --- 9. Reconciliation --------------------------------------------------
  const nonCardAccounts = accounts.filter((a) => a.type !== "card");
  if (nonCardAccounts.length === 0) {
    warnings.push("No checking or savings account supplied; reported closing cash is 0.");
  }
  const reportedClosing = nonCardAccounts.reduce((s, a) => s + a.balance_cents, 0);
  const netCashMovement = ledgerTransactions
    .filter((t) => t.counts_in_cash)
    .reduce((s, t) => s + t.amount_cents, 0);
  const openingBalance = reportedClosing - netCashMovement;
  const computedClosing = openingBalance + netCashMovement;

  const asOf =
    nonCardAccounts.reduce<ISODate | null>(
      (acc, a) => (acc === null || compareISODate(a.as_of, acc) > 0 ? a.as_of : acc),
      null,
    ) ?? historyEndNorm;

  const reconciliation: ReconciliationReport = {
    as_of: asOf,
    opening_balance_cents: openingBalance,
    reported_closing_balance_cents: reportedClosing,
    computed_closing_balance_cents: computedClosing,
    matches: computedClosing === reportedClosing,
    internal_transfer_pairs: internalTransferPairs,
    unpaired_transfer_legs: unpairedTransferLegs,
    card_settlements: cardSettlements,
    card_purchases_covered: cardPurchasesCovered,
    unpaired_settlements: unpairedSettlements,
    pending_rows_dropped: rows.filter((r) => r.dropped).length,
    financing_net_cents: financingNet,
    refunds_netted_cents: refundsNetted,
    needs_review_count: needsReviewCount,
    needs_review_outflow_cents: needsReviewOutflow,
    warnings,
  };

  return {
    company,
    accounts,
    transactions: ledgerTransactions,
    weeks,
    reconciliation,
    history_start: historyStartNorm,
    history_end: historyEndNorm,
  };
};

/**
 * The classifier's method survives only where the flow-type rules kept its
 * category. Otherwise a deterministic rule decided it — an unclassified
 * operating outflow is the one case that is genuinely unknown.
 */
function resolveMethod(
  base: { category: Category; method: ClassificationMethod } | null,
  resolved: Category,
  flowType: FlowType,
): ClassificationMethod {
  if (base) return base.category === resolved ? base.method : "RULE";
  return flowType === "OPERATING_OUTFLOW" ? "NEEDS_REVIEW" : "RULE";
}

/**
 * The category of any other transaction for the same merchant, in (date, id)
 * order, so a refund nets against the bucket the vendor's spend landed in.
 */
function findVendorCategory(rows: WorkingRow[], refund: WorkingRow): Category | null {
  for (const candidate of rows) {
    if (candidate === refund) continue;
    if (candidate.tx.merchant_normalized !== refund.tx.merchant_normalized) continue;
    if (candidate.tx.flow_type === "REFUND") continue;
    if (NON_INHERITABLE_REFUND_CATEGORIES.includes(candidate.category)) continue;
    return candidate.category;
  }
  return null;
}

function toLedgerTransaction(row: WorkingRow): LedgerTransaction {
  return {
    ...row.tx,
    tags: row.tags,
    category: row.category,
    classification_method: row.method,
    counts_in_burn: row.counts_in_burn,
    counts_in_cash: row.counts_in_cash,
    dropped: row.dropped,
    excluded_reason: row.excluded_reason,
  };
}

export interface ClosingBalanceCheck {
  expected_opening_balance_cents: Cents;
  /** What the engine derived from the bank anchor. */
  derived_opening_balance_cents: Cents;
  /** Σ of `counts_in_cash` amounts. */
  net_cash_movement_cents: Cents;
  /** expected_opening + net_cash_movement. */
  computed_closing_balance_cents: Cents;
  reported_closing_balance_cents: Cents;
  matches: boolean;
  /** computed − reported. Zero when the identity holds. */
  difference_cents: Cents;
}

/**
 * Verify the reconciliation identity from a known opening balance instead of
 * deriving it from the closing anchor (contract §3, PRD §9). `buildLedger`
 * makes `matches` true by construction; this is the independent check for
 * callers that know the true opening balance (e.g. the generator fixture).
 */
export function verifyClosingBalance(
  ledger: Ledger,
  expectedOpeningCents: Cents,
): ClosingBalanceCheck {
  const netCashMovement = ledger.transactions
    .filter((t) => t.counts_in_cash)
    .reduce((s, t) => s + t.amount_cents, 0);
  const computed = expectedOpeningCents + netCashMovement;
  const reported = ledger.reconciliation.reported_closing_balance_cents;
  return {
    expected_opening_balance_cents: expectedOpeningCents,
    derived_opening_balance_cents: ledger.reconciliation.opening_balance_cents,
    net_cash_movement_cents: netCashMovement,
    computed_closing_balance_cents: computed,
    reported_closing_balance_cents: reported,
    matches: computed === reported,
    difference_cents: computed - reported,
  };
}
