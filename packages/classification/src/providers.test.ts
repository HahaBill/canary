import { CATEGORIES, DEMO } from "@canary/shared";
import { describe, expect, it } from "vitest";
import { LLM_ALLOWED_CATEGORIES } from "./classify.ts";
import type { FetchLike, HttpRequestInit } from "./http.ts";
import {
  LlmNoAnswerError,
  OPENAI_CHAT_COMPLETIONS_URL,
  OPENAI_MODEL,
  OpenAiProvider,
  buildOpenAiSystemPrompt,
} from "./providers/openai.ts";
import { TAVILY_SEARCH_URL, TavilyProvider, buildTavilyQuery, prettyVendorName } from "./providers/tavily.ts";

interface Call {
  url: string;
  init: HttpRequestInit;
  body: Record<string, unknown>;
}

/** Fake `fetch`: records every call, replies from a queue of `[status, body]`. */
function fakeFetch(replies: Array<{ status?: number; body: unknown }>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...replies];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) as Record<string, unknown> });
    const reply = queue.shift() ?? { status: 500, body: { error: "no reply queued" } };
    const status = reply.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body)),
    };
  };
  return { fetch, calls };
}

const chatReply = (content: unknown) => ({
  body: { choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] },
});

const ashbyInput = {
  merchant_raw: DEMO.UNKNOWN_VENDOR.merchant_raw,
  merchant_normalized: DEMO.UNKNOWN_VENDOR.merchant_normalized,
  description: "",
  amount_cents: -150_000,
  history_summary: "3 payments, median $1,500.00",
  allowed_categories: LLM_ALLOWED_CATEGORIES,
};

describe("OpenAiProvider", () => {
  it("posts chat completions in JSON mode at temperature 0 and returns the proposal", async () => {
    const { fetch, calls } = fakeFetch([chatReply({ category: "RECRUITING", reason: "Ashby is a recruiting platform." })]);
    const provider = OpenAiProvider("sk-test", fetch);

    const proposal = await provider.proposeCategory(ashbyInput);

    expect(proposal).toEqual({ category: "RECRUITING", reason: "Ashby is a recruiting platform." });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe(OPENAI_CHAT_COMPLETIONS_URL);
    expect(call!.init.method).toBe("POST");
    expect(call!.init.headers["authorization"]).toBe("Bearer sk-test");
    expect(call!.body["model"]).toBe(OPENAI_MODEL);
    expect(call!.body["temperature"]).toBe(0);
    expect(call!.body["response_format"]).toEqual({ type: "json_object" });
    const messages = call!.body["messages"] as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("RECRUITING");
    expect(messages[1]!.content).toContain(DEMO.UNKNOWN_VENDOR.merchant_raw);
  });

  it("rejects a category outside the allowed list instead of inventing one", async () => {
    const { fetch } = fakeFetch([chatReply({ category: "CRYPTO", reason: "made up" })]);
    await expect(OpenAiProvider("sk-test", fetch).proposeCategory(ashbyInput)).rejects.toBeInstanceOf(LlmNoAnswerError);
  });

  it("rejects a non-operating category that the flow type owns", async () => {
    const { fetch } = fakeFetch([chatReply({ category: "INTERNAL_TRANSFER", reason: "nope" })]);
    await expect(OpenAiProvider("sk-test", fetch).proposeCategory(ashbyInput)).rejects.toBeInstanceOf(LlmNoAnswerError);
  });

  it("rejects unparseable content and missing content", async () => {
    const bad = fakeFetch([chatReply("not json at all")]);
    await expect(OpenAiProvider("sk-test", bad.fetch).proposeCategory(ashbyInput)).rejects.toBeInstanceOf(LlmNoAnswerError);

    const empty = fakeFetch([{ body: { choices: [] } }]);
    await expect(OpenAiProvider("sk-test", empty.fetch).proposeCategory(ashbyInput)).rejects.toBeInstanceOf(LlmNoAnswerError);
  });

  it("surfaces HTTP failures with the status", async () => {
    const { fetch } = fakeFetch([{ status: 429, body: { error: "rate limited" } }]);
    await expect(OpenAiProvider("sk-test", fetch).proposeCategory(ashbyInput)).rejects.toThrow(/429/);
  });

  it("strips URLs and confidence numbers out of the model's prose", async () => {
    const { fetch } = fakeFetch([
      chatReply({ category: "RECRUITING", reason: "See https://ashbyhq.com for details. confidence: 0.93" }),
    ]);
    const proposal = await OpenAiProvider("sk-test", fetch).proposeCategory(ashbyInput);
    expect(proposal.reason).not.toContain("http");
    expect(proposal.reason).not.toContain("0.93");
  });

  it("falls back to a deterministic reason when the model omits one", async () => {
    const { fetch } = fakeFetch([chatReply({ category: "RECRUITING" })]);
    const proposal = await OpenAiProvider("sk-test", fetch, { name: "openai" }).proposeCategory(ashbyInput);
    expect(proposal.reason).toBe(`RECRUITING proposed by openai (${OPENAI_MODEL}).`);
  });

  it("lists every allowed category and the required JSON shape in the system prompt", () => {
    const prompt = buildOpenAiSystemPrompt(LLM_ALLOWED_CATEGORIES);
    for (const category of LLM_ALLOWED_CATEGORIES) expect(prompt).toContain(category);
    expect(prompt).toContain('{"category"');
    expect(prompt).toContain('"reason"');
    // Categories the pipeline owns must not be offered to the model.
    expect(LLM_ALLOWED_CATEGORIES).not.toContain("NEEDS_REVIEW");
    expect(LLM_ALLOWED_CATEGORIES).not.toContain("INTERNAL_TRANSFER");
    expect(LLM_ALLOWED_CATEGORIES.every((c) => CATEGORIES.includes(c))).toBe(true);
  });
});

const tavilyInput = {
  merchant_raw: DEMO.UNKNOWN_VENDOR.merchant_raw,
  merchant_normalized: DEMO.UNKNOWN_VENDOR.merchant_normalized,
  display_name: DEMO.UNKNOWN_VENDOR.display_name,
};

const NOW = "2026-09-12T17:00:00.000Z";

describe("TavilyProvider", () => {
  it("builds the documented request and a citable enrichment", async () => {
    const { fetch, calls } = fakeFetch([
      {
        body: {
          answer: "Ashby is an all-in-one recruiting platform used by scaling technology companies.",
          results: [
            { title: "Ashby — All-in-one recruiting", url: "https://www.ashbyhq.com/", content: "Ashby provides applicant tracking and analytics." },
            { title: "Second", url: "https://example.com/second", content: "other" },
          ],
        },
      },
    ]);

    const enrichment = await TavilyProvider("tvly-test", fetch, { now: () => NOW }).enrichVendor(tavilyInput);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(TAVILY_SEARCH_URL);
    expect(calls[0]!.body).toEqual({
      api_key: "tvly-test",
      query: "Ashby ASHBYHQ company what does it do",
      search_depth: "basic",
      include_answer: true,
      max_results: 5,
    });
    expect(enrichment).toEqual({
      vendor_name: "Ashby",
      merchant_normalized: "ashby",
      business_type: "Ashby is an all-in-one recruiting platform used by scaling technology companies.",
      mapped_category: "RECRUITING",
      source_url: "https://www.ashbyhq.com/",
      source_title: "Ashby — All-in-one recruiting",
      retrieved_at: NOW,
      snippet: "Ashby provides applicant tracking and analytics.",
      cached: false,
    });
  });

  it("falls back to the top result's content when there is no answer", async () => {
    const longContent = `Ashby builds recruiting software. ${"detail ".repeat(80)}`;
    const { fetch } = fakeFetch([{ body: { answer: "", results: [{ title: "T", url: "https://t.example.com/a", content: longContent }] } }]);

    const enrichment = await TavilyProvider("tvly-test", fetch, { now: () => NOW }).enrichVendor(tavilyInput);

    expect(enrichment?.business_type.length).toBeLessThanOrEqual(200);
    expect(enrichment?.business_type.startsWith("Ashby builds recruiting software.")).toBe(true);
    expect(enrichment?.mapped_category).toBe("RECRUITING");
  });

  it("returns null when there are no results", async () => {
    const { fetch } = fakeFetch([{ body: { answer: "nothing", results: [] } }]);
    expect(await TavilyProvider("tvly-test", fetch, { now: () => NOW }).enrichVendor(tavilyInput)).toBeNull();
  });

  it("never fabricates a URL: results without a real URL are unusable", async () => {
    const { fetch } = fakeFetch([{ body: { answer: "a recruiting platform", results: [{ title: "No link", content: "text" }] } }]);
    expect(await TavilyProvider("tvly-test", fetch, { now: () => NOW }).enrichVendor(tavilyInput)).toBeNull();
  });

  it("marks an undescribable vendor with the NEEDS_REVIEW sentinel rather than guessing", async () => {
    const { fetch } = fakeFetch([{ body: { answer: "A company that exists.", results: [{ title: "T", url: "https://t.example.com/a", content: "" }] } }]);
    const enrichment = await TavilyProvider("tvly-test", fetch, { now: () => NOW }).enrichVendor(tavilyInput);
    expect(enrichment?.mapped_category).toBe("NEEDS_REVIEW");
  });

  it("retries once with the Authorization header when the body api_key is rejected", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 401, body: { detail: "unauthorized" } },
      { body: { answer: "Recruiting software.", results: [{ title: "T", url: "https://t.example.com/a", content: "c" }] } },
    ]);

    const enrichment = await TavilyProvider("tvly-test", fetch, { now: () => NOW }).enrichVendor(tavilyInput);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.body["api_key"]).toBe("tvly-test");
    expect(calls[1]!.body["api_key"]).toBeUndefined();
    expect(calls[1]!.init.headers["authorization"]).toBe("Bearer tvly-test");
    expect(enrichment?.mapped_category).toBe("RECRUITING");
  });

  it("surfaces non-401 HTTP failures", async () => {
    const { fetch } = fakeFetch([{ status: 500, body: "boom" }]);
    await expect(TavilyProvider("tvly-test", fetch, { now: () => NOW }).enrichVendor(tavilyInput)).rejects.toThrow(/500/);
  });

  it("builds the query from the display name, falling back to the raw descriptor", () => {
    expect(buildTavilyQuery(tavilyInput)).toBe("Ashby ASHBYHQ company what does it do");
    expect(buildTavilyQuery({ merchant_raw: "ACME WIDGETS", merchant_normalized: "acme_widgets" })).toBe(
      "ACME WIDGETS company what does it do",
    );
    expect(buildTavilyQuery({ merchant_raw: "", merchant_normalized: "acme_widgets" })).toBe("Acme Widgets company what does it do");
    expect(prettyVendorName("google_workspace")).toBe("Google Workspace");
  });
});

// ---------------------------------------------------------------------------
// Live API tests — skipped unless the key is present (offline CI stays green).
// ---------------------------------------------------------------------------

const liveOpenAi = process.env["OPENAI_API_KEY"] ? it : it.skip;
const liveTavily = process.env["TAVILY_API_KEY"] ? it : it.skip;

describe("live providers", () => {
  liveOpenAi(
    "OpenAI proposes an allowed category for the demo's unknown vendor",
    async () => {
      const provider = OpenAiProvider(process.env["OPENAI_API_KEY"]!);
      const proposal = await provider.proposeCategory(ashbyInput);
      expect(LLM_ALLOWED_CATEGORIES).toContain(proposal.category);
      expect(proposal.reason.length).toBeGreaterThan(0);
      expect(proposal.reason).not.toMatch(/https?:\/\//);
    },
    30_000,
  );

  liveTavily(
    "Tavily returns a real indexed source for the demo's unknown vendor",
    async () => {
      const provider = TavilyProvider(process.env["TAVILY_API_KEY"]!, undefined, { now: () => NOW });
      const enrichment = await provider.enrichVendor(tavilyInput);
      expect(enrichment).not.toBeNull();
      expect(enrichment!.source_url).toMatch(/^https?:\/\//);
      expect(enrichment!.business_type.length).toBeGreaterThan(0);
      expect(enrichment!.retrieved_at).toBe(NOW);
      expect(enrichment!.cached).toBe(false);
    },
    30_000,
  );
});

describe("pickCitation", () => {
  it("prefers the vendor's own domain over aggregators, else the first result", async () => {
    const { pickCitation } = await import("./providers/tavily.ts");
    const results = [
      { title: "Jobs", url: "https://www.ziprecruiter.com/Jobs/Ashbyhq", content: "" },
      { title: "Ashby", url: "https://www.ashbyhq.com/", content: "" },
    ];
    expect(pickCitation(results, "ashby").url).toBe("https://www.ashbyhq.com/");
    // No own-domain match and neither result mentions "datadog" → Tavily's ranking stands.
    expect(pickCitation(results, "datadog").url).toBe("https://www.ziprecruiter.com/Jobs/Ashbyhq");
    // Irrelevant results are dropped when at least one result mentions the vendor.
    const mixed = [
      { title: "A F Evans Company Inc", url: "https://www.directionus.com/ca/sf/a-f-evans", content: "directory listing" },
      { title: "Ashbyhq Jobs", url: "https://www.ziprecruiter.com/Jobs/Ashbyhq", content: "" },
    ];
    expect(pickCitation(mixed, "ashby").url).toBe("https://www.ziprecruiter.com/Jobs/Ashbyhq");
  });
});
