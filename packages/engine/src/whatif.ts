/**
 * What-if simulator (PRD §25, BUILD Phase 8).
 *
 * Pure arithmetic over a `BurnSummary`. The only number read from the request
 * is `percentage`; everything else is derived from the engine. Speech strings
 * come from shared money helpers — never from an LLM.
 */
import {
  SCENARIO_LABEL,
  runwayMonths,
  speakMonths,
  speakPercentage,
  speakUsd,
  weeklyToAnnual,
  weeklyToMonthly,
  type BurnSummary,
  type SimulateCostChange,
  type WhatIfResult,
} from "@canary/shared";

function roundMonths(months: number): number {
  return Math.round(months * 10) / 10;
}

function runwayClause(current: number | null, scenario: number | null): string {
  if (scenario === null) return "the company would no longer be burning cash";
  const spoken = speakMonths(scenario);
  if (current === null) return `runway would be ${spoken}`;
  if (scenario > current) return `runway would extend to ${spoken}`;
  if (scenario < current) return `runway would shorten to ${spoken}`;
  return `runway would stay at ${spoken}`;
}

export const simulateCostChange: SimulateCostChange = (
  burn: BurnSummary,
  req,
): WhatIfResult => {
  const { entity, percentage } = req;
  // Unknown entity → zero current spend, so the scenario changes nothing.
  const currentWeekly = burn.weekly_variable_by_entity[entity] ?? 0;
  const hypotheticalWeekly = Math.round(currentWeekly * (1 + percentage / 100));
  const deltaWeekly = hypotheticalWeekly - currentWeekly;
  const deltaMonthly = weeklyToMonthly(deltaWeekly);

  const currentBurnMonthly = burn.monthly_net_burn_cents;
  const scenarioBurnMonthly = currentBurnMonthly + deltaMonthly;
  const currentRunway = burn.runway_months;
  const scenarioRunway = runwayMonths(burn.available_operating_cash_cents, scenarioBurnMonthly);
  const runwayDelta =
    currentRunway !== null && scenarioRunway !== null
      ? roundMonths(scenarioRunway - currentRunway)
      : null;

  const deltaSpeech = speakUsd(Math.abs(deltaMonthly));
  const burnClause =
    deltaMonthly === 0
      ? "monthly burn would not change"
      : `monthly burn would ${deltaMonthly < 0 ? "fall" : "rise"} by ${deltaSpeech}`;

  return {
    label: SCENARIO_LABEL,
    entity,
    percentage,
    current_weekly_cents: currentWeekly,
    current_monthly_cents: weeklyToMonthly(currentWeekly),
    hypothetical_weekly_cents: hypotheticalWeekly,
    hypothetical_monthly_cents: weeklyToMonthly(hypotheticalWeekly),
    delta_monthly_cents: deltaMonthly,
    delta_annualized_cents: weeklyToAnnual(deltaWeekly),
    current_burn_monthly_cents: currentBurnMonthly,
    scenario_burn_monthly_cents: scenarioBurnMonthly,
    current_runway_months: currentRunway,
    scenario_runway_months: scenarioRunway,
    runway_delta_months: runwayDelta,
    speech: {
      delta_monthly: deltaSpeech,
      scenario_runway: speakMonths(scenarioRunway),
      summary: `If ${entity} were ${speakPercentage(percentage)}, ${burnClause} and ${runwayClause(currentRunway, scenarioRunway)}.`,
    },
  };
};
