import { describe, expect, it } from "vitest";
import { formatUsdWhole } from "@canary/shared";
import { buildMockDerived } from "@canary/shared/fixtures";
import {
  burnWindowCaption,
  categoryLabel,
  entityDisplayName,
  formatWeekLabel,
  formatWeeklyLevel,
  ruleLabel,
} from "@/lib/format.ts";

describe("entityDisplayName", () => {
  it("uses known display names", () => {
    expect(entityDisplayName("aws")).toBe("AWS");
    expect(entityDisplayName("datadog")).toBe("Datadog");
    expect(entityDisplayName("ashby")).toBe("Ashby");
    expect(entityDisplayName("figma")).toBe("Figma");
  });

  it("title-cases anything else", () => {
    expect(entityDisplayName("gusto_payroll")).toBe("Gusto Payroll");
    expect(entityDisplayName("stripe_payouts")).toBe("Stripe Payouts");
    expect(entityDisplayName("unknown_merchant_4471")).toBe("Unknown Merchant 4471");
  });
});

describe("labels", () => {
  it("humanizes categories and materiality rules", () => {
    expect(categoryLabel("CLOUD_INFRASTRUCTURE")).toBe("Cloud Infrastructure");
    expect(categoryLabel(null)).toBeNull();
    expect(ruleLabel("MIN_MONTHLY_DELTA")).toBe("Min monthly delta");
  });
});

describe("dates", () => {
  it("formats ISO dates in UTC so they never shift a day", () => {
    expect(formatWeekLabel("2026-09-07")).toBe("Sep 7");
    expect(formatWeekLabel("2026-01-01")).toBe("Jan 1");
  });
});

describe("money wrappers", () => {
  it("suffixes the shared formatter rather than building strings by hand", () => {
    const cents = buildMockDerived().burn.weekly_variable_spend_cents;
    expect(formatWeeklyLevel(cents)).toBe(`${formatUsdWhole(cents)}/wk`);
  });
});

describe("burnWindowCaption", () => {
  const burn = buildMockDerived().burn;

  it("names the post-change window when that is the reason", () => {
    expect(burnWindowCaption(burn)).toContain("post-change window");
  });

  it("falls back to the trailing window", () => {
    const trailing = { ...burn, burn_window_reason: "TRAILING_DEFAULT" as const, weeks_in_window: 8 };
    expect(burnWindowCaption(trailing)).toBe("trailing 8 weeks");
  });
});
