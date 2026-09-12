/**
 * The classification pipeline (PRD §10):
 *
 *   deterministic rules → OpenAI → Tavily corroboration → Needs Review
 *
 * Two invariants hold everywhere in this file:
 *
 *  1. **Confidence comes from agreement, never from the model.** RULE is HIGH;
 *     OpenAI + Tavily agreeing is HIGH; OpenAI alone is MEDIUM; disagreement or
 *     silence is LOW and the category becomes NEEDS_REVIEW. No LLM-reported
 *     confidence number is ever read.
 *  2. **Nothing falls through silently.** Every merchant gets a category, every
 *     signal that was consulted is recorded in `supporting_signals`, and
 *     NEEDS_REVIEW amounts still count in cash and burn downstream.
 *
 * Work is done once per (merchant, flow type) group: at most one LLM call and
 * one research call per merchant, cache checked first.
 */
import {
  CATEGORIES,
  FLOW_TYPES,
  NON_OPERATING_CATEGORIES,
  formatUsd,
  median,
  sumCents,
  type Category,
  type Cents,
  type Classification,
  type ClassificationMap,
  type ClassifyOptions,
  type ClassifyResult,
  type ClassifyTransactions,
  type ConfidenceLevel,
  type EnrichmentCache,
  type FlowType,
  type LlmProvider,
  type ResearchProvider,
  type SupportingSignal,
  type Transaction,
  type VendorEnrichment,
} from "@canary/shared";
import { truncate } from "./http.ts";
import { mapBusinessTypeToCategory } from "./business-type.ts";
import { matchFlowTypeRule, matchMerchantRule } from "./rules.ts";

/**
 * Categories the model may propose. Non-operating categories plus REFUND and
 * CUSTOMER_REVENUE are decided by flow type, and NEEDS_REVIEW is our verdict
 * about the evidence — not something a model is allowed to self-declare.
 */
export const LLM_ALLOWED_CATEGORIES: readonly Category[] = CATEGORIES.filter(
  (category) =>
    !(NON_OPERATING_CATEGORIES as readonly Category[]).includes(category) &&
    category !== "NEEDS_REVIEW" &&
    category !== "REFUND" &&
    category !== "CUSTOMER_REVENUE",
);

/** `by_merchant` reports the vendor decision, so the operating outflow wins over a refund leg. */
const FLOW_PRIORITY: readonly FlowType[] = ["OPERATING_OUTFLOW", ...FLOW_TYPES.filter((f) => f !== "OPERATING_OUTFLOW")];

interface MerchantGroup {
  merchant_normalized: string;
  flow_type: FlowType;
  transactions: Transaction[];
}

interface Decision {
  category: Category;
  method: Classification["method"];
  confidence_level: ConfidenceLevel;
  reason: string;
  supporting_signals: SupportingSignal[];
  enrichment: VendorEnrichment | null;
}

function groupTransactions(transactions: readonly Transaction[]): MerchantGroup[] {
  const groups = new Map<string, MerchantGroup>();
  for (const tx of transactions) {
    const key = `${tx.merchant_normalized}\u0000${tx.flow_type}`;
    const existing = groups.get(key);
    if (existing) existing.transactions.push(tx);
    else groups.set(key, { merchant_normalized: tx.merchant_normalized, flow_type: tx.flow_type, transactions: [tx] });
  }
  // Sorted so a batch always produces byte-identical output.
  return [...groups.values()].sort(
    (a, b) =>
      a.merchant_normalized.localeCompare(b.merchant_normalized) ||
      FLOW_TYPES.indexOf(a.flow_type) - FLOW_TYPES.indexOf(b.flow_type),
  );
}

/** Largest single payment in the group — what the research amount gate is measured against. */
function largestAbsAmount(group: MerchantGroup): Cents {
  return group.transactions.reduce((max, tx) => Math.max(max, Math.abs(tx.amount_cents)), 0);
}

/** Deterministic prose for the model's prompt. Amounts are inputs, never model output. */
export function summarizeMerchantHistory(transactions: readonly Transaction[]): string {
  if (transactions.length === 0) return "no prior payments";
  const amounts = transactions.map((tx) => Math.abs(tx.amount_cents));
  const dates = transactions.map((tx) => tx.date).sort();
  const count = transactions.length;
  return [
    `${count} payment${count === 1 ? "" : "s"}`,
    `median ${formatUsd(Math.round(median(amounts)))}`,
    `total ${formatUsd(sumCents(amounts))}`,
    `first ${dates[0]}`,
    `last ${dates[dates.length - 1]}`,
  ].join(", ");
}

/** A cached enrichment may pre-date today's keyword table, so re-map when the stored category is the sentinel. */
function researchCategoryOf(enrichment: VendorEnrichment | null): Category | null {
  if (enrichment === null) return null;
  if (enrichment.mapped_category !== "NEEDS_REVIEW") return enrichment.mapped_category;
  return mapBusinessTypeToCategory(enrichment.business_type);
}

function errorMessage(error: unknown): string {
  return truncate(error instanceof Error ? error.message : String(error), 160);
}

interface PipelineContext {
  llm?: LlmProvider | undefined;
  research?: ResearchProvider | undefined;
  cache?: EnrichmentCache | undefined;
  minAmountForResearchCents: Cents;
}

async function decideGroup(group: MerchantGroup, ctx: PipelineContext): Promise<Decision> {
  const representative = group.transactions[0]!;

  // 1. Flow type is a structural fact from the bank.
  const flowCategory = matchFlowTypeRule(group.flow_type);
  if (flowCategory !== null) {
    return {
      category: flowCategory,
      method: "RULE",
      confidence_level: "HIGH",
      reason: `Flow type ${group.flow_type} maps directly to ${flowCategory}.`,
      supporting_signals: [
        {
          source: "FLOW_TYPE",
          detail: `Bank flow type ${group.flow_type} is classified as ${flowCategory}.`,
          proposed_category: flowCategory,
        },
      ],
      enrichment: null,
    };
  }

  // 2. Deterministic merchant table.
  const rule = matchMerchantRule(representative.merchant_raw, group.merchant_normalized);
  if (rule !== null) {
    return {
      category: rule.category,
      method: "RULE",
      confidence_level: "HIGH",
      reason: `Merchant rule "${rule.id}" matched ${rule.category}.`,
      supporting_signals: [
        {
          source: "RULE",
          detail: `Merchant rule "${rule.id}" (${String(rule.pattern)}) matched the bank descriptor.`,
          proposed_category: rule.category,
        },
      ],
      enrichment: null,
    };
  }

  // 3. Unknown merchant → model + external corroboration.
  const signals: SupportingSignal[] = [
    { source: "RULE", detail: `No deterministic rule matched "${group.merchant_normalized}".` },
  ];

  const needsReview = (reason: string): Decision => ({
    category: "NEEDS_REVIEW",
    method: "NEEDS_REVIEW",
    confidence_level: "LOW",
    reason,
    supporting_signals: signals,
    enrichment: null,
  });

  if (ctx.llm === undefined && ctx.research === undefined) {
    return needsReview("No deterministic rule matched and no classification providers were configured. Left as Needs Review.");
  }

  const largest = largestAbsAmount(group);
  if (largest < ctx.minAmountForResearchCents) {
    return needsReview(
      `No deterministic rule matched and the largest payment is below the research threshold of ${formatUsd(ctx.minAmountForResearchCents)}. Left as Needs Review.`,
    );
  }

  const historySummary = summarizeMerchantHistory(group.transactions);

  let llmCategory: Category | null = null;
  let llmReason = "";
  if (ctx.llm !== undefined) {
    const largestTx = group.transactions.reduce((a, b) => (Math.abs(b.amount_cents) > Math.abs(a.amount_cents) ? b : a));
    const description = group.transactions.find((tx) => tx.description.trim() !== "")?.description ?? "";
    try {
      const proposal = await ctx.llm.proposeCategory({
        merchant_raw: representative.merchant_raw,
        merchant_normalized: group.merchant_normalized,
        description,
        amount_cents: largestTx.amount_cents,
        history_summary: historySummary,
        allowed_categories: LLM_ALLOWED_CATEGORIES,
      });
      // Defensive: a third-party provider may not enforce the allowed list itself.
      if (LLM_ALLOWED_CATEGORIES.includes(proposal.category)) {
        llmCategory = proposal.category;
        llmReason = proposal.reason.trim();
        signals.push({
          source: "OPENAI",
          detail: `${ctx.llm.name}: ${llmReason || `proposed ${proposal.category}`}`,
          proposed_category: proposal.category,
        });
      } else {
        signals.push({
          source: "OPENAI",
          detail: `${ctx.llm.name} proposed a category outside the allowed list and was discarded.`,
        });
      }
    } catch (error) {
      signals.push({ source: "OPENAI", detail: `${ctx.llm.name} did not answer: ${errorMessage(error)}` });
    }
  }

  // Cache first: the demo must not depend on a live search at showtime.
  let enrichment: VendorEnrichment | null = null;
  if (ctx.cache !== undefined) {
    try {
      enrichment = await ctx.cache.get(group.merchant_normalized);
    } catch (error) {
      signals.push({ source: "TAVILY", detail: `enrichment cache read failed: ${errorMessage(error)}` });
    }
  }
  const fromCache = enrichment !== null;

  if (enrichment === null && ctx.research !== undefined) {
    try {
      enrichment = await ctx.research.enrichVendor({
        merchant_raw: representative.merchant_raw,
        merchant_normalized: group.merchant_normalized,
      });
      if (enrichment === null) {
        signals.push({ source: "TAVILY", detail: `${ctx.research.name} found no indexed result for "${group.merchant_normalized}".` });
      } else if (ctx.cache !== undefined) {
        try {
          await ctx.cache.set(enrichment);
        } catch {
          // A cache write failure must not change the classification.
        }
      }
    } catch (error) {
      signals.push({ source: "TAVILY", detail: `${ctx.research.name} lookup failed: ${errorMessage(error)}` });
    }
  }

  const researchCategory = researchCategoryOf(enrichment);
  if (enrichment !== null) {
    signals.push({
      source: "TAVILY",
      detail: `${enrichment.business_type}${fromCache ? " (previously retrieved)" : ""}`,
      ...(researchCategory === null ? {} : { proposed_category: researchCategory }),
      url: enrichment.source_url,
    });
  }

  // 4. Confidence from agreement.
  if (llmCategory !== null && researchCategory !== null) {
    if (llmCategory === researchCategory) {
      return {
        category: llmCategory,
        method: "LLM_CORROBORATED",
        confidence_level: "HIGH",
        reason: `OpenAI proposed ${llmCategory}${llmReason ? ` (${llmReason})` : ""} and external research describing this vendor as "${enrichment!.business_type}" mapped to the same category.`,
        supporting_signals: signals,
        enrichment,
      };
    }
    return {
      category: "NEEDS_REVIEW",
      method: "NEEDS_REVIEW",
      confidence_level: "LOW",
      reason: `Signals disagreed: OpenAI proposed ${llmCategory}, external research ("${enrichment!.business_type}") mapped to ${researchCategory}. Left as Needs Review.`,
      supporting_signals: signals,
      enrichment,
    };
  }

  if (llmCategory !== null) {
    return {
      category: llmCategory,
      method: "LLM_ONLY",
      confidence_level: "MEDIUM",
      reason: `OpenAI proposed ${llmCategory}${llmReason ? ` (${llmReason})` : ""}; no external corroboration was available, so confidence is capped at medium.`,
      supporting_signals: signals,
      enrichment,
    };
  }

  if (researchCategory !== null) {
    return {
      category: "NEEDS_REVIEW",
      method: "NEEDS_REVIEW",
      confidence_level: "LOW",
      reason: `Only external research answered ("${enrichment!.business_type}" → ${researchCategory}); one signal is not enough to classify. Left as Needs Review.`,
      supporting_signals: signals,
      enrichment,
    };
  }

  return {
    ...needsReview("No deterministic rule matched and no signal identified this merchant. Left as Needs Review."),
    enrichment,
  };
}

/**
 * Classifies a batch of transactions. Async because the unknown-merchant path
 * may call OpenAI and Tavily; with no providers configured it never touches
 * the network and every unknown merchant becomes NEEDS_REVIEW.
 */
export const classifyTransactions: ClassifyTransactions = async (
  transactions: Transaction[],
  opts: ClassifyOptions = {},
): Promise<ClassifyResult> => {
  const ctx: PipelineContext = {
    llm: opts.llm,
    research: opts.research,
    cache: opts.cache,
    minAmountForResearchCents: opts.min_amount_for_research_cents ?? 0,
  };

  const classifications: ClassificationMap = {};
  const byMerchant: Record<string, Classification> = {};
  const byMerchantPriority = new Map<string, number>();
  const enrichments = new Map<string, VendorEnrichment>();

  for (const group of groupTransactions(transactions)) {
    const decision = await decideGroup(group, ctx);

    for (const tx of group.transactions) {
      classifications[tx.id] = {
        transaction_id: tx.id,
        merchant_normalized: group.merchant_normalized,
        category: decision.category,
        method: decision.method,
        reason: decision.reason,
        supporting_signals: [...decision.supporting_signals],
        confidence_level: decision.confidence_level,
      };
    }

    const priority = FLOW_PRIORITY.indexOf(group.flow_type);
    const currentPriority = byMerchantPriority.get(group.merchant_normalized);
    if (currentPriority === undefined || priority < currentPriority) {
      byMerchantPriority.set(group.merchant_normalized, priority);
      byMerchant[group.merchant_normalized] = { ...classifications[group.transactions[0]!.id]! };
    }

    if (decision.enrichment !== null) enrichments.set(decision.enrichment.merchant_normalized, decision.enrichment);
  }

  return {
    classifications,
    enrichments: [...enrichments.keys()].sort().map((key) => enrichments.get(key)!),
    by_merchant: byMerchant,
  };
};
