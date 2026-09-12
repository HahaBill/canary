/**
 * The `SCHEDULE` iMessage reply. Every path either books something and says
 * exactly what, or says plainly that it did not — there is no third option.
 */
import { buildMockDerived } from "@canary/shared/fixtures";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1 } from "../test/fake-d1.ts";
import { connectGoogle, GOOGLE_TEST_ENV, googleFetchHandler, TEST_ENV, type GoogleScript } from "../test/harness.ts";
import type { FetchLike } from "../sendblue/client.ts";
import { clearGoogleCalendarCache, GoogleCalendarProvider } from "./google/provider.ts";
import { GoogleOauthStore } from "./google/store.ts";
import { clearGoogleTokenCache } from "./google/tokens.ts";
import { ReviewEventStore } from "./review-events.ts";
import { scheduleReviewReply, speakSlot } from "./schedule-command.ts";

const NOW = "2026-09-14T12:00:00.000Z";
const BASE_URL = "https://canary.test";
const derived = buildMockDerived();
const incident = derived.primary_incident!;

async function googleProvider(script: GoogleScript = {}, env: Record<string, string> = {}): Promise<{ calendar: GoogleCalendarProvider; db: FakeD1 }> {
  const db = new FakeD1();
  await connectGoogle(db, { now: NOW });
  const handler = googleFetchHandler(script);
  const fetchImpl: FetchLike = async (input, init) => (await handler(input, init)) ?? new Response("unhandled", { status: 404 });
  return {
    db,
    calendar: new GoogleCalendarProvider({
      store: new GoogleOauthStore(db, TEST_ENV.WEBHOOK_SECRET),
      env: { ...GOOGLE_TEST_ENV, ...env },
      fetchImpl,
      now: () => NOW,
    }),
  };
}

beforeEach(() => {
  clearGoogleTokenCache();
  clearGoogleCalendarCache();
});

describe("speakSlot", () => {
  it("reads the founder's own clock, not UTC", () => {
    expect(speakSlot("2026-09-14T13:00:00.000Z", "America/New_York")).toBe("Monday at 9:00 AM");
    expect(speakSlot("2026-09-14T13:00:00.000Z", "America/Los_Angeles")).toBe("Monday at 6:00 AM");
    expect(speakSlot("2026-09-15T21:45:00.000Z", "America/New_York")).toBe("Tuesday at 5:45 PM");
  });
});

describe("booking", () => {
  it("says what it booked, when, and links the incident", async () => {
    const { calendar } = await googleProvider({ busy: [] });
    const reply = await scheduleReviewReply({ provider: "google", calendar, incident, baseUrl: BASE_URL, now: NOW });

    const [first, second] = reply.split("\n");
    expect(first).toBe(`Booked 15 minutes on Monday at 9:00 AM to review the AWS incident.`);
    // The link is built by `buildAppPath` — never written by a model.
    expect(second).toBe(`${BASE_URL}/incidents/${incident.id}`);
  });

  it("works around the founder's meetings", async () => {
    const { calendar } = await googleProvider({ busy: [{ start: "2026-09-14T12:00:00.000Z", end: "2026-09-14T15:30:00.000Z" }] });
    const reply = await scheduleReviewReply({ provider: "google", calendar, incident, baseUrl: BASE_URL, now: NOW });
    expect(reply).toContain("Monday at 11:30 AM");
  });

  it("records the marker when a store is passed, so /api/calendar agrees with the text", async () => {
    const { calendar, db } = await googleProvider({ busy: [] });
    const reviews = new ReviewEventStore(db);
    await scheduleReviewReply({ provider: "google", calendar, incident, baseUrl: BASE_URL, now: NOW, reviews });

    expect(await reviews.list()).toEqual([
      {
        id: `${incident.id}|2026-09-14T13:00:00.000Z`,
        incident_id: incident.id,
        event_id: "evt_test_review",
        html_link: "https://calendar.google.com/event?eid=evt_test_review",
        title: `Review scheduled — ${incident.title}`,
        start_at: "2026-09-14T13:00:00.000Z",
        end_at: "2026-09-14T13:15:00.000Z",
        created_at: NOW,
      },
    ]);
  });

  it("books without a store when D1 is not available", async () => {
    const { calendar } = await googleProvider({ busy: [] });
    const reply = await scheduleReviewReply({ provider: "google", calendar, incident, baseUrl: BASE_URL, now: NOW, reviews: null });
    expect(reply).toContain("Booked 15 minutes");
  });

  it("states the duration it actually used", async () => {
    const { calendar } = await googleProvider({ busy: [] });
    const reply = await scheduleReviewReply({ provider: "google", calendar, incident, baseUrl: BASE_URL, now: NOW, durationMinutes: 30 });
    expect(reply).toContain("Booked 30 minutes");
  });

  it("names the one-off vendor for a one-off incident", async () => {
    const { calendar } = await googleProvider({ busy: [] });
    const oneOff = derived.one_off_incident!;
    const reply = await scheduleReviewReply({ provider: "google", calendar, incident: oneOff, baseUrl: BASE_URL, now: NOW });
    expect(reply).toContain("to review the Figma incident");
  });
});

describe("honest refusals", () => {
  it("will not claim to book anything with a read-only iCal feed", async () => {
    const reply = await scheduleReviewReply({ provider: "ics", calendar: null, incident, baseUrl: BASE_URL, now: NOW });
    expect(reply).toContain("can only read your calendar");
    expect(reply).not.toContain("Booked");
  });

  it("says so when no calendar is connected at all", async () => {
    const reply = await scheduleReviewReply({ provider: "none", calendar: null, incident, baseUrl: BASE_URL, now: NOW });
    expect(reply).toContain("no calendar is connected");
  });

  it("has nothing to review when nothing is flagged", async () => {
    const { calendar } = await googleProvider();
    const reply = await scheduleReviewReply({ provider: "google", calendar, incident: null, baseUrl: BASE_URL, now: NOW });
    expect(reply).toContain("Nothing is flagged");
    expect(reply).not.toContain("Booked");
  });

  it("does not guess a time when availability cannot be read", async () => {
    const { calendar } = await googleProvider({ override: (url) => (url.includes("freeBusy") ? new Response("nope", { status: 500 }) : null) });
    const reply = await scheduleReviewReply({ provider: "google", calendar, incident, baseUrl: BASE_URL, now: NOW });
    expect(reply).toContain("couldn't reach your calendar");
    expect(reply).not.toContain("Booked");
  });

  it("says the week is full rather than booking over a meeting", async () => {
    const { calendar } = await googleProvider({ busy: [{ start: "2026-09-14T00:00:00.000Z", end: "2026-09-19T00:00:00.000Z" }] });
    const reply = await scheduleReviewReply({ provider: "google", calendar, incident, baseUrl: BASE_URL, now: NOW });
    expect(reply).toContain("nothing free for 15 minutes");
    expect(reply).not.toContain("Booked");
  });

  it("says nothing is booked when Google refuses the insert", async () => {
    const { calendar, db } = await googleProvider({
      busy: [],
      override: (url, init) => ((init?.method ?? "GET") === "POST" && url.includes("/events") ? new Response("nope", { status: 403 }) : null),
    });
    const reviews = new ReviewEventStore(db);
    const reply = await scheduleReviewReply({ provider: "google", calendar, incident, baseUrl: BASE_URL, now: NOW, reviews });
    expect(reply).toContain("nothing is booked");
    expect(await reviews.list()).toEqual([]);
  });

  it("never puts a URL in a refusal", async () => {
    const refusals = await Promise.all([
      scheduleReviewReply({ provider: "ics", calendar: null, incident, baseUrl: BASE_URL, now: NOW }),
      scheduleReviewReply({ provider: "none", calendar: null, incident, baseUrl: BASE_URL, now: NOW }),
      scheduleReviewReply({ provider: "google", calendar: null, incident, baseUrl: BASE_URL, now: NOW }),
    ]);
    for (const reply of refusals) expect(reply).not.toContain("http");
  });
});
