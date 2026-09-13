import { describe, expect, it } from "vitest";
import { isOffTopic, mentionsCashDomain } from "./scope.ts";

describe("conversation scope", () => {
  it("treats ledger questions as in-scope", () => {
    for (const text of [
      "what were the recent AWS transactions?",
      "how's our runway?",
      "what if Datadog were 20% lower?",
      "and 40%?",
      "anything in Needs Review?",
    ]) {
      expect(mentionsCashDomain(text)).toBe(true);
      expect(isOffTopic(text)).toBe(false);
    }
  });

  it("flags standalone off-topic chatter", () => {
    for (const text of ["what's the weather", "tell me a joke", "write a poem", "who won the sports game"]) {
      expect(isOffTopic(text)).toBe(true);
    }
  });

  it("keeps a cash question that happens to mention an off-topic word", () => {
    expect(isOffTopic("how's AWS spend looking given the weather")).toBe(false);
    expect(isOffTopic("any bitcoin-looking charges on the ledger")).toBe(false);
  });
});
