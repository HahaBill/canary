import type { ScoutResponse, VendorEnrichment } from "@canary/shared";
import { SCOUT, entityFromScoutKey, selectScoutVendors } from "@canary/shared";
import { TAVILY_SEARCH_URL } from "@canary/classification/core";
import { buildMockDerived } from "@canary/shared/fixtures";
import { describe, expect, it } from "vitest";
import { D1Store } from "../data/d1.ts";
import { displayName } from "../format.ts";
import { FakeD1 } from "../test/fake-d1.ts";
import { createHarness, FIXED_NOW } from "../test/harness.ts";

const ENRICHMENT: VendorEnrichment = {
  vendor_name: "Ashby",
  merchant_normalized: "ashby",
  business_type: "Recruiting software",
  mapped_category: "RECRUITING",
  source_url: "https://www.ashbyhq.com/",
  source_title: "Ashby",
  retrieved_at: "2026-09-01T00:00:00.000Z",
  cached: true,
};

describe("GET /api/scout", () => {
  it("renders from the committed cache with the network down", async () => {
    const h = createHarness();
    const { status, body } = await h.json<ScoutResponse>("/api/scout");
    expect(status).toBe(200);
    expect(h.calls).toEqual([]);

    const expected = selectScoutVendors(h.derived.burn.weekly_variable_by_entity);
    expect(body.vendors.map((v) => v.entity)).toEqual(expected);
    expect(body.vendors.map((v) => v.display_name)).toEqual(expected.map(displayName));
    expect(body.vendors.every((v) => v.display_name !== v.entity || v.entity === displayName(v.entity))).toBe(true);
    expect(body.cached).toBe(true);
    expect(body.never_searched).toBe(true);
    expect(body.tavily_calls).toBe(0);
    expect(body.lookback_days).toBe(SCOUT.LOOKBACK_DAYS);
    expect(body.whatif_incident_id).toBe(h.derived.primary_incident!.id);

    for (const card of body.vendors) {
      expect(card.trailing_weekly_cents).toBe(h.derived.burn.weekly_variable_by_entity[card.entity]);
      expect(card.searched).toBe(false);
      expect(card.empty_window).toBe(false);
      expect(card.query).toMatch(/pricing change/);
      expect(card.evidence).toEqual([]);
    }
  });

  it("does not create an incident or write vendor enrichments", async () => {
    const db = new FakeD1();
    const h = createHarness({ db });
    await h.json("/api/scout");
    expect(db.rows("incidents")).toEqual([]);
    expect(db.rows("vendor_enrichments")).toEqual([]);
    expect(db.executed.every((e) => !e.sql.includes("scout_briefs"))).toBe(true);
  });
});

describe("POST /api/scout/refresh", () => {
  it("calls Tavily once per selected vendor, keeps dated hits, and leaves the Ashby fixture unchanged", async () => {
    const db = new FakeD1();
    const store = new D1Store(db);
    await store.saveEnrichment(ENRICHMENT);

    const h = createHarness({
      db,
      env: { TAVILY_API_KEY: "tvly-test" },
      fetchHandler: (input) => {
        if (String(input) !== TAVILY_SEARCH_URL) return null;
        return new Response(
          JSON.stringify({
            results: [
              {
                title: "AWS announces a new plan",
                url: "https://aws.amazon.com/blogs/aws/new-plan",
                content: "AWS launched a plan.",
                published_date: "2026-08-01",
              },
              {
                title: "Evergreen AWS overview",
                url: "https://aws.amazon.com/what-is-aws",
                content: "AWS is a cloud.",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const incidentsBefore = [...h.derived.incidents];
    const { status, body } = await h.post<ScoutResponse>("/api/scout/refresh");
    expect(status).toBe(200);

    const tavily = h.calls.filter((c) => c.url === TAVILY_SEARCH_URL);
    expect(tavily.length).toBeGreaterThan(0);
    expect(tavily.length).toBeLessThanOrEqual(SCOUT.MAX_TAVILY_CALLS_PER_RUN);
    expect(tavily.length).toBe(selectScoutVendors(h.derived.burn.weekly_variable_by_entity).length);
    expect(tavily.every((c) => c.body && (c.body as { include_answer?: boolean }).include_answer === false)).toBe(true);
    expect(
      tavily.every((c) => {
        const body = c.body as { days?: unknown; start_date?: string; end_date?: string };
        return body.days === undefined && Boolean(body.start_date) && Boolean(body.end_date);
      }),
    ).toBe(true);
    expect(tavily.every((c) => !JSON.stringify(c.body).match(/cheaper|alternative|switch|cancel/i))).toBe(true);

    const aws = body.vendors.find((v) => v.entity === "aws");
    expect(body.never_searched).toBe(false);
    expect(aws?.searched).toBe(true);
    expect(aws?.empty_window).toBe(false);
    expect(aws?.cached).toBe(false);
    expect(aws?.findings[0]?.cached).toBe(false);
    expect(aws?.findings[0]?.published_at).toBe("2026-08-01");
    expect(aws?.evidence[0]?.kind).toBe("EVIDENCE");
    expect(aws?.query).toMatch(/^AWS /);
    expect(body.tavily_calls).toBe(tavily.length);
    expect(body.vendors.every((v) => v.searched)).toBe(true);

    const rows = db.rows("vendor_enrichments");
    const ashby = rows.find((row) => row["merchant_normalized"] === "ashby");
    expect(ashby).toBeDefined();
    expect(ashby!["payload_json"]).toBe(JSON.stringify(ENRICHMENT));
    expect(await store.getEnrichment("ashby")).toMatchObject({
      merchant_normalized: "ashby",
      business_type: ENRICHMENT.business_type,
    });
    expect(await store.getEnrichment("scout:aws")).toBeNull();
    expect(await store.getEnrichment("scout:aws:0")).toBeNull();

    const scoutRows = rows.filter((row) => String(row["merchant_normalized"]).startsWith("scout:"));
    expect(scoutRows.length).toBeGreaterThan(0);
    expect(
      [...new Set(scoutRows.map((row) => entityFromScoutKey(String(row["merchant_normalized"]))))].sort(),
    ).toEqual(selectScoutVendors(h.derived.burn.weekly_variable_by_entity).slice().sort());
    expect(db.rows("incidents")).toEqual([]);
    expect(h.derived.incidents).toEqual(incidentsBefore);
    expect(db.rows("scout_briefs")).toEqual([]);
    expect(db.executed.every((e) => !e.sql.includes("scout_briefs"))).toBe(true);

    const callsAfterRefresh = h.calls.length;
    const cached = await h.json<ScoutResponse>("/api/scout");
    expect(cached.status).toBe(200);
    expect(cached.body.never_searched).toBe(false);
    expect(cached.body.vendors.find((v) => v.entity === "aws")?.searched).toBe(true);
    expect(cached.body.vendors.find((v) => v.entity === "aws")?.empty_window).toBe(false);
    expect(h.calls.length).toBe(callsAfterRefresh);
  });

  it("refuses a Scout-shaped write onto the Ashby corroboration key", async () => {
    const db = new FakeD1();
    const store = new D1Store(db);
    await store.saveEnrichment(ENRICHMENT);
    await expect(store.saveEnrichment({ ...ENRICHMENT, kind: "scout" })).rejects.toThrow(/scout:/);
    expect(await store.getEnrichment("ashby")).toMatchObject({
      merchant_normalized: "ashby",
      business_type: ENRICHMENT.business_type,
    });
    expect(JSON.parse(String(db.rows("vendor_enrichments")[0]!["payload_json"]))).toEqual(ENRICHMENT);
  });

  it("skips live calls when the cache is still inside the TTL", async () => {
    const db = new FakeD1();
    const store = new D1Store(db);
    await store.saveScoutBrief(
      {
        entity: "aws",
        findings: [],
        empty_window: true,
        retrieved_at: FIXED_NOW,
      },
      "AWS",
    );

    let tavilyHits = 0;
    const h = createHarness({
      db,
      env: { TAVILY_API_KEY: "tvly-test" },
      fetchHandler: (input) => {
        if (String(input) === TAVILY_SEARCH_URL) {
          tavilyHits += 1;
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        }
        return null;
      },
    });

    const first = await h.post<ScoutResponse>("/api/scout/refresh");
    expect(first.status).toBe(200);
    const afterFirst = tavilyHits;
    expect(afterFirst).toBeGreaterThan(0);

    const second = await h.post<ScoutResponse>("/api/scout/refresh");
    expect(second.status).toBe(200);
    expect(tavilyHits).toBe(afterFirst);
    expect(second.body.vendors.find((v) => v.entity === "aws")?.cached).toBe(true);
  });

  it("stays on the cache when Tavily is not configured", async () => {
    const h = createHarness();
    const { status, body } = await h.post<ScoutResponse>("/api/scout/refresh");
    expect(status).toBe(200);
    expect(body.refresh_error).toBe("TAVILY_NOT_CONFIGURED");
    expect(body.never_searched).toBe(true);
    expect(body.tavily_calls).toBe(0);
    expect(body.vendors.every((v) => v.findings.length === 0)).toBe(true);
    expect(h.calls.filter((c) => c.url === TAVILY_SEARCH_URL)).toEqual([]);
  });

  it("treats a whitespace-only key as missing", async () => {
    const h = createHarness({ env: { TAVILY_API_KEY: "   " } });
    const { body } = await h.post<ScoutResponse>("/api/scout/refresh");
    expect(body.refresh_error).toBe("TAVILY_NOT_CONFIGURED");
    expect(h.calls.filter((c) => c.url === TAVILY_SEARCH_URL)).toEqual([]);
  });

  it("classifies a rejected key, quota, and a dropped connection without inventing sources", async () => {
    const unauthorized = createHarness({
      env: { TAVILY_API_KEY: "tvly-test" },
      fetchHandler: (input) => {
        if (String(input) !== TAVILY_SEARCH_URL) return null;
        return new Response(JSON.stringify({ detail: "unauthorized" }), { status: 401 });
      },
    });
    const rejected = await unauthorized.post<ScoutResponse>("/api/scout/refresh");
    expect(rejected.status).toBe(200);
    expect(rejected.body.refresh_error).toBe("TAVILY_UNAUTHORIZED");
    expect(rejected.body.never_searched).toBe(true);
    expect(rejected.body.tavily_calls).toBe(0);
    expect(rejected.body.vendors.every((v) => !v.searched && v.findings.length === 0)).toBe(true);
    expect(unauthorized.calls.filter((c) => c.url === TAVILY_SEARCH_URL).length).toBe(1);

    const quota = createHarness({
      env: { TAVILY_API_KEY: "tvly-test" },
      fetchHandler: (input) => {
        if (String(input) !== TAVILY_SEARCH_URL) return null;
        return new Response(JSON.stringify({ detail: "rate limited" }), { status: 429 });
      },
    });
    const limited = await quota.post<ScoutResponse>("/api/scout/refresh");
    expect(limited.body.refresh_error).toBe("TAVILY_QUOTA");
    expect(limited.body.never_searched).toBe(true);
    expect(quota.calls.filter((c) => c.url === TAVILY_SEARCH_URL).length).toBe(1);

    const dropped = createHarness({
      env: { TAVILY_API_KEY: "tvly-test" },
      fetchHandler: (input) => {
        if (String(input) === TAVILY_SEARCH_URL) throw new Error("socket hang up");
        return null;
      },
    });
    const unreachable = await dropped.post<ScoutResponse>("/api/scout/refresh");
    expect(unreachable.body.refresh_error).toBe("TAVILY_UNREACHABLE");
    expect(unreachable.body.never_searched).toBe(true);
  });

  it("keeps last retrieved findings when Tavily returns a request error", async () => {
    const db = new FakeD1();
    const store = new D1Store(db);
    await store.saveScoutBrief(
      {
        entity: "aws",
        findings: [
          {
            kind: "EVIDENCE",
            claim: "AWS announced a new plan.",
            source_url: "https://aws.amazon.com/blogs/aws/new-plan",
            source_title: "AWS announced a new plan",
            published_at: "2026-08-01",
            retrieved_at: "2026-08-01T00:00:00.000Z",
            cached: true,
          },
        ],
        empty_window: false,
        retrieved_at: "2026-08-01T00:00:00.000Z",
      },
      "AWS",
    );

    const h = createHarness({
      db,
      env: { TAVILY_API_KEY: "tvly-test" },
      fetchHandler: (input) => {
        if (String(input) !== TAVILY_SEARCH_URL) return null;
        return new Response(JSON.stringify({ detail: { error: "When days is set, start_date or end_date cannot be set" } }), {
          status: 400,
        });
      },
    });
    const { body } = await h.post<ScoutResponse>("/api/scout/refresh");
    expect(body.refresh_error).toBe("TAVILY_FAILED");
    expect(body.never_searched).toBe(false);
    expect(body.vendors.find((v) => v.entity === "aws")?.findings[0]?.source_url).toBe(
      "https://aws.amazon.com/blogs/aws/new-plan",
    );
  });

  it("does not fall back to generic optimization copy when nothing is dated", async () => {
    const h = createHarness({
      env: { TAVILY_API_KEY: "tvly-test" },
      fetchHandler: (input) => {
        if (String(input) !== TAVILY_SEARCH_URL) return null;
        return new Response(
          JSON.stringify({
            results: [
              {
                title: "10 ways to cut cloud spend",
                url: "https://tips.example.com/optimize",
                content: "Generic hosting advice.",
                published_date: "2026-08-01",
              },
            ],
          }),
          { status: 200 },
        );
      },
    });
    const { body } = await h.post<ScoutResponse>("/api/scout/refresh");
    expect(body.vendors.every((v) => v.searched && v.empty_window && v.findings.length === 0)).toBe(true);
  });
});

describe("selectScoutVendors on the mock ledger", () => {
  it("picks financially important variable vendors from the burn window", () => {
    const derived = buildMockDerived();
    const selected = selectScoutVendors(derived.burn.weekly_variable_by_entity);
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThanOrEqual(SCOUT.MAX_VENDORS);
    for (const entity of selected) {
      expect(derived.burn.weekly_variable_by_entity[entity]!).toBeGreaterThanOrEqual(SCOUT.MIN_TRAILING_WEEKLY_CENTS);
    }
  });
});
