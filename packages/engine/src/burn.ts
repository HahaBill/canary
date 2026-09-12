/**
 * Normalized burn + runway over a representative window (PRD §14, §19,
 * contract §7). The window is not "trailing 8 weeks forever": once a regime
 * change is confirmed and the post-change segment is long enough, that segment
 * is the representative window.
 */
import {
  MIN_POST_CHANGE_WEEKS,
  TRAILING_WINDOW_WEEKS,
  runwayMonths,
  weeklyToMonthly,
  type BankAccount,
  type BurnSummary,
  type BurnWindowReason,
  type Cents,
  type ComputeBurn,
  type Ledger,
  type WeeklyBucket,
} from "@canary/shared";

/** Checking + savings. Card liability is excluded from operating cash. */
export function availableOperatingCashCents(accounts: BankAccount[]): Cents {
  return accounts.filter((a) => a.type !== "card").reduce((s, a) => s + a.balance_cents, 0);
}

function meanCents(values: Cents[]): Cents {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((s, v) => s + v, 0) / values.length);
}

export const computeBurn: ComputeBurn = (ledger: Ledger, opts): BurnSummary => {
  const trailingWeeks = opts.trailingWindowWeeks ?? TRAILING_WINDOW_WEEKS;
  const minPostChangeWeeks = opts.minPostChangeWeeks ?? MIN_POST_CHANGE_WEEKS;
  const weeks = ledger.weeks;
  const cash = availableOperatingCashCents(ledger.accounts);

  if (weeks.length === 0) return emptySummary(ledger, cash);

  const trailingCount = Math.max(1, Math.min(trailingWeeks, weeks.length));
  const trailing = weeks.slice(weeks.length - trailingCount);

  let window: WeeklyBucket[] = trailing;
  let reason: BurnWindowReason = "TRAILING_DEFAULT";
  const regimeStart = opts.regimeStartWeekIndex;
  if (regimeStart !== null && regimeStart !== undefined) {
    const clamped = Math.max(0, Math.min(regimeStart, weeks.length));
    const postChange = weeks.slice(clamped);
    if (postChange.length >= minPostChangeWeeks) {
      window = postChange;
      reason = "POST_CHANGE_SEGMENT";
    } else {
      reason = "POST_CHANGE_INSUFFICIENT_FALLBACK_TRAILING";
    }
  }

  const weeklyGross = meanCents(window.map((w) => w.total_operating_outflow_cents));
  const weeklyInflow = meanCents(window.map((w) => w.operating_inflow_cents));
  // Derived from the two rounded averages so gross − inflow = net holds for
  // every figure the UI shows side by side.
  const weeklyNet = weeklyGross - weeklyInflow;
  const monthlyNet = weeklyToMonthly(weeklyNet);

  const entities = [...new Set(window.flatMap((w) => Object.keys(w.variable_by_entity)))].sort();
  const weeklyByEntity: Record<string, Cents> = {};
  for (const entity of entities) {
    weeklyByEntity[entity] = meanCents(window.map((w) => w.variable_by_entity[entity] ?? 0));
  }

  return {
    burn_window_start: window[0]!.week_start,
    burn_window_end: window[window.length - 1]!.week_end,
    burn_window_reason: reason,
    weeks_in_window: window.length,
    weekly_gross_burn_cents: weeklyGross,
    weekly_operating_inflow_cents: weeklyInflow,
    weekly_net_burn_cents: weeklyNet,
    weekly_variable_spend_cents: meanCents(window.map((w) => w.variable_spend_cents)),
    weekly_fixed_spend_cents: meanCents(window.map((w) => w.fixed_spend_cents)),
    monthly_gross_burn_cents: weeklyToMonthly(weeklyGross),
    monthly_net_burn_cents: monthlyNet,
    available_operating_cash_cents: cash,
    runway_months: runwayMonths(cash, monthlyNet),
    weekly_variable_by_entity: weeklyByEntity,
  };
};

function emptySummary(ledger: Ledger, cash: Cents): BurnSummary {
  return {
    burn_window_start: ledger.history_start,
    burn_window_end: ledger.history_end,
    burn_window_reason: "TRAILING_DEFAULT",
    weeks_in_window: 0,
    weekly_gross_burn_cents: 0,
    weekly_operating_inflow_cents: 0,
    weekly_net_burn_cents: 0,
    weekly_variable_spend_cents: 0,
    weekly_fixed_spend_cents: 0,
    monthly_gross_burn_cents: 0,
    monthly_net_burn_cents: 0,
    available_operating_cash_cents: cash,
    runway_months: runwayMonths(cash, 0),
    weekly_variable_by_entity: {},
  };
}
