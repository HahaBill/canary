import { describe, expect, it } from "vitest";
import { SCOUT } from "./config.ts";
import {
  assembleScoutPage,
  briefToEnrichments,
  emptyScoutCache,
  enrichmentsToScoutCache,
  entityFromScoutKey,
  isScoutCacheFile,
  isScoutEnrichmentKey,
  mergeScoutCaches,
  parseScoutCacheFile,
  scoutCacheFresh,
  scoutEnrichmentKey,
  scoutFindingToEvidence,
  selectScoutVendors,
  type ScoutCacheFile,
  type ScoutFinding,
} from "./scout.ts";

const NOW = "2026-09-14T12:00:00.000Z";

function finding(over: Partial<ScoutFinding> = {}): ScoutFinding {
  return {
    kind: "EVIDENCE",
    claim: "AWS announced a new plan.",
    source_url: "https://aws.amazon.com/blogs/aws/new-plan",
    source_title: "New plan",
    published_at: "2026-08-01",
    retrieved_at: NOW,
    cached: false,
    ...over,
  };
}

describe("selectScoutVendors", () => {
  const spend = {
    aws: 680_000,
    upwork: 250_000,
    datadog: 85_000,
    ashby: 65_000,
    doordash: 24_000,
    figma: 12_000,
  };

  it("takes the top N above the floor, not a hardcoded list", () => {
    expect(selectScoutVendors(spend)).toEqual(["aws", "upwork", "datadog", "ashby"]);
    expect(selectScoutVendors(spend)).not.toContain("doordash");
    expect(selectScoutVendors(spend)).not.toContain("figma");
  });

  it("honours a tighter max and a different floor without naming vendors", () => {
    expect(selectScoutVendors(spend, { max: 2 })).toEqual(["aws", "upwork"]);
    expect(selectScoutVendors(spend, { floorCents: 20_000 })).toEqual([
      "aws",
      "upwork",
      "datadog",
      "ashby",
      "doordash",
    ]);
  });

  it("breaks spend ties on the entity key so two runs stay byte-identical", () => {
    expect(selectScoutVendors({ zeta: 80_000, alpha: 80_000, mid: 90_000 })).toEqual(["mid", "alpha", "zeta"]);
  });

  it("returns nothing when nobody clears the floor", () => {
    expect(selectScoutVendors({ snacks: 1_000 })).toEqual([]);
  });
});

describe("scout cache", () => {
  it("rejects an enrichment-shaped record so the corroboration fixture cannot be read as Scout", () => {
    expect(
      isScoutCacheFile({
        ashby: { vendor_name: "Ashby", merchant_normalized: "ashby", business_type: "ATS" },
      }),
    ).toBe(false);
    expect(parseScoutCacheFile({ ashby: { business_type: "ATS" } }).vendors).toEqual({});
  });

  it("keeps only well-formed dated findings", () => {
    const parsed = parseScoutCacheFile({
      kind: "scout",
      lookback_days: SCOUT.LOOKBACK_DAYS,
      retrieved_at: NOW,
      vendors: {
        aws: {
          entity: "aws",
          empty_window: false,
          retrieved_at: NOW,
          findings: [finding(), { claim: "no date" }, finding({ published_at: "2026-07-15", source_url: "https://aws.amazon.com/b" })],
        },
      },
    });
    expect(parsed.vendors["aws"]!.findings).toHaveLength(2);
  });

  it("lets an overlay replace one vendor without dropping the others", () => {
    const base: ScoutCacheFile = {
      kind: "scout",
      lookback_days: 90,
      retrieved_at: "2026-09-01T00:00:00.000Z",
      vendors: { aws: { entity: "aws", findings: [], empty_window: true, retrieved_at: "2026-09-01T00:00:00.000Z" } },
    };
    const overlay: ScoutCacheFile = {
      kind: "scout",
      lookback_days: 90,
      retrieved_at: NOW,
      vendors: { datadog: { entity: "datadog", findings: [finding()], empty_window: false, retrieved_at: NOW } },
    };
    const merged = mergeScoutCaches(base, overlay);
    expect(Object.keys(merged.vendors).sort()).toEqual(["aws", "datadog"]);
    expect(merged.retrieved_at).toBe(NOW);
  });

  it("treats a cache younger than the TTL as fresh", () => {
    expect(scoutCacheFresh(NOW, NOW)).toBe(true);
    expect(scoutCacheFresh("2026-09-13T13:00:00.000Z", NOW)).toBe(true);
    expect(scoutCacheFresh("2026-09-13T12:00:00.000Z", NOW)).toBe(false);
  });
});

describe("scout enrichment keys", () => {
  it("namespaces Scout rows so they cannot collide with a corroboration key", () => {
    expect(scoutEnrichmentKey("ashby")).toBe("scout:ashby");
    expect(scoutEnrichmentKey("ashby", 0)).toBe("scout:ashby:0");
    expect(isScoutEnrichmentKey("ashby")).toBe(false);
    expect(isScoutEnrichmentKey("scout:ashby")).toBe(true);
    expect(entityFromScoutKey("scout:gusto_payroll:2")).toBe("gusto_payroll");
    expect(entityFromScoutKey("ashby")).toBeNull();
  });

  it("round-trips a brief through the VendorEnrichment shape", () => {
    const brief = {
      entity: "aws",
      findings: [finding()],
      empty_window: false,
      retrieved_at: NOW,
    };
    const rows = briefToEnrichments(brief, "AWS");
    expect(rows.every((row) => row.kind === "scout")).toBe(true);
    expect(rows.every((row) => row.merchant_normalized.startsWith("scout:"))).toBe(true);
    expect(rows[0]).toMatchObject({
      vendor_name: "AWS",
      business_type: "AWS announced a new plan.",
      published_at: "2026-08-01",
      source_url: "https://aws.amazon.com/blogs/aws/new-plan",
    });
    const back = enrichmentsToScoutCache(rows, NOW);
    expect(back.vendors["aws"]!.findings).toHaveLength(1);
    expect(back.vendors["aws"]!.findings[0]!.published_at).toBe("2026-08-01");
  });

  it("stores an empty window as a sentinel that cannot be read as corroboration", () => {
    const rows = briefToEnrichments(
      { entity: "ashby", findings: [], empty_window: true, retrieved_at: NOW },
      "Ashby",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.merchant_normalized).toBe("scout:ashby");
    expect(rows[0]!.source_title).toBe("NOTHING_DATED");
    expect(enrichmentsToScoutCache(rows, NOW).vendors["ashby"]).toMatchObject({
      empty_window: true,
      findings: [],
    });
  });
});

describe("assembleScoutPage", () => {
  it("reads spend from the ledger and labels a missing cache as an empty window", () => {
    const page = assembleScoutPage({
      weeklyVariableByEntity: { aws: 680_000, snacks: 1_000 },
      windowStart: "2026-06-29",
      windowEnd: "2026-09-13",
      whatifIncidentId: "inc_1",
      cache: emptyScoutCache(NOW),
      now: NOW,
      displayName: (entity) => (entity === "aws" ? "AWS" : entity),
    });

    expect(page.vendors).toHaveLength(1);
    expect(page.vendors[0]).toMatchObject({
      entity: "aws",
      display_name: "AWS",
      trailing_weekly_cents: 680_000,
      empty_window: true,
      cached: true,
    });
    expect(page.vendors[0]!.display_name).not.toBe("aws");
    expect(page.tavily_calls).toBe(0);
    expect(page.whatif_incident_id).toBe("inc_1");
  });

  it("projects findings as taxonomy EVIDENCE without inventing amounts", () => {
    const cached = finding({ cached: false });
    const page = assembleScoutPage({
      weeklyVariableByEntity: { aws: 680_000 },
      windowStart: "2026-06-29",
      windowEnd: "2026-09-13",
      whatifIncidentId: null,
      cache: {
        kind: "scout",
        lookback_days: 90,
        retrieved_at: NOW,
        vendors: { aws: { entity: "aws", findings: [cached], empty_window: false, retrieved_at: NOW } },
      },
      now: NOW,
      displayName: () => "AWS",
    });

    expect(page.vendors[0]!.evidence).toEqual([scoutFindingToEvidence({ ...cached, cached: true })]);
    expect(page.vendors[0]!.evidence[0]!.kind).toBe("EVIDENCE");
    expect(page.vendors[0]!.evidence[0]!.published_at).toBe("2026-08-01");
  });
});
