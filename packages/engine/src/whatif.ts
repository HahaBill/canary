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

/**
 * Why a scenario changed nothing. "No change" on its own reads as a broken
 * simulator; the founder needs to know whether they typo'd a vendor name, asked
 * about payroll (which Canary does not model as variable), or asked for 0%.
 *
 * Only what `BurnSummary` can honestly support is decided here. It carries just
 * the monitored variable spend per entity, so it cannot tell a fixed-category
 * vendor apart from one that was never seen — both are simply absent. Callers
 * with the full derived object (see `apps/api/src/speech.ts`) refine
 * `NOT_MONITORED` into the specific case.
 */
export type WhatIfNoChangeReason =
  /** The request itself asked for no change. */
  | "ZERO_PERCENTAGE"
  /** The entity has no monitored variable spend: fixed category, excluded, or never seen. */
  | "NOT_MONITORED"
  /** Seen, but its net spend over the window is zero or negative (credits outweigh charges). */
  | "NO_SPEND_TO_CHANGE";

export function whatIfNoChangeReason(burn: BurnSummary, entity: string, percentage: number): WhatIfNoChangeReason | null {
  const current = burn.weekly_variable_by_entity[entity];
  if (current === undefined) return "NOT_MONITORED";
  if (current <= 0) return "NO_SPEND_TO_CHANGE";
  if (percentage === 0) return "ZERO_PERCENTAGE";
  return null;
}

function sentenceCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The engine-level sentence. Never a number that was not computed. */
export function noChangeClause(reason: WhatIfNoChangeReason, entity: string): string {
  switch (reason) {
    case "ZERO_PERCENTAGE":
      return `a zero percent change to ${entity} leaves everything where it is`;
    case "NOT_MONITORED":
      return `${entity} is not part of the variable spend Canary monitors, so changing it does not move modeled burn`;
    case "NO_SPEND_TO_CHANGE":
      return `${entity} has no net spend left to change over the current burn window`;
  }
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
  const noChange = whatIfNoChangeReason(burn, entity, percentage);
  // Scaling a NEGATIVE current spend inverts the request: "20% lower" on a
  // vendor whose credits outweigh its charges would move the figure toward zero
  // and report burn RISING. A credit balance has nothing to cut, so the honest
  // scenario is no change at all, with a reason attached.
  const hypotheticalWeekly = currentWeekly <= 0 ? currentWeekly : Math.round(currentWeekly * (1 + percentage / 100));
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
    deltaMonthly === 0 ? "monthly burn would not change" : `monthly burn would ${deltaMonthly < 0 ? "fall" : "rise"} by ${deltaSpeech}`;
  // The reason is its own sentence. Threading it through the middle of the
  // clause produces a run-on nobody can follow, least of all spoken aloud.
  const why = noChange ? ` ${sentenceCase(noChangeClause(noChange, entity))}.` : "";

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
      summary: `If ${entity} were ${speakPercentage(percentage)}, ${burnClause} and ${runwayClause(currentRunway, scenarioRunway)}.${why}`,
    },
  };
};
