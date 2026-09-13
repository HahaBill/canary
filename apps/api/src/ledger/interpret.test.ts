import { describe, expect, it } from "vitest";
import { buildMockDerived } from "@canary/shared/fixtures";
import { mockLedgerPivot } from "../data/mock-views.ts";
import { fakeOpenAi } from "../test/fake-openai.ts";
import { openAiClient } from "../conversation/openai.ts";
import { interpretLedgerQuery } from "./interpret.ts";

const pivot = mockLedgerPivot(buildMockDerived(), "month");

describe("interpretLedgerQuery", () => {
  it("stays on the rules path for a short vendor query", async () => {
    const openai = fakeOpenAi([{ content: JSON.stringify({ entities: ["datadog"] }) }]);
    const result = await interpretLedgerQuery("AWS", pivot, openAiClient({ apiKey: "test", fetchImpl: openai.fetchImpl }));
    expect(result.source).toBe("rules");
    expect(result.spec.entities).toEqual(["aws"]);
    expect(openai.requests).toHaveLength(0);
  });

  it("asks the model only when the rules find nothing, and still ignores invented amounts", async () => {
    const openai = fakeOpenAi([{ content: JSON.stringify({ entities: ["aws"], min_abs_cents: 99_999 }) }]);
    const result = await interpretLedgerQuery(
      "what's eating the bill lately",
      pivot,
      openAiClient({ apiKey: "test", fetchImpl: openai.fetchImpl }),
    );
    expect(result.source).toBe("model");
    expect(result.spec.entities).toEqual(["aws"]);
    expect(result.spec.min_abs_cents).toBeUndefined();
    expect(openai.requests).toHaveLength(1);
  });
});
