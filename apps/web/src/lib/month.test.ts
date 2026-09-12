import { describe, expect, it } from "vitest";
import { addMonths, firstDayOfMonth, isInMonth, lastDayOfMonth, monthGridDays, monthKeyOf } from "@/lib/month.ts";

describe("month helpers", () => {
  it("bounds a month without shifting a day", () => {
    expect(monthKeyOf("2026-09-13")).toBe("2026-09");
    expect(firstDayOfMonth("2026-09")).toBe("2026-09-01");
    expect(lastDayOfMonth("2026-09")).toBe("2026-09-30");
    expect(lastDayOfMonth("2026-02")).toBe("2026-02-28");
    // 2028 is a leap year.
    expect(lastDayOfMonth("2028-02")).toBe("2028-02-29");
  });

  it("steps across year boundaries", () => {
    expect(addMonths("2026-09", 1)).toBe("2026-10");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-09", -12)).toBe("2025-09");
  });

  it("pads the grid to whole Mon–Sun rows", () => {
    // 2026-09-01 is a Tuesday, 2026-09-30 a Wednesday.
    const days = monthGridDays("2026-09");
    expect(days).toHaveLength(35);
    expect(days[0]).toBe("2026-08-31");
    expect(days[days.length - 1]).toBe("2026-10-04");
    expect(days.length % 7).toBe(0);
    expect(isInMonth(days[0]!, "2026-09")).toBe(false);
    expect(isInMonth("2026-09-30", "2026-09")).toBe(true);
  });

  it("does not pad a month that already starts on Monday and ends on Sunday", () => {
    // 2027-02-01 is a Monday and 2027-02-28 a Sunday.
    const days = monthGridDays("2027-02");
    expect(days).toHaveLength(28);
    expect(days[0]).toBe("2027-02-01");
    expect(days[27]).toBe("2027-02-28");
  });
});
