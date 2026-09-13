/**
 * Tavily Scout search — dated pricing / plan / credit / announcement hits
 * for a vendor we already pay (PRD §11 P1).
 *
 * Separate from `enrichVendor`. That path identifies an unknown merchant and
 * writes the demo corroboration cache. This path never does.
 */
import {
  SCOUT,
  addDays,
  type ISODate,
  type ISODateTime,
  type ScoutFinding,
  type ScoutVendorCache,
} from "@canary/shared";
import { asRecord, defaultFetch, isHttpUrl, sanitizeModelText, type FetchLike } from "../http.ts";
import { prettyVendorName, tavilySearch, type TavilyVendorInput } from "./tavily.ts";

const SCOUT_TOPIC = "news" as const;

/** Words this query must never ask Tavily for. AGENT_BEHAVIOR §4. */
const FORBIDDEN_QUERY = /\b(cheaper|alternative|vs\.?|versus|compare|switch|cancel|downgrade|you could save)\b/i;

export function buildScoutQuery(input: TavilyVendorInput): string {
  const display = (input.display_name ?? "").trim() || prettyVendorName(input.merchant_normalized);
  const query = `${display} pricing change OR new plan OR startup credit OR discount program OR announcement`;
  if (FORBIDDEN_QUERY.test(query)) {
    throw new Error("scout query contained forbidden comparison language");
  }
  return query;
}

export function parsePublishedAt(value: unknown): ISODate | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const iso = /^(\d{4}-\d{2}-\d{2})T/.exec(trimmed);
  if (iso) return iso[1]!;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function mentionsVendor(title: string, url: string, content: string, merchantNormalized: string, displayName: string): boolean {
  const key = merchantNormalized.replace(/[^a-z0-9]/g, "");
  const brand = displayName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const hay = `${title} ${content} ${url}`.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (key.length >= 3 && hay.includes(key)) return true;
  if (brand.length >= 3 && hay.includes(brand)) return true;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/[^a-z0-9]/g, "");
    return (key.length >= 3 && host.includes(key)) || (brand.length >= 3 && host.includes(brand));
  } catch {
    return false;
  }
}

export function claimFromResult(title: string, content: string): string {
  const line = title.trim() || content.split(/(?<=[.!?])\s+/)[0] || content;
  return sanitizeModelText(line, SCOUT.CLAIM_MAX_CHARS);
}

export function findingsFromTavilyBody(
  body: Record<string, unknown> | null,
  input: {
    merchantNormalized: string;
    displayName: string;
    retrievedAt: ISODateTime;
    windowStart: ISODate;
    windowEnd: ISODate;
  },
): ScoutFinding[] {
  const raw = body?.["results"];
  if (!Array.isArray(raw)) return [];
  const out: ScoutFinding[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const url = record?.["url"];
    if (!isHttpUrl(url)) continue;
    const title = typeof record?.["title"] === "string" ? record["title"].trim() : "";
    const content = typeof record?.["content"] === "string" ? record["content"] : "";
    const published = parsePublishedAt(record?.["published_date"] ?? record?.["published_at"]);
    if (!published) continue;
    if (published < input.windowStart || published > input.windowEnd) continue;
    if (!mentionsVendor(title, url, content, input.merchantNormalized, input.displayName)) continue;
    const claim = claimFromResult(title, content);
    if (claim === "") continue;
    out.push({
      kind: "EVIDENCE",
      claim,
      source_url: url.trim(),
      source_title: title || url.trim(),
      published_at: published,
      retrieved_at: input.retrievedAt,
      cached: false,
    });
    if (out.length >= SCOUT.MAX_RESULTS_PER_VENDOR) break;
  }
  return out;
}

export interface ScoutSearchOptions {
  now: () => ISODateTime;
  lookbackDays?: number;
  url?: string;
}

/** One date-filtered Tavily search. Empty findings is a valid result. */
export async function searchScoutVendor(
  apiKey: string,
  input: TavilyVendorInput,
  fetchImpl?: FetchLike,
  options: ScoutSearchOptions = { now: () => new Date().toISOString() },
): Promise<ScoutVendorCache> {
  const doFetch = fetchImpl ?? defaultFetch();
  const retrievedAt = options.now();
  const lookback = options.lookbackDays ?? SCOUT.LOOKBACK_DAYS;
  const windowEnd = retrievedAt.slice(0, 10);
  const windowStart = addDays(windowEnd, -lookback);
  const displayName = (input.display_name ?? "").trim() || prettyVendorName(input.merchant_normalized);

  const body = await tavilySearch(
    apiKey,
    doFetch,
    {
      query: buildScoutQuery(input),
      search_depth: "basic",
      include_answer: false,
      max_results: SCOUT.MAX_RESULTS_PER_VENDOR,
      topic: SCOUT_TOPIC,
      days: lookback,
      start_date: windowStart,
      end_date: windowEnd,
    },
    { url: options.url, name: "tavily-scout" },
  );

  const findings = findingsFromTavilyBody(body, {
    merchantNormalized: input.merchant_normalized,
    displayName,
    retrievedAt,
    windowStart,
    windowEnd,
  });

  return {
    entity: input.merchant_normalized,
    findings,
    empty_window: findings.length === 0,
    retrieved_at: retrievedAt,
  };
}
