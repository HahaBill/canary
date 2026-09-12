/**
 * Pre-rendered speech strings for ElevenLabs and iMessage.
 *
 * Every figure comes from engine/detector output and is verbalized with the
 * shared `speak*` helpers. No LLM writes these; no number is hard-coded.
 */
import {
  speakMonths,
  speakPercentage,
  speakUsd,
  type DerivedDemoObject,
  type HealthSummaryResponse,
  type Incident,
  type ToolGetIncidentResponse,
  type WhatIfResult,
} from "@canary/shared";
import { driverEntity, positiveContributors, variableSpendRates } from "./derive.ts";
import { displayName, formatDateShort } from "./format.ts";

export function whatIfSpeech(result: WhatIfResult): WhatIfResult["speech"] {
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
    summary: `If ${entity} were ${speakPercentage(result.percentage)}, ${burnClause} and ${runwayClause}. ${result.label}`,
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
