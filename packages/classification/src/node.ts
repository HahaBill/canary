/**
 * Node-only surface. Everything that touches `node:fs` lives here so
 * `core.ts` stays importable from a Cloudflare Worker (which imports
 * `@canary/classification/core`).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { EnrichmentCache, VendorEnrichment } from "@canary/shared";
import { isPlaceholderEnrichment, parseEnrichmentRecord, serializeEnrichmentRecord, type EnrichmentRecord } from "./cache.ts";
import { parseJsonSafe } from "./http.ts";

/** The committed demo cache: `packages/classification/cache/enrichments.json`. */
export const DEMO_CACHE_FILE: string = fileURLToPath(new URL("../cache/enrichments.json", import.meta.url));

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
    const hit = (await this.read())[merchantNormalized];
    if (hit === undefined || isPlaceholderEnrichment(hit)) return null;
    return { ...hit, cached: true };
  }

  /** Read–modify–write so one vendor's refresh never drops the others. */
  async set(enrichment: VendorEnrichment): Promise<void> {
    const record = await this.read();
    record[enrichment.merchant_normalized] = enrichment;
    await this.write(record);
  }

  async write(record: EnrichmentRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, serializeEnrichmentRecord(record), "utf8");
  }
}

/** The committed demo cache, ready to pass as `ClassifyOptions.cache`. */
export function demoEnrichmentCache(): FileEnrichmentCache {
  return new FileEnrichmentCache(DEMO_CACHE_FILE);
}
