/**
 * The ICS reader, against hand-written Google-Calendar-shaped fixtures. Every
 * case here is one Canary has to get right to avoid texting a founder mid-meeting
 * (or holding an alert for a meeting that was cancelled).
 */
import { describe, expect, it } from "vitest";
import { expand, parseDuration, parseEvents, parseLine, parseRRule, unescapeText, unfold } from "./parse.ts";
import { wallTimeToUtc, zoneOffsetMs } from "./timezone.ts";

const NY = "America/New_York";

/** A Google Calendar export: VTIMEZONE preamble, VALARM inside the event, folded lines. */
const GOOGLE_FEED = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "VERSION:2.0",
  "CALSCALE:GREGORIAN",
  "METHOD:PUBLISH",
  "X-WR-CALNAME:Founder",
  "X-WR-TIMEZONE:America/New_York",
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "TZNAME:EDT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:EST",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
  // 1. Zoned meeting with a reminder and a folded summary.
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/New_York:20260914T090000",
  "DTEND;TZID=America/New_York:20260914T100000",
  "DTSTAMP:20260901T120000Z",
  "UID:board-meeting@google.com",
  "SUMMARY:Board meeting with the whole investor sync agenda spelled out at len",
  " gth",
  "STATUS:CONFIRMED",
  "TRANSP:OPAQUE",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "DESCRIPTION:This is an event reminder",
  "TRIGGER:-P0DT0H10M0S",
  "END:VALARM",
  "END:VEVENT",
  // 2. All-day event (DTEND is exclusive, per RFC 5545).
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20260915",
  "DTEND;VALUE=DATE:20260916",
  "UID:offsite@google.com",
  "SUMMARY:Offsite",
  "END:VEVENT",
  // 3. Weekly recurrence on Mondays and Wednesdays.
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/New_York:20260907T100000",
  "DTEND;TZID=America/New_York:20260907T103000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE",
  "UID:standup@google.com",
  "SUMMARY:Standup",
  "END:VEVENT",
  // 4. Cancelled: must not make anyone busy.
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/New_York:20260914T140000",
  "DTEND;TZID=America/New_York:20260914T150000",
  "UID:cancelled-1on1@google.com",
  "SUMMARY:1:1 (cancelled)",
  "STATUS:CANCELLED",
  "END:VEVENT",
  // 5. Marked "free" in Google Calendar.
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/New_York:20260914T160000",
  "DTEND;TZID=America/New_York:20260914T170000",
  "UID:gym@google.com",
  "SUMMARY:Gym",
  "TRANSP:TRANSPARENT",
  "END:VEVENT",
  // 6. UTC form with DURATION instead of DTEND.
  "BEGIN:VEVENT",
  "DTSTART:20260916T200000Z",
  "DURATION:PT1H30M",
  "UID:investor-call@google.com",
  "SUMMARY:Investor call",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const events = parseEvents(GOOGLE_FEED);
const byUid = (uid: string) => events.find((e) => e.uid === uid)!;

describe("unfold", () => {
  it("joins continuation lines and drops blank ones", () => {
    expect(unfold("SUMMARY:one\r\n two\r\n\r\nUID:x")).toEqual(["SUMMARY:onetwo", "UID:x"]);
  });

  it("treats a tab as a continuation too", () => {
    expect(unfold("SUMMARY:a\n\tb")).toEqual(["SUMMARY:ab"]);
  });
});

describe("parseLine", () => {
  it("splits name, params and value, and ignores colons inside quoted params", () => {
    expect(parseLine('DTSTART;TZID="America/New_York":20260914T090000')).toEqual({
      name: "DTSTART",
      params: { TZID: "America/New_York" },
      value: "20260914T090000",
    });
  });

  it("keeps colons in the value", () => {
    expect(parseLine("SUMMARY:1:1 with Sam")?.value).toBe("1:1 with Sam");
  });

  it("returns null for a line with no colon", () => {
    expect(parseLine("END VCALENDAR")).toBeNull();
  });
});

describe("unescapeText", () => {
  it("decodes escaped commas, semicolons, backslashes and newlines", () => {
    expect(unescapeText("Sync\\, prep\\; notes\\nline two\\\\end")).toBe("Sync, prep; notes\nline two\\end");
  });
});

describe("timezone conversion", () => {
  it("reads a summer wall time in New York as EDT (UTC-4)", () => {
    expect(wallTimeToUtc({ year: 2026, month: 9, day: 14, hour: 9, minute: 0, second: 0 }, NY).toISOString()).toBe("2026-09-14T13:00:00.000Z");
  });

  it("reads a winter wall time in New York as EST (UTC-5)", () => {
    expect(wallTimeToUtc({ year: 2026, month: 1, day: 14, hour: 9, minute: 0, second: 0 }, NY).toISOString()).toBe("2026-01-14T14:00:00.000Z");
  });

  it("measures the offset on both sides of a DST boundary", () => {
    expect(zoneOffsetMs(new Date("2026-07-01T12:00:00Z"), NY)).toBe(-4 * 3_600_000);
    expect(zoneOffsetMs(new Date("2026-12-01T12:00:00Z"), NY)).toBe(-5 * 3_600_000);
    expect(zoneOffsetMs(new Date("2026-07-01T12:00:00Z"), "UTC")).toBe(0);
  });

  it("falls back to UTC for an unknown TZID rather than dropping the event", () => {
    const parsed = parseEvents(
      ["BEGIN:VEVENT", "DTSTART;TZID=Mars/Olympus:20260914T090000", "DURATION:PT1H", "UID:mars", "END:VEVENT"].join("\r\n"),
    );
    expect(parsed[0]!.start.toISOString()).toBe("2026-09-14T09:00:00.000Z");
  });
});

describe("parseEvents", () => {
  it("reads every event that can make the founder busy, and no others", () => {
    expect(events.map((e) => e.uid)).toEqual([
      "board-meeting@google.com",
      "offsite@google.com",
      "standup@google.com",
      "investor-call@google.com",
    ]);
  });

  it("resolves a TZID event to the right UTC instant", () => {
    const meeting = byUid("board-meeting@google.com");
    expect(meeting.start.toISOString()).toBe("2026-09-14T13:00:00.000Z");
    expect(meeting.end.toISOString()).toBe("2026-09-14T14:00:00.000Z");
    expect(meeting.allDay).toBe(false);
  });

  it("unfolds the summary and ignores the VALARM inside the event", () => {
    expect(byUid("board-meeting@google.com").summary).toBe("Board meeting with the whole investor sync agenda spelled out at length");
  });

  it("reads an all-day event as a full UTC day", () => {
    const offsite = byUid("offsite@google.com");
    expect(offsite.allDay).toBe(true);
    expect(offsite.start.toISOString()).toBe("2026-09-15T00:00:00.000Z");
    expect(offsite.end.toISOString()).toBe("2026-09-16T00:00:00.000Z");
  });

  it("applies DURATION when DTEND is absent", () => {
    const call = byUid("investor-call@google.com");
    expect(call.start.toISOString()).toBe("2026-09-16T20:00:00.000Z");
    expect(call.durationMs).toBe(90 * 60_000);
  });

  it("defaults an all-day event with neither DTEND nor DURATION to one day", () => {
    const [event] = parseEvents(["BEGIN:VEVENT", "DTSTART;VALUE=DATE:20260915", "UID:pto", "END:VEVENT"].join("\r\n"));
    expect(event!.durationMs).toBe(86_400_000);
  });

  it("skips an event with no DTSTART", () => {
    expect(parseEvents(["BEGIN:VEVENT", "UID:broken", "SUMMARY:No start", "END:VEVENT"].join("\r\n"))).toEqual([]);
  });

  it("clamps an end that precedes its start", () => {
    const [event] = parseEvents(
      ["BEGIN:VEVENT", "DTSTART:20260914T120000Z", "DTEND:20260914T110000Z", "UID:backwards", "END:VEVENT"].join("\r\n"),
    );
    expect(event!.durationMs).toBe(0);
  });

  it("synthesises an id for an event with no UID", () => {
    const [event] = parseEvents(["BEGIN:VEVENT", "DTSTART:20260914T120000Z", "DURATION:PT1H", "END:VEVENT"].join("\r\n"));
    expect(event!.uid).toBe("canary-ics-0");
  });
});

describe("parseDuration", () => {
  it.each([
    ["PT30M", 1_800_000],
    ["PT1H30M", 5_400_000],
    ["P1D", 86_400_000],
    ["P2W", 1_209_600_000],
    ["PT45S", 45_000],
    ["-PT1H", 0],
  ])("reads %s", (value, expected) => {
    expect(parseDuration(value)).toBe(expected);
  });

  it("rejects nonsense", () => {
    expect(parseDuration("PT")).toBeNull();
    expect(parseDuration("1h")).toBeNull();
    expect(parseDuration("P")).toBeNull();
  });
});

describe("parseRRule", () => {
  it("reads FREQ, INTERVAL, BYDAY, UNTIL and COUNT", () => {
    expect(parseRRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261231T235959Z")).toEqual({
      freq: "WEEKLY",
      interval: 2,
      byDay: [0, 2],
      until: new Date("2026-12-31T23:59:59.000Z"),
      count: null,
    });
    expect(parseRRule("FREQ=DAILY;COUNT=3")).toMatchObject({ freq: "DAILY", interval: 1, count: 3 });
  });

  it("marks unsupported frequencies rather than guessing", () => {
    expect(parseRRule("FREQ=MONTHLY;BYMONTHDAY=1")?.freq).toBe("MONTHLY");
    expect(parseRRule("FREQ=HOURLY")?.freq).toBe("OTHER");
    expect(parseRRule("BYDAY=MO")).toBeNull();
  });

  it("ignores an ordinal prefix in BYDAY", () => {
    expect(parseRRule("FREQ=WEEKLY;BYDAY=2SU")?.byDay).toEqual([6]);
  });
});

describe("expand", () => {
  const from = new Date("2026-09-14T00:00:00Z");
  const to = new Date("2026-09-21T00:00:00Z");

  it("expands a weekly BYDAY=MO,WE rule inside the window only", () => {
    // The series starts Mon 2026-09-07, before the window; the next Monday
    // (2026-09-21T14:00Z) is past the window's exclusive end.
    const occurrences = expand(byUid("standup@google.com"), from, to);
    expect(occurrences.map((o) => o.start.toISOString())).toEqual(["2026-09-14T14:00:00.000Z", "2026-09-16T14:00:00.000Z"]);
  });

  it("keeps the wall-clock hour across a DST boundary", () => {
    const [event] = parseEvents(
      [
        "BEGIN:VEVENT",
        "DTSTART;TZID=America/New_York:20261028T090000",
        "DTEND;TZID=America/New_York:20261028T093000",
        "RRULE:FREQ=WEEKLY;BYDAY=WE",
        "UID:weekly-sync",
        "END:VEVENT",
      ].join("\r\n"),
    );
    const occurrences = expand(event!, new Date("2026-10-28T00:00:00Z"), new Date("2026-11-12T00:00:00Z"));
    // EDT ends 2026-11-01, so the same 9am meeting moves from 13:00Z to 14:00Z.
    expect(occurrences.map((o) => o.start.toISOString())).toEqual([
      "2026-10-28T13:00:00.000Z",
      "2026-11-04T14:00:00.000Z",
      "2026-11-11T14:00:00.000Z",
    ]);
  });

  it("honours INTERVAL", () => {
    const [event] = parseEvents(
      ["BEGIN:VEVENT", "DTSTART:20260907T100000Z", "DURATION:PT1H", "RRULE:FREQ=WEEKLY;INTERVAL=2", "UID:biweekly", "END:VEVENT"].join("\r\n"),
    );
    const occurrences = expand(event!, new Date("2026-09-07T00:00:00Z"), new Date("2026-10-12T00:00:00Z"));
    expect(occurrences.map((o) => o.start.toISOString().slice(0, 10))).toEqual(["2026-09-07", "2026-09-21", "2026-10-05"]);
  });

  it("stops at UNTIL and at COUNT", () => {
    const daily = (rrule: string) =>
      expand(
        parseEvents(["BEGIN:VEVENT", "DTSTART:20260914T100000Z", "DURATION:PT1H", `RRULE:${rrule}`, "UID:daily", "END:VEVENT"].join("\r\n"))[0]!,
        new Date("2026-09-14T00:00:00Z"),
        new Date("2026-09-30T00:00:00Z"),
      );
    expect(daily("FREQ=DAILY;UNTIL=20260916T100000Z")).toHaveLength(3);
    expect(daily("FREQ=DAILY;COUNT=2").map((o) => o.start.toISOString().slice(0, 10))).toEqual(["2026-09-14", "2026-09-15"]);
  });

  it("removes an occurrence listed in EXDATE", () => {
    const [event] = parseEvents(
      [
        "BEGIN:VEVENT",
        "DTSTART:20260914T100000Z",
        "DURATION:PT1H",
        "RRULE:FREQ=DAILY;COUNT=3",
        "EXDATE:20260915T100000Z",
        "UID:daily-with-hole",
        "END:VEVENT",
      ].join("\r\n"),
    );
    const occurrences = expand(event!, new Date("2026-09-14T00:00:00Z"), new Date("2026-09-30T00:00:00Z"));
    expect(occurrences.map((o) => o.start.toISOString().slice(0, 10))).toEqual(["2026-09-14", "2026-09-16"]);
  });

  it("yields only the first occurrence of a MONTHLY rule (documented limitation)", () => {
    const [event] = parseEvents(
      ["BEGIN:VEVENT", "DTSTART:20260901T100000Z", "DURATION:PT1H", "RRULE:FREQ=MONTHLY;BYMONTHDAY=1", "UID:monthly", "END:VEVENT"].join("\r\n"),
    );
    expect(expand(event!, new Date("2026-09-01T00:00:00Z"), new Date("2026-12-01T00:00:00Z"))).toHaveLength(1);
  });

  it("reaches a series that started long before the window without iterating every day", () => {
    const [event] = parseEvents(
      ["BEGIN:VEVENT", "DTSTART:20240102T100000Z", "DURATION:PT1H", "RRULE:FREQ=DAILY", "UID:old-standup", "END:VEVENT"].join("\r\n"),
    );
    const occurrences = expand(event!, from, new Date("2026-09-17T00:00:00Z"));
    expect(occurrences.map((o) => o.start.toISOString().slice(0, 10))).toEqual(["2026-09-14", "2026-09-15", "2026-09-16"]);
  });

  it("includes an event that straddles the start of the window but not one that ends on it", () => {
    const straddling = parseEvents(
      ["BEGIN:VEVENT", "DTSTART:20260913T230000Z", "DTEND:20260914T010000Z", "UID:overnight", "END:VEVENT"].join("\r\n"),
    )[0]!;
    const ending = parseEvents(
      ["BEGIN:VEVENT", "DTSTART:20260913T230000Z", "DTEND:20260914T000000Z", "UID:ends-at-midnight", "END:VEVENT"].join("\r\n"),
    )[0]!;
    expect(expand(straddling, from, to)).toHaveLength(1);
    expect(expand(ending, from, to)).toHaveLength(0);
  });
});
