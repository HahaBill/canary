/**
 * `GoogleCalendarProvider` against the ICS feed's contract: same busy/free
 * semantics, same "titles are not Canary's business" default, same degradation
 * when the calendar cannot be read — plus the one thing ICS cannot do, creating
 * the review event.
 */
import { buildMockDerived } from "@canary/shared/fixtures";
import type { Incident } from "@canary/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1 } from "../../test/fake-d1.ts";
import { connectGoogle, GOOGLE_TEST_ENV, googleFetchHandler, TEST_ENV, type GoogleScript } from "../../test/harness.ts";
import type { FetchLike } from "../../sendblue/client.ts";
import { clearGoogleCalendarCache, GoogleCalendarProvider, observedLine } from "./provider.ts";
import { GoogleOauthStore } from "./store.ts";
import { clearGoogleTokenCache } from "./tokens.ts";

const NOW = "2026-09-14T12:00:00.000Z";

interface Fixture {
  provider: GoogleCalendarProvider;
  db: FakeD1;
  calls: Array<{ url: string; method: string; body: Record<string, unknown> | null; auth: string | undefined }>;
}

async function fixture(script: GoogleScript = {}, env: Record<string, string> = {}, now = () => NOW): Promise<Fixture> {
  const db = new FakeD1();
  await connectGoogle(db, { now: now() });
  const handler = googleFetchHandler(script);
  const calls: Fixture["calls"] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      auth: headers.authorization,
    });
    return (await handler(input, init)) ?? new Response("unhandled", { status: 404 });
  };

  const provider = new GoogleCalendarProvider({
    store: new GoogleOauthStore(db, TEST_ENV.WEBHOOK_SECRET),
    env: { ...GOOGLE_TEST_ENV, ...env },
    fetchImpl,
    now,
  });
  return { provider, db, calls };
}

function busy(start: string, end: string): { start: string; end: string } {
  return { start, end };
}

beforeEach(() => {
  clearGoogleCalendarCache();
  clearGoogleTokenCache();
});

describe("isBusyAt", () => {
  it("asks freeBusy for the primary calendar over the next 24 hours, with a bearer token", async () => {
    const { provider, calls } = await fixture();
    await provider.isBusyAt(NOW);

    const call = calls.find((c) => c.url.includes("freeBusy"))!;
    expect(call.method).toBe("POST");
    expect(call.auth).toBe("Bearer test-access-token");
    expect(call.body).toEqual({ timeMin: NOW, timeMax: "2026-09-15T12:00:00.000Z", items: [{ id: "primary" }] });
  });

  it("reports free with no next meeting when nothing is booked", async () => {
    const { provider } = await fixture({ busy: [] });
    expect(await provider.isBusyAt(NOW)).toEqual({ busy: false, until: null, next_busy_start: null, source: "ics" });
  });

  it("reports busy until the end of the block containing now", async () => {
    const { provider } = await fixture({ busy: [busy("2026-09-14T11:30:00.000Z", "2026-09-14T12:30:00.000Z")] });
    expect(await provider.isBusyAt(NOW)).toEqual({ busy: true, until: "2026-09-14T12:30:00.000Z", next_busy_start: null, source: "ics" });
  });

  it("merges back-to-back meetings, so `until` is the end of the last one", async () => {
    const { provider } = await fixture({
      busy: [
        busy("2026-09-14T11:30:00.000Z", "2026-09-14T12:30:00.000Z"),
        busy("2026-09-14T12:30:00.000Z", "2026-09-14T13:00:00.000Z"),
        busy("2026-09-14T12:45:00.000Z", "2026-09-14T14:00:00.000Z"),
      ],
    });
    expect(await provider.isBusyAt(NOW)).toMatchObject({ busy: true, until: "2026-09-14T14:00:00.000Z" });
  });

  it("does not merge across a real gap", async () => {
    const { provider } = await fixture({
      busy: [busy("2026-09-14T11:30:00.000Z", "2026-09-14T12:30:00.000Z"), busy("2026-09-14T15:00:00.000Z", "2026-09-14T16:00:00.000Z")],
    });
    expect(await provider.isBusyAt(NOW)).toMatchObject({ until: "2026-09-14T12:30:00.000Z" });
  });

  it("names the next meeting when free, and ignores one beyond the lookahead", async () => {
    const inside = await fixture({ busy: [busy("2026-09-14T15:00:00.000Z", "2026-09-14T16:00:00.000Z")] });
    expect(await inside.provider.isBusyAt(NOW)).toEqual({
      busy: false,
      until: null,
      next_busy_start: "2026-09-14T15:00:00.000Z",
      source: "ics",
    });

    clearGoogleCalendarCache();
    const outside = await fixture({ busy: [busy("2026-09-16T15:00:00.000Z", "2026-09-16T16:00:00.000Z")] });
    expect(await outside.provider.isBusyAt(NOW)).toMatchObject({ busy: false, next_busy_start: null });
  });

  it("treats a block ending exactly at now as over", async () => {
    const { provider } = await fixture({ busy: [busy("2026-09-14T11:00:00.000Z", NOW)] });
    expect(await provider.isBusyAt(NOW)).toMatchObject({ busy: false });
  });

  it("degrades to `none` when Google refuses, so a broken calendar never blocks an alert", async () => {
    const { provider } = await fixture({ override: (url) => (url.includes("freeBusy") ? new Response("nope", { status: 403 }) : null) });
    expect(await provider.isBusyAt(NOW)).toEqual({ busy: false, until: null, next_busy_start: null, source: "none" });
  });

  it("degrades to `none` when the calendar itself reports an error", async () => {
    const { provider } = await fixture({
      override: (url) =>
        url.includes("freeBusy")
          ? new Response(JSON.stringify({ calendars: { primary: { errors: [{ reason: "notFound" }] } } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : null,
    });
    expect(await provider.isBusyAt(NOW)).toMatchObject({ source: "none" });
  });

  it("degrades to `none` when there is no usable token, without inventing availability", async () => {
    const db = new FakeD1();
    const provider = new GoogleCalendarProvider({
      store: new GoogleOauthStore(db, TEST_ENV.WEBHOOK_SECRET),
      env: GOOGLE_TEST_ENV,
      fetchImpl: async () => new Response("{}", { status: 200 }),
      now: () => NOW,
    });
    expect(await provider.isBusyAt(NOW)).toMatchObject({ busy: false, source: "none" });
  });

  it("caches for a minute: repeated checks inside the same minute make one call", async () => {
    const { provider, calls } = await fixture({ busy: [] });
    await provider.isBusyAt(NOW);
    await provider.isBusyAt("2026-09-14T12:00:30.000Z");
    expect(calls.filter((c) => c.url.includes("freeBusy"))).toHaveLength(1);
  });

  it("asks again once the cache has expired", async () => {
    let clock = NOW;
    const { provider, calls } = await fixture({ busy: [] }, {}, () => clock);
    await provider.isBusyAt(clock);
    clock = "2026-09-14T12:02:00.000Z";
    await provider.isBusyAt(clock);
    expect(calls.filter((c) => c.url.includes("freeBusy"))).toHaveLength(2);
  });
});

describe("busyBetween", () => {
  it("returns merged ranges for an explicit window", async () => {
    const { provider } = await fixture({
      busy: [busy("2026-09-14T13:00:00.000Z", "2026-09-14T14:00:00.000Z"), busy("2026-09-14T14:00:00.000Z", "2026-09-14T15:00:00.000Z")],
    });
    expect(await provider.busyBetween(NOW, "2026-09-21T12:00:00.000Z")).toEqual([
      { start: "2026-09-14T13:00:00.000Z", end: "2026-09-14T15:00:00.000Z" },
    ]);
  });

  it("returns null — not an empty list — when Google could not be asked, so the caller can tell the difference", async () => {
    const { provider } = await fixture({ override: () => new Response("nope", { status: 500 }) });
    expect(await provider.busyBetween(NOW, "2026-09-21T12:00:00.000Z")).toBeNull();
  });
});

describe("fetchEvents", () => {
  const TIMED = {
    id: "standup",
    summary: "Standup with the team",
    status: "confirmed",
    start: { dateTime: "2026-09-14T11:30:00-04:00" },
    end: { dateTime: "2026-09-14T12:00:00-04:00" },
  };
  const ALL_DAY = { id: "offsite", summary: "Offsite", status: "confirmed", start: { date: "2026-09-15" }, end: { date: "2026-09-16" } };

  it("asks for single expanded events in start order over the whole day range", async () => {
    const { provider, calls } = await fixture({ events: [] });
    await provider.fetchEvents("2026-09-14", "2026-09-15");
    const url = new URL(calls.find((c) => c.url.includes("/events"))!.url);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      timeMin: "2026-09-14T00:00:00.000Z",
      timeMax: "2026-09-16T00:00:00.000Z",
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
    });
  });

  it("maps timed events to instants", async () => {
    const { provider } = await fixture({ events: [TIMED] });
    const { events, source } = await provider.fetchEvents("2026-09-14", "2026-09-14");
    expect(source).toBe("ics");
    expect(events).toEqual([
      { uid: "standup", start: "2026-09-14T15:30:00.000Z", end: "2026-09-14T16:00:00.000Z", summary: "Busy", allDay: false },
    ]);
  });

  it("maps all-day events, keeping Google's exclusive end date", async () => {
    const { provider } = await fixture({ events: [ALL_DAY] });
    const { events } = await provider.fetchEvents("2026-09-15", "2026-09-15");
    expect(events).toEqual([
      { uid: "offsite", start: "2026-09-15T00:00:00.000Z", end: "2026-09-16T00:00:00.000Z", summary: "Busy", allDay: true },
    ]);
  });

  it("hides titles by default and shows them only when CALENDAR_SHOW_TITLES=1", async () => {
    const hidden = await fixture({ events: [TIMED] });
    expect((await hidden.provider.fetchEvents("2026-09-14", "2026-09-14")).events[0]!.summary).toBe("Busy");

    clearGoogleCalendarCache();
    const shown = await fixture({ events: [TIMED] }, { CALENDAR_SHOW_TITLES: "1" });
    expect((await shown.provider.fetchEvents("2026-09-14", "2026-09-14")).events[0]!.summary).toBe("Standup with the team");
  });

  it("skips cancelled, transparent and declined events — none of them make the founder busy", async () => {
    const { provider } = await fixture({
      events: [
        { id: "cancelled", status: "cancelled", start: { dateTime: "2026-09-14T13:00:00Z" }, end: { dateTime: "2026-09-14T14:00:00Z" } },
        {
          id: "free",
          status: "confirmed",
          transparency: "transparent",
          start: { dateTime: "2026-09-14T14:00:00Z" },
          end: { dateTime: "2026-09-14T15:00:00Z" },
        },
        {
          id: "declined",
          status: "confirmed",
          attendees: [{ self: true, responseStatus: "declined" }],
          start: { dateTime: "2026-09-14T15:00:00Z" },
          end: { dateTime: "2026-09-14T16:00:00Z" },
        },
        TIMED,
      ],
    });
    expect((await provider.fetchEvents("2026-09-14", "2026-09-14")).events.map((e) => e.uid)).toEqual(["standup"]);
  });

  it("keeps an event someone else declined, and one the founder accepted", async () => {
    const { provider } = await fixture({
      events: [
        {
          id: "kept",
          status: "confirmed",
          attendees: [
            { self: false, responseStatus: "declined" },
            { self: true, responseStatus: "accepted" },
          ],
          start: { dateTime: "2026-09-14T13:00:00Z" },
          end: { dateTime: "2026-09-14T14:00:00Z" },
        },
      ],
    });
    expect((await provider.fetchEvents("2026-09-14", "2026-09-14")).events.map((e) => e.uid)).toEqual(["kept"]);
  });

  it("drops events with no usable start or end instead of guessing one", async () => {
    const { provider } = await fixture({ events: [{ id: "broken", status: "confirmed", start: {}, end: {} }] });
    expect((await provider.fetchEvents("2026-09-14", "2026-09-14")).events).toEqual([]);
  });

  it("sorts by start", async () => {
    const { provider } = await fixture({
      events: [
        { id: "late", status: "confirmed", start: { dateTime: "2026-09-14T16:00:00Z" }, end: { dateTime: "2026-09-14T17:00:00Z" } },
        { id: "early", status: "confirmed", start: { dateTime: "2026-09-14T13:00:00Z" }, end: { dateTime: "2026-09-14T14:00:00Z" } },
      ],
    });
    expect((await provider.fetchEvents("2026-09-14", "2026-09-14")).events.map((e) => e.uid)).toEqual(["early", "late"]);
  });

  it("reports `none` when the list cannot be read", async () => {
    const { provider } = await fixture({ override: (url) => (url.includes("/events") ? new Response("nope", { status: 401 }) : null) });
    expect(await provider.fetchEvents("2026-09-14", "2026-09-14")).toEqual({ events: [], source: "none" });
  });

  it("caches a range for five minutes, and treats a different range as a different question", async () => {
    let clock = NOW;
    const { provider, calls } = await fixture({ events: [TIMED] }, {}, () => clock);
    const listCalls = () => calls.filter((c) => c.url.includes("/events")).length;

    await provider.fetchEvents("2026-09-14", "2026-09-14");
    await provider.fetchEvents("2026-09-14", "2026-09-14");
    expect(listCalls()).toBe(1);

    await provider.fetchEvents("2026-09-15", "2026-09-15");
    expect(listCalls()).toBe(2);

    clock = "2026-09-14T12:06:00.000Z";
    await provider.fetchEvents("2026-09-14", "2026-09-14");
    expect(listCalls()).toBe(3);
  });
});

describe("createReviewEvent", () => {
  const derived = buildMockDerived();
  const incident = derived.primary_incident!;
  const APP_URL = "https://canary.test/incidents/inc_test";

  it("inserts a 15-minute event titled after the incident, linking back to the app", async () => {
    const { provider, calls } = await fixture();
    const result = await provider.createReviewEvent({ incident, appUrl: APP_URL, start: "2026-09-14T13:45:00.000Z" });

    expect(result).toEqual({
      ok: true,
      event: {
        id: "evt_test_review",
        htmlLink: "https://calendar.google.com/event?eid=evt_test_review",
        start: "2026-09-14T13:45:00.000Z",
        end: "2026-09-14T14:00:00.000Z",
        summary: `Review: ${incident.title} — Canary`,
      },
    });

    const insert = calls.find((c) => c.method === "POST" && c.url.includes("/events"))!;
    expect(insert.body).toMatchObject({
      summary: `Review: ${incident.title} — Canary`,
      start: { dateTime: "2026-09-14T13:45:00.000Z", timeZone: "America/New_York" },
      end: { dateTime: "2026-09-14T14:00:00.000Z", timeZone: "America/New_York" },
      reminders: { useDefault: true },
      source: { title: "Canary", url: APP_URL },
    });
  });

  it("describes the incident with one OBSERVED line and the deep link, and nothing it made up", async () => {
    const { provider, calls } = await fixture();
    await provider.createReviewEvent({ incident, appUrl: APP_URL, start: "2026-09-14T13:45:00.000Z" });

    const description = String(calls.find((c) => c.method === "POST" && c.url.includes("/events"))!.body!.description);
    expect(description).toBe(`${observedLine(incident)}\n\n${APP_URL}`);
    expect(description.startsWith("OBSERVED — ")).toBe(true);
    // One OBSERVED line, one link. No SUGGESTION, no prediction, no second URL.
    expect(description.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("honours a custom duration", async () => {
    const { provider } = await fixture();
    const result = await provider.createReviewEvent({ incident, appUrl: APP_URL, start: "2026-09-14T13:45:00.000Z", durationMinutes: 30 });
    expect(result).toMatchObject({ ok: true, event: { end: "2026-09-14T14:15:00.000Z" } });
  });

  it("reports failure rather than pretending the review is booked", async () => {
    const { provider } = await fixture({
      override: (url, init) => ((init?.method ?? "GET") === "POST" && url.includes("/events") ? new Response("nope", { status: 403 }) : null),
    });
    expect(await provider.createReviewEvent({ incident, appUrl: APP_URL, start: "2026-09-14T13:45:00.000Z" })).toEqual({
      ok: false,
      error: "insert_failed",
      detail: "Google returned 403.",
    });
  });

  it("rejects an unparseable start", async () => {
    const { provider } = await fixture();
    expect(await provider.createReviewEvent({ incident, appUrl: APP_URL, start: "whenever" })).toMatchObject({ ok: false });
  });

  it("invalidates the caches, so the new event shows up immediately", async () => {
    const { provider, calls } = await fixture({ busy: [] });
    await provider.isBusyAt(NOW);
    await provider.createReviewEvent({ incident, appUrl: APP_URL, start: "2026-09-14T13:45:00.000Z" });
    await provider.isBusyAt(NOW);
    expect(calls.filter((c) => c.url.includes("freeBusy"))).toHaveLength(2);
  });
});

describe("observedLine", () => {
  const derived = buildMockDerived();

  it("uses the incident's own figures for a burn-rate shift", () => {
    const incident = derived.primary_incident!;
    const line = observedLine(incident);
    expect(line.startsWith("OBSERVED — variable spending ")).toBe(true);
    expect(line).toContain("modeled runway");
    // Formatted by the shared money helpers, so it reads like every other Canary figure.
    expect(line).toMatch(/\$[\d,]+/);
  });

  it("names the vendor and the amount for a one-off", () => {
    const oneOff = derived.one_off_incident!;
    const line = observedLine(oneOff);
    expect(line).toContain("One-off payment to");
    expect(line).toMatch(/\$[\d,]+/);
  });

  it("falls back to the incident's own summary when there are no figures to state", () => {
    const bare: Incident = {
      ...derived.primary_incident!,
      financial_impact: {
        delta_weekly_cents: null,
        delta_monthly_cents: null,
        delta_annualized_cents: null,
        runway_before_months: null,
        runway_after_months: null,
        runway_impact_months: null,
      },
    };
    expect(observedLine(bare)).toBe(`OBSERVED — ${bare.summary}`);
  });
});
