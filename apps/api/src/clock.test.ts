/**
 * The demo clock. It decides what "today" means to a founder watching the
 * dashboard, so its only job is to be boring: pure, bounded, and never able to
 * point at a day the generator did not produce.
 */
import { DEMO, addDays, historyStart } from "@canary/shared";
import { describe, expect, it } from "vitest";
import { CYCLE_MINUTES, DEFAULT_MINUTES_PER_DAY, demoAsOf, horizonEnd, parseAsOfOverride, parseMinutesPerDay } from "./clock.ts";

const at = (minutes: number) => new Date(minutes * 60_000);

describe("demoAsOf", () => {
  it("starts at the end of history and moves a day at a time", () => {
    const cycleStart = at(0);
    expect(demoAsOf(cycleStart)).toBe(DEMO.END_DATE);
    expect(demoAsOf(at(DEFAULT_MINUTES_PER_DAY))).toBe(addDays(DEMO.END_DATE, 1));
    expect(demoAsOf(at(DEFAULT_MINUTES_PER_DAY * 5))).toBe(addDays(DEMO.END_DATE, 5));
  });

  it("never points past the generated horizon", () => {
    // Every minute of a full cycle, plus well beyond one.
    for (let minute = 0; minute <= CYCLE_MINUTES * 3; minute += 7) {
      const asOf = demoAsOf(at(minute));
      expect(asOf >= DEMO.END_DATE).toBe(true);
      expect(asOf <= horizonEnd()).toBe(true);
    }
  });

  it("returns to the end of history at the top of each cycle", () => {
    expect(demoAsOf(at(CYCLE_MINUTES))).toBe(DEMO.END_DATE);
    expect(demoAsOf(at(CYCLE_MINUTES * 2))).toBe(DEMO.END_DATE);
    // The last minute of a cycle is still inside the horizon, never clamped short.
    expect(demoAsOf(at(CYCLE_MINUTES - 1))).toBe(addDays(DEMO.END_DATE, CYCLE_MINUTES - 1));
  });

  it("is a pure function of the instant", () => {
    const instant = at(12_345);
    expect(demoAsOf(instant)).toBe(demoAsOf(new Date(instant.getTime())));
  });

  it("freezes at the end of history when the speed is zero", () => {
    for (const minute of [0, 37, 999]) {
      expect(demoAsOf(at(minute), { minutesPerDay: 0 })).toBe(DEMO.END_DATE);
    }
  });

  it("handles instants before the epoch without going backwards in time", () => {
    // Negative epoch-relative values must not produce a date before history.
    expect(demoAsOf(new Date(-5 * 60_000)) >= DEMO.END_DATE).toBe(true);
  });
});

describe("operator overrides", () => {
  it("falls back to the default speed rather than freezing on bad input", () => {
    for (const raw of [null, undefined, "", "abc", "-3", "NaN", "Infinity"]) {
      expect(parseMinutesPerDay(raw)).toBe(DEFAULT_MINUTES_PER_DAY);
    }
    expect(parseMinutesPerDay("5")).toBe(5);
    // Zero is a deliberate choice, not bad input: it means "freeze".
    expect(parseMinutesPerDay("0")).toBe(0);
  });

  it("accepts only a real date inside the generated span", () => {
    expect(parseAsOfOverride(DEMO.END_DATE)).toBe(DEMO.END_DATE);
    expect(parseAsOfOverride(horizonEnd())).toBe(horizonEnd());
    expect(parseAsOfOverride(addDays(horizonEnd(), 1))).toBeNull();
    expect(parseAsOfOverride(addDays(DEMO.END_DATE, -DEMO.WEEKS * 7 - 1))).toBeNull();
    for (const raw of ["", "yesterday", "2026-9-1", "2026-09-13T00:00:00Z", null]) {
      expect(parseAsOfOverride(raw)).toBeNull();
    }
  });

  it("bounds the past at the generator's real first day, not at WEEKS * 7", () => {
    // `historyStart` snaps back to the Monday of the earliest week, so on a
    // Sunday end date it is 363 days before, not 364. Re-deriving that
    // arithmetic by hand accepted one day on which no transaction exists —
    // which would hand the pipeline an `asOf` outside its own data.
    const start = historyStart(DEMO.END_DATE, DEMO.WEEKS);

    expect(parseAsOfOverride(start)).toBe(start);
    expect(parseAsOfOverride(addDays(start, -1))).toBeNull();
  });
});
