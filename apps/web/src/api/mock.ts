/**
 * Offline stand-in for apps/api, built from the frozen fixtures in
 * `@canary/shared/fixtures`. Used when `VITE_USE_MOCK=1`, when the real API is
 * unreachable in dev, and by the component tests.
 *
 * Every number here comes out of `buildMockDerived()` / `mockWhatIf()` — this
 * module does no financial arithmetic of its own.
 */
import {
  EVIDENCE_KINDS,
  type DemoResponse,
  type DerivedDemoObject,
  type EvidenceItem,
  type Incident,
  type IncidentDetailResponse,
  type IncidentStatus,
  type ISODateTime,
  type SimulateResponse,
  type VendorEnrichment,
  type WhatIfRequest,
} from "@canary/shared";
import { buildMockDerived, mockWhatIf } from "@canary/shared/fixtures";

/**
 * One mutable snapshot per session so status changes made in the UI stick.
 * `buildMockDerived()` is deterministic, so the starting point always matches.
 */
let snapshot: DerivedDemoObject | null = null;

function derived(): DerivedDemoObject {
  snapshot ??= buildMockDerived();
  return snapshot;
}

/** Test helper: drop the session snapshot so the next read is pristine. */
export function resetMockSnapshot(): void {
  snapshot = null;
}

export function mockDemo(): DemoResponse {
  const { fixture: _fixture, ...rest } = derived();
  return rest;
}

export function mockIncidents(): Incident[] {
  return derived().incidents;
}

export function mockIncidentDetail(id: string): IncidentDetailResponse | null {
  const d = derived();
  const incident = d.incidents.find((i) => i.id === id);
  if (!incident) return null;

  const detail: IncidentDetailResponse = {
    incident,
    weeks: d.weeks,
    cusum_statistic_cents: d.cusum_statistic_cents,
    burn: d.burn,
    cash_cents: d.cash_cents,
    vendor_enrichments: d.vendor_enrichments,
    evidence: assembleEvidence(incident, d.vendor_enrichments),
    provenance: d.provenance,
  };
  if (d.ewma_variable_spend_cents) detail.ewma_variable_spend_cents = d.ewma_variable_spend_cents;
  return detail;
}

export function mockSimulate(req: WhatIfRequest): SimulateResponse {
  return mockWhatIf(derived(), req.entity, req.percentage);
}

/**
 * Mirrors `POST /api/incidents/:id/status`. `now` is injected so the mock stays
 * deterministic; it defaults to the fixture's generated_at.
 */
export function mockSetIncidentStatus(
  id: string,
  status: IncidentStatus,
  now: ISODateTime = derived().provenance.generated_at,
): Incident | null {
  const d = derived();
  const incident = d.incidents.find((i) => i.id === id);
  if (!incident) return null;
  incident.status = status;
  incident.last_updated = now;
  return incident;
}

/**
 * The API assembles `IncidentDetailResponse.evidence` from the incident's own
 * items plus cited vendor research for the entities involved. The mock does the
 * same so the Evidence tab exercises the external-source rendering path.
 */
function assembleEvidence(incident: Incident, enrichments: VendorEnrichment[]): EvidenceItem[] {
  const entities = new Set([incident.entity, ...incident.contributors.map((c) => c.entity)]);
  const seen = new Set(incident.evidence.map((e) => e.source_url).filter(Boolean));

  const external: EvidenceItem[] = enrichments
    .filter((e) => entities.has(e.merchant_normalized) && !seen.has(e.source_url))
    .map((e) => ({
      kind: "EVIDENCE" as const,
      text: `${e.vendor_name} — ${e.business_type}`,
      source_url: e.source_url,
      source_title: e.source_title,
      retrieved_at: e.retrieved_at,
      cached: e.cached,
    }));

  return sortByTaxonomy([...incident.evidence, ...external]);
}

/** OBSERVED → DETECTED → EVIDENCE → ESTIMATE → SUGGESTION, stable within a kind. */
export function sortByTaxonomy(items: EvidenceItem[]): EvidenceItem[] {
  return [...items].sort((a, b) => EVIDENCE_KINDS.indexOf(a.kind) - EVIDENCE_KINDS.indexOf(b.kind));
}
