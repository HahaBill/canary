/**
 * Materiality (PRD §18, contract §12). Every threshold comes from
 * `MATERIALITY` in `@canary/shared`; an LLM never decides any of this.
 *
 * `values` records the numbers each rule was evaluated against so the UI can
 * show "why flagged" without recomputing anything. It is `Record<string, number>`,
 * so keys whose value is unknown (null runway) are omitted rather than zeroed.
 */
import {
  MATERIALITY,
  ONE_OFF_MEDIAN_MULTIPLE,
  ONE_OFF_MIN_ABS_DIFF_CENTS,
  SEVERITY_THRESHOLDS,
  weeklyToMonthly,
  type BurnSummary,
  type Cents,
  type MaterialityVerdict,
  type Severity,
} from "@canary/shared";

/** Rule names are the config keys they read, so a triggered rule is traceable. */
export const RATE_MATERIALITY_RULES = {
  MIN_MONTHLY_DELTA_CENTS: "MIN_MONTHLY_DELTA_CENTS",
  MIN_BURN_PERCENT: "MIN_BURN_PERCENT",
  MIN_RUNWAY_IMPACT_MONTHS: "MIN_RUNWAY_IMPACT_MONTHS",
} as const;

export const ONE_OFF_MATERIALITY_RULES = {
  MIN_ONE_OFF_AMOUNT_CENTS: "MIN_ONE_OFF_AMOUNT_CENTS",
  MIN_ONE_OFF_BURN_PERCENT: "MIN_ONE_OFF_BURN_PERCENT",
} as const;

/**
 * A sustained rate change is material if ANY of the three rules fires:
 * absolute monthly delta, share of monthly gross burn before the change, or
 * runway impact. `deltaWeekly` may be null (CUSUM could not quantify a delta),
 * in which case only the runway rule can fire.
 */
export function evaluateRateMateriality(
  deltaWeekly: Cents | null,
  burnBefore: BurnSummary,
  burnAfter: BurnSummary,
): MaterialityVerdict {
  const rules: string[] = [];
  const values: Record<string, number> = {};

  if (deltaWeekly !== null) {
    const monthlyDelta = weeklyToMonthly(deltaWeekly);
    values.delta_weekly_cents = deltaWeekly;
    values.monthly_delta_cents = monthlyDelta;
    values.min_monthly_delta_cents = MATERIALITY.MIN_MONTHLY_DELTA_CENTS;
    if (monthlyDelta >= MATERIALITY.MIN_MONTHLY_DELTA_CENTS) rules.push(RATE_MATERIALITY_RULES.MIN_MONTHLY_DELTA_CENTS);

    // Share-of-burn is undefined against a zero burn baseline; skip the rule
    // rather than treat every delta as infinitely large.
    if (burnBefore.monthly_gross_burn_cents > 0) {
      const threshold = Math.round(MATERIALITY.MIN_BURN_PERCENT * burnBefore.monthly_gross_burn_cents);
      values.monthly_gross_burn_before_cents = burnBefore.monthly_gross_burn_cents;
      values.burn_percent_threshold_cents = threshold;
      values.share_of_monthly_gross_burn = monthlyDelta / burnBefore.monthly_gross_burn_cents;
      if (monthlyDelta >= threshold) rules.push(RATE_MATERIALITY_RULES.MIN_BURN_PERCENT);
    }
  }

  const runwayImpact = runwayImpactMonths(burnBefore.runway_months, burnAfter.runway_months);
  if (burnBefore.runway_months !== null) values.runway_before_months = burnBefore.runway_months;
  if (burnAfter.runway_months !== null) values.runway_after_months = burnAfter.runway_months;
  if (runwayImpact !== null) {
    values.runway_impact_months = runwayImpact;
    values.min_runway_impact_months = MATERIALITY.MIN_RUNWAY_IMPACT_MONTHS;
    if (runwayImpact >= MATERIALITY.MIN_RUNWAY_IMPACT_MONTHS) rules.push(RATE_MATERIALITY_RULES.MIN_RUNWAY_IMPACT_MONTHS);
  }

  return { material: rules.length > 0, rules_triggered: rules, values };
}

/**
 * One-offs have no monthly delta, so they get their own rule: absolute amount
 * OR share of normalized monthly gross burn.
 */
export function evaluateOneOffMateriality(amount: Cents, burn: BurnSummary): MaterialityVerdict {
  const magnitude = Math.abs(amount);
  const rules: string[] = [];
  const values: Record<string, number> = {
    amount_cents: magnitude,
    min_one_off_amount_cents: MATERIALITY.MIN_ONE_OFF_AMOUNT_CENTS,
  };

  if (magnitude >= MATERIALITY.MIN_ONE_OFF_AMOUNT_CENTS) rules.push(ONE_OFF_MATERIALITY_RULES.MIN_ONE_OFF_AMOUNT_CENTS);

  if (burn.monthly_gross_burn_cents > 0) {
    const threshold = Math.round(MATERIALITY.MIN_ONE_OFF_BURN_PERCENT * burn.monthly_gross_burn_cents);
    values.monthly_gross_burn_cents = burn.monthly_gross_burn_cents;
    values.burn_percent_threshold_cents = threshold;
    values.share_of_monthly_gross_burn = magnitude / burn.monthly_gross_burn_cents;
    if (magnitude >= threshold) rules.push(ONE_OFF_MATERIALITY_RULES.MIN_ONE_OFF_BURN_PERCENT);
  }

  return { material: rules.length > 0, rules_triggered: rules, values };
}

/**
 * `runway_before - runway_after`, rounded to the one decimal `runwayMonths`
 * already reports so the comparison against the threshold is not decided by
 * float noise. Null when either side is not burning.
 */
export function runwayImpactMonths(before: number | null, after: number | null): number | null {
  if (before === null || after === null) return null;
  return Math.round((before - after) * 10) / 10;
}

/** Severity comes from runway impact only (config §SEVERITY_THRESHOLDS). */
export function severityFromRunwayImpact(impactMonths: number | null): Severity {
  if (impactMonths === null) return "LOW";
  if (impactMonths >= SEVERITY_THRESHOLDS.HIGH_RUNWAY_IMPACT_MONTHS) return "HIGH";
  if (impactMonths >= SEVERITY_THRESHOLDS.MEDIUM_RUNWAY_IMPACT_MONTHS) return "MEDIUM";
  return "LOW";
}

/** Exposed for evidence text so the rule is described from config, not prose. */
export const ONE_OFF_RULE_PARAMETERS = {
  median_multiple: ONE_OFF_MEDIAN_MULTIPLE,
  min_abs_diff_cents: ONE_OFF_MIN_ABS_DIFF_CENTS,
} as const;
