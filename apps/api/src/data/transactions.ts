/**
 * Ledger rows the conversational agent may list. Shared by the mock (weekly
 * vendor totals) and the pipeline (posted transactions) so the tool payload
 * is the same shape either way.
 */
import type { Category, Cents, ClassificationMap, DerivedDemoObject, ISODate, Transaction } from "@canary/shared";
import { CONVERSATION } from "@canary/shared";

export interface ListedTransaction {
  id: string;
  date: ISODate;
  entity: string;
  merchant_raw: string;
  description: string;
  amount_cents: Cents;
  category: Category | null;
  needs_review: boolean;
}

export interface TransactionListQuery {
  entity?: string;
  /** Additional merchant keys (from an interpreted ledger filter). */
  entities?: string[];
  categories?: Category[];
  from?: ISODate;
  to?: ISODate;
  needs_review?: boolean;
  limit?: number;
}

export interface TransactionSelection {
  matched: number;
  items: ListedTransaction[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function inRange(date: ISODate, from?: string, to?: string): boolean {
  if (from && ISO_DATE.test(from) && date < from) return false;
  if (to && ISO_DATE.test(to) && date > to) return false;
  return true;
}

export function selectTransactions(rows: readonly ListedTransaction[], query: TransactionListQuery = {}): TransactionSelection {
  const entities = [
    ...(query.entity ? [query.entity] : []),
    ...(query.entities ?? []),
  ];
  const entitySet = entities.length > 0 ? new Set(entities) : null;
  const categorySet = query.categories?.length ? new Set(query.categories) : null;

  const filtered = rows.filter((row) => {
    if (entitySet && !entitySet.has(row.entity)) return false;
    if (categorySet && (row.category === null || !categorySet.has(row.category))) return false;
    if (query.needs_review && !row.needs_review) return false;
    return inRange(row.date, query.from, query.to);
  });
  const newestFirst = [...filtered].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const cap = query.limit ?? CONVERSATION.MAX_LISTED_TRANSACTIONS;
  const limit = Math.min(Math.max(cap, 1), CONVERSATION.MAX_LISTED_TRANSACTIONS);
  return { matched: newestFirst.length, items: newestFirst.slice(0, limit) };
}

/** One row per vendor per week — the mock's finest grain. */
export function listFromWeeklyBuckets(derived: DerivedDemoObject): ListedTransaction[] {
  const categoryOf = new Map<string, Category>();
  for (const week of derived.weeks) {
    for (const [category, amount] of Object.entries(week.variable_by_category)) {
      if (!amount) continue;
      for (const [entity, entityAmount] of Object.entries(week.variable_by_entity)) {
        if (entityAmount === amount && !categoryOf.has(entity)) categoryOf.set(entity, category as Category);
      }
    }
  }

  const rows: ListedTransaction[] = derived.needs_review.items.map((item) => ({
    id: item.transaction_id,
    date: item.date,
    entity: item.merchant_normalized,
    merchant_raw: item.merchant_raw,
    description: item.reason,
    amount_cents: item.amount_cents,
    category: "NEEDS_REVIEW",
    needs_review: true,
  }));

  for (const week of derived.weeks) {
    for (const [entity, amount] of Object.entries(week.variable_by_entity)) {
      if (!amount) continue;
      rows.push({
        id: `week_${entity}_${week.week_start}`,
        date: week.week_start,
        entity,
        merchant_raw: entity.toUpperCase(),
        description: `Weekly ${entity} spend`,
        amount_cents: -amount,
        category: categoryOf.get(entity) ?? null,
        needs_review: false,
      });
    }
  }
  return rows;
}

/** Posted sandbox-bank rows, classified from the derived map (never `category_hint`). */
export function listFromPostedTransactions(transactions: readonly Transaction[], classifications: ClassificationMap): ListedTransaction[] {
  return transactions
    .filter((tx) => tx.status !== "pending")
    .map((tx) => {
      const classification = classifications[tx.id];
      const needsReview = tx.tags.includes("needs_review") || classification?.category === "NEEDS_REVIEW";
      return {
        id: tx.id,
        date: tx.date,
        entity: tx.merchant_normalized,
        merchant_raw: tx.merchant_raw,
        description: tx.description,
        amount_cents: tx.amount_cents,
        category: classification?.category ?? null,
        needs_review: needsReview,
      };
    });
}
