/**
 * Calibration for the fictional company (Perch Analytics, Inc.).
 *
 * Everything here is a generator INPUT. The generator is the source of truth for every
 * derived financial figure (docs/DATA_AND_DETECTOR_CONTRACT.md, "The generator is the
 * source of truth"), so no downstream package may hard-code any of these numbers or
 * anything computed from them.
 *
 * Calibration targets (guidance from docs/WORKSTREAMS.md §A):
 *   monthly gross burn pre-shift ≈ $186K, revenue ≈ $58K/mo, net ≈ $131K/mo
 *   → runway on the $2,012,880.19 sandbox balance ≈ 15.4 months before the shift,
 *     ≈ 13.3 months after it.
 */
import type { Category, Cents } from "@canary/shared";

export type AccountKey = "checking" | "savings" | "card";

// ---------------------------------------------------------------------------
// The monitored (variable) series
// ---------------------------------------------------------------------------

/**
 * Baseline weekly variable spend. The generator drives the weekly variable total to
 * `VARIABLE_WEEKLY_BASE_CENTS × (1 + noise) + ramp × PLANTED_DELTA_WEEKLY_CENTS` and lets
 * `aws` carry the residual (see AWS_IS_THE_ELASTIC_COMPONENT in index.ts). That is what
 * makes σ — and therefore CUSUM detectability — a designed property rather than a
 * happy accident.
 */
export const VARIABLE_WEEKLY_BASE_CENTS: Cents = 1_545_000;

/**
 * Fully-ramped weekly increase planted at `DEMO.CHANGE_START_INDEX`.
 * Sized to ≈ 4.2 × the baseline σ that a MAD estimator sees over the first 8 weeks,
 * which lands inside the 3–5σ window the CUSUM contract needs: big enough to alarm two
 * weeks after the regime starts, small enough not to alarm in the very first one.
 */
export const PLANTED_DELTA_WEEKLY_CENTS: Cents = 480_000;

/**
 * Weekly noise on the variable baseline.
 *
 * Each 4-week block gets a deterministic shuffle of `NOISE_OFFSETS` plus a small jitter.
 * Two properties fall out of this, and both matter:
 *   1. MAD over the first 8 weeks (= exactly two blocks) is ≈ (2/3) × amplitude × base,
 *      so σ is predictable and barely seed-dependent.
 *   2. Only the `+1` week of a block can push the CUSUM statistic up (every other offset
 *      is smaller than k = 0.5σ), so the pre-change statistic returns to zero often and
 *      cannot drift into a false alarm.
 */
export const NOISE_AMPLITUDE = 0.075;
export const NOISE_OFFSETS: readonly number[] = [1, 1 / 3, -1 / 3, -1];
export const NOISE_BLOCK_WEEKS = 4;
export const NOISE_JITTER = NOISE_AMPLITUDE / 6;

/** AWS is the residual; this floor stops a pathological week from going negative. */
export const AWS_MIN_WEEKLY_CENTS: Cents = 150_000;

/** Secondary driver: datadog's monthly bill grows with the ramp (more infra → more logs). */
export const DATADOG_SHIFT_FRACTION = 0.55;


// ---------------------------------------------------------------------------
// A year of history: growth, seasonality, and where the planted events sit
// ---------------------------------------------------------------------------

/**
 * Fixture positions are WEEKS BEFORE THE END, never absolute week indexes.
 *
 * The demo span is a year, but the generator still has to produce a coherent
 * 16-week fixture for tests, and "the shift started ten weeks ago" has to stay
 * true in both. Absolute indexes would bunch every planted event into the first
 * quarter of a year-long ledger and fall off the end of a short one.
 */
export const WEEKS_BEFORE_END = {
  CHANGE_START: 10,
  ONE_OFF: 5,
  UNKNOWN_VENDOR: [9, 6, 3] as readonly number[],
  FRANCHISE_TAX: 30,
  REFUND: 20,
  TRANSFER_DEMO: 35,
  TRANSFER_TEST: 12,
  FINANCING: 28,
  ANNUAL_RENEWAL: 24,
} as const;

/**
 * Headcount grows over the year, so payroll does too: roughly 8 people at the
 * start and 14 at the end, stepping once a quarter as hires land rather than
 * drifting smoothly, because that is how payroll actually moves.
 *
 * Growth lives HERE and in revenue, deliberately NOT in the monitored variable
 * series. CUSUM baselines on the first eight weeks of whatever it is given; a
 * year of organic growth in the monitored series would make it alarm on the
 * growth long before the planted event, and the change point would be
 * meaningless. Payroll is a FIXED category and revenue is an inflow, so both are
 * outside the monitored series. The company visibly grows, and the detector
 * still answers the question it was asked.
 */
export const PAYROLL_GROWTH_STEPS: readonly number[] = [0.58, 0.72, 0.86, 1];

/** Weekly revenue a year ago as a fraction of today's: ~1.6%/week compounding. */
export const REVENUE_START_FRACTION = 0.45;

/**
 * Holiday slowdown on the monitored series over the turn of the year. CUSUM is
 * one-sided upward, so a dip can never cause a false alarm, and the demo span's
 * first eight weeks (mid-September onward) are clear of it, leaving the baseline
 * clean.
 */
export const HOLIDAY_DIP_FRACTION = 0.08;

/** Travel and equipment recur on this cycle rather than only in the first weeks. */
export const CARD_SPEND_CYCLE_WEEKS = 20;

// ---------------------------------------------------------------------------
// Fixed (predictable) spend — excluded from the CUSUM series, still in burn
// ---------------------------------------------------------------------------

/** Biweekly, on the Friday of odd week indexes. 10 runs / 20 weeks = 26 runs / year. */
export const PAYROLL = {
  merchant_raw: "GUSTO PAYROLL 7741",
  merchant_normalized: "gusto_payroll",
  description: "Semi-monthly payroll",
  amount_cents: 4_800_000,
  noise: 0.015,
  day_offset: 4,
} as const;

// ---------------------------------------------------------------------------
// Weekly cadences
// ---------------------------------------------------------------------------

export const AWS = {
  merchant_raw: "AMAZON WEB SERVICES AWS.AMAZON.CO",
  merchant_normalized: "aws",
  description: "AWS usage",
  day_offset: 2,
} as const;

export const REVENUE = {
  merchant_raw: "STRIPE PAYOUT ST-A41K",
  merchant_normalized: "stripe_payouts",
  description: "Customer payments",
  amount_cents: 1_340_000,
  noise: 0.09,
  day_offset: 1,
} as const;

export const UPWORK = {
  merchant_raw: "UPWORK ESCROW INC",
  merchant_normalized: "upwork",
  description: "Contract engineering",
  amount_cents: 160_000,
  noise: 0.16,
  day_offset: 3,
} as const;

/** Named/biweekly contractors. `deel` is rule-classifiable; the named ACH is not. */
export const BIWEEKLY_CONTRACTORS = [
  {
    merchant_raw: "DEEL INC PAYMENTS",
    merchant_normalized: "deel",
    description: "Contractor payouts",
    amount_cents: 240_000,
    noise: 0.08,
    day_offset: 0,
    on_odd_weeks: false,
  },
  {
    merchant_raw: "ACH MIGUEL SANTOS DESIGN",
    merchant_normalized: "miguel_santos",
    description: "Design retainer",
    amount_cents: 220_000,
    noise: 0.06,
    day_offset: 0,
    on_odd_weeks: true,
  },
] as const;

// ---------------------------------------------------------------------------
// Monthly cadences (day-of-month staggered so no single week carries them all)
// ---------------------------------------------------------------------------

export interface MonthlySpec {
  merchant_raw: string;
  merchant_normalized: string;
  description: string;
  day_of_month: number;
  amount_cents: Cents;
  noise: number;
  category_hint: Category;
  account: AccountKey;
  /** Shift Sat/Sun to the following Monday (bank-initiated payments). */
  business_day?: boolean;
}

export const MONTHLY_FIXED: MonthlySpec[] = [
  {
    merchant_raw: "WEWORK 535 MISSION ST",
    merchant_normalized: "wework",
    description: "Office rent",
    day_of_month: 1,
    amount_cents: 1_100_000,
    noise: 0,
    category_hint: "RENT",
    account: "checking",
    business_day: true,
  },
  {
    merchant_raw: "VOUCH INSURANCE PREMIUM",
    merchant_normalized: "vouch",
    description: "Business insurance premium",
    day_of_month: 12,
    amount_cents: 285_000,
    noise: 0.01,
    category_hint: "INSURANCE",
    account: "checking",
    business_day: true,
  },
];

export const MONTHLY_VARIABLE: MonthlySpec[] = [
  {
    merchant_raw: "NOTION LABS INC",
    merchant_normalized: "notion",
    description: "Notion team plan",
    day_of_month: 3,
    amount_cents: 34_000,
    noise: 0.04,
    category_hint: "SAAS_SOFTWARE",
    account: "checking",
  },
  {
    merchant_raw: "FIGMA INC",
    merchant_normalized: "figma",
    description: "Figma design seats",
    day_of_month: 4,
    amount_cents: 115_000,
    noise: 0.05,
    category_hint: "SAAS_SOFTWARE",
    account: "checking",
  },
  {
    merchant_raw: "GOOGLE ADS 8823041",
    merchant_normalized: "google_ads",
    description: "Demand generation campaigns",
    day_of_month: 5,
    amount_cents: 180_000,
    noise: 0.14,
    category_hint: "MARKETING",
    account: "checking",
  },
  {
    merchant_raw: "PILOT.COM BOOKKEEPING",
    merchant_normalized: "pilot",
    description: "Monthly bookkeeping",
    day_of_month: 9,
    amount_cents: 95_000,
    noise: 0.02,
    category_hint: "PROFESSIONAL_SERVICES",
    account: "checking",
    business_day: true,
  },
  {
    merchant_raw: "DATADOG INC",
    merchant_normalized: "datadog",
    description: "Observability platform",
    day_of_month: 11,
    amount_cents: 380_000,
    noise: 0.06,
    category_hint: "SAAS_SOFTWARE",
    account: "checking",
  },
  {
    merchant_raw: "SLACK TECHNOLOGIES LLC",
    merchant_normalized: "slack",
    description: "Slack Business+",
    day_of_month: 14,
    amount_cents: 52_000,
    noise: 0.03,
    category_hint: "SAAS_SOFTWARE",
    account: "checking",
  },
  {
    merchant_raw: "GITHUB INC",
    merchant_normalized: "github",
    description: "GitHub Team seats",
    day_of_month: 18,
    amount_cents: 48_000,
    noise: 0.03,
    category_hint: "SAAS_SOFTWARE",
    account: "checking",
  },
  {
    merchant_raw: "GUNDERSON DETTMER LLP",
    merchant_normalized: "gunderson_dettmer",
    description: "Legal fees",
    day_of_month: 20,
    amount_cents: 220_000,
    noise: 0.2,
    category_hint: "PROFESSIONAL_SERVICES",
    account: "checking",
    business_day: true,
  },
  {
    merchant_raw: "VERCEL INC",
    merchant_normalized: "vercel",
    description: "Vercel Pro",
    day_of_month: 22,
    amount_cents: 76_000,
    noise: 0.05,
    category_hint: "SAAS_SOFTWARE",
    account: "checking",
  },
  {
    merchant_raw: "LINEAR ORBIT INC",
    merchant_normalized: "linear",
    description: "Linear seats",
    day_of_month: 26,
    amount_cents: 29_000,
    noise: 0.03,
    category_hint: "SAAS_SOFTWARE",
    account: "checking",
  },
  {
    merchant_raw: "CANARY SANDBOX BANK FEE",
    merchant_normalized: "bank_fee",
    description: "Account analysis fee",
    day_of_month: 28,
    amount_cents: 9_500,
    noise: 0.01,
    category_hint: "TAXES_FEES",
    account: "checking",
  },
];

/** The pending/settled pair is carved out of this vendor's Nth occurrence. */
/** Recent, so the demo's pending/settled pair is current news. Clamped to the last occurrence on short spans. */
export const PENDING_PAIR = { merchant_normalized: "vercel", occurrence_index: 10 } as const;

// ---------------------------------------------------------------------------
// Employee card spend (card account; settled biweekly by a CARD_SETTLEMENT pair)
// ---------------------------------------------------------------------------

export interface CardSpendSpec {
  merchant_raw: string;
  merchant_normalized: string;
  description: string;
  amount_cents: Cents;
  noise: number;
  day_offset: number;
  category_hint: Category;
}

export const CARD_MEALS: CardSpendSpec[] = [
  {
    merchant_raw: "DOORDASH*TEAM LUNCH",
    merchant_normalized: "doordash",
    description: "Team lunch",
    amount_cents: 15_500,
    noise: 0.35,
    day_offset: 0,
    category_hint: "MEALS",
  },
  {
    merchant_raw: "UBER EATS SF",
    merchant_normalized: "uber_eats",
    description: "Team dinner (on-site)",
    amount_cents: 20_500,
    noise: 0.35,
    day_offset: 2,
    category_hint: "MEALS",
  },
  {
    merchant_raw: "DOORDASH*TEAM LUNCH",
    merchant_normalized: "doordash",
    description: "Team lunch",
    amount_cents: 19_500,
    noise: 0.35,
    day_offset: 4,
    category_hint: "MEALS",
  },
];

/** Keyed by week index so travel and equipment never land in the same week. */
export const CARD_TRAVEL: Record<number, CardSpendSpec> = {
  0: {
    merchant_raw: "UNITED AIRLINES 0162",
    merchant_normalized: "united",
    description: "Customer visit — SFO/SEA",
    amount_cents: 98_000,
    noise: 0.2,
    day_offset: 3,
    category_hint: "TRAVEL",
  },
  4: {
    merchant_raw: "AIRBNB HMXY72Q",
    merchant_normalized: "airbnb",
    description: "Offsite lodging",
    amount_cents: 112_000,
    noise: 0.2,
    day_offset: 3,
    category_hint: "TRAVEL",
  },
  8: {
    merchant_raw: "UNITED AIRLINES 0162",
    merchant_normalized: "united",
    description: "Conference travel",
    amount_cents: 96_000,
    noise: 0.2,
    day_offset: 3,
    category_hint: "TRAVEL",
  },
  12: {
    merchant_raw: "AIRBNB HMXY72Q",
    merchant_normalized: "airbnb",
    description: "Customer onsite lodging",
    amount_cents: 104_000,
    noise: 0.2,
    day_offset: 3,
    category_hint: "TRAVEL",
  },
  16: {
    merchant_raw: "UNITED AIRLINES 0162",
    merchant_normalized: "united",
    description: "Customer visit — SFO/AUS",
    amount_cents: 101_000,
    noise: 0.2,
    day_offset: 3,
    category_hint: "TRAVEL",
  },
};

export const CARD_EQUIPMENT: Record<number, CardSpendSpec> = {
  2: {
    merchant_raw: "APPLE STORE R456",
    merchant_normalized: "apple",
    description: "Laptop for new hire",
    amount_cents: 145_000,
    noise: 0.08,
    day_offset: 1,
    category_hint: "EQUIPMENT",
  },
  10: {
    merchant_raw: "DELL MARKETING LP",
    merchant_normalized: "dell",
    description: "Monitors and docks",
    amount_cents: 168_000,
    noise: 0.08,
    day_offset: 1,
    category_hint: "EQUIPMENT",
  },
  18: {
    merchant_raw: "APPLE STORE R456",
    merchant_normalized: "apple",
    description: "Laptop for new hire",
    amount_cents: 152_000,
    noise: 0.08,
    day_offset: 1,
    category_hint: "EQUIPMENT",
  },
};

/** Card balance must be $0 at `as_of`, so the last week index must be a settlement week. */
export const CARD_SETTLEMENT = {
  merchant_raw_checking: "CARD PAYMENT — CORPORATE CARD",
  merchant_raw_card: "PAYMENT RECEIVED — THANK YOU",
  merchant_normalized: "card_settlement",
  description: "Corporate card settlement",
  /** Settle on the Sunday of odd week indexes, covering the two weeks just closed. */
  day_offset: 6,
} as const;

// ---------------------------------------------------------------------------
// Planted one-off (NOT tagged — the detector has to find it)
// ---------------------------------------------------------------------------

export const ONE_OFF = {
  /** Post-change but not the last week, so there is still confirmation history after it. */
  week_index: 15,
  day_offset: 3,
  merchant_raw: "FIGMA INC ORG UPGRADE",
  description: "Figma org plan seat true-up",
  /** × the vendor's prior median; floored against the shared one-off thresholds. */
  median_multiple: 12,
} as const;

// ---------------------------------------------------------------------------
// One-shot planted events
// ---------------------------------------------------------------------------

/** Real, indexed, deliberately not rule-classifiable. Empty description on purpose. */
export const UNKNOWN_VENDOR_WEEKS: readonly number[] = [11, 14, 17];
export const UNKNOWN_VENDOR_AMOUNT_CENTS: Cents = 140_000;
export const UNKNOWN_VENDOR_DAY_OFFSET = 1;
export const UNKNOWN_VENDOR_NOISE = 0.05;

export const FRANCHISE_TAX = {
  week_index: 6,
  day_offset: 2,
  merchant_raw: "DELAWARE FRANCHISE TAX",
  merchant_normalized: "delaware_franchise_tax",
  description: "Annual franchise tax",
  amount_cents: 85_000,
} as const;

export const REFUND = {
  week_index: 7,
  day_offset: 4,
  merchant_raw: "UPWORK ESCROW REFUND",
  merchant_normalized: "upwork",
  description: "Cancelled contract refund",
  amount_cents: 120_000,
  /**
   * Ground truth for a refund is the category it nets against, not `REFUND` — that is what
   * the engine does (`REFUND keeps the vendor's category if known`) and `category_hint` has
   * to agree with the engine for the weekly buckets to line up.
   */
  category_hint: "CONTRACTORS" as Category,
} as const;

export const TRANSFERS = [
  { week_index: 4, day_offset: 4, amount_cents: 7_500_000, description: "Reserve top-up", profile: "demo" as const },
  { week_index: 13, day_offset: 4, amount_cents: 4_000_000, description: "Reserve top-up", profile: "test" as const },
];

export const TRANSFER = {
  merchant_raw_out: "TRANSFER TO SAVINGS 2210",
  merchant_raw_in: "TRANSFER FROM CHECKING 7741",
  merchant_normalized: "internal_transfer",
} as const;

// ---------------------------------------------------------------------------
// `test` profile extras
// ---------------------------------------------------------------------------

export const TEST_FINANCING = {
  week_index: 8,
  day_offset: 0,
  merchant_raw: "WIRE IN - SAFE EXTENSION",
  merchant_normalized: "safe_financing",
  description: "SAFE extension proceeds",
  amount_cents: 15_000_000,
} as const;

export const TEST_ANNUAL_RENEWAL = {
  week_index: 9,
  day_offset: 2,
  merchant_raw: "ZOOM.US ANNUAL PLAN",
  merchant_normalized: "zoom",
  description: "Annual plan renewal",
  amount_cents: 960_000,
} as const;

/** Vendors with no deterministic classification rule — the Needs Review candidates. */
export const NEEDS_REVIEW_ENTITIES: readonly string[] = ["ashby", "miguel_santos", "j_morales", "unknown_ach", "unknown_online"];

// ---------------------------------------------------------------------------
// `test` profile — messy statement shapes (contract §4: "the test seed may
// include reconciliation mismatches and more edge cases")
// ---------------------------------------------------------------------------

/**
 * Patterns taken from how real business bank statements actually read, not from
 * how a tidy ledger is supposed to look. Every one of them breaks a naive
 * reconciliation in a different way, and the demo profile contains none of them.
 *
 * The amounts are deliberately modest: each messy row is variable spend, and AWS
 * closes every week onto its designed target, so a large messy charge would eat
 * into the planted shift instead of testing reconciliation.
 */
export const TEST_MESSY = {
  /**
   * The double-post: the same vendor, the same amount, the same day, twice.
   * Nothing in the data says which one is the mistake — and often neither is.
   */
  DOUBLE_POST: {
    week_index: 11,
    day_offset: 1,
    merchant_raw: "ACH DEBIT VERCEL INC 0392481",
    merchant_normalized: "vercel",
    description: "ACH debit",
    amount_cents: 79_700,
    category_hint: "SAAS_SOFTWARE" as Category,
  },
  /** The bank reverses one leg of the double-post two days later. */
  REVERSAL: {
    week_index: 11,
    day_offset: 3,
    merchant_raw: "REVERSAL ACH DEBIT 0392481",
    merchant_normalized: "vercel",
    description: "Duplicate debit reversed",
    category_hint: "SAAS_SOFTWARE" as Category,
  },
  /**
   * A credit bigger than anything that vendor was charged that week — an
   * annual-plan downgrade refunded in one lump. The vendor's week goes negative.
   */
  OVER_CREDIT: {
    week_index: 12,
    day_offset: 2,
    merchant_raw: "LINEAR REFUND PLAN CHANGE",
    merchant_normalized: "linear",
    description: "Plan downgrade credit",
    amount_cents: 120_000,
    category_hint: "SAAS_SOFTWARE" as Category,
  },
  /** A paper check to a person. No merchant, no category, still real money. */
  CHECK_TO_INDIVIDUAL: {
    week_index: 12,
    day_offset: 3,
    merchant_raw: "CHECK 1042 J MORALES",
    merchant_normalized: "j_morales",
    description: "Check",
    amount_cents: 185_000,
    category_hint: "NEEDS_REVIEW" as Category,
  },
  /** Two debits whose descriptor identifies nothing but the rail they came in on. */
  AMBIGUOUS_ACH: {
    week_indexes: [13, 16] as readonly number[],
    day_offset: 1,
    merchant_raw: "ACH DEBIT 0392481",
    merchant_normalized: "unknown_ach",
    description: "",
    amount_cents: 96_400,
    category_hint: "NEEDS_REVIEW" as Category,
  },
  /** "ONLINE PAYMENT THANK YOU" — a descriptor that thanks you for nothing. */
  AMBIGUOUS_ONLINE: {
    week_index: 13,
    day_offset: 3,
    merchant_raw: "ONLINE PAYMENT THANK YOU",
    merchant_normalized: "unknown_online",
    description: "",
    amount_cents: 47_300,
    category_hint: "NEEDS_REVIEW" as Category,
  },
  /**
   * A wire the company booked as an internal transfer whose other leg never
   * arrives. The engine must not silently trust it as $0 of spend.
   */
  ORPHAN_TRANSFER: {
    week_index: 14,
    day_offset: 2,
    merchant_raw: "TRANSFER 0001234",
    description: "Transfer out — no matching leg",
    amount_cents: 250_000,
  },
  /**
   * A pending authorisation in the final week that never settles: it has to
   * count in cash and burn, because the money is gone as far as the founder
   * is concerned.
   */
  UNSETTLED_PENDING: {
    week_index: 19,
    day_offset: 2,
    merchant_raw: "SQ *UNKNOWN MERCHANT",
    merchant_normalized: "unknown_online",
    description: "Pending authorisation",
    amount_cents: 62_800,
    category_hint: "NEEDS_REVIEW" as Category,
  },
} as const;

/**
 * The transfer pair key that is unpaired ON PURPOSE. `assertFixtureInvariants`
 * skips it: an orphan leg is the fixture, not a defect in the fixture.
 */
export const TEST_UNPAIRED_TRANSFER_KEY = "xfer-orphan";
