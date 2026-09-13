/**
 * Pre-rendered speech strings for ElevenLabs and iMessage.
 *
 * Every figure comes from engine/detector output and is verbalized with the
 * shared `speak*` helpers. No LLM writes these; no number is hard-coded.
 */
import { whatIfNoChangeReason } from "@canary/engine";
import {
  FIXED_CATEGORIES,
  speakMonths,
  speakPercentage,
  speakUsd,
  type Category,
  type DerivedDemoObject,
  type HealthSummaryResponse,
  type Incident,
  type ToolGetIncidentResponse,
  type WhatIfResult,
} from "@canary/shared";
import { driverEntity, positiveContributors, variableSpendRates } from "./derive.ts";
import { displayName, formatDateShort } from "./format.ts";

/**
 * Why a scenario moved nothing, in the words a founder needs. The engine can
 * only see the monitored variable spend, so it reports `NOT_MONITORED` for a
 * fixed-category vendor and for a name it has never seen alike. Here the full
 * derived object is available, so the two can finally be told apart — which
 * matters, because one means "that's payroll" and the other means "check the
 * spelling". docs/AGENT_BEHAVIOR.md §5 requires the distinction.
 */
export function noChangeExplanation(derived: DerivedDemoObject, entity: string, percentage: number): string | null {
  const reason = whatIfNoChangeReason(derived.burn, entity, percentage);
  if (reason === null) return null;
  const name = displayName(entity);

  if (reason === "ZERO_PERCENTAGE") return `a zero percent change to ${name} leaves everything where it is`;
  if (reason === "NO_SPEND_TO_CHANGE") return `${name} has no net spend left to change in the current burn window — its credits cancel its charges`;

  const known = Object.values(derived.classifications).find((c) => c.merchant_normalized === entity);
  if (!known) return `I have no spending on record for ${name}, so there is nothing to model`;
  if (FIXED_CATEGORIES.includes(known.category)) {
    return `${name} is ${categoryPhrase(known.category)}, which Canary treats as fixed rather than variable spend, so this scenario does not move modeled burn`;
  }
  return `${name} has no spend inside the current burn window, so this scenario does not move modeled burn`;
}

function categoryPhrase(category: Category): string {
  return category.toLowerCase().replace(/_/g, " ");
}

export function whatIfSpeech(
  result: WhatIfResult,
  noChangeReason: string | null | undefined = result.no_change_reason,
): WhatIfResult["speech"] {
  const entity = displayName(result.entity);
  const delta = result.delta_monthly_cents;
  const deltaMonthly =
    delta === 0
      ? "no change to monthly burn"
      : `${speakUsd(Math.abs(delta))} ${delta < 0 ? "lower" : "higher"} per month`;
  const scenarioRunway = speakMonths(result.scenario_runway_months);

  const burnClause =
    delta === 0 ? "monthly burn would not change" : `monthly burn would ${delta < 0 ? "fall" : "rise"} by ${speakUsd(Math.abs(delta))}`;

  let runwayClause: string;
  const before = result.current_runway_months;
  const after = result.scenario_runway_months;
  if (after === null) {
    runwayClause = "the company would no longer be burning cash";
  } else if (before === null || before === after) {
    runwayClause = `runway would stay at ${scenarioRunway}`;
  } else {
    runwayClause = `runway would ${after > before ? "extend" : "shorten"} to ${scenarioRunway}`;
  }

  return {
    delta_monthly: deltaMonthly,
    scenario_runway: scenarioRunway,
    // The reason is its own sentence, after the numbers and before the label:
    // spoken aloud, a reason spliced into the middle is impossible to follow.
    summary: `If ${entity} were ${speakPercentage(result.percentage)}, ${burnClause} and ${runwayClause}.${
      noChangeReason ? ` ${capitalize(noChangeReason)}.` : ""
    } ${result.label}`,
  };
}

export function healthSummarySpeech(derived: DerivedDemoObject, primary: Incident | null): HealthSummaryResponse["speech"] {
  const cash = speakUsd(derived.cash_cents);
  const monthly = derived.burn.monthly_net_burn_cents;
  const burnMonthly = monthly > 0 ? speakUsd(monthly) : "not currently burning cash";
  const runway = speakMonths(derived.burn.runway_months);

  const burnClause = monthly > 0 ? `is burning ${burnMonthly} a month, leaving ${runway} of runway` : "is not currently burning cash";
  const incidentClause = primary
    ? `, with ${displayName(driverEntity(primary))} as the largest recent change`
    : ", and nothing is currently flagged";

  return {
    cash,
    burn_monthly: burnMonthly,
    runway,
    headline: `${derived.company.name} has ${cash} in the bank and ${burnClause}${incidentClause}.`,
  };
}

export function incidentSpeech(derived: DerivedDemoObject, incident: Incident): ToolGetIncidentResponse["speech"] {
  const driver = displayName(driverEntity(incident));
  const impact = incident.financial_impact;

  const summary =
    incident.type === "ONE_OFF_VENDOR_PAYMENT"
      ? `Canary flagged an unusually large payment to ${displayName(incident.entity)}${
          impact.one_off_amount_cents ? ` of ${speakUsd(impact.one_off_amount_cents)}` : ""
        }, well above that vendor's usual amount.`
      : `Canary flagged a sustained increase in variable spending${
          incident.estimated_change_point ? ` starting the week of ${formatDateShort(incident.estimated_change_point)}` : ""
        }. ${driver} is the largest contributor.`;

  const top = positiveContributors(incident, 2);
  const drivers =
    top.length === 0
      ? "This signal is a single vendor payment, so there is no driver breakdown."
      : top.length === 1
        ? `${displayName(top[0]!.entity)} is up ${speakUsd(top[0]!.delta_weekly_cents)} a week.`
        : `${displayName(top[0]!.entity)} is up ${speakUsd(top[0]!.delta_weekly_cents)} a week, followed by ${displayName(
            top[1]!.entity,
          )} at ${speakUsd(top[1]!.delta_weekly_cents)} a week.`;

  const rates = variableSpendRates(derived, incident);
  const parts: string[] = [];
  if (impact.delta_monthly_cents !== null && impact.delta_monthly_cents !== 0) {
    parts.push(`monthly burn is up ${speakUsd(Math.abs(impact.delta_monthly_cents))}`);
  } else if (impact.one_off_amount_cents) {
    parts.push(`the payment was ${speakUsd(impact.one_off_amount_cents)}`);
  } else if (rates) {
    parts.push(`weekly variable spend moved by ${speakUsd(Math.abs(rates.delta_weekly_cents))}`);
  }
  if (impact.runway_before_months !== null && impact.runway_after_months !== null) {
    parts.push(`runway moves from ${speakMonths(impact.runway_before_months)} to ${speakMonths(impact.runway_after_months)}`);
  } else {
    parts.push(`current runway is ${speakMonths(derived.burn.runway_months)}`);
  }

  return { summary, drivers, impact: `${capitalize(parts.join(", and "))}.` };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
