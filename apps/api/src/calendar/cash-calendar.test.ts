/** Day-boundary and clipping rules for the calendar merge (the fiddly half of the route). */
import type { CalendarEvent } from "@canary/shared";
import { describe, expect, it } from "vitest";
import { buildCashCalendar, busyEvents } from "./cash-calendar.ts";
import type { CalendarFeedEvent } from "./ics.ts";

const RANGE = { from: "2026-09-07", to: "2026-09-13" } as const;

const actual: CalendarEvent = { id: "actual_aws", kind: "actual", date: "2026-09-07", title: "aws", amount_cents: -420_000, entity: "aws" };
const expected: CalendarEvent = { id: "expected_aws", kind: "expected", date: "2026-09-14", title: "aws", amount_cents: -430_000, entity: "aws" };

function feedEvent(patch: Partial<CalendarFeedEvent> = {}): CalendarFeedEvent {
  return { uid: "sync@google.com", start: "2026-09-08T14:00:00.000Z", end: "2026-09-08T15:00:00.000Z", summary: "Sync", allDay: false, ...patch };
}

describe("busyEvents", () => {
  it("hides the title by default and shows it when asked", () => {
    expect(busyEvents({ ...RANGE, busy: [feedEvent()], showTitles: false })[0]!.title).toBe("Busy");
    expect(busyEvents({ ...RANGE, busy: [feedEvent()], showTitles: true })[0]!.title).toBe("Sync");
  });

  it("falls back to Busy for an untitled event even with titles on", () => {
    expect(busyEvents({ ...RANGE, busy: [feedEvent({ summary: "" })], showTitles: true })[0]!.title).toBe("Busy");
  });

  it("assigns a block ending exactly at midnight to the previous day only", () => {
    const overnight = feedEvent({ start: "2026-09-08T22:00:00.000Z", end: "2026-09-09T00:00:00.000Z" });
    expect(busyEvents({ ...RANGE, busy: [overnight], showTitles: false }).map((e) => e.date)).toEqual(["2026-09-08"]);
  });

  it("spans a block that crosses midnight over both days", () => {
    const overnight = feedEvent({ start: "2026-09-08T22:00:00.000Z", end: "2026-09-09T01:00:00.000Z" });
    expect(busyEvents({ ...RANGE, busy: [overnight], showTitles: false }).map((e) => e.date)).toEqual(["2026-09-08", "2026-09-09"]);
  });

  it("clips a block that starts before the range", () => {
    const long = feedEvent({ start: "2026-09-05T09:00:00.000Z", end: "2026-09-08T17:00:00.000Z" });
    expect(busyEvents({ ...RANGE, busy: [long], showTitles: false }).map((e) => e.date)).toEqual([
      "2026-09-07",
      "2026-09-08",
    ]);
  });

  it("gives every day of a recurring event its own id", () => {
    const recurring = [feedEvent(), feedEvent({ start: "2026-09-09T14:00:00.000Z", end: "2026-09-09T15:00:00.000Z" })];
    const ids = busyEvents({ ...RANGE, busy: recurring, showTitles: false }).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("busy_sync_google_com_2026-09-08_1400");
  });
});

describe("buildCashCalendar", () => {
  const calendar = buildCashCalendar({ ...RANGE, events: [actual, expected], busy: [feedEvent()], busySource: "ics", showTitles: false });

  it("emits one day per date in the range, inclusive", () => {
    expect(calendar.days.map((d) => d.date)).toEqual([
      "2026-09-07",
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
      "2026-09-13",
    ]);
  });

  it("drops events outside the range and nets the rest", () => {
    expect(calendar.days.flatMap((d) => d.events).map((e) => e.id)).not.toContain("expected_aws");
    expect(calendar.days[0]!.net_actual_cents).toBe(-420_000);
    expect(calendar.days.every((d) => d.net_expected_cents === 0)).toBe(true);
  });

  it("orders a day's events canary → actual → expected → busy", () => {
    const day = "2026-09-09";
    const mixed = buildCashCalendar({
      from: day,
      to: day,
      events: [
        { id: "e", kind: "expected", date: day, title: "aws", amount_cents: -1 },
        { id: "a", kind: "actual", date: day, title: "aws", amount_cents: -2 },
        { id: "c", kind: "canary", date: day, title: "Detector alarm" },
      ],
      busy: [feedEvent({ start: `${day}T14:00:00.000Z`, end: `${day}T15:00:00.000Z` })],
      busySource: "ics",
      showTitles: false,
    });
    expect(mixed.days[0]!.events.map((e) => e.kind)).toEqual(["canary", "actual", "expected", "busy"]);
  });

  it("ignores a `busy` event handed in through the cash-event list — those come from the feed only", () => {
    const smuggled = buildCashCalendar({
      ...RANGE,
      events: [{ id: "smuggled", kind: "busy", date: "2026-09-07", title: "Secret meeting" }],
      busy: [],
      busySource: "none",
      showTitles: false,
    });
    expect(smuggled.days.flatMap((d) => d.events)).toEqual([]);
    expect(smuggled.busy_source).toBe("none");
  });

  it("handles a single-day range", () => {
    const oneDay = buildCashCalendar({ from: "2026-09-07", to: "2026-09-07", events: [actual], busy: [], busySource: "none", showTitles: false });
    expect(oneDay.days).toHaveLength(1);
    expect(oneDay.days[0]!.events).toHaveLength(1);
  });
});
