import { SCOUT } from "@canary/shared";
import { describe, expect, it } from "vitest";
import type { FetchLike, HttpRequestInit } from "../http.ts";
import { TAVILY_SEARCH_URL } from "./tavily.ts";
import {
  buildScoutQuery,
  claimFromResult,
  findingsFromTavilyBody,
  parsePublishedAt,
  searchScoutVendor,
} from "./tavily-scout.ts";

const NOW = "2026-09-14T12:00:00.000Z";
const WINDOW_START = "2026-06-16";

function fakeFetch(replies: Array<{ status?: number; body: unknown }>): { fetch: FetchLike; calls: Array<{ url: string; body: Record<string, unknown> }> } {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const queue = [...replies];
  const fetch: FetchLike = async (url, init: HttpRequestInit) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
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

describe("buildScoutQuery", () => {
  it("asks for dated vendor changes, not a cheaper alternative", () => {
    const query = buildScoutQuery({ merchant_raw: "AWS", merchant_normalized: "aws", display_name: "AWS" });
    expect(query).toMatch(/^AWS /);
    expect(query).toMatch(/pricing change/);
    expect(query).not.toMatch(/cheaper|alternative|switch|cancel|downgrade|you could save|versus|\bvs\b/i);
  });
});

describe("parsePublishedAt", () => {
  it("accepts ISO dates and discards undated strings", () => {
    expect(parsePublishedAt("2026-08-01")).toBe("2026-08-01");
    expect(parsePublishedAt("2026-08-01T09:00:00.000Z")).toBe("2026-08-01");
    expect(parsePublishedAt("Sat, 01 Aug 2026 00:00:00 GMT")).toBe("2026-08-01");
    expect(parsePublishedAt("")).toBeNull();
    expect(parsePublishedAt("last year")).toBeNull();
    expect(parsePublishedAt(undefined)).toBeNull();
  });
});

describe("findingsFromTavilyBody", () => {
  const input = {
    merchantNormalized: "aws",
    displayName: "AWS",
    retrievedAt: NOW,
    windowStart: WINDOW_START,
    windowEnd: "2026-09-14",
  };

  it("keeps a dated vendor hit and drops undated evergreen copy", () => {
    const findings = findingsFromTavilyBody(
      {
        results: [
          {
            title: "How to optimize cloud spend",
            url: "https://example.com/optimize",
            content: "Generic tips for any vendor.",
          },
          {
            title: "AWS announces a new plan",
            url: "https://aws.amazon.com/blogs/aws/new-plan",
            content: "A new compute plan is generally available.",
            published_date: "2026-08-20",
          },
        ],
      },
      input,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "EVIDENCE",
      source_url: "https://aws.amazon.com/blogs/aws/new-plan",
      published_at: "2026-08-20",
      retrieved_at: NOW,
      cached: false,
    });
    expect(findings[0]!.claim).toMatch(/AWS announces a new plan/);
  });

  it("drops a dated result outside the window and a result that never names the vendor", () => {
    const findings = findingsFromTavilyBody(
      {
        results: [
          {
            title: "Old AWS price list",
            url: "https://aws.amazon.com/pricing/old",
            content: "AWS",
            published_date: "2025-01-01",
          },
          {
            title: "Cloud savings in 2026",
            url: "https://tips.example.com/save",
            content: "Ten ways to cut hosting.",
            published_date: "2026-08-01",
          },
        ],
      },
      input,
    );
    expect(findings).toEqual([]);
  });

  it("never fabricates a URL", () => {
    expect(
      findingsFromTavilyBody(
        { results: [{ title: "AWS plan", content: "AWS", published_date: "2026-08-01" }] },
        input,
      ),
    ).toEqual([]);
  });
});

describe("claimFromResult", () => {
  it("stays one line and does not keep a URL", () => {
    const claim = claimFromResult("AWS new plan https://aws.amazon.com/x", "");
    expect(claim).not.toMatch(/https?:\/\//);
    expect(claim.length).toBeLessThanOrEqual(SCOUT.CLAIM_MAX_CHARS);
  });
});

describe("searchScoutVendor", () => {
  it("sends a news search with an explicit date window and include_answer false", async () => {
    const { fetch, calls } = fakeFetch([
      {
        body: {
          results: [
            {
              title: "AWS credit program",
              url: "https://aws.amazon.com/credits",
              content: "AWS",
              published_date: "2026-07-01",
            },
          ],
        },
      },
    ]);

    const brief = await searchScoutVendor(
      "tvly-test",
      { merchant_raw: "AWS", merchant_normalized: "aws", display_name: "AWS" },
      fetch,
      { now: () => NOW },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(TAVILY_SEARCH_URL);
    expect(calls[0]!.body).toMatchObject({
      api_key: "tvly-test",
      topic: "news",
      include_answer: false,
      start_date: WINDOW_START,
      end_date: "2026-09-14",
    });
    expect(calls[0]!.body).not.toHaveProperty("days");
    expect(String(calls[0]!.body["query"])).not.toMatch(/company what does it do/);
    expect(brief.empty_window).toBe(false);
    expect(brief.findings).toHaveLength(1);
  });

  it("returns an empty window when nothing dated survives", async () => {
    const { fetch } = fakeFetch([{ body: { results: [{ title: "Evergreen", url: "https://aws.amazon.com/what-is", content: "AWS" }] } }]);
    const brief = await searchScoutVendor(
      "tvly-test",
      { merchant_raw: "AWS", merchant_normalized: "aws", display_name: "AWS" },
      fetch,
      { now: () => NOW },
    );
    expect(brief).toEqual({ entity: "aws", findings: [], empty_window: true, retrieved_at: NOW });
  });
});
