import { describe, expect, it } from "vitest";
import { formatUsd, formatUsdCompact, mad, median, runwayMonths, speakMonths, speakUsd, weeklyToMonthly } from "./money.ts";
import { WEEKS_PER_MONTH } from "./config.ts";
import { buildAppPath } from "./api.ts";
import { sandboxClosingCashCents } from "./company.ts";

describe("money", () => {
  it("pins 52/12 weeks per month", () => {
    expect(WEEKS_PER_MONTH).toBeCloseTo(4.3333, 4);
    expect(weeklyToMonthly(100_000)).toBe(433_333);
  });

  it("runway", () => {
    expect(runwayMonths(200_000_000, 14_000_000)).toBe(14.3);
    expect(runwayMonths(200_000_000, 0)).toBeNull();
    expect(runwayMonths(200_000_000, -5)).toBeNull();
  });

  it("median / mad", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(mad([1, 2, 3, 4, 100])).toBe(1);
  });

  it("formats", () => {
    expect(formatUsd(123_456)).toBe("$1,234.56");
    expect(formatUsdCompact(201_288_019)).toBe("$2.01M");
    expect(formatUsdCompact(3_940_000)).toBe("$39.4K");
    expect(formatUsdCompact(85_000)).toBe("$850");
  });

  it("speech", () => {
    expect(speakUsd(390_000)).toBe("about thirty-nine hundred dollars");
    expect(speakUsd(1_812_345)).toBe("about eighteen thousand dollars");
    expect(speakUsd(201_288_019)).toBe("about two million dollars");
    expect(speakUsd(-390_000)).toBe("about minus thirty-nine hundred dollars");
    expect(speakMonths(14.1)).toBe("about fourteen months");
    expect(speakMonths(13.5)).toBe("about thirteen and a half months");
    expect(speakMonths(null)).toBe("not currently burning cash");
  });

  it("app paths", () => {
    expect(buildAppPath({ destination: "dashboard" })).toBe("/");
    expect(buildAppPath({ destination: "incident", id: "inc_1" })).toBe("/incidents/inc_1");
    expect(buildAppPath({ destination: "incident", id: "inc_1", tab: "evidence" })).toBe("/incidents/inc_1?tab=evidence");
  });

  it("sandbox closing cash excludes card", () => {
    expect(sandboxClosingCashCents()).toBe(201_288_019);
  });
});
