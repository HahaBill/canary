/**
 * Canary shared domain types — THE CONTRACT.
 *
 * Rules that every package must follow:
 *  - All money is integer cents (`Cents`). Never floats for money.
 *  - Sign convention on transactions: inflow > 0, outflow < 0.
 *  - Aggregates named `*_spend_cents`, `*_burn_cents`, `*_rate_*_cents` are
 *    POSITIVE magnitudes (a spend of $100 is 10_000, not -10_000).
 *  - Dates are ISO `YYYY-MM-DD`; timestamps are ISO 8601 with timezone.
 *  - Weeks are non-overlapping calendar weeks starting Monday (see dates.ts).
 *  - LLMs never produce any numeric field in these types.
 *
 * Only the lead integrator edits this file. Report gaps; do not fork it.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Integer cents. Signed on transactions, positive magnitudes on aggregates. */
export type Cents = number;
/** `YYYY-MM-DD` */
export type ISODate = string;
/** ISO 8601 timestamp, e.g. `2026-09-12T17:00:00.000Z` */
export type ISODateTime = string;

// ---------------------------------------------------------------------------
// Company / bank
// ---------------------------------------------------------------------------

export type AccountType = "checking" | "savings" | "card";

export interface BankAccount {
  id: string;
  name: string;
  type: AccountType;
  currency: "USD";
  /** Closing balance as reported by the bank provider. Card accounts report
   *  outstanding liability as a NEGATIVE number (or 0 when fully settled). */
  balance_cents: Cents;
  as_of: ISODate;
}

export interface CompanyProfile {
  name: string;
  legal_name: string;
  description: string;
  stage: string;
  headcount: number;
  raised_cents: Cents;
  bank_name: string;
  /** Date the sandbox bank reports balances for and the last day of history. */
  as_of: ISODate;
  accounts: BankAccount[];
}

/** Seam for a real bank API (Rho or otherwise). The sandbox bank implements it. */
export interface BankProvider {
  readonly name: string;
  getAccounts(): Promise<BankAccount[]>;
  getTransactions(params?: { from?: ISODate; to?: ISODate; account_id?: string }): Promise<Transaction[]>;
  /** Sum of cash accounts (checking + savings). Card liability excluded. */
  getClosingBalance(): Promise<{ total_cents: Cents; as_of: ISODate; by_account: Record<string, Cents> }>;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export const FLOW_TYPES = [
  /** Money leaving the company for operations (vendors, payroll, rent, card purchases). Counts in burn. */
  "OPERATING_OUTFLOW",
  /** Customer revenue and other operating receipts. Offsets burn (net burn). */
  "OPERATING_INFLOW",
  /** Movement between the company's own accounts. Two legs share `transfer_pair_id`. Contributes $0 to burn and $0 to total cash. */
  "INTERNAL_TRANSFER",
  /** Bank-side payment of the corporate card balance. Cash leaves checking, liability on card account shrinks.
   *  Excluded from burn because the underlying card purchases are already OPERATING_OUTFLOW. */
  "CARD_SETTLEMENT",
  /** SAFE / equity / debt proceeds (or repayments). Changes cash. Never revenue; never reduces operating burn. */
  "FINANCING",
  /** Money returned by a vendor. Netted against that vendor's spend. */
  "REFUND",
] as const;
export type FlowType = (typeof FLOW_TYPES)[number];

export type TransactionStatus = "pending" | "settled";

export type TransactionSource = "sandbox_bank" | "synthetic";

export const TRANSACTION_TAGS = [
  /** Set by the one-off detector (never by the generator in the demo seed). Excluded/winsorized from the CUSUM series, still in burn. */
  "one_off",
  /** Predictable annual renewal. Excluded from the CUSUM variable series, still in burn. May be set by generator (test seed) or rules. */
  "annual_renewal",
  /** Classification could not be corroborated. Amount still counts in burn/cash. */
  "needs_review",
] as const;
export type TransactionTag = (typeof TRANSACTION_TAGS)[number];

export interface Transaction {
  id: string;
  account_id: string;
  /** Effective/posted date. Used for weekly bucketing. */
  date: ISODate;
  /** Signed. inflow > 0, outflow < 0. */
  amount_cents: Cents;
  currency: "USD";
  /** Raw bank descriptor, e.g. `AMAZON WEB SERVICES AWS.AMAZON.CO` */
  merchant_raw: string;
  /** Canonical entity key, lower_snake, e.g. `aws`, `figma`, `gusto_payroll`. This is the `entity` used everywhere (drivers, what-if). */
  merchant_normalized: string;
  description: string;
  flow_type: FlowType;
  status: TransactionStatus;
  source: TransactionSource;
  /** Both legs of an internal transfer share this id. */
  transfer_pair_id?: string;
  /** On a CARD_SETTLEMENT: its own id. On each card purchase it covers: the settlement's id. */
  settlement_pair_id?: string;
  /** On a settled transaction that supersedes an earlier pending row: the pending row's id. Engine drops the pending row. */
  pending_of?: string;
  tags: TransactionTag[];
  /**
   * Ground-truth category from the generator. FOR TESTS/ASSERTIONS ONLY.
   * Classification code must never read this in a production path.
   * For a REFUND row this is the category of the vendor being refunded (the
   * engine nets the refund into that category), not `REFUND`.
   */
  category_hint?: Category;
}

// ---------------------------------------------------------------------------
// Categories & classification
// ---------------------------------------------------------------------------

export const CATEGORIES = [
  "PAYROLL",
  "RENT",
  "CLOUD_INFRASTRUCTURE",
  "SAAS_SOFTWARE",
  "CONTRACTORS",
  "RECRUITING",
  "MARKETING",
  "TRAVEL",
  "MEALS",
  "EQUIPMENT",
  "PROFESSIONAL_SERVICES",
  "INSURANCE",
  "TAXES_FEES",
  "CUSTOMER_REVENUE",
  "FINANCING",
  "INTERNAL_TRANSFER",
  "CARD_SETTLEMENT",
  "REFUND",
  "NEEDS_REVIEW",
] as const;
export type Category = (typeof CATEGORIES)[number];

export type ClassificationMethod =
  /** Deterministic merchant/flow rule matched. */
  | "RULE"
  /** OpenAI proposed a category AND Tavily's structured business type mapped to the same category. */
  | "LLM_CORROBORATED"
  /** OpenAI proposed a category, external corroboration not attempted/needed (e.g. tiny amount) — MEDIUM confidence at most. */
  | "LLM_ONLY"
  /** Signals disagreed or were insufficient. Category is NEEDS_REVIEW. Amount still counts. */
  | "NEEDS_REVIEW";

export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW";

export interface SupportingSignal {
  source: "RULE" | "OPENAI" | "TAVILY" | "HISTORY" | "FLOW_TYPE";
  detail: string;
  proposed_category?: Category;
  url?: string;
}

export interface Classification {
  transaction_id: string;
  merchant_normalized: string;
  category: Category;
  method: ClassificationMethod;
  reason: string;
  supporting_signals: SupportingSignal[];
  /** Derived from signal agreement count, never from an LLM self-report. */
  confidence_level: ConfidenceLevel;
}

/** Keyed by transaction id. JSON-friendly. */
export type ClassificationMap = Record<string, Classification>;

/** Tavily structured vendor enrichment (contract §13). */
export interface VendorEnrichment {
  vendor_name: string;
  merchant_normalized: string;
  business_type: string;
  mapped_category: Category;
  source_url: string;
  source_title: string;
  retrieved_at: ISODateTime;
  snippet?: string;
  /** True when served from the on-disk/D1 cache rather than a live call. */
  cached: boolean;
}

// ---------------------------------------------------------------------------
// Ledger (engine output)
// ---------------------------------------------------------------------------

export interface LedgerTransaction extends Transaction {
  category: Category;
  classification_method: ClassificationMethod;
  /** True for OPERATING_OUTFLOW (incl. NEEDS_REVIEW outflows) and REFUND (as a negative spend). False for transfers, settlements, financing, inflows. */
  counts_in_burn: boolean;
  /** True for anything that moves total cash (checking+savings): everything except pure card-account rows. */
  counts_in_cash: boolean;
  /** True when the engine dropped this row (pending superseded by settled). Dropped rows are kept for audit with this flag. */
  dropped: boolean;
  excluded_reason?: string;
}

export interface WeeklyBucket {
  /** Monday, `YYYY-MM-DD`. */
  week_start: ISODate;
  /** Sunday, `YYYY-MM-DD`. */
  week_end: ISODate;
  /** 0-based from the first week of history. */
  week_index: number;
  /**
   * CUSUM INPUT. Positive magnitude of operating outflows in VARIABLE categories,
   * excluding transactions tagged `one_off` or `annual_renewal`, net of refunds to those entities.
   */
  variable_spend_cents: Cents;
  /** Positive magnitude of outflows in FIXED categories (payroll, rent, insurance...). */
  fixed_spend_cents: Cents;
  /** Positive magnitude of outflows tagged `one_off` or `annual_renewal` (in burn, out of CUSUM). */
  excluded_from_monitoring_cents: Cents;
  /** variable + fixed + excluded_from_monitoring. Positive magnitude. */
  total_operating_outflow_cents: Cents;
  /** Positive. Customer revenue etc. */
  operating_inflow_cents: Cents;
  /** total_operating_outflow - operating_inflow. May be negative if revenue exceeds spend. */
  net_burn_cents: Cents;
  /** Positive magnitude of VARIABLE spend by `merchant_normalized` (same exclusions as variable_spend_cents). */
  variable_by_entity: Record<string, Cents>;
  /** Positive magnitude of variable spend by category. */
  variable_by_category: Partial<Record<Category, Cents>>;
  transaction_count: number;
}

export interface ReconciliationReport {
  as_of: ISODate;
  /** Balance at the start of history. Bank-reported when `expectedOpeningBalanceCents` was supplied, else derived = closing − net cash flows. */
  opening_balance_cents: Cents;
  /** True when the opening balance came from the bank (so `matches` is a genuine reconciliation), false when derived. */
  opening_balance_reported: boolean;
  /** Bank-reported closing cash (checking + savings). */
  reported_closing_balance_cents: Cents;
  /** opening + Σ(counts_in_cash amounts). Must equal reported. */
  computed_closing_balance_cents: Cents;
  /** Reported closing − computed closing. 0 when reconciled. */
  discrepancy_cents: Cents;
  matches: boolean;
  internal_transfer_pairs: number;
  unpaired_transfer_legs: number;
  card_settlements: number;
  card_purchases_covered: number;
  unpaired_settlements: number;
  pending_rows_dropped: number;
  financing_net_cents: Cents;
  refunds_netted_cents: Cents;
  needs_review_count: number;
  needs_review_outflow_cents: Cents;
  warnings: string[];
}

export interface Ledger {
  company: CompanyProfile;
  accounts: BankAccount[];
  transactions: LedgerTransaction[];
  weeks: WeeklyBucket[];
  reconciliation: ReconciliationReport;
  history_start: ISODate;
  history_end: ISODate;
}

// ---------------------------------------------------------------------------
// Burn / runway (engine output)
// ---------------------------------------------------------------------------

export type BurnWindowReason =
  | "TRAILING_DEFAULT"
  | "POST_CHANGE_SEGMENT"
  | "POST_CHANGE_INSUFFICIENT_FALLBACK_TRAILING";

export interface BurnSummary {
  burn_window_start: ISODate;
  burn_window_end: ISODate;
  burn_window_reason: BurnWindowReason;
  weeks_in_window: number;
  /** Average weekly figures over the window. Positive magnitudes. */
  weekly_gross_burn_cents: Cents;
  weekly_operating_inflow_cents: Cents;
  weekly_net_burn_cents: Cents;
  weekly_variable_spend_cents: Cents;
  weekly_fixed_spend_cents: Cents;
  /** weekly × WEEKS_PER_MONTH, rounded. */
  monthly_gross_burn_cents: Cents;
  monthly_net_burn_cents: Cents;
  /** Checking + savings closing balance. Card liability excluded. */
  available_operating_cash_cents: Cents;
  /** available_operating_cash / monthly_net_burn. `null` when net burn ≤ 0 (not burning). */
  runway_months: number | null;
  /** Weekly variable spend by entity over the window. Used by what-if. */
  weekly_variable_by_entity: Record<string, Cents>;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface CusumConfig {
  /** k = k_factor × σ. Default 0.5. */
  k_factor: number;
  /** h = h_multiplier × σ. Default from config (4–5). */
  h_multiplier: number;
  /** Weeks used to estimate baseline median/MAD. */
  min_baseline_weeks: number;
  /** σ floor as a fraction of baseline median, to avoid degenerate MAD = 0. */
  sigma_floor_fraction: number;
}

export interface CusumResult {
  fired: boolean;
  config: CusumConfig;
  baseline_weeks: number;
  baseline_median_cents: Cents;
  sigma_cents: Cents;
  k_cents: Cents;
  h_cents: Cents;
  /** Cumulative statistic per week (cents). Same length as input. */
  statistic_cents: Cents[];
  alarm_week_index: number | null;
  alarm_week_start: ISODate | null;
  /** Last week before alarm where statistic was 0 → first week of the new regime is index+1. */
  estimated_change_point_index: number | null;
  estimated_change_point_week_start: ISODate | null;
  pre_change_rate_weekly_cents: Cents | null;
  post_change_rate_weekly_cents: Cents | null;
  delta_weekly_cents: Cents | null;
  detection_lag_weeks: number | null;
  /** Number of weeks from change point through end of series. */
  post_change_weeks: number | null;
}

export interface OneOffResult {
  transaction_id: string;
  entity: string;
  date: ISODate;
  current_amount_cents: Cents;
  prior_payment_count: number;
  /** Null when prior_payment_count < MIN_PRIOR_VENDOR_PAYMENTS. */
  vendor_median_cents: Cents | null;
  vendor_mad_cents: Cents | null;
  multiple_of_median: number | null;
  is_new_vendor: boolean;
  is_anomalous: boolean;
  materiality: MaterialityVerdict;
}

export interface Contributor {
  entity: string;
  category: Category | null;
  pre_rate_weekly_cents: Cents;
  post_rate_weekly_cents: Cents;
  /** post − pre. May be negative. */
  delta_weekly_cents: Cents;
  delta_monthly_cents: Cents;
  /** delta / total_delta. Not forced to sum to 1. */
  share_of_total_delta: number;
}

export interface MaterialityVerdict {
  material: boolean;
  rules_triggered: string[];
  values: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export type IncidentType = "BURN_RATE_SHIFT" | "ONE_OFF_VENDOR_PAYMENT";
export const INCIDENT_STATUSES = ["OPEN", "ACKNOWLEDGED", "RESOLVED"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export type Severity = "LOW" | "MEDIUM" | "HIGH";

export interface FinancialImpact {
  delta_weekly_cents: Cents | null;
  delta_monthly_cents: Cents | null;
  delta_annualized_cents: Cents | null;
  /** Runway using pre-change burn vs post-change burn. */
  runway_before_months: number | null;
  runway_after_months: number | null;
  runway_impact_months: number | null;
  one_off_amount_cents?: Cents;
}

export interface ChildSignal {
  entity: string;
  category: Category | null;
  description: string;
  delta_weekly_cents: Cents;
}

export const EVIDENCE_KINDS = ["OBSERVED", "DETECTED", "EVIDENCE", "ESTIMATE", "SUGGESTION"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface EvidenceItem {
  kind: EvidenceKind;
  text: string;
  source_url?: string;
  source_title?: string;
  retrieved_at?: ISODateTime;
  /** True when served from cache; UI labels "previously retrieved". */
  cached?: boolean;
}

export interface Incident {
  id: string;
  type: IncidentType;
  /** Primary entity: the largest contributor for BURN_RATE_SHIFT (or `variable_spend` if none), the vendor for ONE_OFF. */
  entity: string;
  title: string;
  summary: string;
  estimated_change_point: ISODate | null;
  alarm_date: ISODate | null;
  severity: Severity;
  status: IncidentStatus;
  first_detected: ISODateTime;
  last_updated: ISODateTime;
  last_notified: ISODateTime | null;
  financial_impact: FinancialImpact;
  contributors: Contributor[];
  child_signals: ChildSignal[];
  detection: { cusum?: CusumResult; one_off?: OneOffResult };
  materiality: MaterialityVerdict;
  evidence: EvidenceItem[];
}

// ---------------------------------------------------------------------------
// What-if
// ---------------------------------------------------------------------------

export interface WhatIfRequest {
  /** `merchant_normalized` entity, e.g. `aws`. */
  entity: string;
  /** Percentage change to the entity's spend. −20 means "20% lower". */
  percentage: number;
}

export const SCENARIO_LABEL = "Scenario estimate — not guaranteed savings." as const;

export interface WhatIfResult {
  label: typeof SCENARIO_LABEL;
  entity: string;
  percentage: number;
  current_weekly_cents: Cents;
  current_monthly_cents: Cents;
  hypothetical_weekly_cents: Cents;
  hypothetical_monthly_cents: Cents;
  /** hypothetical − current (negative = savings). */
  delta_monthly_cents: Cents;
  delta_annualized_cents: Cents;
  current_burn_monthly_cents: Cents;
  scenario_burn_monthly_cents: Cents;
  current_runway_months: number | null;
  scenario_runway_months: number | null;
  runway_delta_months: number | null;
  /** Pre-rendered for voice. Produced by shared/money.ts helpers, never by an LLM. */
  speech: {
    delta_monthly: string;
    scenario_runway: string;
    summary: string;
  };
}

// ---------------------------------------------------------------------------
// Fixture metadata (generator output, for assertions)
// ---------------------------------------------------------------------------

export interface FixtureMetadata {
  seed: number;
  profile: "demo" | "test";
  weeks: number;
  start_date: ISODate;
  end_date: ISODate;
  closing_balance_cents: Cents;
  opening_balance_cents: Cents;
  burn_shift: {
    /** Week index where the new regime begins. */
    true_change_start_index: number;
    true_change_start_week: ISODate;
    expected_driver_entities: string[];
    expected_direction: "upward";
    /** Approximate planted weekly delta once fully ramped. Positive. */
    planted_delta_weekly_cents: Cents;
  };
  one_off: {
    transaction_id: string;
    entity: string;
    amount_cents: Cents;
    prior_payment_count: number;
    prior_median_cents: Cents;
  };
  unknown_vendor: {
    transaction_ids: string[];
    merchant_raw: string;
    merchant_normalized: string;
    expected_category: Category;
  };
  internal_transfer_pair_ids: string[];
  card_settlement_ids: string[];
  pending_settled_pairs: Array<{ pending_id: string; settled_id: string }>;
  financing_transaction_ids: string[];
  refund_transaction_ids: string[];
  needs_review_candidate_ids: string[];
}

export interface GeneratedCompany {
  company: CompanyProfile;
  accounts: BankAccount[];
  transactions: Transaction[];
  fixture: FixtureMetadata;
}

// ---------------------------------------------------------------------------
// Derived demo object (contract §14) — the single source for UI / iMessage / voice
// ---------------------------------------------------------------------------

export type HistorySource = "synthetic" | "sandbox_bank" | "mock";

export interface DataProvenance {
  company_is_fictional: true;
  balance_source: "sandbox_bank" | "mock";
  history_source: HistorySource;
  seed: number;
  weeks: number;
  start_date: ISODate;
  end_date: ISODate;
  generated_at: ISODateTime;
}

export interface NeedsReviewItem {
  transaction_id: string;
  date: ISODate;
  merchant_raw: string;
  merchant_normalized: string;
  amount_cents: Cents;
  reason: string;
}

export interface DerivedDemoObject {
  provenance: DataProvenance;
  company: CompanyProfile;
  accounts: BankAccount[];
  cash_cents: Cents;
  burn: BurnSummary;
  reconciliation: ReconciliationReport;
  needs_review: { count: number; outflow_cents: Cents; items: NeedsReviewItem[] };
  weeks: WeeklyBucket[];
  /** Same length as weeks. For the incident chart. */
  cusum_statistic_cents: Cents[];
  /** Optional EWMA of variable spend, visualization only. */
  ewma_variable_spend_cents?: Cents[];
  incidents: Incident[];
  /** The BURN_RATE_SHIFT incident the demo centers on, or null. */
  primary_incident: Incident | null;
  /** The standalone ONE_OFF incident, or null. */
  one_off_incident: Incident | null;
  vendor_enrichments: VendorEnrichment[];
  classifications: ClassificationMap;
  /** Present in verification runs only; the API strips it before serving. */
  fixture?: FixtureMetadata;
}
