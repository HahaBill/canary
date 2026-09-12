/** Evidence assembly: taxonomy order, cited sources, scenario estimate, suggestion. */
import { EVIDENCE_KINDS, formatMonths, formatSignedUsd, SCENARIO_LABEL, type EvidenceItem } from "@canary/shared";
import { buildMockDerived } from "@canary/shared/fixtures";
import { describe, expect, it } from "vitest";
import { MockDataProvider } from "./data/provider.ts";
import { assembleEvidence, buildEvidence, ESTIMATE_PERCENTAGE, relevantEnrichments, sortByTaxonomy } from "./evidence.ts";

const derived = buildMockDerived();
const incident = derived.primary_incident!;
const provider = new MockDataProvider(derived);

describe("sortByTaxonomy", () => {
  it("orders by kind and keeps insertion order within a kind", () => {
    const items: EvidenceItem[] = [
      { kind: "SUGGESTION", text: "s" },
      { kind: "OBSERVED", text: "o1" },
      { kind: "ESTIMATE", text: "e" },
      { kind: "OBSERVED", text: "o2" },
      { kind: "EVIDENCE", text: "v" },
      { kind: "DETECTED", text: "d" },
    ];
    expect(sortByTaxonomy(items).map((i) => `${i.kind}:${i.text}`)).toEqual([
      "OBSERVED:o1",
      "OBSERVED:o2",
      "DETECTED:d",
      "EVIDENCE:v",
      "ESTIMATE:e",
      "SUGGESTION:s",
    ]);
  });
});

describe("relevantEnrichments", () => {
  it("keeps enrichments for the incident entity or its contributors", () => {
    expect(relevantEnrichments(derived, incident).map((e) => e.merchant_normalized)).toEqual(["ashby"]);
    expect(relevantEnrichments(derived, derived.one_off_incident!)).toEqual([]);
  });
});

describe("assembleEvidence", () => {
  it("returns the five kinds in taxonomy order with no duplicates", async () => {
    const { evidence } = await assembleEvidence(provider, derived, incident);
    const ranks = evidence.map((e) => EVIDENCE_KINDS.indexOf(e.kind));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(evidence.map((e) => `${e.kind}:${e.text}`)).size).toBe(evidence.length);
    // Exactly one API-generated estimate and suggestion. (The mock fixture ships
    // its own placeholders of every kind; real detectors emit OBSERVED/DETECTED only.)
    expect(evidence.filter((e) => e.text.startsWith("A hypothetical"))).toHaveLength(1);
    expect(evidence.filter((e) => e.text.startsWith("Review recent"))).toHaveLength(1);
  });

  it("keeps every detector-emitted item", async () => {
    const { evidence } = await assembleEvidence(provider, derived, incident);
    for (const item of incident.evidence) {
      expect(evidence.some((e) => e.kind === item.kind && e.text === item.text)).toBe(true);
    }
  });

  it("computes the ESTIMATE from the provider's simulator", async () => {
    const { evidence, scenario } = await assembleEvidence(provider, derived, incident);
    expect(scenario!.percentage).toBe(ESTIMATE_PERCENTAGE);
    expect(scenario!.entity).toBe("aws");

    const estimate = evidence.find((e) => e.kind === "ESTIMATE" && e.text.startsWith("A hypothetical"))!;
    expect(estimate.text).toContain("A hypothetical 20% reduction in AWS");
    expect(estimate.text).toContain(formatSignedUsd(scenario!.delta_monthly_cents, "/mo"));
    expect(estimate.text).toContain(`runway from ${formatMonths(scenario!.current_runway_months)} to ${formatMonths(scenario!.scenario_runway_months)}`);
    expect(estimate.text).toContain(SCENARIO_LABEL);
  });

  it("keeps the SUGGESTION generic and non-prescriptive", async () => {
    const { evidence } = await assembleEvidence(provider, derived, incident);
    const suggestion = evidence.find((e) => e.kind === "SUGGESTION" && e.text.startsWith("Review"))!;
    expect(suggestion.text).toBe("Review recent AWS usage and vendor documentation before making an operational decision.");
    expect(suggestion.text).not.toMatch(/\$|\d/);
  });

  it("still renders the page when the simulator is unavailable", async () => {
    const broken = new MockDataProvider(derived);
    broken.simulate = async () => {
      throw new Error("engine offline");
    };
    const { evidence, scenario } = await assembleEvidence(broken, derived, incident);
    expect(scenario).toBeNull();
    expect(evidence.some((e) => e.kind === "SUGGESTION")).toBe(true);
  });
});

describe("buildEvidence", () => {
  it("drops exact duplicates", () => {
    const duplicated = {
      ...incident,
      evidence: [
        { kind: "OBSERVED", text: "same" },
        { kind: "OBSERVED", text: "same" },
      ] as EvidenceItem[],
    };
    const built = buildEvidence({ incident: duplicated, enrichments: [], scenario: null });
    expect(built.filter((e) => e.text === "same")).toHaveLength(1);
  });
});
