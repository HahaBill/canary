import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FileEnrichmentCache, FileScoutCache } from "@canary/classification";
import { afterEach, describe, expect, it } from "vitest";
import { loadDemoCaches, loadDemoScoutCache } from "./caches.ts";

const ENRICHMENTS = resolve(dirname(fileURLToPath(import.meta.url)), "../cache/enrichments.json");

describe("demo enrichment fixture vs Scout", () => {
  const temps: string[] = [];

  afterEach(async () => {
    await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("keeps the committed corroboration fixture unchanged after a Scout cache write", async () => {
    const before = await readFile(ENRICHMENTS);
    const dir = await mkdtemp(join(tmpdir(), "canary-scout-"));
    temps.push(dir);

    await new FileScoutCache(join(dir, "scout.json")).set({
      entity: "aws",
      findings: [],
      empty_window: true,
      retrieved_at: "2026-09-14T12:00:00.000Z",
    });

    expect(await readFile(ENRICHMENTS)).toEqual(before);
  });

  it("refuses a Scout write into the committed corroboration fixture", async () => {
    const before = await readFile(ENRICHMENTS);
    await expect(
      new FileEnrichmentCache(ENRICHMENTS).set({
        kind: "scout",
        vendor_name: "AWS",
        merchant_normalized: "scout:aws",
        business_type: "",
        mapped_category: "NEEDS_REVIEW",
        source_url: "",
        source_title: "NOTHING_DATED",
        retrieved_at: "2026-09-14T12:00:00.000Z",
        cached: true,
      }),
    ).rejects.toThrow(/Scout/);
    expect(await readFile(ENRICHMENTS)).toEqual(before);
  });

  it("loads Scout from a kind:scout document, not from enrichments.json", async () => {
    const caches = await loadDemoCaches();
    const scout = loadDemoScoutCache();
    expect(scout.kind).toBe("scout");
    expect(caches.cachedEnrichments.some((e) => "claim" in e)).toBe(false);
    expect(JSON.stringify(scout)).not.toMatch(/business_type/);
  });
});
