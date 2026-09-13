/** Status + shape for the ledger sheet, the cash calendar, availability and Needs Review. */
import type {
  AvailabilityResponse,
  CalendarResponse,
  ClassificationOverrideResponse,
  ErrorResponse,
  LedgerCellResponse,
  LedgerFilterQueryResponse,
  LedgerResponse,
  NeedsReviewResponse,
} from "@canary/shared";
import { buildMockDerived } from "@canary/shared/fixtures";
import { describe, expect, it } from "vitest";
import type { CalendarFeedEvent } from "../calendar/ics.ts";
import { D1Store } from "../data/d1.ts";
import { FakeD1 } from "../test/fake-d1.ts";
import { openAiClient } from "../conversation/openai.ts";
import { fakeOpenAi } from "../test/fake-openai.ts";
import { PipelineDataProvider } from "../data/pipeline-provider.ts";
import { createHarness, FIXED_NOW } from "../test/harness.ts";

const MEETING: CalendarFeedEvent = {
  uid: "board@google.com",
  start: "2026-09-08T14:00:00.000Z",
  end: "2026-09-08T15:00:00.000Z",
  summary: "Board meeting",
  allDay: false,
};

describe("GET /api/ledger", () => {
  it("defaults to month granularity and adds up to the weekly buckets", async () => {
    const h = createHarness();
    const { status, body } = await h.json<LedgerResponse>("/api/ledger");
    expect(status).toBe(200);

    const { pivot } = body;
    expect(pivot.granularity).toBe("month");
    // Derived from the span, not hard-coded: the demo history is a year long.
    expect(pivot.periods[0]!.key).toBe(h.derived.provenance.start_date.slice(0, 7));
    expect(pivot.periods[pivot.periods.length - 1]!.key).toBe(h.derived.provenance.end_date.slice(0, 7));
    expect(pivot.periods.map((p) => p.key)).toEqual([...pivot.periods.map((p) => p.key)].sort());
    expect(new Set(pivot.periods.map((p) => p.key)).size).toBe(pivot.periods.length);
    expect(pivot.history_start).toBe(h.derived.provenance.start_date);
    expect(pivot.history_end).toBe(h.derived.provenance.end_date);
    expect(pivot.weeks_of_history).toBe(h.derived.weeks.length);
    expect(pivot.regime_start).toBe(h.derived.primary_incident!.estimated_change_point);

    const variable = pivot.rows.find((r) => r.id === "section:VARIABLE_SPEND")!;
    expect(variable.cells).toHaveLength(pivot.periods.length);
    expect(variable.total_cents).toBe(h.derived.weeks.reduce((sum, w) => sum + w.variable_spend_cents, 0));
    expect(variable.level).toBe(0);
  });

  it("nests category rows under variable spend and vendor rows under those", async () => {
    const h = createHarness();
    const { pivot } = (await h.json<LedgerResponse>("/api/ledger")).body;

    const cloud = pivot.rows.find((r) => r.id === "category:CLOUD_INFRASTRUCTURE")!;
    expect(cloud).toMatchObject({ level: 1, section: "VARIABLE_SPEND", parent_id: "section:VARIABLE_SPEND" });

    const aws = pivot.rows.find((r) => r.id === "vendor:aws")!;
    expect(aws).toMatchObject({ level: 2, entity: "aws", parent_id: "category:CLOUD_INFRASTRUCTURE" });
    // Vendor rows link to the incident they drive.
    expect(aws.incident_id).toBe(h.derived.primary_incident!.id);
    expect(aws.total_cents).toBe(h.derived.weeks.reduce((sum, w) => sum + (w.variable_by_entity.aws ?? 0), 0));

    // Every category's vendors sum to no more than the category itself.
    for (const category of pivot.rows.filter((r) => r.level === 1)) {
      const vendors = pivot.rows.filter((r) => r.parent_id === category.id);
      expect(vendors.reduce((sum, v) => sum + v.total_cents, 0)).toBeLessThanOrEqual(category.total_cents);
    }
  });

  it("ends on the bank's closing balance and tints post-change periods", async () => {
    const h = createHarness();
    const { pivot } = (await h.json<LedgerResponse>("/api/ledger?granularity=week")).body;

    const cash = pivot.rows.find((r) => r.id === "section:CASH_END")!;
    expect(cash.cells[cash.cells.length - 1]!.amount_cents).toBe(h.derived.cash_cents);
    expect(cash.annualized_cents).toBeNull();

    const regimeStart = pivot.regime_start!;
    expect(pivot.periods.filter((p) => p.post_change).map((p) => p.key)[0]).toBe(regimeStart);
    expect(pivot.periods.every((p) => p.post_change === p.start >= regimeStart)).toBe(true);
  });

  it("serves week granularity as one period per bucket", async () => {
    const h = createHarness();
    const { pivot } = (await h.json<LedgerResponse>("/api/ledger?granularity=week")).body;
    expect(pivot.granularity).toBe("week");
    expect(pivot.periods.map((p) => p.key)).toEqual(h.derived.weeks.map((w) => w.week_start));
    expect(pivot.periods.every((p) => !p.partial)).toBe(true);
  });

  it("flags the periods carrying a one-off and a Needs Review item", async () => {
    const h = createHarness();
    const { pivot } = (await h.json<LedgerResponse>("/api/ledger?granularity=week")).body;
    const oneOffWeek = h.derived.weeks.find((w) => w.excluded_from_monitoring_cents > 0)!.week_start;
    const oneOffRow = pivot.rows.find((r) => r.id === "section:ONE_OFF")!;
    const index = pivot.periods.findIndex((p) => p.key === oneOffWeek);
    expect(oneOffRow.cells[index]!.flags).toContain("one_off");

    const reviewDate = h.derived.needs_review.items[0]!.date;
    const variable = pivot.rows.find((r) => r.id === "section:VARIABLE_SPEND")!;
    const reviewIndex = pivot.periods.findIndex((p) => reviewDate >= p.start && reviewDate <= p.end);
    expect(variable.cells[reviewIndex]!.flags).toContain("needs_review");
  });

  it("400s on any other granularity", async () => {
    const h = createHarness();
    const { status, body } = await h.json<ErrorResponse>("/api/ledger?granularity=day");
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_granularity");
  });
});

describe("POST /api/ledger/query", () => {
  it("interprets via the model against the live catalog", async () => {
    const openai = fakeOpenAi([{ content: JSON.stringify({ entities: ["aws"], post_change_only: true }) }]);
    const h = createHarness({ llm: openAiClient({ apiKey: "test", fetchImpl: openai.fetchImpl }) });
    const { status, body } = await h.post<LedgerFilterQueryResponse>("/api/ledger/query", {
      q: "Amazon after the change",
      granularity: "month",
    });
    expect(status).toBe(200);
    expect(body.source).toBe("model");
    expect(body.unmatched).toBe(false);
    expect(body.spec.entities).toEqual(["aws"]);
    expect(body.spec.post_change_only).toBe(true);
    expect(body.chips.map((chip) => chip.toLowerCase())).toContain("aws");
    expect(body.chips).toContain("after the change");
    expect(openai.textOf(0)).toMatch(/\baws · /i);
  });

  it("returns unmatched when no model is configured — not a full-sheet no-op", async () => {
    const h = createHarness();
    const { status, body } = await h.post<LedgerFilterQueryResponse>("/api/ledger/query", {
      q: "display all delivery services",
      granularity: "month",
    });
    expect(status).toBe(200);
    expect(body.source).toBe("unconfigured");
    expect(body.unmatched).toBe(true);
    expect(body.spec.unmatched).toBe(true);
  });

  it("400s when q is missing", async () => {
    const h = createHarness();
    const { status, body } = await h.post<ErrorResponse>("/api/ledger/query", { granularity: "month" });
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_query");
  });
});

describe("GET /api/ledger/cell", () => {
  it("returns the transactions behind a vendor × period cell", async () => {
    const h = createHarness();
    const { status, body } = await h.json<LedgerCellResponse>("/api/ledger/cell?row_id=vendor:aws&period_key=2026-09");
    expect(status).toBe(200);
    expect(body.detail.row_id).toBe("vendor:aws");
    expect(body.detail.period_key).toBe("2026-09");
    expect(body.detail.transactions.length).toBeGreaterThan(0);
    // Outflows are signed negative, and every row carries its category.
    expect(body.detail.transactions.every((t) => t.amount_cents < 0 && t.category === "CLOUD_INFRASTRUCTURE")).toBe(true);
  });

  it("accepts week granularity", async () => {
    const h = createHarness();
    const week = h.derived.weeks[0]!.week_start;
    const { status, body } = await h.json<LedgerCellResponse>(`/api/ledger/cell?row_id=vendor:aws&period_key=${week}&granularity=week`);
    expect(status).toBe(200);
    expect(body.detail.transactions).toHaveLength(1);
    expect(body.detail.transactions[0]!.amount_cents).toBe(-h.derived.weeks[0]!.variable_by_entity.aws!);
  });

  it("404s an unknown row, period, or a row with nothing to drill into", async () => {
    const h = createHarness();
    expect((await h.json<ErrorResponse>("/api/ledger/cell?row_id=vendor:nobody&period_key=2026-09")).status).toBe(404);
    expect((await h.json<ErrorResponse>("/api/ledger/cell?row_id=vendor:aws&period_key=1999-01")).status).toBe(404);
    const section = await h.json<ErrorResponse>("/api/ledger/cell?row_id=section:CASH_END&period_key=2026-09");
    expect(section.status).toBe(404);
    expect(section.body.error).toBe("cell_not_found");
  });

  it("400s without row_id or period_key", async () => {
    const h = createHarness();
    expect((await h.json<ErrorResponse>("/api/ledger/cell")).body.error).toBe("invalid_row_id");
    expect((await h.json<ErrorResponse>("/api/ledger/cell?row_id=vendor:aws")).body.error).toBe("invalid_period_key");
    expect((await h.json<ErrorResponse>("/api/ledger/cell?row_id=vendor:aws&period_key=2026-09&granularity=hour")).body.error).toBe(
      "invalid_granularity",
    );
  });
});

describe("GET /api/calendar", () => {
  it("defaults to the month of now and covers every day of it", async () => {
    const h = createHarness();
    const { status, body } = await h.json<CalendarResponse>("/api/calendar");
    expect(status).toBe(200);
    expect(body.calendar.from).toBe("2026-09-01");
    expect(body.calendar.to).toBe("2026-09-30");
    expect(body.calendar.days).toHaveLength(30);
    expect(body.calendar.days.map((d) => d.date)).toEqual([...body.calendar.days].sort((a, b) => a.date.localeCompare(b.date)).map((d) => d.date));
    expect(body.calendar.busy_source).toBe("ics");
  });

  it("does not put ledger transactions or detector markers on the calendar", async () => {
    const h = createHarness();
    const { calendar } = (await h.json<CalendarResponse>("/api/calendar?from=2026-07-01&to=2026-09-30")).body;
    const kinds = new Set(calendar.days.flatMap((d) => d.events).map((e) => e.kind));
    expect(kinds.has("actual")).toBe(false);
    expect(kinds.has("expected")).toBe(false);
    expect(calendar.days.every((d) => d.net_actual_cents === 0 && d.net_expected_cents === 0)).toBe(true);
  });

  it("merges busy blocks in without leaking the meeting title", async () => {
    const h = createHarness();
    h.calendar.events = [MEETING];
    const { calendar } = (await h.json<CalendarResponse>("/api/calendar")).body;
    const busy = calendar.days.find((d) => d.date === "2026-09-08")!.events.filter((e) => e.kind === "busy");
    expect(busy).toHaveLength(1);
    expect(busy[0]).toMatchObject({ title: "Busy", start: MEETING.start, end: MEETING.end });
    expect(calendar.days.every((d) => d.net_actual_cents === 0)).toBe(true);
    expect(h.calendar.requested).toEqual([{ from: "2026-09-01", to: "2026-09-30" }]);
  });

  it("shows real titles only when CALENDAR_SHOW_TITLES is 1", async () => {
    const h = createHarness({ env: { CALENDAR_SHOW_TITLES: "1" } });
    h.calendar.events = [MEETING];
    const { calendar } = (await h.json<CalendarResponse>("/api/calendar")).body;
    expect(calendar.days.find((d) => d.date === "2026-09-08")!.events.find((e) => e.kind === "busy")!.title).toBe("Board meeting");
  });

  it("spreads a multi-day block across every day it covers", async () => {
    const h = createHarness();
    h.calendar.events = [{ uid: "offsite", start: "2026-09-08T00:00:00.000Z", end: "2026-09-10T00:00:00.000Z", summary: "Offsite", allDay: true }];
    const { calendar } = (await h.json<CalendarResponse>("/api/calendar")).body;
    const busyDates = calendar.days.filter((d) => d.events.some((e) => e.kind === "busy")).map((d) => d.date);
    expect(busyDates).toEqual(["2026-09-08", "2026-09-09"]);
    expect(new Set(calendar.days.flatMap((d) => d.events).map((e) => e.id)).size).toBe(calendar.days.flatMap((d) => d.events).length);
  });

  it("reports busy_source none when no feed is configured", async () => {
    const h = createHarness();
    h.calendar.source = "none";
    const { calendar } = (await h.json<CalendarResponse>("/api/calendar")).body;
    expect(calendar.busy_source).toBe("none");
    expect(calendar.days.flatMap((d) => d.events).some((e) => e.kind === "busy")).toBe(false);
  });

  it("validates the range", async () => {
    const h = createHarness();
    expect((await h.json<ErrorResponse>("/api/calendar?from=nope")).body.error).toBe("invalid_date");
    expect((await h.json<ErrorResponse>("/api/calendar?from=2026-09-01&to=2026-9-2")).body.error).toBe("invalid_date");
    expect((await h.json<ErrorResponse>("/api/calendar?from=2026-09-10&to=2026-09-01")).body.error).toBe("invalid_range");
    const tooLong = await h.json<ErrorResponse>("/api/calendar?from=2026-01-01&to=2026-12-31");
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toBe("range_too_large");
  });

  it("serves exactly the maximum span", async () => {
    const h = createHarness();
    const { status, body } = await h.json<CalendarResponse>("/api/calendar?from=2026-07-01&to=2026-09-30");
    expect(status).toBe(200);
    expect(body.calendar.days).toHaveLength(92);
  });
});

describe("GET /api/availability", () => {
  it("reports free with the next meeting when the founder is not busy", async () => {
    const h = createHarness();
    h.calendar.next_busy_start = "2026-09-14T15:00:00.000Z";
    const { status, body } = await h.json<AvailabilityResponse>("/api/availability");
    expect(status).toBe(200);
    expect(body).toEqual({
      busy: false,
      until: null,
      next_busy_start: "2026-09-14T15:00:00.000Z",
      source: "ics",
      checked_at: FIXED_NOW,
    });
  });

  it("reports busy with the end of the block", async () => {
    const h = createHarness();
    h.calendar.busy = { until: "2026-09-14T13:30:00.000Z" };
    const { body } = await h.json<AvailabilityResponse>("/api/availability");
    expect(body).toMatchObject({ busy: true, until: "2026-09-14T13:30:00.000Z", next_busy_start: null, source: "ics" });
  });

  it("reports source none when there is no feed", async () => {
    const h = createHarness();
    h.calendar.source = "none";
    const { body } = await h.json<AvailabilityResponse>("/api/availability");
    expect(body).toMatchObject({ busy: false, source: "none" });
  });
});

describe("Needs Review", () => {
  it("lists the items with their classification signals", async () => {
    const h = createHarness();
    const { status, body } = await h.json<NeedsReviewResponse>("/api/needs-review");
    expect(status).toBe(200);
    expect(body.count).toBe(h.derived.needs_review.items.length);
    expect(body.outflow_cents).toBe(h.derived.needs_review.items.reduce((sum, i) => sum + Math.abs(i.amount_cents), 0));
    expect(body.items[0]).toMatchObject({
      transaction_id: h.derived.needs_review.items[0]!.transaction_id,
      merchant_normalized: h.derived.needs_review.items[0]!.merchant_normalized,
    });
    expect(Array.isArray(body.items[0]!.proposals)).toBe(true);
    expect(body.overrides).toEqual([]);
  });

  it("accepts an override without the shared secret", async () => {
    const h = createHarness();
    const transactionId = h.derived.needs_review.items[0]!.transaction_id;
    const { status, body } = await h.post<ClassificationOverrideResponse>("/api/classifications/override", {
      transaction_id: transactionId,
      category: "MARKETING",
    });
    expect(status).toBe(200);
    expect(body.override.category).toBe("MARKETING");
    expect(h.db.rows("classification_overrides")).toHaveLength(1);
  });

  it("persists the override, drops the item and lowers the count", async () => {
    const h = createHarness();
    const transactionId = h.derived.needs_review.items[0]!.transaction_id;
    const { status, body } = await h.post<ClassificationOverrideResponse>("/api/classifications/override", {
      transaction_id: transactionId,
      category: "PROFESSIONAL_SERVICES",
      apply_to_merchant: true,
      note: "  Contractor paid by name  ",
    });
    expect(status).toBe(200);
    expect(body.needs_review_count).toBe(0);
    expect(body.override).toEqual({
      transaction_id: transactionId,
      merchant_normalized: h.derived.needs_review.items[0]!.merchant_normalized,
      category: "PROFESSIONAL_SERVICES",
      apply_to_merchant: true,
      note: "Contractor paid by name",
      created_at: FIXED_NOW,
    });

    expect(h.db.rows("classification_overrides")).toHaveLength(1);
    expect(h.db.rows("classification_overrides")[0]).toMatchObject({ transaction_id: transactionId, apply_to_merchant: 1 });

    const after = await h.json<NeedsReviewResponse>("/api/needs-review");
    expect(after.body.count).toBe(0);
    expect(after.body.outflow_cents).toBe(0);
    expect(after.body.items).toEqual([]);
    expect(after.body.overrides).toEqual([body.override]);
  });

  it("keeps a review applied after a cold isolate, from the D1 record alone", async () => {
    const item = buildMockDerived().needs_review.items[0]!;
    const db = new FakeD1();
    await new D1Store(db).saveClassificationOverride({
      transaction_id: item.transaction_id,
      merchant_normalized: item.merchant_normalized,
      category: "PROFESSIONAL_SERVICES",
      apply_to_merchant: false,
      created_at: "2026-09-13T09:00:00.000Z",
    });

    // A fresh app with a fresh provider: nothing but D1 remembers the review.
    const h = createHarness({ db });
    const { body } = await h.json<NeedsReviewResponse>("/api/needs-review");
    expect(body.count).toBe(0);
    expect(body.overrides).toHaveLength(1);
  });

  it("rejects a category outside the taxonomy, and NEEDS_REVIEW itself", async () => {
    const h = createHarness();
    const id = h.derived.needs_review.items[0]!.transaction_id;
    expect((await h.post<ErrorResponse>("/api/classifications/override", { transaction_id: id, category: "SNACKS" })).body.error).toBe(
      "invalid_category",
    );
    const notADestination = await h.post<ErrorResponse>("/api/classifications/override", { transaction_id: id, category: "NEEDS_REVIEW" });
    expect(notADestination.status).toBe(400);
    expect(notADestination.body.error).toBe("invalid_category");
  });

  it("400s a missing transaction id and 404s an unknown one", async () => {
    const h = createHarness();
    expect((await h.post<ErrorResponse>("/api/classifications/override", { category: "MARKETING" })).body.error).toBe("invalid_transaction_id");
    const unknown = await h.post<ErrorResponse>("/api/classifications/override", { transaction_id: "tx_nope", category: "MARKETING" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe("transaction_not_found");
  });

  it("still applies when the webhook secret is unset", async () => {
    const h = createHarness({ env: { WEBHOOK_SECRET: "" } });
    const transactionId = h.derived.needs_review.items[0]!.transaction_id;
    const { status, body } = await h.post<ClassificationOverrideResponse>("/api/classifications/override", {
      transaction_id: transactionId,
      category: "MARKETING",
    });
    expect(status).toBe(200);
    expect(body.override.category).toBe("MARKETING");
  });

  it("does not uniquely force a heavier path than the dashboard", async () => {
    let derivedLoads = 0;
    const derived = buildMockDerived();
    const provider = new PipelineDataProvider({
      asOf: () => derived.provenance.end_date,
      snapshots: {
        derived: async () => {
          derivedLoads += 1;
          return derived;
        },
      },
    });
    const h = createHarness({ provider });
    expect((await h.json("/api/health-summary")).status).toBe(200);
    expect((await h.json("/api/needs-review")).status).toBe(200);
    expect(derivedLoads).toBe(1);
    expect(provider.pipelineRuns).toBe(0);
    expect(provider.snapshotHits).toBe(1);
  });
});
