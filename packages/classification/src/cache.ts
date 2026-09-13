/**
 * Enrichment caches (contract §13: "cache the successful result for fallback").
 *
 * The demo must not depend on a live Tavily call at showtime, and a cached hit
 * must stay honest about being cached — the incident page labels it
 * "previously retrieved". Both caches therefore force `cached: true` on read.
 *
 * Runtime-agnostic; the on-disk cache lives in `node.ts`.
 */
import {
  CATEGORIES,
  isScoutEnrichment,
  isScoutEnrichmentKey,
  type Category,
  type EnrichmentCache,
  type VendorEnrichment,
} from "@canary/shared";

/** `{ [merchant_normalized]: VendorEnrichment }` — the on-disk/JSON shape. */
export type EnrichmentRecord = Record<string, VendorEnrichment>;

function isCategory(value: unknown): value is Category {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
}

/** Structural check so a hand-edited cache file can never inject a bad category. */
export function isVendorEnrichment(value: unknown): value is VendorEnrichment {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["vendor_name"] === "string" &&
    typeof v["merchant_normalized"] === "string" &&
    typeof v["business_type"] === "string" &&
    isCategory(v["mapped_category"]) &&
    typeof v["source_url"] === "string" &&
    typeof v["source_title"] === "string" &&
    typeof v["retrieved_at"] === "string"
  );
}

/**
 * Marker for the committed-but-unseeded cache entry. A placeholder is NOT a
 * cached result: both caches report it as a miss so a real lookup still runs
 * and the demo never cites `example.invalid` as corroboration.
 */
export const PLACEHOLDER_MARKER = "PLACEHOLDER";

export function isPlaceholderEnrichment(enrichment: VendorEnrichment): boolean {
  return enrichment.source_title.startsWith(PLACEHOLDER_MARKER) || enrichment.business_type.startsWith(PLACEHOLDER_MARKER);
}

function isCorroborationEntry(key: string, entry: VendorEnrichment): boolean {
  return !isScoutEnrichmentKey(key) && !isScoutEnrichment(entry);
}

/** Drops anything malformed rather than throwing: a corrupt cache degrades to a cache miss. */
export function parseEnrichmentRecord(value: unknown): EnrichmentRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: EnrichmentRecord = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isVendorEnrichment(entry) && isCorroborationEntry(key, entry)) out[key] = entry;
  }
  return out;
}

/** Key-sorted so the committed cache file has stable diffs. */
export function serializeEnrichmentRecord(record: EnrichmentRecord): string {
  const sorted: EnrichmentRecord = {};
  for (const key of Object.keys(record).sort()) sorted[key] = record[key]!;
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

export class MemoryEnrichmentCache implements EnrichmentCache {
  #entries = new Map<string, VendorEnrichment>();

  constructor(seed?: EnrichmentRecord | readonly VendorEnrichment[]) {
    if (Array.isArray(seed)) {
      for (const entry of seed) {
        if (isCorroborationEntry(entry.merchant_normalized, entry)) {
          this.#entries.set(entry.merchant_normalized, entry);
        }
      }
    } else if (seed) {
      for (const [key, entry] of Object.entries(seed)) {
        if (isCorroborationEntry(key, entry)) this.#entries.set(key, entry);
      }
    }
  }

  async get(merchantNormalized: string): Promise<VendorEnrichment | null> {
    if (isScoutEnrichmentKey(merchantNormalized)) return null;
    const hit = this.#entries.get(merchantNormalized);
    if (hit === undefined || isPlaceholderEnrichment(hit) || isScoutEnrichment(hit)) return null;
    return { ...hit, cached: true };
  }

  async set(enrichment: VendorEnrichment): Promise<void> {
    if (isScoutEnrichment(enrichment) || isScoutEnrichmentKey(enrichment.merchant_normalized)) {
      throw new Error("refusing to write a Scout row into the corroboration cache");
    }
    this.#entries.set(enrichment.merchant_normalized, enrichment);
  }

  get size(): number {
    return this.#entries.size;
  }

  snapshot(): EnrichmentRecord {
    const record: EnrichmentRecord = {};
    for (const key of [...this.#entries.keys()].sort()) record[key] = this.#entries.get(key)!;
    return record;
  }
}
