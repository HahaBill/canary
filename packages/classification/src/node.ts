/**
 * Node-only surface. Everything that touches `node:fs` lives here so
 * `core.ts` stays importable from a Cloudflare Worker (which imports
 * `@canary/classification/core`).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { EnrichmentCache, ScoutCacheFile, ScoutVendorCache, VendorEnrichment } from "@canary/shared";
import {
  emptyScoutCache,
  isScoutEnrichment,
  isScoutEnrichmentKey,
  parseScoutCacheFile,
  serializeScoutCacheFile,
} from "@canary/shared";
import { isPlaceholderEnrichment, parseEnrichmentRecord, serializeEnrichmentRecord, type EnrichmentRecord } from "./cache.ts";
import { parseJsonSafe } from "./http.ts";

/** The committed demo cache: `packages/classification/cache/enrichments.json`. */
export const DEMO_CACHE_FILE: string = fileURLToPath(new URL("../cache/enrichments.json", import.meta.url));

/**
 * Offline Scout seed helper (kind: "scout" JSON). The Worker reads the
 * committed copy from `packages/pipeline/cache/scout.json` — not this path,
 * and not a new storage binding. Live Refresh writes D1 `vendor_enrichments`
 * under `scout:` keys.
 */
export const DEMO_SCOUT_CACHE_FILE: string = fileURLToPath(new URL("../cache/scout.json", import.meta.url));

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

/**
 * JSON-file enrichment cache: `{ [merchant_normalized]: VendorEnrichment }`.
 * A missing or corrupt file reads as an empty cache — a cache miss, never a crash.
 */
export class FileEnrichmentCache implements EnrichmentCache {
  readonly path: string;

  constructor(path: string | URL = DEMO_CACHE_FILE) {
    this.path = typeof path === "string" ? path : fileURLToPath(path);
  }

  async read(): Promise<EnrichmentRecord> {
    try {
      return parseEnrichmentRecord(parseJsonSafe(await readFile(this.path, "utf8")));
    } catch (error) {
      if (isNotFound(error)) return {};
      throw error;
    }
  }

  async get(merchantNormalized: string): Promise<VendorEnrichment | null> {
    if (isScoutEnrichmentKey(merchantNormalized)) return null;
    const hit = (await this.read())[merchantNormalized];
    if (hit === undefined || isPlaceholderEnrichment(hit) || isScoutEnrichment(hit)) return null;
    return { ...hit, cached: true };
  }

  /** Read–modify–write so one vendor's refresh never drops the others. */
  async set(enrichment: VendorEnrichment): Promise<void> {
    if (isScoutEnrichment(enrichment) || isScoutEnrichmentKey(enrichment.merchant_normalized)) {
      throw new Error("refusing to write a Scout row into the corroboration cache");
    }
    const record = await this.read();
    record[enrichment.merchant_normalized] = enrichment;
    await this.write(record);
  }

  async write(record: EnrichmentRecord): Promise<void> {
    const corroboration: EnrichmentRecord = {};
    for (const [key, entry] of Object.entries(record)) {
      if (!isScoutEnrichmentKey(key) && !isScoutEnrichment(entry)) corroboration[key] = entry;
    }
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, serializeEnrichmentRecord(corroboration), "utf8");
  }
}

/** The committed demo cache, ready to pass as `ClassifyOptions.cache`. */
export function demoEnrichmentCache(): FileEnrichmentCache {
  return new FileEnrichmentCache(DEMO_CACHE_FILE);
}

/**
 * JSON-file Scout cache (`kind: "scout"`). Writes go here, never to
 * `DEMO_CACHE_FILE`. The Worker offline path is the committed pipeline seed.
 */
export class FileScoutCache {
  readonly path: string;

  constructor(path: string | URL = DEMO_SCOUT_CACHE_FILE) {
    this.path = typeof path === "string" ? path : fileURLToPath(path);
  }

  async read(): Promise<ScoutCacheFile> {
    try {
      return parseScoutCacheFile(parseJsonSafe(await readFile(this.path, "utf8")));
    } catch (error) {
      if (isNotFound(error)) return emptyScoutCache("1970-01-01T00:00:00.000Z");
      throw error;
    }
  }

  async get(entity: string): Promise<ScoutVendorCache | null> {
    return (await this.read()).vendors[entity] ?? null;
  }

  async set(brief: ScoutVendorCache): Promise<void> {
    const file = await this.read();
    file.vendors[brief.entity] = brief;
    file.retrieved_at = brief.retrieved_at;
    await this.write(file);
  }

  async write(file: ScoutCacheFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, serializeScoutCacheFile(file), "utf8");
  }
}
