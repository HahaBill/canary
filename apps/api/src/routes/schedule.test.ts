/** `POST /api/incidents/:id/schedule-review`: what it books, what it records, and what it refuses. */
import type { CalendarResponse, ErrorResponse } from "@canary/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { clearGoogleCalendarCache } from "../calendar/google/provider.ts";
import { GoogleOauthStore } from "../calendar/google/store.ts";
import { clearGoogleTokenCache } from "../calendar/google/tokens.ts";
import { FakeD1 } from "../test/fake-d1.ts";
import { connectGoogle, createHarness, FIXED_NOW, GOOGLE_TEST_ENV, googleFetchHandler, TEST_ENV, type GoogleScript } from "../test/harness.ts";
import type { ScheduleReviewResponse } from "./schedule.ts";

const ICS_URL = "https://calendar.google.com/calendar/ical/founder/private-abc/basic.ics";
/** 09:00 in New York on Monday 2026-09-14 — the first business-hours slot after `FIXED_NOW`. */
const FIRST_SLOT = "2026-09-14T13:00:00.000Z";

async function connected(script: GoogleScript = {}, env: Record<string, string | undefined> = {}) {
  const db = new FakeD1();
  await connectGoogle(db);
  const h = createHarness({ db, fetchHandler: googleFetchHandler(script), env: { ...GOOGLE_TEST_ENV, ...env } });
  return { h, db, incidentId: h.derived.primary_incident!.id };
}

beforeEach(() => {
  clearGoogleTokenCache();
  clearGoogleCalendarCache();
});

describe("without Google", () => {
  it("503s with the ICS feed, because an iCal feed cannot be written to", async () => {
    const h = createHarness({ db: new FakeD1(), env: { CALENDAR_ICS_URL: ICS_URL } });
    const { status, body } = await h.authed<ErrorResponse>(`/api/incidents/${h.derived.primary_incident!.id}/schedule-review`);
    expect(status).toBe(503);
    expect(body.error).toBe("google_not_connected");
    expect(body.detail).toContain("read-only");
    expect(body.detail).toContain("/oauth/google/start");
  });

  it("503s with no calendar at all", async () => {
    const h = createHarness({ db: new FakeD1() });
    const { status, body } = await h.authed<ErrorResponse>(`/api/incidents/${h.derived.primary_incident!.id}/schedule-review`);
    expect(status).toBe(503);
    expect(body.error).toBe("google_not_connected");
  });

  it("503s for a connection Google has revoked", async () => {
    const { h, db, incidentId } = await connected();
    await new GoogleOauthStore(db, TEST_ENV.WEBHOOK_SECRET).markRevoked("2026-09-13T09:00:00.000Z");
    const { status, body } = await h.authed<ErrorResponse>(`/api/incidents/${incidentId}/schedule-review`);
    expect(status).toBe(503);
    expect(body.error).toBe("google_not_connected");
  });
});

describe("authorization and input", () => {
  it("requires the operator secret", async () => {
    const { h, incidentId } = await connected();
    const { status, body } = await h.post<ErrorResponse>(`/api/incidents/${incidentId}/schedule-review`);
    expect(status).toBe(401);
    expect(body.error).toBe("unauthorized");
  });

  it("404s for an incident that does not exist", async () => {
    const { h } = await connected();
    const { status, body } = await h.authed<ErrorResponse>("/api/incidents/inc_nope/schedule-review");
    expect(status).toBe(404);
    expect(body.error).toBe("incident_not_found");
  });

  it("rejects a start that is not a timestamp, and a duration out of range", async () => {
    const { h, incidentId } = await connected();
    const path = `/api/incidents/${incidentId}/schedule-review`;
    expect((await h.authed<ErrorResponse>(path, { start: "next tuesday" })).body.error).toBe("invalid_start");
    expect((await h.authed<ErrorResponse>(path, { duration_minutes: 1 })).body.error).toBe("invalid_duration");
    expect((await h.authed<ErrorResponse>(path, { duration_minutes: 240 })).body.error).toBe("invalid_duration");
    expect((await h.authed<ErrorResponse>(path, { duration_minutes: 12.5 })).body.error).toBe("invalid_duration");
  });
});

describe("booking", () => {
  it("picks the next free business-hours slot and creates the event", async () => {
    const { h, incidentId } = await connected({ busy: [] });
    const { status, body } = await h.authed<ScheduleReviewResponse>(`/api/incidents/${incidentId}/schedule-review`);

    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      incident_id: incidentId,
      event: {
        id: "evt_test_review",
        html_link: "https://calendar.google.com/event?eid=evt_test_review",
        start: FIRST_SLOT,
        end: "2026-09-14T13:15:00.000Z",
        title: `Review scheduled — ${h.derived.primary_incident!.title}`,
      },
      url: `https://canary.test/incidents/${incidentId}`,
    });

    const insert = h.calls.find((c) => c.method === "POST" && c.url.includes("/calendar/v3/calendars/primary/events"))!;
    expect(insert.body).toMatchObject({
      summary: `Review: ${h.derived.primary_incident!.title} — Canary`,
      source: { title: "Canary", url: `https://canary.test/incidents/${incidentId}` },
    });
  });

  it("works around the founder's meetings", async () => {
    const { h, incidentId } = await connected({
      busy: [{ start: "2026-09-14T12:00:00.000Z", end: "2026-09-14T14:00:00.000Z" }],
    });
    const { body } = await h.authed<ScheduleReviewResponse>(`/api/incidents/${incidentId}/schedule-review`);
    expect(body.event.start).toBe("2026-09-14T14:00:00.000Z");
  });

  it("honours an explicit start, and skips the availability lookup entirely", async () => {
    const { h, incidentId } = await connected();
    const { body } = await h.authed<ScheduleReviewResponse>(`/api/incidents/${incidentId}/schedule-review`, {
      start: "2026-09-16T18:30:00Z",
      duration_minutes: 30,
    });
    expect(body.event).toMatchObject({ start: "2026-09-16T18:30:00.000Z", end: "2026-09-16T19:00:00.000Z" });
    expect(h.calls.filter((c) => c.url.includes("freeBusy"))).toHaveLength(0);
  });

  it("records the booking in `review_events`, keyed by incident and start", async () => {
    const { h, db, incidentId } = await connected({ busy: [] });
    await h.authed(`/api/incidents/${incidentId}/schedule-review`);

    expect(db.rows("review_events")).toEqual([
      {
        id: `${incidentId}|${FIRST_SLOT}`,
        incident_id: incidentId,
        event_id: "evt_test_review",
        html_link: "https://calendar.google.com/event?eid=evt_test_review",
        title: `Review scheduled — ${h.derived.primary_incident!.title}`,
        start_at: FIRST_SLOT,
        end_at: "2026-09-14T13:15:00.000Z",
        created_at: FIXED_NOW,
      },
    ]);
  });

  it("re-booking the same slot upserts instead of littering the calendar", async () => {
    const { h, db, incidentId } = await connected({ busy: [] });
    await h.authed(`/api/incidents/${incidentId}/schedule-review`, { start: FIRST_SLOT });
    await h.authed(`/api/incidents/${incidentId}/schedule-review`, { start: FIRST_SLOT });
    expect(db.rows("review_events")).toHaveLength(1);
  });

  it("shows up in /api/calendar as a canary marker on the day", async () => {
    const { h, incidentId } = await connected({ busy: [] });
    await h.authed(`/api/incidents/${incidentId}/schedule-review`);

    const { body } = await h.json<CalendarResponse>("/api/calendar?from=2026-09-14&to=2026-09-14");
    const events = body.calendar.days[0]!.events;
    const marker = events.find((e) => e.kind === "canary" && e.id.startsWith("review_"))!;
    expect(marker).toEqual({
      id: "review_evt_test_review",
      kind: "canary",
      date: "2026-09-14",
      start: FIRST_SLOT,
      end: "2026-09-14T13:15:00.000Z",
      title: `Review scheduled — ${h.derived.primary_incident!.title}`,
      incident_id: incidentId,
    });
    // A marker carries no money, so it cannot move the day's net.
    expect(body.calendar.days[0]!.net_actual_cents).toBe(
      events.filter((e) => e.kind === "actual").reduce((sum, e) => sum + (e.amount_cents ?? 0), 0),
    );
  });

  it("stays out of a range it does not fall in", async () => {
    const { h, incidentId } = await connected({ busy: [] });
    await h.authed(`/api/incidents/${incidentId}/schedule-review`);
    const { body } = await h.json<CalendarResponse>("/api/calendar?from=2026-09-20&to=2026-09-21");
    expect(body.calendar.days.flatMap((d) => d.events).filter((e) => e.id.startsWith("review_"))).toEqual([]);
  });
});

describe("when booking cannot be honest", () => {
  it("502s rather than double-booking when availability cannot be read", async () => {
    const { h, incidentId } = await connected({ override: (url) => (url.includes("freeBusy") ? new Response("nope", { status: 500 }) : null) });
    const { status, body } = await h.authed<ErrorResponse>(`/api/incidents/${incidentId}/schedule-review`);
    expect(status).toBe(502);
    expect(body.error).toBe("freebusy_unavailable");
    expect(body.detail).toContain("Nothing was booked");
    expect(h.calls.filter((c) => c.method === "POST" && c.url.includes("/events"))).toHaveLength(0);
  });

  it("409s when three business days hold no free slot", async () => {
    const { h, incidentId } = await connected({ busy: [{ start: "2026-09-14T00:00:00.000Z", end: "2026-09-19T00:00:00.000Z" }] });
    const { status, body } = await h.authed<ErrorResponse>(`/api/incidents/${incidentId}/schedule-review`);
    expect(status).toBe(409);
    expect(body.error).toBe("no_free_slot");
    expect(body.detail).toContain("`start`");
  });

  it("502s when Google refuses the insert, and records nothing", async () => {
    const { h, db, incidentId } = await connected({
      busy: [],
      override: (url, init) => ((init?.method ?? "GET") === "POST" && url.includes("/events") ? new Response("nope", { status: 403 }) : null),
    });
    const { status, body } = await h.authed<ErrorResponse>(`/api/incidents/${incidentId}/schedule-review`);
    expect(status).toBe(502);
    expect(body.error).toBe("calendar_write_failed");
    expect(db.rows("review_events")).toHaveLength(0);
  });

  it("still reports the booked event when the marker cannot be stored", async () => {
    const db = new FakeD1({ rejectTables: ["review_events"] });
    await connectGoogle(db);
    const h = createHarness({ db, fetchHandler: googleFetchHandler({ busy: [] }), env: GOOGLE_TEST_ENV });
    const { status, body } = await h.authed<ScheduleReviewResponse>(`/api/incidents/${h.derived.primary_incident!.id}/schedule-review`);
    expect(status).toBe(200);
    expect(body.event.start).toBe(FIRST_SLOT);
  });
});
