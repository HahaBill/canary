import type { Category, Classification, LlmProvider, ResearchProvider, Transaction, VendorEnrichment } from "@canary/shared";
import { DEMO } from "@canary/shared";
import { SAMPLE_TRANSACTIONS } from "@canary/shared/fixtures";
import { describe, expect, it } from "vitest";
import { MemoryEnrichmentCache } from "./cache.ts";
import { LLM_ALLOWED_CATEGORIES, classifyTransactions, summarizeMerchantHistory } from "./classify.ts";

const VENDOR = DEMO.UNKNOWN_VENDOR;
const NOW = "2026-09-12T17:00:00.000Z";

function ashbyTx(id: string, amountCents = -150_000, date = "2026-08-27"): Transaction {
  return {
    id,
    account_id: "chk",
    date,
    amount_cents: amountCents,
    currency: "USD",
    merchant_raw: VENDOR.merchant_raw,
    merchant_normalized: VENDOR.merchant_normalized,
    description: "",
    flow_type: "OPERATING_OUTFLOW",
    status: "settled",
    source: "synthetic",
    tags: [],
  };
}

const ashbyEnrichment: VendorEnrichment = {
  vendor_name: "Ashby",
  merchant_normalized: "ashby",
  business_type: "Ashby is an all-in-one recruiting platform for scaling companies.",
  mapped_category: "RECRUITING",
  source_url: "https://www.ashbyhq.com/",
  source_title: "Ashby — All-in-one recruiting",
  retrieved_at: NOW,
  cached: false,
};

/** Records what the pipeline asked for, so "one call per merchant" is testable. */
function stubLlm(result: { category?: Category; reason?: string; error?: Error }) {
  const calls: string[] = [];
  const provider: LlmProvider = {
    name: "openai",
    async proposeCategory(input) {
      calls.push(input.merchant_normalized);
      if (result.error) throw result.error;
      return { category: result.category!, reason: result.reason ?? "Stubbed reason." };
    },
  };
  return { provider, calls };
}

function stubResearch(result: { enrichment?: VendorEnrichment | null; error?: Error }) {
  const calls: string[] = [];
  const provider: ResearchProvider = {
    name: "tavily",
    async enrichVendor(input) {
      calls.push(input.merchant_normalized);
      if (result.error) throw result.error;
      return result.enrichment ?? null;
    },
  };
  return { provider, calls };
}

const signal = (c: Classification, source: string) => c.supporting_signals.find((s) => s.source === source);

describe("classifyTransactions — rules first", () => {
  it("classifies every flow type by rule at HIGH confidence", async () => {
    const flows: Array<[string, Transaction["flow_type"], Category]> = [
      ["f_transfer", "INTERNAL_TRANSFER", "INTERNAL_TRANSFER"],
      ["f_settlement", "CARD_SETTLEMENT", "CARD_SETTLEMENT"],
      ["f_financing", "FINANCING", "FINANCING"],
      ["f_refund", "REFUND", "REFUND"],
      ["f_inflow", "OPERATING_INFLOW", "CUSTOMER_REVENUE"],
    ];
    const transactions = flows.map(([id, flow]) => ({ ...ashbyTx(id), flow_type: flow }));

    const { classifications } = await classifyTransactions(transactions);

    for (const [id, flow, expected] of flows) {
      const c = classifications[id]!;
      expect(c.category).toBe(expected);
      expect(c.method).toBe("RULE");
      expect(c.confidence_level).toBe("HIGH");
      expect(signal(c, "FLOW_TYPE")?.proposed_category).toBe(expected);
      expect(c.reason).toContain(flow);
    }
  });

  it("classifies the fixture end to end with no providers: rules for everything but the unknown vendor", async () => {
    const { classifications, by_merchant, enrichments } = await classifyTransactions(SAMPLE_TRANSACTIONS);

    expect(Object.keys(classifications)).toHaveLength(SAMPLE_TRANSACTIONS.length);
    expect(enrichments).toEqual([]);

    for (const tx of SAMPLE_TRANSACTIONS) {
      const c = classifications[tx.id]!;
      if (tx.merchant_normalized === VENDOR.merchant_normalized) {
        // The demo's unknown vendor: no rule may claim it.
        expect(c.method).toBe("NEEDS_REVIEW");
        expect(c.category).toBe("NEEDS_REVIEW");
        expect(c.confidence_level).toBe("LOW");
      } else {
        expect(c.method).toBe("RULE");
        expect(c.confidence_level).toBe("HIGH");
        // Rules must agree with the generator's ground truth.
        expect(c.category).toBe(tx.category_hint);
      }
    }

    // by_merchant reports the vendor decision, not the refund leg.
    expect(by_merchant["upwork"]!.category).toBe("CONTRACTORS");
    expect(classifications["t016"]!.category).toBe("REFUND");
  });

  it("is deterministic: same input, identical output", async () => {
    const a = await classifyTransactions(SAMPLE_TRANSACTIONS);
    const b = await classifyTransactions(SAMPLE_TRANSACTIONS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never calls providers for a merchant a rule already covers", async () => {
    const llm = stubLlm({ category: "SAAS_SOFTWARE" });
    const research = stubResearch({ enrichment: ashbyEnrichment });

    await classifyTransactions(
      SAMPLE_TRANSACTIONS.filter((tx) => tx.merchant_normalized !== VENDOR.merchant_normalized),
      { llm: llm.provider, research: research.provider },
    );

    expect(llm.calls).toEqual([]);
    expect(research.calls).toEqual([]);
  });
});

describe("classifyTransactions — unknown merchant", () => {
  it("agreeing signals → LLM_CORROBORATED / HIGH with both signals recorded", async () => {
    const llm = stubLlm({ category: "RECRUITING", reason: "Ashby sells recruiting software." });
    const research = stubResearch({ enrichment: ashbyEnrichment });

    const { classifications, enrichments, by_merchant } = await classifyTransactions([ashbyTx("a1")], {
      llm: llm.provider,
      research: research.provider,
    });

    const c = classifications["a1"]!;
    expect(c.category).toBe(VENDOR.expected_category);
    expect(c.method).toBe("LLM_CORROBORATED");
    expect(c.confidence_level).toBe("HIGH");
    expect(signal(c, "OPENAI")).toMatchObject({ proposed_category: "RECRUITING" });
    expect(signal(c, "OPENAI")!.detail).toContain("Ashby sells recruiting software.");
    expect(signal(c, "TAVILY")).toMatchObject({ proposed_category: "RECRUITING", url: ashbyEnrichment.source_url });
    expect(enrichments).toEqual([ashbyEnrichment]);
    expect(by_merchant["ashby"]!.method).toBe("LLM_CORROBORATED");
  });

  it("disagreeing signals → NEEDS_REVIEW / LOW, both signals kept", async () => {
    const llm = stubLlm({ category: "SAAS_SOFTWARE", reason: "Looks like software." });
    const research = stubResearch({ enrichment: ashbyEnrichment });

    const { classifications, enrichments } = await classifyTransactions([ashbyTx("a1")], {
      llm: llm.provider,
      research: research.provider,
    });

    const c = classifications["a1"]!;
    expect(c.category).toBe("NEEDS_REVIEW");
    expect(c.method).toBe("NEEDS_REVIEW");
    expect(c.confidence_level).toBe("LOW");
    expect(signal(c, "OPENAI")?.proposed_category).toBe("SAAS_SOFTWARE");
    expect(signal(c, "TAVILY")?.proposed_category).toBe("RECRUITING");
    expect(c.reason).toContain("disagreed");
    // The retrieval still happened, so the evidence panel can still cite it.
    expect(enrichments).toEqual([ashbyEnrichment]);
  });

  it("no research provider → LLM_ONLY / MEDIUM", async () => {
    const llm = stubLlm({ category: "RECRUITING" });

    const { classifications, enrichments } = await classifyTransactions([ashbyTx("a1")], { llm: llm.provider });

    const c = classifications["a1"]!;
    expect(c.category).toBe("RECRUITING");
    expect(c.method).toBe("LLM_ONLY");
    expect(c.confidence_level).toBe("MEDIUM");
    expect(signal(c, "TAVILY")).toBeUndefined();
    expect(enrichments).toEqual([]);
  });

  it("research returns nothing → still LLM_ONLY, and the empty result is recorded", async () => {
    const llm = stubLlm({ category: "RECRUITING" });
    const research = stubResearch({ enrichment: null });

    const { classifications } = await classifyTransactions([ashbyTx("a1")], { llm: llm.provider, research: research.provider });

    const c = classifications["a1"]!;
    expect(c.method).toBe("LLM_ONLY");
    expect(c.confidence_level).toBe("MEDIUM");
    expect(signal(c, "TAVILY")!.detail).toContain("no indexed result");
  });

  it("no providers at all → NEEDS_REVIEW", async () => {
    const { classifications } = await classifyTransactions([ashbyTx("a1")]);
    const c = classifications["a1"]!;
    expect(c.category).toBe("NEEDS_REVIEW");
    expect(c.method).toBe("NEEDS_REVIEW");
    expect(c.confidence_level).toBe("LOW");
    expect(c.reason).toContain("no classification providers");
  });

  it("an off-list LLM category is discarded, not trusted", async () => {
    const llm = stubLlm({ category: "CRYPTO" as Category });

    const { classifications } = await classifyTransactions([ashbyTx("a1")], { llm: llm.provider });

    const c = classifications["a1"]!;
    expect(c.category).toBe("NEEDS_REVIEW");
    expect(signal(c, "OPENAI")!.detail).toContain("outside the allowed list");
    expect(signal(c, "OPENAI")!.proposed_category).toBeUndefined();
  });

  it("a failing LLM call is recorded and degrades to Needs Review", async () => {
    const llm = stubLlm({ error: new Error("openai exploded") });
    const research = stubResearch({ error: new Error("tavily exploded") });

    const { classifications } = await classifyTransactions([ashbyTx("a1")], { llm: llm.provider, research: research.provider });

    const c = classifications["a1"]!;
    expect(c.category).toBe("NEEDS_REVIEW");
    expect(signal(c, "OPENAI")!.detail).toContain("openai exploded");
    expect(signal(c, "TAVILY")!.detail).toContain("tavily exploded");
  });

  it("research alone is one signal, which is not enough", async () => {
    const research = stubResearch({ enrichment: ashbyEnrichment });

    const { classifications, enrichments } = await classifyTransactions([ashbyTx("a1")], { research: research.provider });

    const c = classifications["a1"]!;
    expect(c.category).toBe("NEEDS_REVIEW");
    expect(c.method).toBe("NEEDS_REVIEW");
    expect(signal(c, "TAVILY")?.proposed_category).toBe("RECRUITING");
    expect(enrichments).toEqual([ashbyEnrichment]);
  });

  it("a cache hit short-circuits research and is labelled as previously retrieved", async () => {
    const llm = stubLlm({ category: "RECRUITING" });
    const research = stubResearch({ error: new Error("research must not be called") });
    const cache = new MemoryEnrichmentCache([ashbyEnrichment]);

    const { classifications, enrichments } = await classifyTransactions([ashbyTx("a1")], {
      llm: llm.provider,
      research: research.provider,
      cache,
    });

    expect(research.calls).toEqual([]);
    const c = classifications["a1"]!;
    expect(c.method).toBe("LLM_CORROBORATED");
    expect(signal(c, "TAVILY")!.detail).toContain("previously retrieved");
    expect(enrichments[0]!.cached).toBe(true);
  });

  it("writes a live enrichment through to the cache", async () => {
    const llm = stubLlm({ category: "RECRUITING" });
    const research = stubResearch({ enrichment: ashbyEnrichment });
    const cache = new MemoryEnrichmentCache();

    await classifyTransactions([ashbyTx("a1")], { llm: llm.provider, research: research.provider, cache });

    expect(await cache.get("ashby")).toEqual({ ...ashbyEnrichment, cached: true });
  });

  it("re-maps a cached enrichment whose stored category is the unmapped sentinel", async () => {
    const llm = stubLlm({ category: "RECRUITING" });
    const cache = new MemoryEnrichmentCache([{ ...ashbyEnrichment, mapped_category: "NEEDS_REVIEW" }]);

    const { classifications } = await classifyTransactions([ashbyTx("a1")], { llm: llm.provider, cache });

    expect(classifications["a1"]!.method).toBe("LLM_CORROBORATED");
  });

  it("spends at most one LLM call and one research call per merchant", async () => {
    const llm = stubLlm({ category: "RECRUITING" });
    const research = stubResearch({ enrichment: ashbyEnrichment });

    const { classifications } = await classifyTransactions(
      [ashbyTx("a1"), ashbyTx("a2", -160_000, "2026-09-03"), ashbyTx("a3", -170_000, "2026-09-10")],
      { llm: llm.provider, research: research.provider },
    );

    expect(llm.calls).toEqual(["ashby"]);
    expect(research.calls).toEqual(["ashby"]);
    for (const id of ["a1", "a2", "a3"]) {
      expect(classifications[id]!.category).toBe("RECRUITING");
      expect(classifications[id]!.method).toBe("LLM_CORROBORATED");
    }
  });

  it("skips providers below min_amount_for_research_cents", async () => {
    const llm = stubLlm({ category: "RECRUITING" });
    const research = stubResearch({ enrichment: ashbyEnrichment });

    const { classifications } = await classifyTransactions([ashbyTx("a1", -4_000)], {
      llm: llm.provider,
      research: research.provider,
      min_amount_for_research_cents: 100_000,
    });

    expect(llm.calls).toEqual([]);
    expect(research.calls).toEqual([]);
    const c = classifications["a1"]!;
    expect(c.category).toBe("NEEDS_REVIEW");
    expect(c.reason).toContain("$1,000.00");
  });

  it("uses the merchant's largest payment for the amount gate", async () => {
    const llm = stubLlm({ category: "RECRUITING" });

    const { classifications } = await classifyTransactions([ashbyTx("a1", -4_000), ashbyTx("a2", -400_000, "2026-09-03")], {
      llm: llm.provider,
      min_amount_for_research_cents: 100_000,
    });

    expect(llm.calls).toEqual(["ashby"]);
    expect(classifications["a1"]!.method).toBe("LLM_ONLY");
  });

  it("offers the model only the categories it is allowed to decide", async () => {
    const seen: Array<readonly Category[]> = [];
    const provider: LlmProvider = {
      name: "openai",
      async proposeCategory(input) {
        seen.push(input.allowed_categories);
        return { category: "RECRUITING", reason: "r" };
      },
    };

    await classifyTransactions([ashbyTx("a1")], { llm: provider });

    expect(seen[0]).toEqual(LLM_ALLOWED_CATEGORIES);
    expect(seen[0]).not.toContain("NEEDS_REVIEW");
  });
});

describe("summarizeMerchantHistory", () => {
  it("summarizes deterministically from the transactions, with no invented figures", () => {
    const summary = summarizeMerchantHistory([ashbyTx("a1", -100_000, "2026-08-27"), ashbyTx("a2", -300_000, "2026-09-03")]);
    expect(summary).toBe("2 payments, median $2,000.00, total $4,000.00, first 2026-08-27, last 2026-09-03");
    expect(summarizeMerchantHistory([])).toBe("no prior payments");
  });
});
