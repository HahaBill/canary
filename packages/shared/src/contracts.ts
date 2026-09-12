/**
 * Package-level function contracts. Each workstream package MUST export
 * functions whose types are assignable to these. This is how the lead
 * integrator wires packages together without renegotiating signatures.
 *
 *   @canary/generator      → GenerateDemoCompany
 *   @canary/engine         → BuildLedger, ComputeBurn, SimulateCostChange
 *   @canary/detectors      → DetectOneOffs, RunCusum, DecomposeContributors, BuildIncidents
 *   @canary/classification → ClassifyTransactions, LlmProvider, ResearchProvider
 */
import type {
  BankAccount,
  BurnSummary,
  Category,
  Cents,
  Classification,
  ClassificationMap,
  Contributor,
  CusumConfig,
  CusumResult,
  GeneratedCompany,
  Incident,
  ISODate,
  ISODateTime,
  Ledger,
  OneOffResult,
  Transaction,
  VendorEnrichment,
  WeeklyBucket,
  WhatIfRequest,
  WhatIfResult,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export interface GenerateDemoCompanyOptions {
  seed: number;
  /** Checking + savings the ledger must close on. Default: sandboxClosingCashCents(). */
  closingBalanceCents: Cents;
  /** Last day of history (Sunday). Default: DEMO.END_DATE. */
  endDate: ISODate;
  /** Default: DEMO.WEEKS. */
  weeks: number;
  /** `demo` = only the events needed for the live story. `test` = also financing, annual renewal, extra edge cases. */
  profile: "demo" | "test";
  /** Accounts to generate against. Default: SANDBOX_ACCOUNTS. */
  accounts?: BankAccount[];
}

export type GenerateDemoCompany = (opts: GenerateDemoCompanyOptions) => GeneratedCompany;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface BuildLedgerInput {
  company: import("./types.ts").CompanyProfile;
  accounts: BankAccount[];
  transactions: Transaction[];
  /** Keyed by transaction id. Transactions without an entry are treated as NEEDS_REVIEW (and still count). */
  classifications: ClassificationMap;
  /** Transaction ids the one-off detector has tagged. Engine applies the `one_off` tag and excludes them from `variable_spend_cents`. */
  oneOffTransactionIds?: string[];
  /** Weeks of history; defaults to the span of the transactions. */
  historyStart?: ISODate;
  historyEnd?: ISODate;
}

export type BuildLedger = (input: BuildLedgerInput) => Ledger;

export interface ComputeBurnOptions {
  /** From CUSUM. Index of the FIRST week of the new regime (estimated_change_point_index + 1), or null if none confirmed. */
  regimeStartWeekIndex: number | null;
  trailingWindowWeeks?: number;
  minPostChangeWeeks?: number;
}

export type ComputeBurn = (ledger: Ledger, opts: ComputeBurnOptions) => BurnSummary;

/** Pure. Derives everything from `burn`; never reads the request for numbers other than `percentage`. */
export type SimulateCostChange = (burn: BurnSummary, req: WhatIfRequest) => WhatIfResult;

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/**
 * Runs the vendor-relative one-off rule over every operating outflow in the
 * ledger, in date order, using only PRIOR payments to that entity as history.
 * Returns one result per evaluated transaction that is anomalous OR new-vendor
 * (callers filter on `is_anomalous && materiality.material`).
 */
export type DetectOneOffs = (ledger: Ledger, burn: BurnSummary) => OneOffResult[];

/** One-sided upward CUSUM on `weeks[i].variable_spend_cents`. */
export type RunCusum = (weeks: WeeklyBucket[], config?: Partial<CusumConfig>) => CusumResult;

/** Pre/post rates per entity around `cusum.estimated_change_point_index`. Sorted by delta desc. */
export type DecomposeContributors = (weeks: WeeklyBucket[], cusum: CusumResult) => Contributor[];

export interface BuildIncidentsInput {
  ledger: Ledger;
  cusum: CusumResult;
  contributors: Contributor[];
  oneOffs: OneOffResult[];
  /** Burn computed with the pre-change window (for runway_before). */
  burnBefore: BurnSummary;
  /** Burn computed with the current/post-change window (for runway_after). */
  burnAfter: BurnSummary;
  /** Previously stored incidents, for dedup/update. */
  existing: Incident[];
  now: ISODateTime;
}

/** Returns the full, deduplicated incident list (existing updated + new). */
export type BuildIncidents = (input: BuildIncidentsInput) => Incident[];

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface LlmCategoryProposal {
  category: Category;
  /** One sentence, human-readable. */
  reason: string;
}

export interface LlmProvider {
  readonly name: string;
  proposeCategory(input: {
    merchant_raw: string;
    merchant_normalized: string;
    description: string;
    amount_cents: Cents;
    /** Summary of this merchant's history, e.g. "4 prior payments, median $1,200, monthly cadence". */
    history_summary: string;
    allowed_categories: readonly Category[];
  }): Promise<LlmCategoryProposal>;
}

export interface ResearchProvider {
  readonly name: string;
  /** Returns null when nothing indexed was found. Must never invent URLs. */
  enrichVendor(input: { merchant_raw: string; merchant_normalized: string; display_name?: string }): Promise<VendorEnrichment | null>;
}

export interface EnrichmentCache {
  get(merchant_normalized: string): Promise<VendorEnrichment | null>;
  set(enrichment: VendorEnrichment): Promise<void>;
}

export interface ClassifyOptions {
  llm?: LlmProvider;
  research?: ResearchProvider;
  cache?: EnrichmentCache;
  /** Skip LLM/research for outflows smaller than this; classify NEEDS_REVIEW instead. */
  min_amount_for_research_cents?: Cents;
}

export interface ClassifyResult {
  classifications: ClassificationMap;
  enrichments: VendorEnrichment[];
  /** Per-merchant summary for debugging/evidence. */
  by_merchant: Record<string, Classification>;
}

export type ClassifyTransactions = (transactions: Transaction[], opts?: ClassifyOptions) => Promise<ClassifyResult>;
