/**
 * Speech strings for voice and iMessage. Every figure comes from the engine;
 * this layer only chooses words. docs/AGENT_BEHAVIOR.md is the contract.
 */
import { FIXED_CATEGORIES, type DerivedDemoObject } from "@canary/shared";
import { buildMockDerived } from "@canary/shared/fixtures";
import { simulateCostChange } from "@canary/engine";
import { describe, expect, it } from "vitest";
import { noChangeExplanation, whatIfSpeech } from "./speech.ts";

const derived = buildMockDerived();

/** The derived object with one classified row for `entity` in `category`. */
function withEntity(base: DerivedDemoObject, entity: string, category: string): DerivedDemoObject {
  return {
    ...base,
    classifications: {
      ...base.classifications,
      seeded: {
        transaction_id: "seeded",
        merchant_normalized: entity,
        category: category as never,
        method: "RULE",
        reason: "test fixture",
        supporting_signals: [],
        confidence_level: "HIGH",
      },
    },
  };
}

describe("noChangeExplanation", () => {
  it("says nothing when the scenario really did change something", () => {
    const [entity] = Object.keys(derived.burn.weekly_variable_by_entity);
    expect(noChangeExplanation(derived, entity!, -20)).toBeNull();
  });

  it("tells a founder to check the spelling when the vendor was never seen", () => {
    const reason = noChangeExplanation(derived, "not_a_vendor", -20)!;
    expect(reason).toContain("no spending on record");
  });

  it("distinguishes a fixed-category vendor from one it has never seen", () => {
    // The engine cannot tell these apart — BurnSummary carries only monitored
    // variable spend, so both are simply absent. This layer can, and the
    // difference is "that's payroll" versus "check the spelling".
    const fixed = FIXED_CATEGORIES[0]!;
    const withPayroll = withEntity(derived, "gusto_payroll", fixed);
    const reason = noChangeExplanation(withPayroll, "gusto_payroll", -20)!;

    expect(reason).toContain("fixed rather than variable spend");
    expect(reason).toContain(fixed.toLowerCase().replace(/_/g, " "));
    expect(reason).not.toContain("no spending on record");
  });

  it("explains a zero-percent request as the request's own doing", () => {
    const [entity] = Object.keys(derived.burn.weekly_variable_by_entity);
    expect(noChangeExplanation(derived, entity!, 0)).toContain("zero percent");
  });

  it("explains a vendor whose credits cancel its charges", () => {
    const credited: DerivedDemoObject = {
      ...derived,
      burn: { ...derived.burn, weekly_variable_by_entity: { ...derived.burn.weekly_variable_by_entity, linear: -50_000 } },
    };
    expect(noChangeExplanation(credited, "linear", -20)).toContain("credits cancel its charges");
  });
});

describe("whatIfSpeech", () => {
  it("carries the reason into the spoken summary", () => {
    const result = simulateCostChange(derived.burn, { entity: "not_a_vendor", percentage: -20 });
    const reason = noChangeExplanation(derived, "not_a_vendor", -20);
    const speech = whatIfSpeech(result, reason);

    expect(speech.summary).toContain("monthly burn would not change");
    expect(speech.summary).toContain("no spending on record");
    // Never a URL, never a figure the engine did not compute.
    expect(speech.summary).not.toMatch(/https?:\/\//);
    expect(speech.summary).toContain(result.label);
  });

  it("says nothing extra when a scenario moved real money", () => {
    const [entity] = Object.keys(derived.burn.weekly_variable_by_entity);
    const result = simulateCostChange(derived.burn, { entity: entity!, percentage: -20 });
    const speech = whatIfSpeech(result, noChangeExplanation(derived, entity!, -20));

    expect(speech.summary).not.toContain("would not change");
    expect(speech.summary).toMatch(/monthly burn would (fall|rise)/);
  });

  it("still works with no reason supplied at all", () => {
    const result = simulateCostChange(derived.burn, { entity: "not_a_vendor", percentage: -20 });
    expect(whatIfSpeech(result).summary).toContain("monthly burn would not change");
  });
});
