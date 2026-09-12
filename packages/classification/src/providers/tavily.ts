/**
 * Tavily vendor enrichment — the *external corroboration* signal
 * (PRD §11, contract §13).
 *
 * Returns what the vendor actually does plus a real URL and title that Tavily
 * returned. URLs are never constructed or guessed here; if Tavily gives us no
 * usable result we return `null` and the pipeline falls back to Needs Review.
 *
 * Plain `fetch`, no SDK. `now()` is injected so runs stay deterministic.
 */
import type { ISODateTime, ResearchProvider, VendorEnrichment } from "@canary/shared";
import { mapBusinessTypeToCategory } from "../business-type.ts";
import { asRecord, defaultFetch, isHttpUrl, parseJsonSafe, truncate, type FetchLike } from "../http.ts";

export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
export const TAVILY_MAX_RESULTS = 5;
export const TAVILY_SEARCH_DEPTH = "basic";
/** `business_type` is a short descriptor, not an essay. */
export const BUSINESS_TYPE_MAX_CHARS = 200;
const SNIPPET_MAX_CHARS = 300;

export interface TavilyProviderOptions {
  /** Injected clock for `retrieved_at`. Defaults to wall clock. */
  now?: () => ISODateTime;
  maxResults?: number;
  url?: string;
  name?: string;
}

export interface TavilyVendorInput {
  merchant_raw: string;
  merchant_normalized: string;
  display_name?: string;
}

/** `"Ashby company what does it do"` */
export function buildTavilyQuery(input: TavilyVendorInput): string {
  const display = (input.display_name ?? "").trim();
  const raw = input.merchant_raw.trim();
  // Add the descriptor's brand token next to the display name: "Ashby" alone is
  // ambiguous, but "ASHBYHQ" steers search toward ashbyhq.com. The rest of the
  // descriptor (city/state/ids) only attracts local business directories.
  const brandToken = raw.split(/\s+/)[0] ?? "";
  const subject = display
    ? brandToken && brandToken.toLowerCase() !== display.toLowerCase()
      ? `${display} ${brandToken}`
      : display
    : raw || prettyVendorName(input.merchant_normalized);
  return `${subject} company what does it do`;
}

/** `ashby` → `Ashby`, `google_workspace` → `Google Workspace`. */
export function prettyVendorName(merchantNormalized: string): string {
  return merchantNormalized
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

function readResults(body: Record<string, unknown> | null): TavilyResult[] {
  const raw = body?.["results"];
  if (!Array.isArray(raw)) return [];
  const out: TavilyResult[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const url = record?.["url"];
    // Only results Tavily actually returned a real URL for are citable.
    if (!isHttpUrl(url)) continue;
    const title = record?.["title"];
    const content = record?.["content"];
    out.push({
      url: url.trim(),
      title: typeof title === "string" ? title.trim() : "",
      content: typeof content === "string" ? content : "",
    });
  }
  return out;
}

/**
 * Exported for tests. Picks the result whose hostname contains the vendor key
 * (official site) if any, else the first result. Never fabricates a URL.
 */
export function pickCitation(results: TavilyResult[], merchantNormalized: string): TavilyResult {
  const key = merchantNormalized.replace(/[^a-z0-9]/g, "");
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const hostOf = (url: string): string => {
    try {
      return norm(new URL(url).hostname);
    } catch {
      return "";
    }
  };
  // 1. Relevance: keep results that mention the vendor anywhere; if none do, keep Tavily's list.
  const relevant = key.length >= 3 ? results.filter((r) => hostOf(r.url).includes(key) || norm(r.title).includes(key) || norm(r.content).includes(key)) : [];
  const pool = relevant.length > 0 ? relevant : results;
  // 2. Prefer the vendor's own domain (shallowest page first, avoiding legal/login pages).
  const LOW_VALUE_PATH = /privacy|terms|legal|login|sign-?in/i;
  const own = pool
    .filter((r) => key.length >= 3 && hostOf(r.url).includes(key))
    .map((r, i) => {
      const path = (() => {
        try {
          return new URL(r.url).pathname;
        } catch {
          return "/";
        }
      })();
      const depth = path.split("/").filter(Boolean).length;
      return { r, score: -depth * 2 - (LOW_VALUE_PATH.test(path) ? 10 : 0) - i * 0.1 };
    })
    .sort((a, b) => b.score - a.score);
  if (own.length > 0) return own[0]!.r;
  // 3. Otherwise trust Tavily's ranking within the relevant pool.
  return pool[0]!;
}

/**
 * `ResearchProvider` over Tavily search. Sends the documented `api_key` body
 * form first and retries once with `Authorization: Bearer` if that is rejected
 * with 401 (both forms are accepted by the API).
 */
export function TavilyProvider(apiKey: string, fetchImpl?: FetchLike, options: TavilyProviderOptions = {}): ResearchProvider {
  const doFetch = fetchImpl ?? defaultFetch();
  const url = options.url ?? TAVILY_SEARCH_URL;
  const maxResults = options.maxResults ?? TAVILY_MAX_RESULTS;
  const name = options.name ?? "tavily";
  const now = options.now ?? (() => new Date().toISOString());

  async function search(query: string): Promise<Record<string, unknown> | null> {
    const base = { query, search_depth: TAVILY_SEARCH_DEPTH, include_answer: true, max_results: maxResults };

    let response = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, ...base }),
    });

    if (response.status === 401) {
      response = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(base),
      });
    }

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`${name} request failed with status ${response.status}: ${truncate(raw, 200)}`);
    }
    return asRecord(parseJsonSafe(raw));
  }

  return {
    name,
    async enrichVendor(input: TavilyVendorInput): Promise<VendorEnrichment | null> {
      const body = await search(buildTavilyQuery(input));
      const results = readResults(body);
      if (results.length === 0) return null;

      // Prefer the vendor's own site as the citation: a result whose hostname
      // contains the normalized merchant key (e.g. ashbyhq.com for "ashby")
      // beats aggregator/job-board pages that merely mention it.
      const top = pickCitation(results, input.merchant_normalized);
      const answer = body?.["answer"];
      const businessType =
        truncate(typeof answer === "string" ? answer : "", BUSINESS_TYPE_MAX_CHARS) ||
        truncate(top.content, BUSINESS_TYPE_MAX_CHARS) ||
        truncate(top.title, BUSINESS_TYPE_MAX_CHARS);
      if (businessType === "") return null;

      const snippet = truncate(top.content, SNIPPET_MAX_CHARS);
      return {
        vendor_name: (input.display_name ?? "").trim() || prettyVendorName(input.merchant_normalized),
        merchant_normalized: input.merchant_normalized,
        business_type: businessType,
        // `NEEDS_REVIEW` is the sentinel for "described, but not mappable" —
        // `VendorEnrichment.mapped_category` cannot be null (contract gap).
        mapped_category: mapBusinessTypeToCategory(businessType) ?? "NEEDS_REVIEW",
        source_url: top.url,
        source_title: top.title || top.url,
        retrieved_at: now(),
        ...(snippet === "" ? {} : { snippet }),
        cached: false,
      };
    },
  };
}
