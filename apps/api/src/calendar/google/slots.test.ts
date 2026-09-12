/**
 * `nextFreeSlot`: the deterministic answer to "when should the review be".
 *
 * All times below are stated in UTC; the founder's zone is America/New_York, so
 * 13:00Z is 09:00 local in September (EDT, −04:00).
 */
import { describe, expect, it } from "vitest";
import { mergeBusyRanges, nextFreeSlot, SLOT_GRID_MS } from "./slots.ts";

const TZ = "America/New_York";
/** Monday 2026-09-14, 09:00 in New York. */
const MONDAY_9AM = "2026-09-14T13:00:00.000Z";

function busy(start: string, end: string): { start: string; end: string } {
  return { start, end };
}

describe("mergeBusyRanges", () => {
  it("merges overlapping and back-to-back blocks into one run", () => {
    const merged = mergeBusyRanges([
      busy("2026-09-14T14:00:00.000Z", "2026-09-14T15:00:00.000Z"),
      busy("2026-09-14T15:00:00.000Z", "2026-09-14T16:00:00.000Z"),
      busy("2026-09-14T15:30:00.000Z", "2026-09-14T17:00:00.000Z"),
    ]);
    expect(merged).toEqual([{ start: Date.parse("2026-09-14T14:00:00.000Z"), end: Date.parse("2026-09-14T17:00:00.000Z") }]);
  });

  it("keeps a real gap, and sorts input it was handed out of order", () => {
    const merged = mergeBusyRanges([
      busy("2026-09-14T18:00:00.000Z", "2026-09-14T19:00:00.000Z"),
      busy("2026-09-14T14:00:00.000Z", "2026-09-14T15:00:00.000Z"),
    ]);
    expect(merged.map((r) => new Date(r.start).toISOString())).toEqual(["2026-09-14T14:00:00.000Z", "2026-09-14T18:00:00.000Z"]);
  });

  it("drops unparseable ranges rather than producing a NaN window", () => {
    expect(mergeBusyRanges([busy("not-a-date", "also-not")])).toEqual([]);
  });
});

describe("nextFreeSlot", () => {
  it("books the first quarter hour after the lead time when the day is empty", () => {
    // 09:05 local + 30 min lead = 09:35 → next grid point is 09:45.
    const slot = nextFreeSlot({ now: "2026-09-14T13:05:00.000Z", busy: [], timeZone: TZ });
    expect(slot).toEqual({ start: "2026-09-14T13:45:00.000Z", end: "2026-09-14T14:00:00.000Z" });
  });

  it("never books inside the lead time, even on an empty calendar", () => {
    const slot = nextFreeSlot({ now: MONDAY_9AM, busy: [], timeZone: TZ })!;
    expect(new Date(slot.start).getTime() - Date.parse(MONDAY_9AM)).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it("waits for the start of business hours when asked early in the morning", () => {
    // 06:00 local on Monday: the first slot is 09:00, not 06:30.
    const slot = nextFreeSlot({ now: "2026-09-14T10:00:00.000Z", busy: [], timeZone: TZ });
    expect(slot?.start).toBe(MONDAY_9AM);
  });

  it("skips a busy block and lands on the grid point after it", () => {
    // Busy 09:00-10:20 local → 10:20 is not a grid point, so 10:30.
    const slot = nextFreeSlot({
      now: MONDAY_9AM,
      busy: [busy("2026-09-14T13:00:00.000Z", "2026-09-14T14:20:00.000Z")],
      timeZone: TZ,
    });
    expect(slot).toEqual({ start: "2026-09-14T14:30:00.000Z", end: "2026-09-14T14:45:00.000Z" });
  });

  it("treats back-to-back meetings as one unavailable stretch", () => {
    const slot = nextFreeSlot({
      now: MONDAY_9AM,
      busy: [
        busy("2026-09-14T13:00:00.000Z", "2026-09-14T14:00:00.000Z"),
        busy("2026-09-14T14:00:00.000Z", "2026-09-14T15:00:00.000Z"),
        busy("2026-09-14T15:00:00.000Z", "2026-09-14T16:00:00.000Z"),
      ],
      timeZone: TZ,
    });
    expect(slot?.start).toBe("2026-09-14T16:00:00.000Z");
  });

  it("finds a gap between meetings when it is long enough", () => {
    const slot = nextFreeSlot({
      now: MONDAY_9AM,
      busy: [busy("2026-09-14T13:00:00.000Z", "2026-09-14T14:00:00.000Z"), busy("2026-09-14T14:15:00.000Z", "2026-09-14T18:00:00.000Z")],
      timeZone: TZ,
    });
    expect(slot).toEqual({ start: "2026-09-14T14:00:00.000Z", end: "2026-09-14T14:15:00.000Z" });
  });

  it("refuses a gap that is one minute too short and moves on", () => {
    const slot = nextFreeSlot({
      now: MONDAY_9AM,
      busy: [busy("2026-09-14T13:00:00.000Z", "2026-09-14T14:01:00.000Z"), busy("2026-09-14T14:15:00.000Z", "2026-09-14T16:00:00.000Z")],
      timeZone: TZ,
    });
    // 14:01 → grid 14:15, which is busy until 16:00.
    expect(slot?.start).toBe("2026-09-14T16:00:00.000Z");
  });

  it("crosses the day boundary when the request comes in after hours", () => {
    // Monday 17:50 local + 30 min = 18:20, past the 18:00 cutoff → Tuesday 09:00.
    const slot = nextFreeSlot({ now: "2026-09-14T21:50:00.000Z", busy: [], timeZone: TZ });
    expect(slot?.start).toBe("2026-09-15T13:00:00.000Z");
  });

  it("crosses the day boundary when the whole day is booked", () => {
    const slot = nextFreeSlot({
      now: MONDAY_9AM,
      busy: [busy("2026-09-14T12:00:00.000Z", "2026-09-14T23:00:00.000Z")],
      timeZone: TZ,
    });
    expect(slot?.start).toBe("2026-09-15T13:00:00.000Z");
  });

  it("skips the weekend: a Friday evening request lands on Monday", () => {
    // Friday 2026-09-18, 19:00 local.
    const slot = nextFreeSlot({ now: "2026-09-18T23:00:00.000Z", busy: [], timeZone: TZ });
    expect(slot?.start).toBe("2026-09-21T13:00:00.000Z");
    expect(new Date(slot!.start).getUTCDay()).toBe(1);
  });

  it("gives up rather than inventing a time when three business days are full", () => {
    const slot = nextFreeSlot({
      now: MONDAY_9AM,
      busy: [busy("2026-09-14T00:00:00.000Z", "2026-09-18T00:00:00.000Z")],
      timeZone: TZ,
    });
    expect(slot).toBeNull();
  });

  it("searches exactly `businessDays` days — the fourth is out of scope", () => {
    // Mon/Tue/Wed fully booked; Thursday is free but beyond a three-day search.
    const bookedThroughWednesday = [busy("2026-09-14T00:00:00.000Z", "2026-09-16T23:59:00.000Z")];
    expect(nextFreeSlot({ now: MONDAY_9AM, busy: bookedThroughWednesday, timeZone: TZ, businessDays: 3 })).toBeNull();
    expect(nextFreeSlot({ now: MONDAY_9AM, busy: bookedThroughWednesday, timeZone: TZ, businessDays: 4 })?.start).toBe("2026-09-17T13:00:00.000Z");
  });

  it("honours business hours in a different zone", () => {
    // 09:00 in Los Angeles is 16:00Z in September.
    const slot = nextFreeSlot({ now: "2026-09-14T10:00:00.000Z", busy: [], timeZone: "America/Los_Angeles" });
    expect(slot?.start).toBe("2026-09-14T16:00:00.000Z");
  });

  it("respects the wall clock across a DST change", () => {
    // 2026-11-02 is the Monday after clocks go back: 09:00 in New York is 14:00Z, not 13:00Z.
    const slot = nextFreeSlot({ now: "2026-11-02T10:00:00.000Z", busy: [], timeZone: TZ });
    expect(slot?.start).toBe("2026-11-02T14:00:00.000Z");
  });

  it("books a longer review when asked, and refuses one that cannot fit before 18:00", () => {
    const almostFull = [busy("2026-09-14T13:00:00.000Z", "2026-09-14T21:30:00.000Z")];
    // 17:30-18:00 local is free: 30 minutes fits, 45 does not.
    expect(nextFreeSlot({ now: MONDAY_9AM, busy: almostFull, timeZone: TZ, durationMinutes: 30 })?.start).toBe("2026-09-14T21:30:00.000Z");
    expect(nextFreeSlot({ now: MONDAY_9AM, busy: almostFull, timeZone: TZ, durationMinutes: 45, businessDays: 1 })).toBeNull();
  });

  it("always lands on a quarter-hour boundary", () => {
    for (const minute of [1, 7, 13, 22, 44, 59]) {
      const slot = nextFreeSlot({ now: `2026-09-14T13:${String(minute).padStart(2, "0")}:33.000Z`, busy: [], timeZone: TZ })!;
      expect(new Date(slot.start).getTime() % SLOT_GRID_MS).toBe(0);
    }
  });

  it("returns null on nonsense input instead of guessing", () => {
    expect(nextFreeSlot({ now: "not-a-date", busy: [], timeZone: TZ })).toBeNull();
    expect(nextFreeSlot({ now: MONDAY_9AM, busy: [], timeZone: TZ, durationMinutes: 0 })).toBeNull();
    expect(nextFreeSlot({ now: MONDAY_9AM, busy: [], timeZone: TZ, businessDays: 0 })).toBeNull();
  });
});
