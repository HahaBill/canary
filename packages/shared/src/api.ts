/**
 * HTTP API + agent-tool contracts between apps/api (Worker) and apps/web,
 * Sendblue, and ElevenLabs. Request/response bodies are JSON.
 *
 * All routes are unauthenticated in the hackathon build (PRD §31), except the
 * inbound Sendblue webhook which checks a shared secret.
 */
import type {
  AlertHistoryItem,
  AvailabilityResponse,
  CashCalendar,
  ClassificationOverride,
  LedgerPivot,
  NotifyDecision,
  PendingAlert,
  PivotCellDetail,
  PivotGranularity,
} from "./views.ts";
import type {
  BankAccount,
  BurnSummary,
  Category,
  Cents,
  DataProvenance,
  DerivedDemoObject,
  EvidenceItem,
  Incident,
  IncidentStatus,
  ISODate,
  ReconciliationReport,
  Transaction,
  VendorEnrichment,
  WeeklyBucket,
  WhatIfRequest,
  WhatIfResult,
} from "./types.ts";

export const API_ROUTES = {
  health: "GET /api/health",
  healthSummary: "GET /api/health-summary",
  demo: "GET /api/demo",
  incidents: "GET /api/incidents",
  incident: "GET /api/incidents/:id",
  incidentEvidence: "GET /api/incidents/:id/evidence",
  incidentStatus: "POST /api/incidents/:id/status",
  simulate: "POST /api/simulate",
  vendorEnrichment: "GET /api/vendors/:entity/enrichment",
  bankAccounts: "GET /api/bank/accounts",
  bankTransactions: "GET /api/bank/transactions",
  sendAlert: "POST /api/alerts/send",
  sendblueWebhook: "POST /webhooks/sendblue",
  toolHealthSummary: "POST /api/tools/get_health_summary",
  toolGetIncident: "POST /api/tools/get_incident",
  toolSimulate: "POST /api/tools/simulate_cost_change",
  toolCreateAppLink: "POST /api/tools/create_app_link",
  // Views (ledger sheet, calendar) and notification policy
  ledger: "GET /api/ledger",
  ledgerCell: "GET /api/ledger/cell",
  calendar: "GET /api/calendar",
  availability: "GET /api/availability",
  alertHistory: "GET /api/alerts/history",
  alertsPending: "GET /api/alerts/pending",
  needsReview: "GET /api/needs-review",
  classificationOverride: "POST /api/classifications/override",
} as const;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface HealthResponse {
  ok: true;
  service: "canary-api";
  version: string;
  time: string;
}

export interface HealthSummaryResponse {
  provenance: DataProvenance;
  company_name: string;
  bank_name: string;
  cash_cents: Cents;
  burn: BurnSummary;
  reconciliation_status: "OK" | "MISMATCH";
  reconciliation: ReconciliationReport;
  needs_review_count: number;
  needs_review_outflow_cents: Cents;
  open_incident_count: number;
  primary_incident: Incident | null;
  one_off_incident: Incident | null;
  /** Pre-rendered strings for voice/iMessage. */
  speech: {
    cash: string;
    burn_monthly: string;
    runway: string;
    headline: string;
  };
}

/** `GET /api/demo` returns DerivedDemoObject with `fixture` stripped. */
export type DemoResponse = Omit<DerivedDemoObject, "fixture">;

export type IncidentsResponse = { incidents: Incident[] };

export interface IncidentDetailResponse {
  incident: Incident;
  weeks: WeeklyBucket[];
  cusum_statistic_cents: Cents[];
  ewma_variable_spend_cents?: Cents[];
  burn: BurnSummary;
  cash_cents: Cents;
  vendor_enrichments: VendorEnrichment[];
  /** OBSERVED / DETECTED / EVIDENCE / ESTIMATE / SUGGESTION, in that order. */
  evidence: EvidenceItem[];
  provenance: DataProvenance;
}

export type IncidentEvidenceResponse = { evidence: EvidenceItem[] };

export interface IncidentStatusRequest {
  status: IncidentStatus;
}

export type SimulateRequest = WhatIfRequest;
export type SimulateResponse = WhatIfResult;

export type VendorEnrichmentResponse = { enrichment: VendorEnrichment | null };

export type BankAccountsResponse = { bank_name: string; accounts: BankAccount[]; closing_cash_cents: Cents; as_of: ISODate };
export type BankTransactionsResponse = { transactions: Transaction[] };

export interface SendAlertRequest {
  /** E.164. Defaults to env FOUNDER_PHONE. */
  to?: string;
  incident_id?: string;
  /** Also send an ElevenLabs voice note after the text (default true when TTS is configured). */
  voice?: boolean;
  /**
   * Bypass the notification policy (status must be OPEN, not already notified,
   * founder not in a meeting). Demo/operator use only.
   */
  force?: boolean;
}
export interface SendAlertVoiceResult {
  sent: boolean;
  /** The exact script that was voiced — rendered from the same incident as the text. */
  transcript: string;
  media_url?: string;
  seconds?: number;
  provider_message_id?: string;
  /** Present when the voice note was skipped or failed; the text alert is unaffected. */
  error?: string;
}
export interface SendAlertResponse {
  sent: boolean;
  to: string;
  message: string;
  provider_message_id?: string;
  error?: string;
  voice?: SendAlertVoiceResult;
  /** Present when the policy declined or deferred the alert (`sent` is false). */
  decision?: NotifyDecision;
  /** Present when deferred: the queued alert (delivered by cron once the founder is free). */
  pending?: PendingAlert;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface LedgerQuery {
  granularity?: PivotGranularity; // default "month"
}
export type LedgerResponse = { pivot: LedgerPivot };
export interface LedgerCellQuery {
  row_id: string;
  period_key: string;
  granularity?: PivotGranularity;
}
export type LedgerCellResponse = { detail: PivotCellDetail };

export interface CalendarQuery {
  /** Inclusive, `YYYY-MM-DD`. Defaults to the month containing history_end. */
  from?: ISODate;
  to?: ISODate;
}
export type CalendarResponse = { calendar: CashCalendar };

export type { AvailabilityResponse };
export type AlertHistoryResponse = { items: AlertHistoryItem[] };
export type AlertsPendingResponse = { pending: PendingAlert[] };

export interface NeedsReviewResponse {
  count: number;
  outflow_cents: Cents;
  items: Array<{
    transaction_id: string;
    date: ISODate;
    merchant_raw: string;
    merchant_normalized: string;
    amount_cents: Cents;
    reason: string;
    /** Signals recorded by classification (OPENAI/TAVILY proposals), for the reviewer. */
    proposals: Array<{ source: string; category?: string; detail: string; url?: string }>;
  }>;
  overrides: ClassificationOverride[];
}

export interface ClassificationOverrideRequest {
  transaction_id: string;
  category: Category;
  apply_to_merchant?: boolean;
  note?: string;
}
export type ClassificationOverrideResponse = { override: ClassificationOverride; needs_review_count: number };

export interface ErrorResponse {
  error: string;
  detail?: string;
}

// ---------------------------------------------------------------------------
// iMessage keyword protocol (PRD §23)
// ---------------------------------------------------------------------------

export const IMESSAGE_COMMANDS = ["WHY", "SHOW ME", "SOURCES", "HELP"] as const;
export type IMessageCommand = (typeof IMESSAGE_COMMANDS)[number];

// ---------------------------------------------------------------------------
// Agent tools (PRD §21, §24) — used by ElevenLabs server tools and the iMessage router
// ---------------------------------------------------------------------------

export type ToolGetHealthSummaryRequest = Record<string, never>;
export type ToolGetHealthSummaryResponse = HealthSummaryResponse;

export interface ToolGetIncidentRequest {
  /** Omit to get the primary open incident. */
  id?: string;
}
export type ToolGetIncidentResponse = IncidentDetailResponse & {
  /** Speech-friendly explanation built from generator-derived values. */
  speech: { summary: string; drivers: string; impact: string };
};

export type ToolSimulateRequest = WhatIfRequest;
export type ToolSimulateResponse = WhatIfResult;

export interface CreateAppLinkRequest {
  destination: "dashboard" | "incident";
  id?: string;
  tab?: "overview" | "drivers" | "evidence" | "whatif";
}
export interface CreateAppLinkResponse {
  /** Absolute URL: PUBLIC_BASE_URL + path. */
  url: string;
  /** e.g. `/incidents/inc_abc?tab=evidence` */
  path: string;
}

/** Deterministic path builder. The only place URLs are formed. */
export function buildAppPath(req: CreateAppLinkRequest): string {
  if (req.destination === "dashboard") return "/";
  if (!req.id) throw new Error("incident link requires id");
  const base = `/incidents/${encodeURIComponent(req.id)}`;
  return req.tab && req.tab !== "overview" ? `${base}?tab=${req.tab}` : base;
}
