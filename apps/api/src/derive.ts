/**
 * Read-only projections over a `DerivedDemoObject`. Nothing here invents a
 * financial figure: every number is either copied from engine/detector output
 * or averaged over weekly buckets the engine produced.
 */
import type { Cents, Contributor, DerivedDemoObject, Incident, WeeklyBucket } from "@canary/shared";

export interface VariableRates {
  pre_weekly_cents: Cents;
  post_weekly_cents: Cents;
  delta_weekly_cents: Cents;
}

function mean(values: number[]): Cents {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

/** Index of the first week of the new regime, or null when unknown. */
export function changePointWeekIndex(weeks: WeeklyBucket[], incident: Incident): number | null {
  const fromCusum = incident.detection.cusum?.estimated_change_point_index;
  if (typeof fromCusum === "number") return fromCusum + 1;
  if (!incident.estimated_change_point) return null;
  const idx = weeks.findIndex((w) => w.week_start === incident.estimated_change_point);
  return idx > 0 ? idx : null;
}

/**
 * Pre/post weekly variable-spend rates for an incident. Prefers the CUSUM
 * result; falls back to averaging the engine's weekly buckets around the
 * change point, then to summing contributor rates.
 */
export function variableSpendRates(derived: DerivedDemoObject, incident: Incident): VariableRates | null {
  const cusum = incident.detection.cusum;
  if (cusum && cusum.pre_change_rate_weekly_cents !== null && cusum.post_change_rate_weekly_cents !== null) {
    const pre = cusum.pre_change_rate_weekly_cents;
    const post = cusum.post_change_rate_weekly_cents;
    return { pre_weekly_cents: pre, post_weekly_cents: post, delta_weekly_cents: cusum.delta_weekly_cents ?? post - pre };
  }

  const idx = changePointWeekIndex(derived.weeks, incident);
  if (idx !== null && idx > 0 && idx < derived.weeks.length) {
    const pre = mean(derived.weeks.slice(0, idx).map((w) => w.variable_spend_cents));
    const post = mean(derived.weeks.slice(idx).map((w) => w.variable_spend_cents));
    return { pre_weekly_cents: pre, post_weekly_cents: post, delta_weekly_cents: post - pre };
  }

  if (incident.contributors.length > 0) {
    const pre = incident.contributors.reduce((s, c) => s + c.pre_rate_weekly_cents, 0);
    const post = incident.contributors.reduce((s, c) => s + c.post_rate_weekly_cents, 0);
    return { pre_weekly_cents: pre, post_weekly_cents: post, delta_weekly_cents: post - pre };
  }

  return null;
}

/** Contributors that grew, largest first. */
export function positiveContributors(incident: Incident, limit?: number): Contributor[] {
  const grew = incident.contributors
    .filter((c) => c.delta_weekly_cents > 0)
    .sort((a, b) => b.delta_weekly_cents - a.delta_weekly_cents);
  return typeof limit === "number" ? grew.slice(0, limit) : grew;
}

/** The incident's own entity plus every contributor entity, de-duplicated. */
export function incidentEntities(incident: Incident): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entity of [incident.entity, ...incident.contributors.map((c) => c.entity)]) {
    if (!entity || seen.has(entity)) continue;
    seen.add(entity);
    out.push(entity);
  }
  return out;
}

/** The incident the demo (and every alert) centers on. */
export function primaryIncident(derived: DerivedDemoObject): Incident | null {
  if (derived.primary_incident) return derived.primary_incident;
  const open = derived.incidents.filter((i) => i.status === "OPEN");
  return open[0] ?? derived.incidents[0] ?? null;
}

/** Driver entity key for an incident: its top positive contributor, else its own entity. */
export function driverEntity(incident: Incident): string {
  return positiveContributors(incident, 1)[0]?.entity ?? incident.entity;
}
