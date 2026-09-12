/**
 * Contributor decomposition (PRD §15): who moved the variable-spend rate.
 *
 * Dollar contribution per entity, pre vs post the CUSUM change point, over ALL
 * weeks of each segment (an entity absent from a week counts as 0 that week).
 * Negative contributors are valid and shares are not forced to sum to 1.
 *
 * Because `Σ_e weeks[i].variable_by_entity[e] === weeks[i].variable_spend_cents`
 * (engine contract), the entity deltas sum to `cusum.delta_weekly_cents` up to
 * per-entity rounding: at most ~1 cent per entity plus the 2 cents of rounding
 * in the CUSUM pre/post rates. Tests assert that tolerance; nothing is fudged
 * to force an exact match.
 */
import { weeklyToMonthly, type Cents, type Contributor, type CusumResult, type DecomposeContributors, type WeeklyBucket } from "@canary/shared";

export const decomposeContributors: DecomposeContributors = (weeks: WeeklyBucket[], cusum: CusumResult): Contributor[] => {
  const changePointIndex = cusum.estimated_change_point_index;
  if (!cusum.fired || changePointIndex === null) return [];
  // NO_PRE_CHANGE_SEGMENT (-1): the statistic never returned to zero before the
  // alarm, so there is no "before" to compare against. CUSUM reports an unknown
  // pre-change rate as null; an empty pre-segment here would instead give every
  // entity a pre-rate of 0 and report its full-series average as a DELTA — a
  // change that never happened. No comparison is the honest answer.
  if (changePointIndex < 0) return [];

  const regimeStart = changePointIndex + 1;
  if (regimeStart >= weeks.length) return [];

  const pre = weeks.slice(0, regimeStart);
  const post = weeks.slice(regimeStart);
  const totalDelta = cusum.delta_weekly_cents ?? 0;

  const entities = new Set<string>();
  for (const week of weeks) for (const entity of Object.keys(week.variable_by_entity)) entities.add(entity);

  return [...entities]
    .map((entity) => {
      const preRate = meanRate(pre, entity);
      const postRate = meanRate(post, entity);
      const delta = postRate - preRate;
      return {
        entity,
        // The weekly buckets carry no entity → category mapping; `buildIncidents`
        // fills this in from the ledger before the incident is published.
        category: null,
        pre_rate_weekly_cents: preRate,
        post_rate_weekly_cents: postRate,
        delta_weekly_cents: delta,
        delta_monthly_cents: weeklyToMonthly(delta),
        share_of_total_delta: totalDelta === 0 ? 0 : delta / totalDelta,
      };
    })
    .sort(compareContributors);
};

/** Desc by weekly delta, then entity asc so the order is total and stable. */
export function compareContributors(a: Contributor, b: Contributor): number {
  if (b.delta_weekly_cents !== a.delta_weekly_cents) return b.delta_weekly_cents - a.delta_weekly_cents;
  return a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0;
}

/** Mean weekly spend for one entity across a segment. An empty segment is 0. */
function meanRate(segment: WeeklyBucket[], entity: string): Cents {
  if (segment.length === 0) return 0;
  let total = 0;
  for (const week of segment) total += week.variable_by_entity[entity] ?? 0;
  return Math.round(total / segment.length);
}
