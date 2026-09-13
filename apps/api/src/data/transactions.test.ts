import { CONVERSATION, formatUsdWhole } from "@canary/shared";
import { buildMockDerived } from "@canary/shared/fixtures";
import { describe, expect, it } from "vitest";
import { MockDataProvider } from "./provider.ts";
import { listFromWeeklyBuckets, selectTransactions } from "./transactions.ts";

describe("listFromWeeklyBuckets / selectTransactions", () => {
  const derived = buildMockDerived();

  it("returns newest AWS weekly totals first, capped", () => {
    const rows = listFromWeeklyBuckets(derived).filter((row) => row.entity === "aws");
    const { matched, items } = selectTransactions(rows, { entity: "aws" });
    expect(matched).toBe(derived.weeks.filter((week) => (week.variable_by_entity.aws ?? 0) > 0).length);
    expect(items.length).toBeLessThanOrEqual(CONVERSATION.MAX_LISTED_TRANSACTIONS);
    expect(items[0]!.date >= items.at(-1)!.date).toBe(true);
    const last = [...derived.weeks].reverse().find((week) => (week.variable_by_entity.aws ?? 0) > 0)!;
    expect(items[0]!.date).toBe(last.week_start);
    expect(Math.abs(items[0]!.amount_cents)).toBe(last.variable_by_entity.aws);
  });

  it("filters Needs Review separately from weekly totals", () => {
    const { items } = selectTransactions(listFromWeeklyBuckets(derived), { needs_review: true });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((row) => row.needs_review)).toBe(true);
  });
});

describe("MockDataProvider.listTransactions", () => {
  it("caps the list the conversational tool will see", async () => {
    const selection = await new MockDataProvider().listTransactions({ entity: "aws" });
    expect(selection.items.length).toBeLessThanOrEqual(CONVERSATION.MAX_LISTED_TRANSACTIONS);
    expect(selection.matched).toBeGreaterThan(selection.items.length);
    expect(formatUsdWhole(Math.abs(selection.items[0]!.amount_cents))).toMatch(/^\$/);
  });
});
