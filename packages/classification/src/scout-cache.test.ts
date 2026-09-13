import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ScoutFinding } from "@canary/shared";
import { MemoryEnrichmentCache } from "./cache.ts";
import { DEMO_CACHE_FILE, FileEnrichmentCache, FileScoutCache } from "./node.ts";

const NOW = "2026-09-14T12:00:00.000Z";

const FINDING: ScoutFinding = {
  kind: "EVIDENCE",
  claim: "AWS announced a new plan.",
  source_url: "https://aws.amazon.com/blogs/aws/new-plan",
  source_title: "New plan",
  published_at: "2026-08-01",
  retrieved_at: NOW,
  cached: false,
};

describe("Scout cache isolation", () => {
  const temps: string[] = [];

  afterEach(async () => {
    await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("writes a kind:scout file and leaves the demo corroboration fixture byte-identical", async () => {
    const before = await readFile(DEMO_CACHE_FILE);
    const dir = await mkdtemp(join(tmpdir(), "canary-scout-"));
    temps.push(dir);
    const path = join(dir, "scout.json");

    const cache = new FileScoutCache(path);
    await cache.set({ entity: "aws", findings: [FINDING], empty_window: false, retrieved_at: NOW });

    expect(await readFile(DEMO_CACHE_FILE)).toEqual(before);
    expect(path).not.toBe(DEMO_CACHE_FILE);

    const written = JSON.parse(await readFile(path, "utf8")) as { kind: string; vendors: Record<string, unknown> };
    expect(written.kind).toBe("scout");
    expect(written.vendors["aws"]).toBeDefined();
    expect(JSON.stringify(written)).not.toMatch(/business_type/);
  });

  it("does not share a MemoryEnrichmentCache with Scout findings", async () => {
    const enrichments = new MemoryEnrichmentCache({
      ashby: {
        vendor_name: "Ashby",
        merchant_normalized: "ashby",
        business_type: "Recruiting software",
        mapped_category: "RECRUITING",
        source_url: "https://www.ashbyhq.com/",
        source_title: "Ashby",
        retrieved_at: NOW,
        cached: true,
      },
    });
    const before = enrichments.snapshot();

    // Scout writes go to a different store on purpose. This is the invariant
    // a mixed-up caller would break — we assert the enrichment snapshot is
    // untouched after a Scout-shaped write is constructed next to it.
    const scout = new FileScoutCache(join(await mkdtemp(join(tmpdir(), "canary-scout-")).then((d) => (temps.push(d), d)), "scout.json"));
    await scout.set({ entity: "ashby", findings: [FINDING], empty_window: false, retrieved_at: NOW });

    expect(enrichments.snapshot()).toEqual(before);
    expect(await enrichments.get("ashby")).toMatchObject({ merchant_normalized: "ashby", business_type: "Recruiting software" });
  });

  it("cannot overwrite the demo corroboration fixture via FileEnrichmentCache", async () => {
    const before = await readFile(DEMO_CACHE_FILE);
    const cache = new FileEnrichmentCache(DEMO_CACHE_FILE);
    await expect(
      cache.set({
        kind: "scout",
        vendor_name: "Ashby",
        merchant_normalized: "scout:ashby",
        business_type: FINDING.claim,
        mapped_category: "NEEDS_REVIEW",
        source_url: FINDING.source_url,
        source_title: FINDING.source_title,
        retrieved_at: NOW,
        published_at: FINDING.published_at,
        cached: false,
      }),
    ).rejects.toThrow(/Scout/);
    expect(await readFile(DEMO_CACHE_FILE)).toEqual(before);
    expect(await cache.get("ashby")).not.toBeNull();
  });
});
