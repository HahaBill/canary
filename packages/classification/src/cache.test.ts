import { DEMO, type VendorEnrichment } from "@canary/shared";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MemoryEnrichmentCache,
  isPlaceholderEnrichment,
  isVendorEnrichment,
  parseEnrichmentRecord,
  serializeEnrichmentRecord,
} from "./cache.ts";
import { DEMO_CACHE_FILE, FileEnrichmentCache, demoEnrichmentCache } from "./node.ts";

const enrichment: VendorEnrichment = {
  vendor_name: "Ashby",
  merchant_normalized: "ashby",
  business_type: "Recruiting and applicant tracking software.",
  mapped_category: "RECRUITING",
  source_url: "https://www.ashbyhq.com/",
  source_title: "Ashby",
  retrieved_at: "2026-09-12T17:00:00.000Z",
  cached: false,
};

describe("MemoryEnrichmentCache", () => {
  it("round-trips and marks reads as cached", async () => {
    const cache = new MemoryEnrichmentCache();
    expect(await cache.get("ashby")).toBeNull();

    await cache.set(enrichment);

    expect(await cache.get("ashby")).toEqual({ ...enrichment, cached: true });
    expect(cache.size).toBe(1);
  });

  it("refuses a Scout-namespaced write so corroboration stays isolated", async () => {
    const cache = new MemoryEnrichmentCache([enrichment]);
    await expect(
      cache.set({ ...enrichment, kind: "scout", merchant_normalized: "scout:ashby" }),
    ).rejects.toThrow(/Scout/);
    expect(await cache.get("ashby")).toEqual({ ...enrichment, cached: true });
    expect(await cache.get("scout:ashby")).toBeNull();
  });

  it("seeds from a record or an array and snapshots in key order", async () => {
    const fromArray = new MemoryEnrichmentCache([enrichment]);
    const fromRecord = new MemoryEnrichmentCache({ ashby: enrichment });
    expect(await fromArray.get("ashby")).toEqual(await fromRecord.get("ashby"));

    const many = new MemoryEnrichmentCache([
      { ...enrichment, merchant_normalized: "zeta" },
      { ...enrichment, merchant_normalized: "alpha" },
    ]);
    expect(Object.keys(many.snapshot())).toEqual(["alpha", "zeta"]);
  });

  it("treats a placeholder entry as a miss", async () => {
    const placeholder = { ...enrichment, source_title: "PLACEHOLDER — run seed-cache", mapped_category: "NEEDS_REVIEW" as const };
    expect(isPlaceholderEnrichment(placeholder)).toBe(true);
    expect(await new MemoryEnrichmentCache([placeholder]).get("ashby")).toBeNull();
  });
});

describe("enrichment record serialization", () => {
  it("validates entries and drops malformed ones", () => {
    expect(isVendorEnrichment(enrichment)).toBe(true);
    expect(isVendorEnrichment({ ...enrichment, mapped_category: "NOT_A_CATEGORY" })).toBe(false);
    expect(isVendorEnrichment({ ...enrichment, source_url: 42 })).toBe(false);
    expect(parseEnrichmentRecord({ ashby: enrichment, bogus: { nope: true } })).toEqual({ ashby: enrichment });
    expect(
      parseEnrichmentRecord({
        ashby: enrichment,
        "scout:ashby": { ...enrichment, kind: "scout", merchant_normalized: "scout:ashby" },
      }),
    ).toEqual({ ashby: enrichment });
    expect(parseEnrichmentRecord(null)).toEqual({});
    expect(parseEnrichmentRecord([enrichment])).toEqual({});
  });

  it("writes key-sorted JSON with a trailing newline for stable diffs", () => {
    const text = serializeEnrichmentRecord({ zeta: enrichment, alpha: enrichment });
    expect(text.endsWith("\n")).toBe(true);
    expect(Object.keys(JSON.parse(text) as Record<string, unknown>)).toEqual(["alpha", "zeta"]);
  });
});

describe("FileEnrichmentCache", () => {
  async function tempCache(): Promise<FileEnrichmentCache> {
    const dir = await mkdtemp(join(tmpdir(), "canary-enrichments-"));
    return new FileEnrichmentCache(join(dir, "nested", "enrichments.json"));
  }

  it("reads a missing file as an empty cache", async () => {
    const cache = await tempCache();
    expect(await cache.read()).toEqual({});
    expect(await cache.get("ashby")).toBeNull();
  });

  it("creates the file on write and round-trips through JSON", async () => {
    const cache = await tempCache();
    await cache.set(enrichment);

    expect(await cache.get("ashby")).toEqual({ ...enrichment, cached: true });
    expect(JSON.parse(await readFile(cache.path, "utf8")) as Record<string, VendorEnrichment>).toEqual({ ashby: enrichment });
  });

  it("merges on write instead of clobbering other vendors", async () => {
    const cache = await tempCache();
    await cache.set(enrichment);
    await cache.set({ ...enrichment, merchant_normalized: "acme", vendor_name: "Acme" });

    expect(Object.keys(await cache.read())).toEqual(["acme", "ashby"]);
  });

  it("degrades a corrupt file to a cache miss", async () => {
    const cache = await tempCache();
    await cache.write({});
    await writeFile(cache.path, "{not json", "utf8");

    expect(await cache.read()).toEqual({});
    expect(await cache.get("ashby")).toBeNull();
  });

  it("refuses a Scout write against the committed demo fixture and leaves the file byte-identical", async () => {
    const before = await readFile(DEMO_CACHE_FILE);
    const cache = new FileEnrichmentCache(DEMO_CACHE_FILE);
    await expect(
      cache.set({ ...enrichment, kind: "scout", merchant_normalized: "scout:ashby" }),
    ).rejects.toThrow(/Scout/);
    expect(await readFile(DEMO_CACHE_FILE)).toEqual(before);
    expect(await cache.get("scout:ashby")).toBeNull();
  });
});

describe("committed demo cache", () => {
  it("contains a valid entry for the demo's unknown vendor", async () => {
    const cache = demoEnrichmentCache();
    expect(cache.path).toBe(DEMO_CACHE_FILE);

    const entry = (await cache.read())[DEMO.UNKNOWN_VENDOR.merchant_normalized];
    expect(entry).toBeDefined();
    expect(isVendorEnrichment(entry)).toBe(true);

    if (isPlaceholderEnrichment(entry!)) {
      // Not seeded yet: it must read as a miss so a live lookup still runs.
      expect(await cache.get(DEMO.UNKNOWN_VENDOR.merchant_normalized)).toBeNull();
    } else {
      expect(entry!.source_url).toMatch(/^https?:\/\//);
      expect(entry!.mapped_category).toBe(DEMO.UNKNOWN_VENDOR.expected_category);
      expect((await cache.get(DEMO.UNKNOWN_VENDOR.merchant_normalized))!.cached).toBe(true);
    }
  });
});
