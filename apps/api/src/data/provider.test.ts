/** MockDataProvider + the D1 status/enrichment overlay. */
import { SCENARIO_LABEL } from "@canary/shared";
import { buildMockDerived } from "@canary/shared/fixtures";
import { describe, expect, it } from "vitest";
import { FakeD1 } from "../test/fake-d1.ts";
import { D1Store, type SqlDatabase } from "./d1.ts";
import { PipelineDataProvider } from "./pipeline-provider.ts";
import { MockDataProvider, withD1Overlay } from "./provider.ts";

const NOW = "2026-09-14T12:00:00.000Z";

describe("MockDataProvider", () => {
  it("serves the mock derived object untouched", async () => {
    const derived = buildMockDerived();
    const provider = new MockDataProvider(derived);
    expect(await provider.getDerived()).toEqual(derived);
    expect((await provider.getDerived()).provenance.history_source).toBe("mock");
  });

  it("looks up incidents and enrichments", async () => {
    const provider = new MockDataProvider();
    const derived = await provider.getDerived();
    expect((await provider.getIncident(derived.primary_incident!.id))?.id).toBe(derived.primary_incident!.id);
    expect(await provider.getIncident("inc_nope")).toBeNull();
    expect((await provider.getEnrichment("ashby"))?.merchant_normalized).toBe("ashby");
    expect(await provider.getEnrichment("nobody")).toBeNull();
  });

  it("applies status changes without mutating the source fixture", async () => {
    const derived = buildMockDerived();
    const provider = new MockDataProvider(derived);
    const id = derived.primary_incident!.id;

    const updated = await provider.updateIncidentStatus(id, "RESOLVED", NOW);
    expect(updated?.status).toBe("RESOLVED");
    expect(updated?.last_updated).toBe(NOW);
    expect(derived.primary_incident!.status).toBe("OPEN");

    const after = await provider.getDerived();
    expect(after.primary_incident!.status).toBe("RESOLVED");
    expect(after.incidents.find((i) => i.id === id)!.status).toBe("RESOLVED");
    expect(await provider.updateIncidentStatus("inc_nope", "RESOLVED", NOW)).toBeNull();
  });

  it("records notification timestamps", async () => {
    const provider = new MockDataProvider();
    const id = (await provider.getDerived()).primary_incident!.id;
    await provider.markNotified(id, NOW);
    expect((await provider.getIncident(id))?.last_notified).toBe(NOW);
    await expect(provider.markNotified("inc_nope", NOW)).resolves.toBeUndefined();
  });

  it("renders what-if speech from the shared helpers, not the fixture placeholder", async () => {
    const provider = new MockDataProvider();
    const result = await provider.simulate({ entity: "aws", percentage: -20 });
    expect(result.label).toBe(SCENARIO_LABEL);
    expect(result.speech.summary).toContain("AWS");
    expect(result.speech.summary).toContain("twenty percent lower");
    expect(result.speech.delta_monthly).toContain("lower per month");
    expect(result.speech.summary).not.toContain("mock");
  });

  it("carries the deterministic no-change reason beside the spoken scenario", async () => {
    const provider = new MockDataProvider();
    const result = await provider.simulate({ entity: "not_a_vendor", percentage: -20 });
    expect(result.no_change_reason).toContain("no spending on record");
    expect(result.speech.summary).toContain(result.no_change_reason!);
  });
});

describe("withD1Overlay", () => {
  it("persists incident status across provider instances", async () => {
    const db = new FakeD1();
    const id = buildMockDerived().primary_incident!.id;

    const first = withD1Overlay(new MockDataProvider(), db);
    await first.updateIncidentStatus(id, "ACKNOWLEDGED", NOW);
    expect(db.rows("incidents").find((r) => r.id === id)).toMatchObject({ status: "ACKNOWLEDGED", last_updated: NOW });

    // A cold start reads the status back out of D1.
    const second = withD1Overlay(new MockDataProvider(), db);
    expect((await second.getIncident(id))?.status).toBe("ACKNOWLEDGED");
    expect((await second.getDerived()).primary_incident?.status).toBe("ACKNOWLEDGED");
  });

  it("does not revert a persisted status when a cold isolate marks the incident notified (and vice versa)", async () => {
    const db = new FakeD1();
    const id = buildMockDerived().primary_incident!.id;

    // Isolate A acknowledges.
    const a = withD1Overlay(new MockDataProvider(), db);
    await a.updateIncidentStatus(id, "ACKNOWLEDGED", NOW);

    // Isolate B (fresh in-memory provider, same D1) sends an alert → markNotified.
    const later = "2026-09-14T13:00:00.000Z";
    const b = withD1Overlay(new MockDataProvider(), db);
    await b.markNotified(id, later);
    const afterB = await b.getIncident(id);
    expect(afterB?.status).toBe("ACKNOWLEDGED");
    expect(afterB?.last_notified).toBe(later);

    // Isolate C changes status; the notification timestamp must survive.
    const c = withD1Overlay(new MockDataProvider(), db);
    const updated = await c.updateIncidentStatus(id, "RESOLVED", "2026-09-14T14:00:00.000Z");
    expect(updated?.status).toBe("RESOLVED");
    expect(updated?.last_notified).toBe(later);
    expect((await withD1Overlay(new MockDataProvider(), db).getIncident(id))?.last_notified).toBe(later);
  });

  it("persists notification timestamps", async () => {
    const db = new FakeD1();
    const id = buildMockDerived().one_off_incident!.id;
    await withD1Overlay(new MockDataProvider(), db).markNotified(id, NOW);
    expect(db.rows("incidents").find((r) => r.id === id)).toMatchObject({ last_notified: NOW });
    expect((await withD1Overlay(new MockDataProvider(), db).getIncident(id))?.last_notified).toBe(NOW);
  });

  it("caches enrichments into D1 and serves them from there", async () => {
    const db = new FakeD1();
    const provider = withD1Overlay(new MockDataProvider(), db);

    const first = await provider.getEnrichment("ashby");
    expect(first?.merchant_normalized).toBe("ashby");
    expect(db.rows("vendor_enrichments")).toHaveLength(1);

    // Second read is served from D1 even if the underlying provider forgets.
    const emptyBase = new MockDataProvider(Object.assign(buildMockDerived(), { vendor_enrichments: [] }));
    expect((await withD1Overlay(emptyBase, db).getEnrichment("ashby"))?.source_url).toBe(first!.source_url);
  });

  it("degrades to in-memory when D1 throws", async () => {
    const brokenDb: SqlDatabase = {
      prepare() {
        throw new Error("D1_ERROR: no such table");
      },
    };
    const provider = withD1Overlay(new MockDataProvider(), brokenDb);
    const id = (await provider.getDerived()).primary_incident!.id;
    expect(await provider.updateIncidentStatus(id, "RESOLVED", NOW)).not.toBeNull();
    expect((await provider.getEnrichment("ashby"))?.merchant_normalized).toBe("ashby");
  });
});

describe("PipelineDataProvider", () => {
  it("reuses one pipeline run for getDerived and getNeedsReview", async () => {
    const provider = new PipelineDataProvider();
    await provider.getDerived();
    expect(provider.pipelineRuns).toBe(1);
    await provider.getNeedsReview();
    expect(provider.pipelineRuns).toBe(1);
  });

  it("loads needs-review from the same as-of snapshot as getDerived, without running the pipeline", async () => {
    const derived = buildMockDerived();
    const provider = new PipelineDataProvider({
      asOf: () => derived.provenance.end_date,
      snapshots: { derived: async () => derived },
    });
    expect((await provider.getDerived()).cash_cents).toBe(derived.cash_cents);
    expect((await provider.getNeedsReview()).map((i) => i.transaction_id)).toEqual(derived.needs_review.items.map((i) => i.transaction_id));
    expect(provider.pipelineRuns).toBe(0);
    expect(provider.snapshotHits).toBe(1);
  });

  it("returns raw snapshot JSON for the dashboard without a second derived load", async () => {
    const derived = buildMockDerived();
    const raw = JSON.stringify(derived);
    let derivedLoads = 0;
    const provider = new PipelineDataProvider({
      asOf: () => derived.provenance.end_date,
      snapshots: {
        derived: async () => {
          derivedLoads += 1;
          return raw;
        },
      },
    });
    expect(await provider.getDemoJson()).toBe(raw);
    expect(await provider.getDemoJson()).toBe(raw);
    expect(derivedLoads).toBe(1);
    expect(provider.pipelineRuns).toBe(0);
  });

  it("does not pass a raw demo snapshot through once an incident overlay exists", async () => {
    const derived = buildMockDerived();
    const inner = new PipelineDataProvider({
      asOf: () => derived.provenance.end_date,
      snapshots: { derived: async () => JSON.stringify(derived) },
    });
    const db = new FakeD1();
    const wrapped = withD1Overlay(inner, db);
    expect(await wrapped.getDemoJson()).toBe(JSON.stringify(derived));
    await wrapped.updateIncidentStatus(derived.primary_incident!.id, "ACKNOWLEDGED", NOW);
    expect(await wrapped.getDemoJson()).toBeNull();
    expect((await wrapped.getDerived()).primary_incident?.status).toBe("ACKNOWLEDGED");
  });

  it("serves the ledger pivot, cell detail, and calendar from the real engine, consistent with the pipeline", async () => {
    const provider = new PipelineDataProvider();
    const derived = await provider.getDerived();

    const pivot = await provider.getLedgerPivot("week");
    expect(pivot.periods).toHaveLength(derived.weeks.length);
    const variable = pivot.rows.find((r) => r.id === "section:VARIABLE_SPEND")!;
    // The sheet must agree with the CUSUM monitoring series to the cent, every week.
    expect(variable.cells.map((c) => c.amount_cents)).toEqual(derived.weeks.map((w) => w.variable_spend_cents));
    const cashEnd = pivot.rows.find((r) => r.section === "CASH_END")!;
    expect(cashEnd.cells[cashEnd.cells.length - 1]!.amount_cents).toBe(derived.cash_cents);
    expect(pivot.regime_start).toBe(derived.primary_incident!.detection.cusum!.estimated_change_point_week_start);
    const awsRow = pivot.rows.find((r) => r.entity === "aws" && r.section === "VARIABLE_SPEND")!;
    expect(awsRow.incident_id).toBe(derived.primary_incident!.id);

    const monthly = await provider.getLedgerPivot("month");
    const firstVendor = monthly.rows.find((r) => r.level === 2)!;
    const cell = await provider.getLedgerCell(firstVendor.id, monthly.periods[monthly.periods.length - 1]!.key, "month");
    expect(cell).not.toBeNull();
    expect(await provider.getLedgerCell("vendor:nope", "2026-09", "month")).toBeNull();

    const events = await provider.getCalendarEvents("2026-08-31", "2026-10-15");
    expect(events.some((e) => e.kind === "actual")).toBe(true);
    expect(events.some((e) => e.kind === "expected" && e.date > "2026-09-13")).toBe(true);
    expect(events.some((e) => e.kind === "busy")).toBe(false); // busy blocks are merged by the route, not the provider
  });
});

describe("D1Store.logMessage", () => {
  it("writes the full row when migration 0002 is applied", async () => {
    const db = new FakeD1();
    await new D1Store(db).logMessage({ direction: "inbound", phone: "+15550001111", body: "WHY", created_at: NOW, command: "WHY" });
    expect(db.rows("imessage_log")[0]).toMatchObject({ direction: "inbound", phone: "+15550001111", body: "WHY", command: "WHY" });
  });

  it("falls back to the 0001 columns when 0002 has not run", async () => {
    const db = new FakeD1({ rejectColumns: ["command", "provider_message_id"] });
    await new D1Store(db).logMessage({ direction: "outbound", phone: "+15550001111", body: "hi", created_at: NOW, command: "HELP" });
    // `id` is assigned by the table's AUTOINCREMENT, not by the statement.
    expect(db.rows("imessage_log")).toEqual([{ id: 1, direction: "outbound", phone: "+15550001111", body: "hi", created_at: NOW }]);
  });
});
