/**
 * Agent tools (PRD §21, §24). One implementation shared by the REST routes,
 * the iMessage router, and the ElevenLabs server tools — so voice, text, and
 * web can never disagree about a number.
 */
import type {
  CreateAppLinkRequest,
  CreateAppLinkResponse,
  DerivedDemoObject,
  HealthSummaryResponse,
  IncidentDetailResponse,
  ToolGetIncidentResponse,
  WhatIfRequest,
  WhatIfResult,
} from "@canary/shared";
import type { DataProvider } from "./data/provider.ts";
import { primaryIncident } from "./derive.ts";
import { assembleEvidence } from "./evidence.ts";
import { createAppLink } from "./links.ts";
import { healthSummarySpeech, incidentSpeech } from "./speech.ts";

export const PERCENTAGE_MIN = -100;
export const PERCENTAGE_MAX = 100;

const TABS = ["overview", "drivers", "evidence", "whatif"] as const;
const DESTINATIONS = ["dashboard", "incident"] as const;

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string; detail: string };

export async function getHealthSummary(provider: DataProvider): Promise<HealthSummaryResponse> {
  const derived = await provider.getDerived();
  return {
    provenance: derived.provenance,
    company_name: derived.company.name,
    bank_name: derived.company.bank_name,
    cash_cents: derived.cash_cents,
    burn: derived.burn,
    reconciliation_status: derived.reconciliation.matches ? "OK" : "MISMATCH",
    reconciliation: derived.reconciliation,
    needs_review_count: derived.needs_review.count,
    needs_review_outflow_cents: derived.needs_review.outflow_cents,
    open_incident_count: derived.incidents.filter((i) => i.status === "OPEN").length,
    primary_incident: derived.primary_incident,
    one_off_incident: derived.one_off_incident,
    speech: healthSummarySpeech(derived, primaryIncident(derived)),
  };
}

/** `id` omitted → the primary incident. Null when the id is unknown or nothing is flagged. */
export async function getIncidentDetail(provider: DataProvider, id?: string): Promise<IncidentDetailResponse | null> {
  const derived = await provider.getDerived();
  const incident = id ? (derived.incidents.find((i) => i.id === id) ?? null) : primaryIncident(derived);
  if (!incident) return null;
  const { evidence, enrichments } = await assembleEvidence(provider, derived, incident);
  const detail: IncidentDetailResponse = {
    incident,
    weeks: derived.weeks,
    cusum_statistic_cents: derived.cusum_statistic_cents,
    burn: derived.burn,
    cash_cents: derived.cash_cents,
    vendor_enrichments: enrichments,
    evidence,
    provenance: derived.provenance,
  };
  if (derived.ewma_variable_spend_cents) detail.ewma_variable_spend_cents = derived.ewma_variable_spend_cents;
  return detail;
}

export async function getIncidentTool(provider: DataProvider, id?: string): Promise<ToolGetIncidentResponse | null> {
  const detail = await getIncidentDetail(provider, id);
  if (!detail) return null;
  const derived = await provider.getDerived();
  return { ...detail, speech: incidentSpeech(derived, detail.incident) };
}

export async function simulateCostChange(provider: DataProvider, req: WhatIfRequest): Promise<WhatIfResult> {
  return provider.simulate(req);
}

/**
 * Validates a what-if body. Numeric strings are coerced (voice agents send
 * them); anything else non-numeric or outside [−100, 100] is a 400.
 */
export function parseWhatIfRequest(body: Record<string, unknown> | null): Validated<WhatIfRequest> {
  if (!body) return { ok: false, error: "invalid_json", detail: "Request body must be a JSON object." };

  const entity = body.entity;
  if (typeof entity !== "string" || entity.trim().length === 0) {
    return { ok: false, error: "invalid_entity", detail: "`entity` must be a non-empty string (a merchant_normalized key)." };
  }

  const raw = body.percentage;
  let percentage: number;
  if (typeof raw === "number") {
    percentage = raw;
  } else if (typeof raw === "string" && raw.trim().length > 0) {
    percentage = Number(raw);
  } else {
    return { ok: false, error: "invalid_percentage", detail: "`percentage` must be a number between -100 and 100." };
  }
  if (!Number.isFinite(percentage)) {
    return { ok: false, error: "invalid_percentage", detail: "`percentage` must be a number between -100 and 100." };
  }
  if (percentage < PERCENTAGE_MIN || percentage > PERCENTAGE_MAX) {
    return { ok: false, error: "percentage_out_of_range", detail: `\`percentage\` must be between ${PERCENTAGE_MIN} and ${PERCENTAGE_MAX}.` };
  }

  return { ok: true, value: { entity: entity.trim(), percentage } };
}

export function parseCreateAppLinkRequest(body: Record<string, unknown> | null): Validated<CreateAppLinkRequest> {
  if (!body) return { ok: false, error: "invalid_json", detail: "Request body must be a JSON object." };

  const destination = body.destination;
  if (destination !== "dashboard" && destination !== "incident") {
    return { ok: false, error: "invalid_destination", detail: `\`destination\` must be one of: ${DESTINATIONS.join(", ")}.` };
  }

  const req: CreateAppLinkRequest = { destination };

  const id = body.id;
  if (id !== undefined && id !== null) {
    if (typeof id !== "string" || id.trim().length === 0) {
      return { ok: false, error: "invalid_id", detail: "`id` must be a non-empty string." };
    }
    req.id = id.trim();
  }
  if (destination === "incident" && !req.id) {
    return { ok: false, error: "missing_id", detail: "`id` is required when destination is `incident`." };
  }

  const tab = body.tab;
  if (tab !== undefined && tab !== null) {
    if (typeof tab !== "string" || !(TABS as readonly string[]).includes(tab)) {
      return { ok: false, error: "invalid_tab", detail: `\`tab\` must be one of: ${TABS.join(", ")}.` };
    }
    req.tab = tab as CreateAppLinkRequest["tab"];
  }

  return { ok: true, value: req };
}

export function createLink(req: CreateAppLinkRequest, base: string): CreateAppLinkResponse {
  return createAppLink(req, base);
}

/** `GET /api/demo` never serves the fixture metadata. */
export function stripFixture(derived: DerivedDemoObject): Omit<DerivedDemoObject, "fixture"> {
  const { fixture: _fixture, ...rest } = derived;
  return rest;
}
