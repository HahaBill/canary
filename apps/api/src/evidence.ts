/**
 * Evidence assembly for the incident page (PRD §20).
 *
 * Taxonomy order is OBSERVED → DETECTED → EVIDENCE → ESTIMATE → SUGGESTION.
 * Detectors emit OBSERVED/DETECTED; this layer adds cited external EVIDENCE,
 * one deterministic ESTIMATE, and one non-prescriptive SUGGESTION.
 */
import {
  EVIDENCE_KINDS,
  formatMonths,
  formatSignedUsd,
  type DerivedDemoObject,
  type EvidenceItem,
  type Incident,
  type VendorEnrichment,
  type WhatIfResult,
} from "@canary/shared";
import type { DataProvider } from "./data/provider.ts";
import { driverEntity, incidentEntities } from "./derive.ts";
import { displayName } from "./format.ts";

/** The scenario the incident page always shows, per docs/DEMO.md 1:45. */
export const ESTIMATE_PERCENTAGE = -20;

/** Enrichments for the incident entity or any of its contributors. */
export function relevantEnrichments(derived: DerivedDemoObject, incident: Incident): VendorEnrichment[] {
  const entities = new Set(incidentEntities(incident));
  return derived.vendor_enrichments.filter((e) => entities.has(e.merchant_normalized));
}

export function evidenceFromEnrichment(e: VendorEnrichment): EvidenceItem {
  return {
    kind: "EVIDENCE",
    text: `${e.vendor_name}: ${e.business_type}`,
    source_url: e.source_url,
    source_title: e.source_title,
    retrieved_at: e.retrieved_at,
    cached: e.cached,
  };
}

export function evidenceFromScenario(incident: Incident, scenario: WhatIfResult): EvidenceItem {
  const driver = displayName(driverEntity(incident));
  const magnitude = `${Math.abs(scenario.percentage)}% ${scenario.percentage < 0 ? "reduction" : "increase"}`;
  return {
    kind: "ESTIMATE",
    text:
      `A hypothetical ${magnitude} in ${driver} changes modeled monthly burn by ` +
      `${formatSignedUsd(scenario.delta_monthly_cents, "/mo")} and runway from ` +
      `${formatMonths(scenario.current_runway_months)} to ${formatMonths(scenario.scenario_runway_months)}. ` +
      scenario.label,
  };
}

/** Deliberately generic: Canary never prescribes an operational decision. */
export function suggestionFor(incident: Incident): EvidenceItem {
  const driver = displayName(driverEntity(incident));
  return {
    kind: "SUGGESTION",
    text: `Review recent ${driver} usage and vendor documentation before making an operational decision.`,
  };
}

export function sortByTaxonomy(items: EvidenceItem[]): EvidenceItem[] {
  const rank = (kind: EvidenceItem["kind"]) => EVIDENCE_KINDS.indexOf(kind);
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item.kind) - rank(b.item.kind) || a.index - b.index)
    .map(({ item }) => item);
}

export function buildEvidence(input: {
  incident: Incident;
  enrichments: VendorEnrichment[];
  scenario: WhatIfResult | null;
}): EvidenceItem[] {
  const items: EvidenceItem[] = [...input.incident.evidence, ...input.enrichments.map(evidenceFromEnrichment)];
  if (input.scenario) items.push(evidenceFromScenario(input.incident, input.scenario));
  items.push(suggestionFor(input.incident));

  const seen = new Set<string>();
  const deduped = items.filter((item) => {
    const key = `${item.kind}\u0000${item.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return sortByTaxonomy(deduped);
}

/** Full evidence list for an incident, including the −20% scenario estimate. */
export async function assembleEvidence(
  provider: DataProvider,
  derived: DerivedDemoObject,
  incident: Incident,
): Promise<{ evidence: EvidenceItem[]; enrichments: VendorEnrichment[]; scenario: WhatIfResult | null }> {
  const enrichments = relevantEnrichments(derived, incident);
  let scenario: WhatIfResult | null = null;
  try {
    scenario = await provider.simulate({ entity: driverEntity(incident), percentage: ESTIMATE_PERCENTAGE });
  } catch {
    // An unavailable simulator must not take down the incident page.
  }
  return { evidence: buildEvidence({ incident, enrichments, scenario }), enrichments, scenario };
}
