/**
 * The demo clock. It decides what "today" means to a founder watching the
 * dashboard, so its only job is to be boring: pure, bounded, and never able to
 * point at a day that has not happened.
 */
import { DEMO, addDays, historyStart } from "@canary/shared";
import { describe, expect, it } from "vitest";
import {
  CYCLE_DAYS,
  DEFAULT_MINUTES_PER_DAY,
  cycleMinutes,
  cycleStart,
  demoAsOf,
  horizonEnd,
  parseAsOfOverride,
  parseMinutesPerDay,
} from "./clock.ts";

const at = (minutes: number) => new Date(minutes * 60_000);
const LOOP = cycleMinutes();

describe("demoAsOf", () => {
  it("NEVER names a day after the end of history", () => {
    // The whole reason the clock walks backward. A dashboard that says "balance
    // as of Sep 20" on Sep 13 is not a demo device, it is a wrong answer —
    // nobody's bank knows next week's balance.
    for (let minute = 0; minute <= LOOP * 4; minute += 0.25) {
      expect(demoAsOf(at(minute)) <= DEMO.END_DATE, `minute ${minute}`).toBe(true);
    }
  });

  it("stays inside generated history at every instant", () => {
    const start = historyStart(DEMO.END_DATE, DEMO.WEEKS);
    for (let minute = 0; minute <= LOOP * 4; minute += 0.25) {
      const asOf = demoAsOf(at(minute));
      expect(asOf >= start, `minute ${minute}`).toBe(true);
      expect(asOf >= cycleStart(), `minute ${minute}`).toBe(true);
    }
  });

  it("walks a day at a time and ends ON the last day of history", () => {
    for (let day = 0; day < CYCLE_DAYS; day++) {
      expect(demoAsOf(at(day * DEFAULT_MINUTES_PER_DAY))).toBe(addDays(cycleStart(), day));
    }
    // The final step of the loop is the documented demo day, so the figures a
    // judge reads on screen are the ones in the README and the demo script.
    expect(demoAsOf(at((CYCLE_DAYS - 1) * DEFAULT_MINUTES_PER_DAY))).toBe(DEMO.END_DATE);
  });

  it("actually moves: consecutive days are different dates", () => {
    const seen = new Set<string>();
    for (let day = 0; day < CYCLE_DAYS; day++) seen.add(demoAsOf(at(day * DEFAULT_MINUTES_PER_DAY)));
    expect(seen.size).toBe(CYCLE_DAYS);
  });

  it("returns to the start of the loop at the top of each cycle", () => {
    expect(demoAsOf(at(0))).toBe(cycleStart());
    expect(demoAsOf(at(LOOP))).toBe(cycleStart());
    expect(demoAsOf(at(LOOP * 2))).toBe(cycleStart());
  });

  it("is a pure function of the instant", () => {
    const instant = at(12_345);
    expect(demoAsOf(instant)).toBe(demoAsOf(new Date(instant.getTime())));
  });

  it("freezes on the documented day when the speed is zero", () => {
    // The setting for a recorded clip: every figure on screen is the one in the
    // docs, and it cannot move mid-take.
    for (const minute of [0, 37, 999]) {
      expect(demoAsOf(at(minute), { minutesPerDay: 0 })).toBe(DEMO.END_DATE);
    }
  });

  it("handles instants before the epoch without escaping its bounds", () => {
    for (const minute of [-0.5, -5, -1234]) {
      const asOf = demoAsOf(at(minute));
      expect(asOf >= cycleStart()).toBe(true);
      expect(asOf <= DEMO.END_DATE).toBe(true);
    }
  });

  it("honours a custom speed and loop length without leaving the bounds", () => {
    for (const minutesPerDay of [0.25, 1, 5]) {
      for (const cycleDays of [1, 3, 30]) {
        for (const minute of [0, 1, 7.5, 61, 1440]) {
          const asOf = demoAsOf(at(minute), { minutesPerDay, cycleDays });
          expect(asOf <= DEMO.END_DATE).toBe(true);
          expect(asOf >= cycleStart(cycleDays)).toBe(true);
        }
      }
    }
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
