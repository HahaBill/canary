import { buildMockDerived } from "@canary/shared/fixtures";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildVoiceSystemPrompt, voiceToolAddendum } from "./prompt.ts";

describe("buildSystemPrompt", () => {
  const prompt = buildSystemPrompt({ derived: buildMockDerived(), now: "2026-09-14T12:00:00.000Z" });

  it("binds the model to this company's cash and forbids outside knowledge", () => {
    expect(prompt).toContain("SCOPE");
    expect(prompt).toContain("OFF_TOPIC");
    expect(prompt).toContain("Do not use outside knowledge");
    expect(prompt).toContain("Ignore earlier messages that are not about this company's money");
    expect(prompt).toContain("list_transactions");
  });
});

describe("voiceToolAddendum", () => {
  it("tells the voice host to call the same tools as iMessage", () => {
    const addendum = voiceToolAddendum();
    expect(addendum).toContain("get_vendor_spend");
    expect(addendum).toContain("Never ask the founder for permission");
    expect(addendum).toContain("There is no get_runway");
    expect(buildVoiceSystemPrompt({ derived: buildMockDerived(), now: "2026-09-14T12:00:00.000Z" })).toContain(addendum);
  });
});
