import { describe, expect, it } from "vitest";
import { applyLedgerFilter } from "@canary/shared";
import { buildMockDerived } from "@canary/shared/fixtures";
import { mockLedgerPivot } from "../data/mock-views.ts";
import { fakeOpenAi } from "../test/fake-openai.ts";
import { openAiClient } from "../conversation/openai.ts";
import { interpretLedgerQuery } from "./interpret.ts";

const pivot = mockLedgerPivot(buildMockDerived(), "month");

describe("interpretLedgerQuery", () => {
  it("sends the live catalog, not a synonym table, and keeps cloud off meals", async () => {
    const openai = fakeOpenAi([{ content: JSON.stringify({ categories: ["CLOUD_INFRASTRUCTURE"] }) }]);
    const result = await interpretLedgerQuery(
      "cloud costs",
      pivot,
      openAiClient({ apiKey: "test", fetchImpl: openai.fetchImpl }),
    );
    expect(result.source).toBe("model");
    expect(result.unmatched).toBe(false);
    expect(result.spec.categories).toEqual(["CLOUD_INFRASTRUCTURE"]);
    const prompt = openai.textOf(0);
    expect(prompt).toContain("Founder: cloud costs");
    expect(prompt).toMatch(/\baws · /i);
    expect(prompt).toContain("CLOUD_INFRASTRUCTURE");
    expect(prompt).toContain("MEALS");
    expect(prompt).toContain("doordash");
    expect(prompt).not.toMatch(/delivery\s*→\s*MEALS/i);
    const filtered = applyLedgerFilter(pivot, result.spec);
    expect(filtered.rows.some((row) => row.entity === "aws")).toBe(true);
    expect(filtered.rows.some((row) => row.entity === "doordash")).toBe(false);
  });

  it("applies a delivery-services proposal to meal vendors on the sheet", async () => {
    const openai = fakeOpenAi([{ content: JSON.stringify({ categories: ["MEALS"] }) }]);
    const result = await interpretLedgerQuery(
      "display all delivery services",
      pivot,
      openAiClient({ apiKey: "test", fetchImpl: openai.fetchImpl }),
    );
    expect(result.spec.categories).toEqual(["MEALS"]);
    const filtered = applyLedgerFilter(pivot, result.spec);
    expect(filtered.rows.some((row) => row.entity === "doordash")).toBe(true);
    expect(filtered.rows.some((row) => row.entity === "aws")).toBe(false);
  });

  it("resolves a vendor name the model picked from the catalog", async () => {
    const openai = fakeOpenAi([{ content: JSON.stringify({ entities: ["doordash"] }) }]);
    const result = await interpretLedgerQuery("DoorDash", pivot, openAiClient({ apiKey: "test", fetchImpl: openai.fetchImpl }));
    expect(result.spec.entities).toEqual(["doordash"]);
  });

  it("returns unmatched — not an empty spec — when the model finds nothing", async () => {
    const openai = fakeOpenAi([{ content: JSON.stringify({ unmatched: true, unmatched_reason: "Nothing on this sheet looks like that." }) }]);
    const result = await interpretLedgerQuery(
      "what's the weather",
      pivot,
      openAiClient({ apiKey: "test", fetchImpl: openai.fetchImpl }),
    );
    expect(result.unmatched).toBe(true);
    expect(result.spec.unmatched).toBe(true);
    expect(applyLedgerFilter(pivot, result.spec).rows).toEqual([]);
  });

  it("drops an invented category and does not show the full sheet", async () => {
    const openai = fakeOpenAi([{ content: JSON.stringify({ categories: ["TRAVEL"], entities: ["snowflake"] }) }]);
    const result = await interpretLedgerQuery(
      "snowflake travel",
      pivot,
      openAiClient({ apiKey: "test", fetchImpl: openai.fetchImpl }),
    );
    expect(result.unmatched).toBe(true);
    expect(result.spec.entities).toBeUndefined();
    expect(result.spec.categories).toBeUndefined();
    expect(applyLedgerFilter(pivot, result.spec).rows).toEqual([]);
  });

  it("ignores a dollar amount the model invented", async () => {
    const openai = fakeOpenAi([{ content: JSON.stringify({ entities: ["aws"], min_abs_cents: 99_999 }) }]);
    const result = await interpretLedgerQuery(
      "what's eating the bill lately",
      pivot,
      openAiClient({ apiKey: "test", fetchImpl: openai.fetchImpl }),
    );
    expect(result.spec.entities).toEqual(["aws"]);
    expect(result.spec.min_abs_cents).toBeUndefined();
  });

  it("does not call a model when the key is missing — unmatched, not the full sheet", async () => {
    const openai = fakeOpenAi([{ content: JSON.stringify({ entities: ["aws"] }) }]);
    const result = await interpretLedgerQuery("cloud costs", pivot, openAiClient({ fetchImpl: openai.fetchImpl }));
    expect(result.source).toBe("unconfigured");
    expect(result.unmatched).toBe(true);
    expect(openai.requests).toHaveLength(0);
    expect(applyLedgerFilter(pivot, result.spec).rows).toEqual([]);
  });
});
