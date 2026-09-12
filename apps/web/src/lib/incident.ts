/**
 * Read-only helpers that pick the right engine-provided figure for the UI.
 * Nothing here invents a number: the only arithmetic is `sumCents` over values
 * the detectors already computed.
 */
import { sumCents, type Cents, type Contributor, type Incident } from "@canary/shared";

/** The driver the incident is named after, i.e. the largest positive contributor. */
export function topPositiveContributor(incident: Incident): Contributor | null {
  let best: Contributor | null = null;
  for (const c of incident.contributors) {
    if (c.delta_weekly_cents <= 0) continue;
    if (!best || c.delta_weekly_cents > best.delta_weekly_cents) best = c;
  }
  return best;
}

/**
 * Weekly variable-spend rate before and after the change point. The CUSUM
 * result is authoritative; contributor rates are the same totals broken out by
 * entity, so they stand in when `detection.cusum` is absent.
 */
export function variableRates(incident: Incident): { pre: Cents | null; post: Cents | null } {
  const cusum = incident.detection.cusum;
  if (cusum && cusum.pre_change_rate_weekly_cents !== null && cusum.post_change_rate_weekly_cents !== null) {
    return { pre: cusum.pre_change_rate_weekly_cents, post: cusum.post_change_rate_weekly_cents };
  }
  if (incident.contributors.length > 0) {
    return {
      pre: sumCents(incident.contributors.map((c) => c.pre_rate_weekly_cents)),
      post: sumCents(incident.contributors.map((c) => c.post_rate_weekly_cents)),
    };
  }
  return { pre: null, post: null };
}

/** Entities offered in the what-if picker, primary driver first. */
export function whatIfEntities(weeklyByEntity: Record<string, Cents>, preferred?: string): string[] {
  const entities = Object.keys(weeklyByEntity).sort((a, b) => (weeklyByEntity[b] ?? 0) - (weeklyByEntity[a] ?? 0));
  if (preferred && entities.includes(preferred)) {
    return [preferred, ...entities.filter((e) => e !== preferred)];
  }
  return entities;
}
