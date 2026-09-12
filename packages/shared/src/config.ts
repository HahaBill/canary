/**
 * All tunable thresholds live here. No package may hard-code a threshold.
 * Only the lead integrator edits this file.
 */
import type { Category, CusumConfig } from "./types.ts";

/** Pinned globally. Never use 4-week months. */
export const WEEKS_PER_MONTH = 52 / 12;

// ---------------------------------------------------------------------------
// Category behaviour
// ---------------------------------------------------------------------------

/** Predictable outflows excluded from the CUSUM variable-spend series (still in burn). */
export const FIXED_CATEGORIES: readonly Category[] = ["PAYROLL", "RENT", "INSURANCE"] as const;

/** Never part of operating burn. */
export const NON_OPERATING_CATEGORIES: readonly Category[] = [
  "FINANCING",
  "INTERNAL_TRANSFER",
  "CARD_SETTLEMENT",
] as const;

/** Operating outflow categories that are neither fixed nor non-operating → variable (monitored by CUSUM). */
export const VARIABLE_CATEGORIES: readonly Category[] = [
  "CLOUD_INFRASTRUCTURE",
  "SAAS_SOFTWARE",
  "CONTRACTORS",
  "RECRUITING",
  "MARKETING",
  "TRAVEL",
  "MEALS",
  "EQUIPMENT",
  "PROFESSIONAL_SERVICES",
  "TAXES_FEES",
  "NEEDS_REVIEW",
] as const;

// ---------------------------------------------------------------------------
// CUSUM (PRD §13, contract §6)
// ---------------------------------------------------------------------------

export const CUSUM_DEFAULTS: CusumConfig = {
  k_factor: 0.5,
  h_multiplier: 4,
  min_baseline_weeks: 8,
  sigma_floor_fraction: 0.02,
};

/** Post-change segment must have at least this many weeks before it becomes the burn window. */
export const MIN_POST_CHANGE_WEEKS = 4;
/** Trailing window used before a confirmed regime change (or as fallback). */
export const TRAILING_WINDOW_WEEKS = 8;

// ---------------------------------------------------------------------------
// One-off detector (PRD §12, contract §8–9)
// ---------------------------------------------------------------------------

export const MIN_PRIOR_VENDOR_PAYMENTS = 3;
export const ONE_OFF_MEDIAN_MULTIPLE = 3;
/** Absolute difference (current − median) must exceed this too. */
export const ONE_OFF_MIN_ABS_DIFF_CENTS = 200_000; // $2,000

// ---------------------------------------------------------------------------
// Materiality (PRD §18, contract §12)
// ---------------------------------------------------------------------------

export const MATERIALITY = {
  /** Rate change: monthlyized delta ≥ this … */
  MIN_MONTHLY_DELTA_CENTS: 500_000, // $5,000
  /** … OR ≥ this fraction of normalized monthly gross burn … */
  MIN_BURN_PERCENT: 0.05,
  /** … OR runway impact ≥ this many months. */
  MIN_RUNWAY_IMPACT_MONTHS: 0.5,
  /** One-off: amount ≥ this … */
  MIN_ONE_OFF_AMOUNT_CENTS: 500_000, // $5,000
  /** … OR ≥ this fraction of normalized monthly gross burn. */
  MIN_ONE_OFF_BURN_PERCENT: 0.03,
} as const;

// ---------------------------------------------------------------------------
// Incidents (PRD §17, contract §10–11)
// ---------------------------------------------------------------------------

export const INCIDENT_DEDUP_WEEKS = 2;
/** Assertion tolerance for estimated vs true change point. */
export const CHANGE_POINT_TOLERANCE_WEEKS = 2;
/** Contributor deltas must sum to total delta within this fraction. */
export const CONTRIBUTOR_SUM_TOLERANCE = 0.02;

export const SEVERITY_THRESHOLDS = {
  /** runway_impact_months ≥ HIGH → HIGH; ≥ MEDIUM → MEDIUM; else LOW */
  HIGH_RUNWAY_IMPACT_MONTHS: 1.5,
  MEDIUM_RUNWAY_IMPACT_MONTHS: 0.5,
} as const;

// ---------------------------------------------------------------------------
// Demo fixture constants (contract §4–5, §13)
// ---------------------------------------------------------------------------

export const DEMO = {
  SEED: 20260912,
  TEST_SEED: 424242,
  WEEKS: 20,
  /** Sunday. History covers 20 complete Mon–Sun weeks ending here. */
  END_DATE: "2026-09-13",
  /** New regime begins at this 0-based week index (contract §5 recommends 10–11 of 20). */
  CHANGE_START_INDEX: 10,
  /** Ramp the shift in over this many weeks so it reads as "sustained drift". */
  CHANGE_RAMP_WEEKS: 3,
  PRIMARY_DRIVER_ENTITY: "aws",
  SECONDARY_DRIVER_ENTITIES: ["ashby", "datadog"],
  ONE_OFF_ENTITY: "figma",
  /**
   * Real, indexed, moderately obscure vendor for Tavily corroboration.
   * Ashby (ashbyhq.com) is a recruiting platform → RECRUITING. Not in deterministic rules on purpose.
   */
  UNKNOWN_VENDOR: {
    merchant_raw: "ASHBYHQ INC SAN FRANCISCO CA",
    merchant_normalized: "ashby",
    display_name: "Ashby",
    expected_category: "RECRUITING" as Category,
  },
} as const;
