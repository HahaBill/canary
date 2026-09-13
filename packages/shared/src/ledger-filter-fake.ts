/**
 * Test-only stand-in for the OpenAI ledger interpreter.
 *
 * It may only name merchants and categories that are on the catalog it is
 * given. Production never imports this — the Worker calls OpenAI with that
 * same catalog.
 */
import {
  LEDGER_SEARCH_UNMATCHED,
  type LedgerCatalog,
  type LedgerFilterProposal,
} from "./ledger-filter.ts";

function includesWord(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

/**
 * Scripted agent: exact catalog hits first, then a few intents that still
 * resolve only to keys present on *this* sheet (so "delivery" cannot invent
 * Meals if that category is not loaded).
 */
export function fakeLedgerProposer(query: string, catalog: LedgerCatalog): LedgerFilterProposal {
  const q = query.trim();
  if (!q) return {};
  const folded = q.toLowerCase();

  const merchantHits = catalog.merchants.filter(
    (merchant) => includesWord(folded, merchant.entity) || includesWord(folded, merchant.label.toLowerCase()),
  );

  const categoryHits = catalog.categories.filter(
    (category) =>
      includesWord(folded, category.label.toLowerCase()) ||
      includesWord(folded, category.key.toLowerCase().replace(/_/g, " ")),
  );

  const spec: LedgerFilterProposal = {};

  if (/\bafter (the )?(change|shift|regime)\b|\bpost[- ]change\b/i.test(q)) spec.post_change_only = true;
  if (/\bbefore (the )?(change|shift|regime)\b|\bpre[- ]change\b/i.test(q)) spec.pre_change_only = true;
  if (/\bneeds review\b|\buncategorized\b/i.test(q)) spec.flags = ["needs_review"];
  if (/\bone[- ]off\b|\brenewal\b/i.test(q)) spec.flags = [...(spec.flags ?? []), "one_off"];
  if (/\bincident\b|\bflagged\b|\balarm\b|\bcusum\b/i.test(q)) spec.has_incident = true;

  // Semantic intents — only if those rows exist on the catalog.
  const cloud = catalog.categories.find((category) => category.key === "CLOUD_INFRASTRUCTURE");
  if (cloud && /\bcloud\b/i.test(q)) spec.categories = uniqueKeys([...(spec.categories ?? []), cloud.key]);

  const meals = catalog.categories.find((category) => category.key === "MEALS");
  const mealMerchants = catalog.merchants.filter((merchant) => merchant.category === "MEALS");
  if (/\bdeliver(?:y|ies)\b|\bmeal/i.test(q)) {
    if (meals) spec.categories = uniqueKeys([...(spec.categories ?? []), meals.key]);
    else if (mealMerchants.length) spec.entities = uniqueKeys([...(spec.entities ?? []), ...mealMerchants.map((m) => m.entity)]);
  }

  if (merchantHits.length && !spec.categories?.length) {
    spec.entities = uniqueKeys(merchantHits.map((merchant) => merchant.entity));
  } else if (categoryHits.length && !spec.categories?.length) {
    spec.categories = uniqueKeys(categoryHits.map((category) => category.key));
  }

  if (
    !spec.entities?.length &&
    !spec.categories?.length &&
    !spec.sections?.length &&
    !spec.flags?.length &&
    !spec.has_incident &&
    !spec.post_change_only &&
    !spec.pre_change_only
  ) {
    return { unmatched: true, unmatched_reason: LEDGER_SEARCH_UNMATCHED };
  }
  return spec;
}

function uniqueKeys<T extends string>(values: T[]): T[] {
  return [...new Set(values)];
}
