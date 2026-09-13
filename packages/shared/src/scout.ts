/**
 * Scout — dated external changes at vendors we already pay (PRD §11 P1).
 *
 * The language layer only chooses which ledger vendors to research and which
 * Tavily rows to keep. It never computes spend, never ranks a vendor we do
 * not pay, and never invents a published date.
 */
import { SCOUT } from "./config.ts";
import type { Cents, EvidenceItem, ISODate, ISODateTime, VendorEnrichment } from "./types.ts";

export const SCOUT_CACHE_KIND = "scout" as const;
/** D1 / enrichment-map key prefix. `ashby` stays the P0 corroboration row. */
export const SCOUT_KEY_PREFIX = "scout:";
/** `source_title` on a Scout enrichment that means we searched and found nothing dated. */
export const SCOUT_EMPTY_WINDOW = "NOTHING_DATED";

/** One dated source. Same evidence fields as a Tavily enrichment, plus a claim and a published date. */
export interface ScoutFinding {
  kind: "EVIDENCE";
  claim: string;
  source_url: string;
  source_title: string;
  published_at: ISODate;
  retrieved_at: ISODateTime;
  cached: boolean;
}

/** Per-vendor research stored on disk / D1. Spend is never cached — it is re-read from the ledger. */
export interface ScoutVendorCache {
  entity: string;
  findings: ScoutFinding[];
  /** True when we searched and nothing dated survived the filter. A valid result. */
  empty_window: boolean;
  retrieved_at: ISODateTime;
}

export interface ScoutCacheFile {
  kind: typeof SCOUT_CACHE_KIND;
  lookback_days: number;
  retrieved_at: ISODateTime;
  vendors: Record<string, ScoutVendorCache>;
}

export interface ScoutVendorCard {
  entity: string;
  display_name: string;
  /** Trailing weekly variable spend from the burn window. OBSERVED. */
  trailing_weekly_cents: Cents;
  window_start: ISODate;
  window_end: ISODate;
  findings: ScoutFinding[];
  /** Findings projected as taxonomy EVIDENCE items (same shape the incident page uses). */
  evidence: EvidenceItem[];
  /**
   * True only after Tavily has been asked for this vendor. A cache miss is
   * "not yet searched", not an empty dated window.
   */
  searched: boolean;
  /** Exact Tavily query. Deterministic from the display name — never invented per result. */
  query: string;
  /** Searched, and nothing dated survived the lookback filter. A valid result. */
  empty_window: boolean;
  retrieved_at: ISODateTime;
  cached: boolean;
}

export interface ScoutPage {
  vendors: ScoutVendorCard[];
  lookback_days: number;
  retrieved_at: ISODateTime;
  cached: boolean;
  /** True when selected vendors exist and none of them have been sent to Tavily. */
  never_searched: boolean;
  whatif_incident_id: string | null;
  /** Live Tavily calls made while assembling this page (0 on GET). */
  tavily_calls: number;
  /** Present when Refresh could not call Tavily; the page still renders from cache. */
  refresh_error?: string;
}

/**
 * The Tavily news query for a vendor we already pay. Pricing / plan / credits /
 * announcements only — never a cheaper-alternative prompt (AGENT_BEHAVIOR §4).
 */
export function scoutResearchQuery(displayName: string): string {
  return `${displayName} pricing change OR new plan OR startup credit OR discount program OR announcement`;
}

/**
 * Top N monitored variable-spend vendors by trailing weekly spend, above the
 * config floor. Deterministic: spend desc, then entity key asc. No vendor
 * names are hardcoded here.
 */
export function selectScoutVendors(
  weeklyVariableByEntity: Record<string, Cents>,
  options: { max?: number; floorCents?: number } = {},
): string[] {
  const max = options.max ?? SCOUT.MAX_VENDORS;
  const floor = options.floorCents ?? SCOUT.MIN_TRAILING_WEEKLY_CENTS;
  return Object.entries(weeklyVariableByEntity)
    .filter(([, cents]) => cents >= floor)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, max)
    .map(([entity]) => entity);
}

export function scoutEnrichmentKey(entity: string, index?: number): string {
  const rest = entity.startsWith(SCOUT_KEY_PREFIX) ? entity.slice(SCOUT_KEY_PREFIX.length) : entity;
  return index === undefined ? `${SCOUT_KEY_PREFIX}${rest}` : `${SCOUT_KEY_PREFIX}${rest}:${index}`;
}

export function isScoutEnrichmentKey(key: string): boolean {
  return key.startsWith(SCOUT_KEY_PREFIX);
}

export function entityFromScoutKey(key: string): string | null {
  if (!isScoutEnrichmentKey(key)) return null;
  const rest = key.slice(SCOUT_KEY_PREFIX.length);
  const indexed = /^(.+):(\d+)$/.exec(rest);
  return indexed?.[1] ?? rest;
}

export function isScoutEnrichment(enrichment: VendorEnrichment): boolean {
  return enrichment.kind === "scout" || isScoutEnrichmentKey(enrichment.merchant_normalized);
}

/** One VendorEnrichment per finding (or one empty-window sentinel). Same shape as P0 corroboration. */
export function briefToEnrichments(brief: ScoutVendorCache, displayName: string): VendorEnrichment[] {
  if (brief.findings.length === 0) {
    return [
      {
        kind: "scout",
        vendor_name: displayName,
        merchant_normalized: scoutEnrichmentKey(brief.entity),
        business_type: "",
        mapped_category: "NEEDS_REVIEW",
        source_url: "",
        source_title: SCOUT_EMPTY_WINDOW,
        retrieved_at: brief.retrieved_at,
        cached: true,
      },
    ];
  }
  return brief.findings.map((finding, index) => ({
    kind: "scout" as const,
    vendor_name: displayName,
    merchant_normalized: scoutEnrichmentKey(brief.entity, index),
    business_type: finding.claim,
    mapped_category: "NEEDS_REVIEW" as const,
    source_url: finding.source_url,
    source_title: finding.source_title,
    retrieved_at: finding.retrieved_at,
    published_at: finding.published_at,
    snippet: finding.published_at,
    cached: finding.cached,
  }));
}

export function enrichmentToFinding(enrichment: VendorEnrichment): ScoutFinding | null {
  if (!isScoutEnrichment(enrichment)) return null;
  if (enrichment.source_title === SCOUT_EMPTY_WINDOW || enrichment.source_url === "") return null;
  const published = enrichment.published_at ?? (enrichment.snippet && /^\d{4}-\d{2}-\d{2}$/.test(enrichment.snippet) ? enrichment.snippet : null);
  if (!published) return null;
  return {
    kind: "EVIDENCE",
    claim: enrichment.business_type,
    source_url: enrichment.source_url,
    source_title: enrichment.source_title,
    published_at: published,
    retrieved_at: enrichment.retrieved_at,
    cached: enrichment.cached,
  };
}

export function enrichmentsToScoutCache(rows: readonly VendorEnrichment[], now: ISODateTime): ScoutCacheFile {
  const file = emptyScoutCache(now);
  const byEntity = new Map<string, VendorEnrichment[]>();
  for (const row of rows) {
    if (!isScoutEnrichment(row)) continue;
    const entity = entityFromScoutKey(row.merchant_normalized);
    if (!entity) continue;
    const list = byEntity.get(entity) ?? [];
    list.push(row);
    byEntity.set(entity, list);
    if (row.retrieved_at > file.retrieved_at || file.retrieved_at === "1970-01-01T00:00:00.000Z") {
      file.retrieved_at = row.retrieved_at;
    }
  }
  for (const [entity, list] of byEntity) {
    const findings = list
      .map(enrichmentToFinding)
      .filter((finding): finding is ScoutFinding => finding !== null);
    const retrieved = list.reduce((latest, row) => (row.retrieved_at > latest ? row.retrieved_at : latest), list[0]!.retrieved_at);
    file.vendors[entity] = { entity, findings, empty_window: findings.length === 0, retrieved_at: retrieved };
  }
  return file;
}

export function scoutFindingToEvidence(finding: ScoutFinding): EvidenceItem {
  return {
    kind: "EVIDENCE",
    text: finding.claim,
    source_url: finding.source_url,
    source_title: finding.source_title,
    retrieved_at: finding.retrieved_at,
    published_at: finding.published_at,
    cached: finding.cached,
  };
}

export function emptyScoutCache(now: ISODateTime): ScoutCacheFile {
  return { kind: SCOUT_CACHE_KIND, lookback_days: SCOUT.LOOKBACK_DAYS, retrieved_at: now, vendors: {} };
}

export function isScoutCacheFile(value: unknown): value is ScoutCacheFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record["kind"] === SCOUT_CACHE_KIND && typeof record["vendors"] === "object" && record["vendors"] !== null;
}

/** Drops malformed entries. A corrupt cache degrades to empty, never a crash. */
export function parseScoutCacheFile(value: unknown): ScoutCacheFile {
  if (!isScoutCacheFile(value)) return emptyScoutCache("1970-01-01T00:00:00.000Z");
  const vendors: Record<string, ScoutVendorCache> = {};
  for (const [key, entry] of Object.entries(value.vendors)) {
    const parsed = parseScoutVendorCache(key, entry);
    if (parsed) vendors[key] = parsed;
  }
  return {
    kind: SCOUT_CACHE_KIND,
    lookback_days: typeof value.lookback_days === "number" ? value.lookback_days : SCOUT.LOOKBACK_DAYS,
    retrieved_at: typeof value.retrieved_at === "string" ? value.retrieved_at : "1970-01-01T00:00:00.000Z",
    vendors,
  };
}

function parseScoutVendorCache(entity: string, value: unknown): ScoutVendorCache | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const retrievedAt = record["retrieved_at"];
  if (typeof retrievedAt !== "string") return null;
  const findings: ScoutFinding[] = [];
  if (Array.isArray(record["findings"])) {
    for (const item of record["findings"]) {
      const finding = parseScoutFinding(item);
      if (finding) findings.push(finding);
    }
  }
  return {
    entity: typeof record["entity"] === "string" ? record["entity"] : entity,
    findings,
    empty_window: record["empty_window"] === true || findings.length === 0,
    retrieved_at: retrievedAt,
  };
}

function parseScoutFinding(value: unknown): ScoutFinding | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record["claim"] !== "string") return null;
  if (typeof record["source_url"] !== "string") return null;
  if (typeof record["source_title"] !== "string") return null;
  if (typeof record["published_at"] !== "string") return null;
  if (typeof record["retrieved_at"] !== "string") return null;
  return {
    kind: "EVIDENCE",
    claim: record["claim"],
    source_url: record["source_url"],
    source_title: record["source_title"],
    published_at: record["published_at"],
    retrieved_at: record["retrieved_at"],
    cached: record["cached"] === true,
  };
}

/** Overlay wins per vendor. Used to layer a Refresh write over the committed demo cache. */
export function mergeScoutCaches(base: ScoutCacheFile, overlay: ScoutCacheFile): ScoutCacheFile {
  return {
    kind: SCOUT_CACHE_KIND,
    lookback_days: overlay.lookback_days || base.lookback_days,
    retrieved_at: overlay.retrieved_at > base.retrieved_at ? overlay.retrieved_at : base.retrieved_at,
    vendors: { ...base.vendors, ...overlay.vendors },
  };
}

export function scoutCacheFresh(retrievedAt: ISODateTime, now: ISODateTime, ttlHours = SCOUT.TTL_HOURS): boolean {
  const ageMs = Date.parse(now) - Date.parse(retrievedAt);
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < ttlHours * 3_600_000;
}

/** Key-sorted so the committed cache file has stable diffs. */
export function serializeScoutCacheFile(cache: ScoutCacheFile): string {
  const vendors: Record<string, ScoutVendorCache> = {};
  for (const key of Object.keys(cache.vendors).sort()) vendors[key] = cache.vendors[key]!;
  return `${JSON.stringify({ ...cache, kind: SCOUT_CACHE_KIND, vendors }, null, 2)}\n`;
}

export function markScoutFindingsCached(cache: ScoutVendorCache): ScoutVendorCache {
  return {
    ...cache,
    findings: cache.findings.map((finding) => ({ ...finding, cached: true })),
  };
}

export function assembleScoutPage(input: {
  weeklyVariableByEntity: Record<string, Cents>;
  windowStart: ISODate;
  windowEnd: ISODate;
  whatifIncidentId: string | null;
  cache: ScoutCacheFile;
  now: ISODateTime;
  displayName: (entity: string) => string;
  tavilyCalls?: number;
  refreshError?: string;
  /** Entity keys Tavily was asked about on this request. Findings stay uncached. */
  freshEntities?: readonly string[];
}): ScoutPage {
  const fresh = new Set(input.freshEntities ?? []);
  const entities = selectScoutVendors(input.weeklyVariableByEntity);
  const vendors: ScoutVendorCard[] = entities.map((entity) => {
    const hit = input.cache.vendors[entity];
    const searched = Boolean(hit);
    const justFetched = fresh.has(entity);
    const brief = hit ?? {
      entity,
      findings: [] as ScoutFinding[],
      empty_window: false,
      retrieved_at: input.cache.retrieved_at,
    };
    const findings = brief.findings.map((finding) => ({ ...finding, cached: !justFetched }));
    const display = input.displayName(entity);
    return {
      entity,
      display_name: display,
      trailing_weekly_cents: input.weeklyVariableByEntity[entity] ?? 0,
      window_start: input.windowStart,
      window_end: input.windowEnd,
      findings,
      evidence: findings.map(scoutFindingToEvidence),
      searched,
      query: scoutResearchQuery(display),
      empty_window: searched && (brief.empty_window || findings.length === 0),
      retrieved_at: brief.retrieved_at,
      cached: !justFetched,
    };
  });

  const searchedVendors = vendors.filter((card) => card.searched);
  const page: ScoutPage = {
    vendors,
    lookback_days: SCOUT.LOOKBACK_DAYS,
    retrieved_at: searchedVendors.reduce(
      (latest, card) => (card.retrieved_at > latest ? card.retrieved_at : latest),
      searchedVendors[0]?.retrieved_at ?? input.cache.retrieved_at,
    ),
    cached: (input.tavilyCalls ?? 0) === 0,
    never_searched: vendors.length > 0 && searchedVendors.length === 0,
    whatif_incident_id: input.whatifIncidentId,
    tavily_calls: input.tavilyCalls ?? 0,
  };
  if (input.refreshError) page.refresh_error = input.refreshError;
  return page;
}
