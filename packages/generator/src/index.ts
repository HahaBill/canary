/**
 * @canary/generator — the deterministic synthetic company generator.
 *
 * This package is the source of truth for every financial figure in Canary
 * (docs/DATA_AND_DETECTOR_CONTRACT.md §2). It produces 20 complete Mon–Sun weeks of
 * history for the fictional Perch Analytics, Inc., generated *backward* from the
 * Canary Sandbox Bank closing balance so the ledger closes on that anchor exactly.
 *
 * Determinism: everything derives from `opts.seed` through named PRNG sub-streams.
 * No `Date.now()`, no `Math.random()`.
 *
 * ── AWS_IS_THE_ELASTIC_COMPONENT ────────────────────────────────────────────────
 * The weekly variable-spend series is a *designed* process:
 *
 *   target(i) = VARIABLE_WEEKLY_BASE × (1 + noise(i)) + ramp(i) × PLANTED_DELTA
 *
 * Every other variable line item is scheduled independently with its own noise, and
 * `aws` is then set to whatever makes the week hit `target(i)`. A cloud bill genuinely is
 * the elastic part of a small company's spend, and modelling it that way is what lets the
 * generator guarantee the CUSUM properties the demo depends on: the baseline σ that a
 * MAD estimator recovers, the fully-ramped delta as a multiple of that σ, and therefore
 * the alarm week. Without it, σ would be an emergent accident of monthly billing dates.
 */
import {
  ACCOUNT_IDS,
  COMPANY,
  DEMO,
  MATERIALITY,
  ONE_OFF_MEDIAN_MULTIPLE,
  ONE_OFF_MIN_ABS_DIFF_CENTS,
  SANDBOX_ACCOUNTS,
  VARIABLE_CATEGORIES,
  addDays,
  historyStart as historyStartOf,
  isoWeekday,
  median,
  parseISODate,
  sandboxClosingCashCents,
  toISODate,
  weekIndexOf,
  weekStart,
  weekStartsEndingAt,
  type BankAccount,
  type Category,
  type Cents,
  type FixtureMetadata,
  type FlowType,
  type GenerateDemoCompany,
  type GenerateDemoCompanyOptions,
  type GeneratedCompany,
  type ISODate,
  type Transaction,
  type TransactionStatus,
  type TransactionTag,
} from "@canary/shared";
import { jitterCents, makeRng, type Rng } from "./prng.ts";
import {
  AWS,
  AWS_MIN_WEEKLY_CENTS,
  BIWEEKLY_CONTRACTORS,
  CARD_EQUIPMENT,
  CARD_MEALS,
  CARD_SETTLEMENT,
  CARD_TRAVEL,
  DATADOG_SHIFT_FRACTION,
  FRANCHISE_TAX,
  MONTHLY_FIXED,
  MONTHLY_VARIABLE,
  NEEDS_REVIEW_ENTITIES,
  NOISE_AMPLITUDE,
  NOISE_BLOCK_WEEKS,
  NOISE_JITTER,
  NOISE_OFFSETS,
  ONE_OFF,
  PAYROLL,
  PENDING_PAIR,
  PLANTED_DELTA_WEEKLY_CENTS,
  REFUND,
  REVENUE,
  TEST_ANNUAL_RENEWAL,
  TEST_MESSY,
  TEST_UNPAIRED_TRANSFER_KEY,
  TEST_FINANCING,
  TRANSFER,
  TRANSFERS,
  UNKNOWN_VENDOR_AMOUNT_CENTS,
  UNKNOWN_VENDOR_DAY_OFFSET,
  UNKNOWN_VENDOR_NOISE,
  CARD_SPEND_CYCLE_WEEKS,
  HOLIDAY_DIP_FRACTION,
  PAYROLL_GROWTH_STEPS,
  REVENUE_START_FRACTION,
  WEEKS_BEFORE_END,
  UPWORK,
  VARIABLE_WEEKLY_BASE_CENTS,
  type AccountKey,
  type CardSpendSpec,
  type MonthlySpec,
} from "./plan.ts";

export { summarizeWeeklyVariableSpend } from "./summarize.ts";
export { PLANTED_DELTA_WEEKLY_CENTS, TEST_MESSY, TEST_UNPAIRED_TRANSFER_KEY, VARIABLE_WEEKLY_BASE_CENTS } from "./plan.ts";

/** Monthly vendors whose bill grows with the planted ramp (`DEMO.SECONDARY_DRIVER_ENTITIES`). */
const RAMPED_MONTHLY_SHIFT: Record<string, number> = { datadog: DATADOG_SHIFT_FRACTION };

export const DEFAULT_DEMO_OPTIONS: GenerateDemoCompanyOptions = {
  seed: DEMO.SEED,
  closingBalanceCents: sandboxClosingCashCents(),
  endDate: DEMO.END_DATE,
  weeks: DEMO.WEEKS,
  profile: "demo",
  accounts: SANDBOX_ACCOUNTS,
};

// ---------------------------------------------------------------------------
// Internal draft model
// ---------------------------------------------------------------------------

/**
 * A transaction before ids exist. Cross-references are held as `key`s and resolved to
 * ids once every draft has been sorted into its final, deterministic order.
 */
interface Draft {
  key: string;
  account: AccountKey;
  date: ISODate;
  amount_cents: Cents;
  merchant_raw: string;
  merchant_normalized: string;
  description: string;
  flow_type: FlowType;
  category_hint: Category;
  status?: TransactionStatus;
  tags?: TransactionTag[];
  transfer_pair_key?: string;
  settlement_key?: string;
  pending_of_key?: string;
  /**
   * True for the planted one-off: it is deliberately untagged (the detector must find it),
   * but it must not move the monitored series, because the engine re-tags and excludes it
   * before bucketing.
   */
  excluded_from_monitored_series?: boolean;
}

const MONITORING_EXCLUDED_TAGS: readonly TransactionTag[] = ["one_off", "annual_renewal"];

function isMonitoredVariable(d: Draft, supersededKeys: ReadonlySet<string>): boolean {
  if (d.excluded_from_monitored_series) return false;
  if (supersededKeys.has(d.key)) return false;
  if (d.tags?.some((t) => MONITORING_EXCLUDED_TAGS.includes(t))) return false;
  return VARIABLE_CATEGORIES.includes(d.category_hint);
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Sat/Sun → the following Monday. */
function toBusinessDay(d: ISODate): ISODate {
  const wd = isoWeekday(d);
  return wd <= 4 ? d : addDays(d, 7 - wd);
}

/** Every `dayOfMonth` in `[start, end]`. `dayOfMonth` must be ≤ 28. */
function monthlyDates(start: ISODate, end: ISODate, dayOfMonth: number): ISODate[] {
  const s = parseISODate(start);
  const out: ISODate[] = [];
  let year = s.getUTCFullYear();
  let month = s.getUTCMonth();
  for (let guard = 0; guard < 64; guard++) {
    const iso = toISODate(new Date(Date.UTC(year, month, dayOfMonth)));
    if (iso > end) break;
    if (iso >= start) out.push(iso);
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The planted shift
// ---------------------------------------------------------------------------

/** 0 before the change, then 1/RAMP … 1 over `DEMO.CHANGE_RAMP_WEEKS`, then flat to the end. */
function rampAt(weekIndex: number, changeStartIndex: number, rampWeeks: number): number {
  if (weekIndex < changeStartIndex) return 0;
  return Math.min(1, (weekIndex - changeStartIndex + 1) / Math.max(1, rampWeeks));
}

/**
 * Weekly multiplicative noise on the variable baseline. One shuffled offset per 4-week
 * block plus jitter — see NOISE_OFFSETS in plan.ts for why the block structure matters.
 */
function weeklyNoise(seed: number, weeks: number): number[] {
  const out: number[] = [];
  const jitter = makeRng(seed, "variable-noise-jitter");
  for (let block = 0; block * NOISE_BLOCK_WEEKS < weeks; block++) {
    const offsets = makeRng(seed, `variable-noise-block-${block}`).shuffled(NOISE_OFFSETS);
    for (let slot = 0; slot < NOISE_BLOCK_WEEKS && out.length < weeks; slot++) {
      out.push(NOISE_AMPLITUDE * offsets[slot]! + jitter.signed(NOISE_JITTER));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export const generateDemoCompany: GenerateDemoCompany = (opts): GeneratedCompany => {
  const { seed, closingBalanceCents, endDate, weeks, profile } = { ...DEFAULT_DEMO_OPTIONS, ...opts };
  const accounts: BankAccount[] = opts.accounts ?? SANDBOX_ACCOUNTS;
  if (weeks < 8) throw new Error(`generateDemoCompany needs at least 8 weeks, got ${weeks}`);

  const weekStarts = weekStartsEndingAt(endDate, weeks);
  const start = historyStartOf(endDate, weeks);
  const lastDay = addDays(weekStarts[weeks - 1]!, 6);
  const changeStart = Math.min(DEMO.CHANGE_START_INDEX, weeks - WEEKS_BEFORE_END.CHANGE_START, weeks - 3);
  /** A planted event's week index, counted back from the end of the span. */
  const weekBeforeEnd = (n: number): number => weeks - 1 - n;
  /**
   * Headcount grows over the year, so payroll steps up with it. PAYROLL is a
   * FIXED category, so this growth never reaches the CUSUM series.
   */
  const payrollFactor = (i: number): number => {
    const step = Math.min(PAYROLL_GROWTH_STEPS.length - 1, Math.floor((i / weeks) * PAYROLL_GROWTH_STEPS.length));
    return PAYROLL_GROWTH_STEPS[step]!;
  };
  /** Revenue compounds up to today's rate. An inflow, so also outside the CUSUM series. */
  const revenueFactor = (i: number): number =>
    weeks <= 1 ? 1 : Math.pow(REVENUE_START_FRACTION, 1 - i / (weeks - 1));
  /** The turn of the year is quiet. A dip can never trip a one-sided upward CUSUM. */
  const holidayFactor = (i: number): number => {
    const monthDay = weekStarts[i]!.slice(5);
    return monthDay >= "12-20" || monthDay <= "01-03" ? 1 - HOLIDAY_DIP_FRACTION : 1;
  };
  const noise = weeklyNoise(seed, weeks);

  const accountId: Record<AccountKey, string> = {
    checking: accounts.find((a) => a.type === "checking")?.id ?? ACCOUNT_IDS.CHECKING,
    savings: accounts.find((a) => a.type === "savings")?.id ?? ACCOUNT_IDS.SAVINGS,
    card: accounts.find((a) => a.type === "card")?.id ?? ACCOUNT_IDS.CARD,
  };

  const drafts: Draft[] = [];
  const push = (d: Draft): Draft => {
    drafts.push(d);
    return d;
  };
  /** Day `offset` (0 = Monday) of week `i`. */
  const day = (i: number, offset: number): ISODate => addDays(weekStarts[i]!, offset);
  const rng = (label: string): Rng => makeRng(seed, label);

  // -- Fixed spend: biweekly payroll -----------------------------------------
  {
    const r = rng("payroll");
    for (let i = 1; i < weeks; i += 2) {
      push({
        key: `payroll-${i}`,
        account: "checking",
        date: day(i, PAYROLL.day_offset),
        amount_cents: -jitterCents(r, Math.round(PAYROLL.amount_cents * payrollFactor(i)), PAYROLL.noise),
        merchant_raw: PAYROLL.merchant_raw,
        merchant_normalized: PAYROLL.merchant_normalized,
        description: PAYROLL.description,
        flow_type: "OPERATING_OUTFLOW",
        category_hint: "PAYROLL",
      });
    }
  }

  // -- Monthly cadences (rent, insurance, SaaS, marketing, legal, fees) ------
  const monthlySpecs: MonthlySpec[] = [...MONTHLY_FIXED, ...MONTHLY_VARIABLE];
  for (const spec of monthlySpecs) {
    const r = rng(`monthly-${spec.merchant_normalized}`);
    const rampFraction = RAMPED_MONTHLY_SHIFT[spec.merchant_normalized] ?? 0;
    const dates = monthlyDates(start, lastDay, spec.day_of_month)
      .map((d) => (spec.business_day ? toBusinessDay(d) : d))
      .filter((d) => d >= start && d <= lastDay);

    dates.forEach((date, occurrence) => {
      const weekIndex = weekIndexOf(date, start);
      const ramped = 1 + rampFraction * rampAt(weekIndex, changeStart, DEMO.CHANGE_RAMP_WEEKS);
      const amount = -jitterCents(r, Math.round(spec.amount_cents * ramped), spec.noise);
      const base: Draft = {
        key: `monthly-${spec.merchant_normalized}-${occurrence}`,
        account: spec.account,
        date,
        amount_cents: amount,
        merchant_raw: spec.merchant_raw,
        merchant_normalized: spec.merchant_normalized,
        description: spec.description,
        flow_type: "OPERATING_OUTFLOW",
        category_hint: spec.category_hint,
      };

      // One occurrence becomes a pending row superseded by a settled row the next day.
      const isPendingPair =
        spec.merchant_normalized === PENDING_PAIR.merchant_normalized &&
        occurrence === Math.min(PENDING_PAIR.occurrence_index, dates.length - 1);
      if (!isPendingPair) {
        push(base);
        return;
      }
      const pendingKey = `${base.key}-pending`;
      push({ ...base, key: pendingKey, status: "pending", description: `${spec.description} (authorization)` });
      push({ ...base, date: addDays(date, 1), pending_of_key: pendingKey });
    });
  }

  // -- Weekly cadences: revenue, contractors --------------------------------
  {
    const r = rng("revenue");
    for (let i = 0; i < weeks; i++) {
      push({
        key: `revenue-${i}`,
        account: "checking",
        date: day(i, REVENUE.day_offset),
        amount_cents: jitterCents(r, Math.round(REVENUE.amount_cents * revenueFactor(i)), REVENUE.noise),
        merchant_raw: REVENUE.merchant_raw,
        merchant_normalized: REVENUE.merchant_normalized,
        description: REVENUE.description,
        flow_type: "OPERATING_INFLOW",
        category_hint: "CUSTOMER_REVENUE",
      });
    }
  }
  {
    const r = rng("upwork");
    for (let i = 0; i < weeks; i++) {
      push({
        key: `upwork-${i}`,
        account: "checking",
        date: day(i, UPWORK.day_offset),
        amount_cents: -jitterCents(r, UPWORK.amount_cents, UPWORK.noise),
        merchant_raw: UPWORK.merchant_raw,
        merchant_normalized: UPWORK.merchant_normalized,
        description: UPWORK.description,
        flow_type: "OPERATING_OUTFLOW",
        category_hint: "CONTRACTORS",
      });
    }
  }
  for (const spec of BIWEEKLY_CONTRACTORS) {
    const r = rng(`contractor-${spec.merchant_normalized}`);
    for (let i = spec.on_odd_weeks ? 1 : 0; i < weeks; i += 2) {
      push({
        key: `contractor-${spec.merchant_normalized}-${i}`,
        account: "checking",
        date: day(i, spec.day_offset),
        amount_cents: -jitterCents(r, spec.amount_cents, spec.noise),
        merchant_raw: spec.merchant_raw,
        merchant_normalized: spec.merchant_normalized,
        description: spec.description,
        flow_type: "OPERATING_OUTFLOW",
        category_hint: "CONTRACTORS",
      });
    }
  }

  // -- Employee card spend (card account) -----------------------------------
  const pushCardSpend = (weekIndex: number, spec: CardSpendSpec, key: string, r: Rng): void => {
    push({
      key,
      account: "card",
      date: day(weekIndex, spec.day_offset),
      amount_cents: -jitterCents(r, spec.amount_cents, spec.noise),
      merchant_raw: spec.merchant_raw,
      merchant_normalized: spec.merchant_normalized,
      description: spec.description,
      flow_type: "OPERATING_OUTFLOW",
      category_hint: spec.category_hint,
    });
  };
  {
    const r = rng("card-meals");
    for (let i = 0; i < weeks; i++) {
      CARD_MEALS.forEach((spec, n) => pushCardSpend(i, spec, `card-meal-${i}-${n}`, r));
    }
    const travel = rng("card-travel");
    const equipment = rng("card-equipment");
    for (let i = 0; i < weeks; i++) {
      const t = CARD_TRAVEL[i % CARD_SPEND_CYCLE_WEEKS];
      if (t) pushCardSpend(i, t, `card-travel-${i}`, travel);
      const e = CARD_EQUIPMENT[i % CARD_SPEND_CYCLE_WEEKS];
      if (e) pushCardSpend(i, e, `card-equipment-${i}`, equipment);
    }
  }

  // -- Unknown real vendor (Ashby): empty description, no rule will match ----
  {
    const r = rng("unknown-vendor");
    for (const n of WEEKS_BEFORE_END.UNKNOWN_VENDOR) {
      const i = weekBeforeEnd(n);
      if (i < 0) continue;
      if (i >= weeks) continue;
      push({
        key: `unknown-vendor-${i}`,
        account: "checking",
        date: day(i, UNKNOWN_VENDOR_DAY_OFFSET),
        amount_cents: -jitterCents(r, UNKNOWN_VENDOR_AMOUNT_CENTS, UNKNOWN_VENDOR_NOISE),
        merchant_raw: DEMO.UNKNOWN_VENDOR.merchant_raw,
        merchant_normalized: DEMO.UNKNOWN_VENDOR.merchant_normalized,
        description: "",
        flow_type: "OPERATING_OUTFLOW",
        category_hint: DEMO.UNKNOWN_VENDOR.expected_category,
      });
    }
  }

  // -- One-shot planted events ---------------------------------------------
  const franchiseWeek = weekBeforeEnd(WEEKS_BEFORE_END.FRANCHISE_TAX);
  if (franchiseWeek >= 0) {
    push({
      key: "franchise-tax",
      account: "checking",
      date: day(franchiseWeek, FRANCHISE_TAX.day_offset),
      amount_cents: -FRANCHISE_TAX.amount_cents,
      merchant_raw: FRANCHISE_TAX.merchant_raw,
      merchant_normalized: FRANCHISE_TAX.merchant_normalized,
      description: FRANCHISE_TAX.description,
      flow_type: "OPERATING_OUTFLOW",
      category_hint: "TAXES_FEES",
    });
  }
  const refundDraft =
    weekBeforeEnd(WEEKS_BEFORE_END.REFUND) >= 0
      ? push({
          key: "refund",
          account: "checking",
          date: day(weekBeforeEnd(WEEKS_BEFORE_END.REFUND), REFUND.day_offset),
          amount_cents: REFUND.amount_cents,
          merchant_raw: REFUND.merchant_raw,
          merchant_normalized: REFUND.merchant_normalized,
          description: REFUND.description,
          flow_type: "REFUND",
          category_hint: REFUND.category_hint,
        })
      : null;

  const transferPairIds: string[] = [];
  for (const [n, t] of TRANSFERS.entries()) {
    if (t.profile === "test" && profile !== "test") continue;
    const transferWeek = weekBeforeEnd(t.profile === "test" ? WEEKS_BEFORE_END.TRANSFER_TEST : WEEKS_BEFORE_END.TRANSFER_DEMO);
    if (transferWeek < 0) continue;
    const pairKey = `xfer_${seed}_${n + 1}`;
    transferPairIds.push(pairKey);
    const date = day(transferWeek, t.day_offset);
    push({
      key: `${pairKey}-out`,
      account: "checking",
      date,
      amount_cents: -t.amount_cents,
      merchant_raw: TRANSFER.merchant_raw_out,
      merchant_normalized: TRANSFER.merchant_normalized,
      description: t.description,
      flow_type: "INTERNAL_TRANSFER",
      category_hint: "INTERNAL_TRANSFER",
      transfer_pair_key: pairKey,
    });
    push({
      key: `${pairKey}-in`,
      account: "savings",
      date,
      amount_cents: t.amount_cents,
      merchant_raw: TRANSFER.merchant_raw_in,
      merchant_normalized: TRANSFER.merchant_normalized,
      description: t.description,
      flow_type: "INTERNAL_TRANSFER",
      category_hint: "INTERNAL_TRANSFER",
      transfer_pair_key: pairKey,
    });
  }

  const financingKeys: string[] = [];
  if (profile === "test" && weekBeforeEnd(WEEKS_BEFORE_END.FINANCING) >= 0) {
    financingKeys.push("financing");
    push({
      key: "financing",
      account: "checking",
      date: day(weekBeforeEnd(WEEKS_BEFORE_END.FINANCING), TEST_FINANCING.day_offset),
      amount_cents: TEST_FINANCING.amount_cents,
      merchant_raw: TEST_FINANCING.merchant_raw,
      merchant_normalized: TEST_FINANCING.merchant_normalized,
      description: TEST_FINANCING.description,
      flow_type: "FINANCING",
      category_hint: "FINANCING",
    });
  }
  if (profile === "test" && weekBeforeEnd(WEEKS_BEFORE_END.ANNUAL_RENEWAL) >= 0) {
    push({
      key: "annual-renewal",
      account: "checking",
      date: day(weekBeforeEnd(WEEKS_BEFORE_END.ANNUAL_RENEWAL), TEST_ANNUAL_RENEWAL.day_offset),
      amount_cents: -TEST_ANNUAL_RENEWAL.amount_cents,
      merchant_raw: TEST_ANNUAL_RENEWAL.merchant_raw,
      merchant_normalized: TEST_ANNUAL_RENEWAL.merchant_normalized,
      description: TEST_ANNUAL_RENEWAL.description,
      flow_type: "OPERATING_OUTFLOW",
      category_hint: "SAAS_SOFTWARE",
      tags: ["annual_renewal"],
    });
  }

  // -- `test` profile: messy statement shapes (contract §4) -----------------
  // Real statements are not tidy. Each of these breaks reconciliation in a
  // different way, and none of them exists in the demo profile.
  if (profile === "test") {
    const m = TEST_MESSY;

    // The double-post and its reversal. Two identical rows on the same day,
    // then a credit that cancels one of them two days later.
    if (m.DOUBLE_POST.week_index < weeks) {
      for (const copy of [0, 1]) {
        push({
          key: `messy-double-post-${copy}`,
          account: "checking",
          date: day(m.DOUBLE_POST.week_index, m.DOUBLE_POST.day_offset),
          amount_cents: -m.DOUBLE_POST.amount_cents,
          merchant_raw: m.DOUBLE_POST.merchant_raw,
          merchant_normalized: m.DOUBLE_POST.merchant_normalized,
          description: m.DOUBLE_POST.description,
          flow_type: "OPERATING_OUTFLOW",
          category_hint: m.DOUBLE_POST.category_hint,
        });
      }
      push({
        key: "messy-reversal",
        account: "checking",
        date: day(m.REVERSAL.week_index, m.REVERSAL.day_offset),
        amount_cents: m.DOUBLE_POST.amount_cents,
        merchant_raw: m.REVERSAL.merchant_raw,
        merchant_normalized: m.REVERSAL.merchant_normalized,
        description: m.REVERSAL.description,
        flow_type: "REFUND",
        category_hint: m.REVERSAL.category_hint,
      });
    }

    // A credit larger than that vendor's charges for the week.
    if (m.OVER_CREDIT.week_index < weeks) {
      push({
        key: "messy-over-credit",
        account: "checking",
        date: day(m.OVER_CREDIT.week_index, m.OVER_CREDIT.day_offset),
        amount_cents: m.OVER_CREDIT.amount_cents,
        merchant_raw: m.OVER_CREDIT.merchant_raw,
        merchant_normalized: m.OVER_CREDIT.merchant_normalized,
        description: m.OVER_CREDIT.description,
        flow_type: "REFUND",
        category_hint: m.OVER_CREDIT.category_hint,
      });
    }

    // A check to a person, and descriptors that identify nothing.
    for (const [key, spec] of [
      ["messy-check", m.CHECK_TO_INDIVIDUAL],
      ["messy-online", m.AMBIGUOUS_ONLINE],
    ] as const) {
      if (spec.week_index >= weeks) continue;
      push({
        key,
        account: "checking",
        date: day(spec.week_index, spec.day_offset),
        amount_cents: -spec.amount_cents,
        merchant_raw: spec.merchant_raw,
        merchant_normalized: spec.merchant_normalized,
        description: spec.description,
        flow_type: "OPERATING_OUTFLOW",
        category_hint: spec.category_hint,
      });
    }
    for (const week of m.AMBIGUOUS_ACH.week_indexes) {
      if (week >= weeks) continue;
      push({
        key: `messy-ach-${week}`,
        account: "checking",
        date: day(week, m.AMBIGUOUS_ACH.day_offset),
        amount_cents: -m.AMBIGUOUS_ACH.amount_cents,
        merchant_raw: m.AMBIGUOUS_ACH.merchant_raw,
        merchant_normalized: m.AMBIGUOUS_ACH.merchant_normalized,
        description: m.AMBIGUOUS_ACH.description,
        flow_type: "OPERATING_OUTFLOW",
        category_hint: m.AMBIGUOUS_ACH.category_hint,
      });
    }

    // An internal transfer whose other leg never arrives.
    if (m.ORPHAN_TRANSFER.week_index < weeks) {
      push({
        key: "messy-orphan-transfer",
        account: "checking",
        date: day(m.ORPHAN_TRANSFER.week_index, m.ORPHAN_TRANSFER.day_offset),
        amount_cents: -m.ORPHAN_TRANSFER.amount_cents,
        merchant_raw: m.ORPHAN_TRANSFER.merchant_raw,
        merchant_normalized: TRANSFER.merchant_normalized,
        description: m.ORPHAN_TRANSFER.description,
        flow_type: "INTERNAL_TRANSFER",
        category_hint: "INTERNAL_TRANSFER",
        transfer_pair_key: TEST_UNPAIRED_TRANSFER_KEY,
      });
    }

    // A pending authorisation in the final week that never settles.
    if (m.UNSETTLED_PENDING.week_index < weeks) {
      push({
        key: "messy-unsettled-pending",
        account: "checking",
        date: day(m.UNSETTLED_PENDING.week_index, m.UNSETTLED_PENDING.day_offset),
        amount_cents: -m.UNSETTLED_PENDING.amount_cents,
        merchant_raw: m.UNSETTLED_PENDING.merchant_raw,
        merchant_normalized: m.UNSETTLED_PENDING.merchant_normalized,
        description: m.UNSETTLED_PENDING.description,
        flow_type: "OPERATING_OUTFLOW",
        category_hint: m.UNSETTLED_PENDING.category_hint,
        status: "pending",
      });
    }
  }

  // -- Planted one-off: derived from the vendor's own prior payments ---------
  const oneOffWeek = Math.max(0, Math.min(weekBeforeEnd(WEEKS_BEFORE_END.ONE_OFF), weeks - 2));
  const oneOffDate = day(oneOffWeek, ONE_OFF.day_offset);
  const priorSameVendor = drafts.filter(
    (d) => d.merchant_normalized === DEMO.ONE_OFF_ENTITY && d.amount_cents < 0 && d.date < oneOffDate,
  );
  const priorMedian = priorSameVendor.length ? Math.round(median(priorSameVendor.map((d) => -d.amount_cents))) : 0;
  // Derived from the vendor's own history so it is guaranteed to clear every shared
  // threshold, then rounded up to whole dollars (invoices do not arrive in odd cents).
  const oneOffAmount =
    Math.ceil(
      Math.max(
        ONE_OFF.median_multiple * priorMedian,
        ONE_OFF_MEDIAN_MULTIPLE * priorMedian + ONE_OFF_MIN_ABS_DIFF_CENTS,
        MATERIALITY.MIN_ONE_OFF_AMOUNT_CENTS,
      ) / 100,
    ) *
      100 +
    100;
  const oneOffDraft = push({
    key: "one-off",
    account: "checking",
    date: oneOffDate,
    amount_cents: -oneOffAmount,
    merchant_raw: ONE_OFF.merchant_raw,
    merchant_normalized: DEMO.ONE_OFF_ENTITY,
    description: ONE_OFF.description,
    flow_type: "OPERATING_OUTFLOW",
    category_hint: "SAAS_SOFTWARE",
    // Untagged on purpose: the one-off detector has to find it. Kept out of the monitored
    // series because the engine tags and excludes it before the CUSUM ever sees it.
    excluded_from_monitored_series: true,
  });

  // -- AWS closes each week onto the designed variable target ---------------
  const supersededKeys = new Set(drafts.filter((d) => d.pending_of_key).map((d) => d.pending_of_key!));
  const monitoredByWeek = new Array<number>(weeks).fill(0);
  for (const d of drafts) {
    if (!isMonitoredVariable(d, supersededKeys)) continue;
    const i = weekIndexOf(d.date, start);
    if (i >= 0 && i < weeks) monitoredByWeek[i] = monitoredByWeek[i]! - d.amount_cents;
  }
  for (let i = 0; i < weeks; i++) {
    // The holiday dip scales the BASELINE only, never the planted delta: a quiet
    // fortnight should not also shrink the shift Canary is meant to find.
    const target = Math.round(
      VARIABLE_WEEKLY_BASE_CENTS * (1 + noise[i]!) * holidayFactor(i) +
        rampAt(i, changeStart, DEMO.CHANGE_RAMP_WEEKS) * PLANTED_DELTA_WEEKLY_CENTS,
    );
    const residual = Math.max(AWS_MIN_WEEKLY_CENTS, target - monitoredByWeek[i]!);
    push({
      key: `aws-${i}`,
      account: "checking",
      date: day(i, AWS.day_offset),
      amount_cents: -residual,
      merchant_raw: AWS.merchant_raw,
      merchant_normalized: AWS.merchant_normalized,
      description: `${AWS.description} — week of ${weekStarts[i]}`,
      flow_type: "OPERATING_OUTFLOW",
      category_hint: "CLOUD_INFRASTRUCTURE",
    });
  }

  // -- Card settlements: biweekly, on the Sunday of odd weeks ---------------
  // The final week always settles, so the card ends fully settled at $0 — which is what
  // SANDBOX_ACCOUNTS reports for the corporate card at `as_of`.
  const settlementKeys: string[] = [];
  let firstUnsettledWeek = 0;
  for (let i = 1; i < weeks; i++) {
    if (i % 2 === 0 && i !== weeks - 1) continue;
    const from = firstUnsettledWeek;
    firstUnsettledWeek = i + 1;
    const covered = drafts.filter((d) => {
      if (d.account !== "card" || d.flow_type !== "OPERATING_OUTFLOW") return false;
      const w = weekIndexOf(d.date, start);
      return w >= from && w <= i;
    });
    if (covered.length === 0) continue;
    const total = covered.reduce((s, d) => s - d.amount_cents, 0);
    const settlementKey = `card-settlement-${i}`;
    settlementKeys.push(settlementKey);
    for (const d of covered) d.settlement_key = settlementKey;
    const date = day(i, CARD_SETTLEMENT.day_offset);
    push({
      key: settlementKey,
      account: "checking",
      date,
      amount_cents: -total,
      merchant_raw: CARD_SETTLEMENT.merchant_raw_checking,
      merchant_normalized: CARD_SETTLEMENT.merchant_normalized,
      description: CARD_SETTLEMENT.description,
      flow_type: "CARD_SETTLEMENT",
      category_hint: "CARD_SETTLEMENT",
      settlement_key: settlementKey,
    });
    push({
      key: `${settlementKey}-card-leg`,
      account: "card",
      date,
      amount_cents: total,
      merchant_raw: CARD_SETTLEMENT.merchant_raw_card,
      merchant_normalized: CARD_SETTLEMENT.merchant_normalized,
      description: CARD_SETTLEMENT.description,
      flow_type: "CARD_SETTLEMENT",
      category_hint: "CARD_SETTLEMENT",
      settlement_key: settlementKey,
    });
  }

  // -- Freeze order, mint ids, resolve cross-references ---------------------
  drafts.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const idByKey = new Map<string, string>();
  drafts.forEach((d, n) => idByKey.set(d.key, `txn_${seed}_${String(n + 1).padStart(4, "0")}`));
  const idOf = (key: string): string => {
    const id = idByKey.get(key);
    if (!id) throw new Error(`generator produced a dangling reference: ${key}`);
    return id;
  };

  const transactions: Transaction[] = drafts.map((d) => {
    const tx: Transaction = {
      id: idOf(d.key),
      account_id: accountId[d.account],
      date: d.date,
      amount_cents: d.amount_cents,
      currency: "USD",
      merchant_raw: d.merchant_raw,
      merchant_normalized: d.merchant_normalized,
      description: d.description,
      flow_type: d.flow_type,
      status: d.status ?? "settled",
      source: "synthetic",
      tags: d.tags ?? [],
      category_hint: d.category_hint,
    };
    if (d.transfer_pair_key) tx.transfer_pair_id = d.transfer_pair_key;
    if (d.settlement_key) tx.settlement_pair_id = idOf(d.settlement_key);
    if (d.pending_of_key) tx.pending_of = idOf(d.pending_of_key);
    return tx;
  });

  // -- Backward anchoring onto the sandbox bank closing balance -------------
  const cashAccountIds = new Set(accounts.filter((a) => a.type !== "card").map((a) => a.id));
  const supersededIds = new Set(transactions.filter((t) => t.pending_of).map((t) => t.pending_of!));
  const netCashMovement = transactions
    .filter((t) => cashAccountIds.has(t.account_id) && !supersededIds.has(t.id))
    .reduce((s, t) => s + t.amount_cents, 0);
  const openingBalanceCents = closingBalanceCents - netCashMovement;

  // -- Fixture metadata -----------------------------------------------------
  const unknownVendorTxns = transactions.filter(
    (t) => t.merchant_normalized === DEMO.UNKNOWN_VENDOR.merchant_normalized,
  );
  const fixture: FixtureMetadata = {
    seed,
    profile,
    weeks,
    start_date: start,
    end_date: endDate,
    closing_balance_cents: closingBalanceCents,
    opening_balance_cents: openingBalanceCents,
    burn_shift: {
      true_change_start_index: changeStart,
      true_change_start_week: weekStarts[changeStart]!,
      expected_driver_entities: [DEMO.PRIMARY_DRIVER_ENTITY, ...DEMO.SECONDARY_DRIVER_ENTITIES],
      expected_direction: "upward",
      planted_delta_weekly_cents: PLANTED_DELTA_WEEKLY_CENTS,
    },
    one_off: {
      transaction_id: idOf(oneOffDraft.key),
      entity: DEMO.ONE_OFF_ENTITY,
      amount_cents: oneOffAmount,
      prior_payment_count: priorSameVendor.length,
      prior_median_cents: priorMedian,
    },
    unknown_vendor: {
      transaction_ids: unknownVendorTxns.map((t) => t.id),
      merchant_raw: DEMO.UNKNOWN_VENDOR.merchant_raw,
      merchant_normalized: DEMO.UNKNOWN_VENDOR.merchant_normalized,
      expected_category: DEMO.UNKNOWN_VENDOR.expected_category,
    },
    internal_transfer_pair_ids: transferPairIds,
    card_settlement_ids: settlementKeys.map((k) => idOf(k)),
    pending_settled_pairs: transactions
      .filter((t) => t.pending_of)
      .map((t) => ({ pending_id: t.pending_of!, settled_id: t.id })),
    financing_transaction_ids: financingKeys.map((k) => idOf(k)),
    refund_transaction_ids: refundDraft ? [idOf(refundDraft.key)] : [],
    needs_review_candidate_ids: transactions
      .filter((t) => NEEDS_REVIEW_ENTITIES.includes(t.merchant_normalized))
      .map((t) => t.id),
  };

  return {
    company: { ...COMPANY, as_of: endDate, accounts },
    accounts,
    transactions,
    fixture,
  };
};

/**
 * Generator self-verification (docs/BUILD.md "Generator assertions", PRD §7).
 * Returns a list of problems; empty means the fixture is internally consistent.
 * Cheap enough to call from the pipeline before serving a demo.
 */
export function assertFixtureInvariants(gen: GeneratedCompany): string[] {
  const problems: string[] = [];
  const { transactions, fixture, accounts } = gen;
  const cashIds = new Set(accounts.filter((a) => a.type !== "card").map((a) => a.id));
  const cardIds = new Set(accounts.filter((a) => a.type === "card").map((a) => a.id));
  const superseded = new Set(transactions.filter((t) => t.pending_of).map((t) => t.pending_of!));

  const net = transactions
    .filter((t) => cashIds.has(t.account_id) && !superseded.has(t.id))
    .reduce((s, t) => s + t.amount_cents, 0);
  if (fixture.opening_balance_cents + net !== fixture.closing_balance_cents) {
    problems.push(
      `closing balance identity broken: ${fixture.opening_balance_cents} + ${net} !== ${fixture.closing_balance_cents}`,
    );
  }

  if (new Set(transactions.map((t) => t.id)).size !== transactions.length) problems.push("duplicate transaction ids");
  if (transactions.some((t) => !Number.isInteger(t.amount_cents))) problems.push("non-integer cents");
  if (transactions.some((t) => t.amount_cents === 0)) problems.push("zero-amount transaction");
  if (transactions.some((t) => !t.category_hint)) problems.push("transaction without category_hint");
  const outOfSpan = transactions.filter((t) => t.date < fixture.start_date || t.date > fixture.end_date);
  if (outOfSpan.length) problems.push(`${outOfSpan.length} transactions outside the history span`);

  const cardBalance = transactions
    .filter((t) => cardIds.has(t.account_id) && !superseded.has(t.id))
    .reduce((s, t) => s + t.amount_cents, 0);
  if (cardBalance !== 0) problems.push(`card account is not fully settled: ${cardBalance}`);

  const byPair = new Map<string, number>();
  for (const t of transactions.filter((t) => t.transfer_pair_id)) {
    byPair.set(t.transfer_pair_id!, (byPair.get(t.transfer_pair_id!) ?? 0) + t.amount_cents);
  }
  for (const [pair, sum] of byPair) {
    // The test profile plants one deliberately unpaired leg; an orphan is the
    // fixture, not a defect in the fixture.
    if (pair === TEST_UNPAIRED_TRANSFER_KEY) continue;
    if (sum !== 0) problems.push(`transfer pair ${pair} nets ${sum}, expected 0`);
  }

  for (const id of fixture.card_settlement_ids) {
    const legs = transactions.filter((t) => t.settlement_pair_id === id && t.flow_type === "CARD_SETTLEMENT");
    const purchases = transactions.filter((t) => t.settlement_pair_id === id && t.flow_type !== "CARD_SETTLEMENT");
    if (legs.length !== 2) problems.push(`settlement ${id} has ${legs.length} legs, expected 2`);
    const checkingLeg = legs.find((t) => cashIds.has(t.account_id));
    const covered = purchases.reduce((s, t) => s - t.amount_cents, 0);
    if (!checkingLeg) problems.push(`settlement ${id} has no cash leg`);
    else if (Math.abs(checkingLeg.amount_cents) !== covered) {
      problems.push(`settlement ${id} covers ${covered} but settles ${Math.abs(checkingLeg.amount_cents)}`);
    }
  }
  const uncovered = transactions.filter(
    (t) => cardIds.has(t.account_id) && t.flow_type === "OPERATING_OUTFLOW" && !t.settlement_pair_id,
  );
  if (uncovered.length) problems.push(`${uncovered.length} card purchases have no settlement`);

  const oneOff = transactions.find((t) => t.id === fixture.one_off.transaction_id);
  if (!oneOff) problems.push("planted one-off transaction id not present");
  else if (oneOff.tags.includes("one_off")) problems.push("planted one-off must not be pre-tagged");
  if (fixture.one_off.prior_payment_count < 3) {
    problems.push(`planted one-off has only ${fixture.one_off.prior_payment_count} prior vendor payments`);
  }

  return problems;
}

/** Convenience for the pipeline/demo: the calibrated demo fixture. */
export function generateDemoFixture(overrides: Partial<GenerateDemoCompanyOptions> = {}): GeneratedCompany {
  return generateDemoCompany({ ...DEFAULT_DEMO_OPTIONS, ...overrides });
}

/** First Monday of the history span implied by an end date and week count. */
export function historySpan(endDate: ISODate, weeks: number): { start: ISODate; end: ISODate } {
  return { start: historyStartOf(endDate, weeks), end: addDays(weekStart(endDate), 6) };
}
