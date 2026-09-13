import { describe, expect, it } from "vitest";
import { addDays, daysBetween, historyStart, isoWeekday, weekEnd, weekIndexOf, weekStart, weekStartsEndingAt } from "./dates.ts";
import { DEMO } from "./config.ts";

describe("dates", () => {
  it("DEMO.END_DATE is a Sunday", () => {
    expect(isoWeekday(DEMO.END_DATE)).toBe(6);
  });

  it("weekStart/weekEnd are Monday/Sunday", () => {
    expect(weekStart("2026-09-12")).toBe("2026-09-07");
    expect(weekEnd("2026-09-12")).toBe("2026-09-13");
    expect(weekStart("2026-09-07")).toBe("2026-09-07");
    expect(weekStart("2026-09-13")).toBe("2026-09-07");
  });

  it("builds N complete weeks ending at end date", () => {
    const starts = weekStartsEndingAt(DEMO.END_DATE, DEMO.WEEKS);
    expect(starts).toHaveLength(DEMO.WEEKS);
    expect(starts[DEMO.WEEKS - 1]).toBe(weekStart(DEMO.END_DATE));
    expect(historyStart(DEMO.END_DATE, DEMO.WEEKS)).toBe(starts[0]);
    expect(daysBetween(starts[0]!, DEMO.END_DATE)).toBe(DEMO.WEEKS * 7 - 1);
    for (let i = 1; i < starts.length; i++) expect(daysBetween(starts[i - 1]!, starts[i]!)).toBe(7);
  });

  it("weekIndexOf buckets by calendar week", () => {
    const hs = historyStart(DEMO.END_DATE, DEMO.WEEKS);
    expect(weekIndexOf(hs, hs)).toBe(0);
    expect(weekIndexOf(addDays(hs, 6), hs)).toBe(0);
    expect(weekIndexOf(addDays(hs, 7), hs)).toBe(1);
    expect(weekIndexOf(DEMO.END_DATE, hs)).toBe(DEMO.WEEKS - 1);
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });
});
