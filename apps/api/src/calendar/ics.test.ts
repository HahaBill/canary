/** `IcsCalendar`: fetching, the per-isolate cache, and the busy/free question the alert policy asks. */
import { beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../sendblue/client.ts";
import { calendarFor, CALENDAR_CACHE_TTL_MS, clearIcsCache, IcsCalendar, NO_CALENDAR } from "./ics.ts";

const URL = "https://calendar.google.com/calendar/ical/founder/private-abc/basic.ics";

function feed(...vevents: string[][]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...vevents.flat(), "END:VCALENDAR"].join("\r\n");
}

const MEETING = [
  "BEGIN:VEVENT",
  "DTSTART:20260914T113000Z",
  "DTEND:20260914T123000Z",
  "UID:standup@google.com",
  "SUMMARY:Standup with the team",
  "END:VEVENT",
];

const LATER_MEETING = [
  "BEGIN:VEVENT",
  "DTSTART:20260914T150000Z",
  "DTEND:20260914T160000Z",
  "UID:1on1@google.com",
  "SUMMARY:1:1",
  "END:VEVENT",
];

interface Stub {
  fetchImpl: FetchLike;
  calls: string[];
  body: string;
  status: number;
}

function stub(body: string, status = 200): Stub {
  const state: Stub = {
    body,
    status,
    calls: [],
    fetchImpl: async (input) => {
      state.calls.push(String(input));
      return new Response(state.body, { status: state.status, headers: { "content-type": "text/calendar" } });
    },
  };
  return state;
}

beforeEach(clearIcsCache);

describe("configuration", () => {
  it("reports itself unconfigured without a URL, and `calendarFor` hands back the empty feed", async () => {
    expect(new IcsCalendar().configured).toBe(false);
    expect(new IcsCalendar({ url: "   " }).configured).toBe(false);
    expect(calendarFor({ url: "" })).toBe(NO_CALENDAR);
    expect(calendarFor({ url: URL })).toBeInstanceOf(IcsCalendar);
  });

  it("never fetches and never claims to know anything when unconfigured", async () => {
    const feedStub = stub(feed(MEETING));
    const calendar = new IcsCalendar({ fetchImpl: feedStub.fetchImpl, now: () => "2026-09-14T12:00:00.000Z" });
    expect(await calendar.fetchEvents("2026-09-14", "2026-09-14")).toEqual({ events: [], source: "none" });
    expect(await calendar.isBusyAt("2026-09-14T12:00:00.000Z")).toEqual({ busy: false, until: null, next_busy_start: null, source: "none" });
    expect(feedStub.calls).toHaveLength(0);
  });

  it("the empty feed answers free from an unknown source", async () => {
    expect(await NO_CALENDAR.isBusyAt("2026-09-14T12:00:00.000Z")).toEqual({ busy: false, until: null, next_busy_start: null, source: "none" });
  });
});

describe("fetchEvents", () => {
  it("returns the occurrences in a date range as instants", async () => {
    const calendar = new IcsCalendar({ url: URL, fetchImpl: stub(feed(MEETING, LATER_MEETING)).fetchImpl, now: () => "2026-09-14T12:00:00.000Z" });
    const { events, source } = await calendar.fetchEvents("2026-09-14", "2026-09-14");
    expect(source).toBe("ics");
    expect(events).toEqual([
      { uid: "standup@google.com", start: "2026-09-14T11:30:00.000Z", end: "2026-09-14T12:30:00.000Z", summary: "Standup with the team", allDay: false },
      { uid: "1on1@google.com", start: "2026-09-14T15:00:00.000Z", end: "2026-09-14T16:00:00.000Z", summary: "1:1", allDay: false },
    ]);
  });

  it("excludes events outside the range", async () => {
    const calendar = new IcsCalendar({ url: URL, fetchImpl: stub(feed(MEETING)).fetchImpl, now: () => "2026-09-14T12:00:00.000Z" });
    expect((await calendar.fetchEvents("2026-09-15", "2026-09-16")).events).toEqual([]);
  });

  it("degrades to `none` when the feed cannot be read, so a broken calendar never blocks an alert", async () => {
    const calendar = new IcsCalendar({ url: URL, fetchImpl: stub("nope", 403).fetchImpl, now: () => "2026-09-14T12:00:00.000Z" });
    expect(await calendar.fetchEvents("2026-09-14", "2026-09-14")).toEqual({ events: [], source: "none" });
  });

  it("degrades to `none` when the fetch throws", async () => {
    const calendar = new IcsCalendar({
      url: URL,
      now: () => "2026-09-14T12:00:00.000Z",
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect((await calendar.isBusyAt("2026-09-14T12:00:00.000Z")).source).toBe("none");
  });

  it("reads a feed with no events as configured but empty", async () => {
    const calendar = new IcsCalendar({ url: URL, fetchImpl: stub(feed()).fetchImpl, now: () => "2026-09-14T12:00:00.000Z" });
    expect(await calendar.fetchEvents("2026-09-14", "2026-09-14")).toEqual({ events: [], source: "ics" });
  });
});

describe("caching", () => {
  it("reads the feed once per isolate for five minutes, then again", async () => {
    const feedStub = stub(feed(MEETING));
    let now = new Date("2026-09-14T12:00:00.000Z").getTime();
    const calendar = new IcsCalendar({ url: URL, fetchImpl: feedStub.fetchImpl, now: () => new Date(now).toISOString() });

    await calendar.fetchEvents("2026-09-14", "2026-09-14");
    await calendar.isBusyAt(new Date(now).toISOString());
    expect(feedStub.calls).toHaveLength(1);

    now += CALENDAR_CACHE_TTL_MS - 1_000;
    await calendar.fetchEvents("2026-09-14", "2026-09-14");
    expect(feedStub.calls).toHaveLength(1);

    now += 2_000;
    await calendar.fetchEvents("2026-09-14", "2026-09-14");
    expect(feedStub.calls).toHaveLength(2);
  });

  it("shares the cache across instances built for the same URL", async () => {
    const feedStub = stub(feed(MEETING));
    const config = { url: URL, fetchImpl: feedStub.fetchImpl, now: () => "2026-09-14T12:00:00.000Z" };
    await new IcsCalendar(config).fetchEvents("2026-09-14", "2026-09-14");
    await new IcsCalendar(config).fetchEvents("2026-09-14", "2026-09-14");
    expect(feedStub.calls).toHaveLength(1);
  });
});

describe("isBusyAt", () => {
  const at = (iso: string, ...vevents: string[][]) =>
    new IcsCalendar({ url: URL, fetchImpl: stub(feed(...vevents)).fetchImpl, now: () => iso }).isBusyAt(iso);

  it("is busy inside a meeting, until it ends", async () => {
    expect(await at("2026-09-14T12:00:00.000Z", MEETING)).toEqual({
      busy: true,
      until: "2026-09-14T12:30:00.000Z",
      next_busy_start: null,
      source: "ics",
    });
  });

  it("is free between meetings, and points at the next one", async () => {
    expect(await at("2026-09-14T13:00:00.000Z", MEETING, LATER_MEETING)).toEqual({
      busy: false,
      until: null,
      next_busy_start: "2026-09-14T15:00:00.000Z",
      source: "ics",
    });
  });

  it("merges back-to-back meetings into one busy run", async () => {
    const backToBack = [
      "BEGIN:VEVENT",
      "DTSTART:20260914T123000Z",
      "DTEND:20260914T133000Z",
      "UID:next@google.com",
      "SUMMARY:Design review",
      "END:VEVENT",
    ];
    expect(await at("2026-09-14T12:00:00.000Z", MEETING, backToBack)).toMatchObject({ busy: true, until: "2026-09-14T13:30:00.000Z" });
  });

  it("reports free with no upcoming block when the next meeting is beyond the 24h lookahead", async () => {
    const nextWeek = ["BEGIN:VEVENT", "DTSTART:20260921T150000Z", "DTEND:20260921T160000Z", "UID:far@google.com", "END:VEVENT"];
    expect(await at("2026-09-14T13:00:00.000Z", nextWeek)).toMatchObject({ busy: false, next_busy_start: null });
  });

  it("treats an all-day event as busy for the whole day", async () => {
    const offsite = ["BEGIN:VEVENT", "DTSTART;VALUE=DATE:20260914", "DTEND;VALUE=DATE:20260915", "UID:offsite@google.com", "END:VEVENT"];
    expect(await at("2026-09-14T18:00:00.000Z", offsite)).toMatchObject({ busy: true, until: "2026-09-15T00:00:00.000Z" });
  });

  it("sees a block that started the previous evening", async () => {
    const overnight = ["BEGIN:VEVENT", "DTSTART:20260913T230000Z", "DTEND:20260914T020000Z", "UID:redeye@google.com", "END:VEVENT"];
    expect(await at("2026-09-14T00:30:00.000Z", overnight)).toMatchObject({ busy: true, until: "2026-09-14T02:00:00.000Z" });
  });

  it("is free during an event the calendar marks as free", async () => {
    const gym = [
      "BEGIN:VEVENT",
      "DTSTART:20260914T113000Z",
      "DTEND:20260914T123000Z",
      "UID:gym@google.com",
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    ];
    expect(await at("2026-09-14T12:00:00.000Z", gym)).toMatchObject({ busy: false, next_busy_start: null });
  });

  it("is free during a cancelled meeting", async () => {
    const cancelled = [
      "BEGIN:VEVENT",
      "DTSTART:20260914T113000Z",
      "DTEND:20260914T123000Z",
      "UID:cancelled@google.com",
      "STATUS:CANCELLED",
      "END:VEVENT",
    ];
    expect(await at("2026-09-14T12:00:00.000Z", cancelled)).toMatchObject({ busy: false });
  });
});
