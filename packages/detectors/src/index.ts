/**
 * @canary/detectors — one-off anomalies, burn-rate change detection,
 * contributor decomposition, materiality and incident assembly.
 *
 * Pipeline order (the engine and the detectors are mutually recursive by
 * design, so this order matters):
 *
 *   1. `detectOneOffs(ledger, burn)` on a first-pass ledger. Feed the ids of
 *      anomalous results back into `buildLedger({ oneOffTransactionIds })` so
 *      those amounts move from `variable_spend_cents` into
 *      `excluded_from_monitoring_cents` — still in burn, out of the monitored
 *      series (PRD §16).
 *   2. `runCusum(ledger.weeks)` on the re-bucketed weeks.
 *   3. `decomposeContributors(ledger.weeks, cusum)`.
 *   4. `computeBurn` twice: once for the pre-change regime and once with
 *      `regimeStartWeekIndex = cusum.estimated_change_point_index + 1`.
 *   5. `buildIncidents({ ... })`.
 *   6. `detectRecurringDrift(ledger, burn)` → `attachDriftSignals(incidents, drifts)`,
 *      which folds a drifting vendor into the incident it already contributes to
 *      instead of raising a second alert (contract §10).
 *
 * Every threshold comes from `@canary/shared` config. Nothing here reads the
 * clock or a random source: `buildIncidents` takes `now` as a parameter, so the
 * same inputs always produce byte-identical output.
 */
export { NO_PRE_CHANGE_SEGMENT, ewma, regimeStartIndex, runCusum } from "./cusum.ts";
export { compareContributors, decomposeContributors } from "./decompose.ts";
export { detectOneOffs } from "./one-off.ts";
export {
  ONE_OFF_MATERIALITY_RULES,
  ONE_OFF_RULE_PARAMETERS,
  RATE_MATERIALITY_RULES,
  evaluateOneOffMateriality,
  evaluateRateMateriality,
  runwayImpactMonths,
  severityFromRunwayImpact,
} from "./materiality.ts";
export { VARIABLE_SPEND_ENTITY, attachDriftSignals, buildIncidents, categoriesByEntity } from "./incidents.ts";
export { RECURRING_DRIFT, detectRecurringDrift, type DetectRecurringDrift, type RecurringDriftResult } from "./recurring-drift.ts";
export { fnv1a32, fnv1a32Hex, incidentIdFor } from "./ids.ts";
