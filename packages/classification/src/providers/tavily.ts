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
import type { ISODateTime, ResearchProvider, ScoutRefreshError, VendorEnrichment } from "@canary/shared";
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

/** Body fields Tavily Search accepts. Scout adds `topic` / dates; corroboration does not. */
export interface TavilySearchRequest {
  query: string;
  search_depth?: string;
  include_answer?: boolean;
  max_results?: number;
  topic?: "general" | "news" | "finance";
  days?: number;
  start_date?: string;
  end_date?: string;
}

/** HTTP / network failure from `tavilySearch`. Codes match `ScoutPage.refresh_error`. */
export class TavilyRequestError extends Error {
  readonly code: ScoutRefreshError;
  readonly status: number;

  constructor(code: ScoutRefreshError, status: number, message: string) {
    super(message);
    this.name = "TavilyRequestError";
    this.code = code;
    this.status = status;
  }
}

export function tavilyErrorCodeFromStatus(status: number): ScoutRefreshError {
  if (status === 401 || status === 403) return "TAVILY_UNAUTHORIZED";
  if (status === 429 || status === 432) return "TAVILY_QUOTA";
  return "TAVILY_FAILED";
}

export function scoutRefreshErrorFrom(error: unknown): ScoutRefreshError {
  if (error instanceof TavilyRequestError) return error.code;
  return "TAVILY_FAILED";
}

/**
 * One Tavily Search call. Body `api_key` first; retries once with Bearer on 401.
 * Shared by vendor corroboration and Scout so the two workflows cannot drift
 * on auth, and so Scout writes never go through `enrichVendor`.
 */
export async function tavilySearch(
  apiKey: string,
  fetchImpl: FetchLike,
  request: TavilySearchRequest,
  options: { url?: string; name?: string } = {},
): Promise<Record<string, unknown> | null> {
  const url = options.url ?? TAVILY_SEARCH_URL;
  const name = options.name ?? "tavily";
  const base: Record<string, unknown> = {
    query: request.query,
    search_depth: request.search_depth ?? TAVILY_SEARCH_DEPTH,
    include_answer: request.include_answer ?? true,
    max_results: request.max_results ?? TAVILY_MAX_RESULTS,
  };
  if (request.topic) base["topic"] = request.topic;
  // Tavily 400s: "When days is set, start_date or end_date cannot be set".
  // Absolute dates win — they follow the injected clock, not Tavily's wall clock.
  const hasAbsoluteWindow = Boolean(request.start_date || request.end_date);
  if (!hasAbsoluteWindow && request.days !== undefined) base["days"] = request.days;
  if (request.start_date) base["start_date"] = request.start_date;
  if (request.end_date) base["end_date"] = request.end_date;

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, ...base }),
    });
  } catch {
    throw new TavilyRequestError("TAVILY_UNREACHABLE", 0, `${name} request failed: network`);
  }

  if (response.status === 401) {
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(base),
      });
    } catch {
      throw new TavilyRequestError("TAVILY_UNREACHABLE", 0, `${name} request failed: network`);
    }
  }

  const raw = await response.text();
  if (!response.ok) {
    throw new TavilyRequestError(
      tavilyErrorCodeFromStatus(response.status),
      response.status,
      `${name} request failed with status ${response.status}: ${truncate(raw, 200)}`,
    );
  }
  return asRecord(parseJsonSafe(raw));
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

  return {
    name,
    async enrichVendor(input: TavilyVendorInput): Promise<VendorEnrichment | null> {
      const body = await tavilySearch(
        apiKey,
        doFetch,
        { query: buildTavilyQuery(input), search_depth: TAVILY_SEARCH_DEPTH, include_answer: true, max_results: maxResults },
        { url, name },
      );
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
