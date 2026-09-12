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
  formatMonths,
  formatSignedUsd,
  formatUsdWhole,
  type AlertHistoryItem,
  type AvailabilityResponse,
  type CashCalendar,
  type ClassificationOverride,
  type ClassificationOverrideRequest,
  type ClassificationOverrideResponse,
  type DemoResponse,
  type DerivedDemoObject,
  type EvidenceItem,
  type Incident,
  type IncidentDetailResponse,
  type IncidentStatus,
  type ISODate,
  type ISODateTime,
  type LedgerPivot,
  type NeedsReviewResponse,
  type PivotCellDetail,
  type PivotGranularity,
  type SimulateResponse,
  type VendorEnrichment,
  type WhatIfRequest,
} from "@canary/shared";
import { buildMockDerived, mockWhatIf } from "@canary/shared/fixtures";
import {
  buildMockAvailability,
  buildMockCalendar,
  buildMockCellDetail,
  buildMockNeedsReview,
  buildMockPivot,
} from "./mock-views.ts";

/**
 * One mutable snapshot per session so status changes made in the UI stick.
 * `buildMockDerived()` is deterministic, so the starting point always matches.
 */
let snapshot: DerivedDemoObject | null = null;

function derived(): DerivedDemoObject {
  snapshot ??= buildMockDerived();
  return snapshot;
}

/** Overrides submitted in this session, newest last. */
let mockOverrides: ClassificationOverride[] = [];

/** Test helper: drop the session snapshot so the next read is pristine. */
export function resetMockSnapshot(): void {
  snapshot = null;
  mockOverrides = [];
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

// ---------------------------------------------------------------------------
// Views — the Worker does not serve these routes yet, so the mock carries them
// ---------------------------------------------------------------------------

export function mockLedger(granularity: PivotGranularity): LedgerPivot {
  return buildMockPivot(derived(), granularity);
}

export function mockLedgerCell(
  rowId: string,
  periodKey: string,
  granularity: PivotGranularity,
): PivotCellDetail {
  return buildMockCellDetail(derived(), rowId, periodKey, granularity);
}

export function mockCalendar(from: ISODate, to: ISODate): CashCalendar {
  return buildMockCalendar(derived(), from, to);
}

export function mockAvailability(): AvailabilityResponse {
  return buildMockAvailability(derived());
}

export function mockNeedsReview(): NeedsReviewResponse {
  return buildMockNeedsReview(derived(), mockOverrides);
}

/**
 * Mirrors `POST /api/classifications/override`: the reviewed rows leave the
 * queue and the counts the dashboard/sidebar read drop with them.
 */
export function mockClassificationOverride(
  req: ClassificationOverrideRequest,
  now: ISODateTime = derived().provenance.generated_at,
): ClassificationOverrideResponse {
  const d = derived();
  const target = d.needs_review.items.find((i) => i.transaction_id === req.transaction_id);
  if (!target) throw new Error(`No transaction awaiting review with id "${req.transaction_id}"`);

  const applyToMerchant = req.apply_to_merchant !== false;
  const cleared = applyToMerchant
    ? d.needs_review.items.filter((i) => i.merchant_normalized === target.merchant_normalized)
    : [target];

  d.needs_review.items = d.needs_review.items.filter((i) => !cleared.includes(i));
  d.needs_review.count -= cleared.length;
  // `outflow_cents` is a positive magnitude; item amounts are signed.
  for (const item of cleared) d.needs_review.outflow_cents -= Math.abs(item.amount_cents);
  d.reconciliation.needs_review_count = d.needs_review.count;
  d.reconciliation.needs_review_outflow_cents = d.needs_review.outflow_cents;

  const override: ClassificationOverride = {
    transaction_id: req.transaction_id,
    merchant_normalized: target.merchant_normalized,
    category: req.category,
    apply_to_merchant: applyToMerchant,
    ...(req.note ? { note: req.note } : {}),
    created_at: now,
  };
  mockOverrides = [...mockOverrides, override];
  return { override, needs_review_count: d.needs_review.count };
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

/**
 * Stand-in for `GET /api/alerts/history`: the alert, its voice note, the
 * founder's WHY and the reply — the four beats of the iMessage demo. Timestamps
 * are anchored to the fixture's `generated_at` so the strip stays deterministic,
 * and every figure in the bodies comes from the same derived object the real
 * alert renders from.
 */
export function mockAlertHistory(limit = 8): AlertHistoryItem[] {
  const d = derived();
  const phone = "+17862139361";
  const incident = d.primary_incident;
  const rate = incident?.detection.cusum?.post_change_rate_weekly_cents ?? null;
  const delta = incident?.financial_impact.delta_weekly_cents ?? null;

  const observed =
    delta !== null
      ? `Variable spend is up ${formatSignedUsd(delta, "/wk")}.`
      : "Variable spend shifted above its baseline.";
  const level = rate !== null ? ` It now runs ${formatUsdWhole(rate)} a week.` : "";

  const items: AlertHistoryItem[] = [
    {
      id: 4,
      direction: "outbound",
      phone,
      body: `${observed}${level} Modeled runway is ${formatMonths(d.burn.runway_months)}.\nReply WHY for the detector parameters.`,
      created_at: shiftHours(d.provenance.generated_at, -6),
      command: null,
      voice: false,
    },
    {
      id: 3,
      direction: "outbound",
      phone,
      body: `${observed} Modeled runway is ${formatMonths(d.burn.runway_months)}. Reply SHOW ME for the incident page.`,
      created_at: shiftHours(d.provenance.generated_at, -6),
      command: null,
      voice: true,
    },
    {
      id: 2,
      direction: "inbound",
      phone,
      body: "WHY",
      created_at: shiftHours(d.provenance.generated_at, -5),
      command: "WHY",
      voice: false,
    },
    {
      id: 1,
      direction: "outbound",
      phone,
      body: `CUSUM flagged it. Change point: week of ${incident?.estimated_change_point ?? d.provenance.end_date}.\nLargest contributor: ${incident?.contributors[0]?.entity ?? "unknown"}.`,
      created_at: shiftHours(d.provenance.generated_at, -5),
      command: "WHY",
      voice: false,
    },
  ];

  // The route returns newest first; ids ascend with time, so sort by id desc.
  return items.sort((a, b) => b.id - a.id).slice(0, limit);
}

/** Offsets an ISO timestamp by whole hours. Chrome only — no financial figure depends on it. */
function shiftHours(ts: ISODateTime, hours: number): ISODateTime {
  return new Date(new Date(ts).getTime() + hours * 3_600_000).toISOString();
}
