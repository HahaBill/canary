/**
 * Incident assembly, grouping and dedup (PRD §16–17, contract §10–11).
 *
 * Two candidate kinds, and the rules that keep them from multiplying:
 *   - ONE BURN_RATE_SHIFT incident for a fired, material CUSUM alarm. The other
 *     positive contributors become `child_signals` INSIDE that incident — a
 *     contributor never becomes a second top-level incident (contract §10).
 *   - ONE standalone ONE_OFF_VENDOR_PAYMENT incident per material anomalous
 *     one-off, even when that vendor is also a contributor to the rate shift.
 *
 * Evidence is limited to OBSERVED (what the numbers did) and DETECTED (what the
 * detector concluded, with its parameters). EVIDENCE / ESTIMATE / SUGGESTION
 * items are added by the API layer, which owns vendor research and scenarios.
 *
 * Dedup: a candidate updates an existing incident in place — keeping `id`,
 * `first_detected`, `status` and `last_notified` — when type and entity match
 * and, for rate shifts, the change point moved by no more than
 * `INCIDENT_DEDUP_WEEKS`. Existing incidents that nothing matched are returned
 * untouched.
 */
import {
  INCIDENT_DEDUP_WEEKS,
  daysBetween,
  formatSignedUsd,
  formatUsdWhole,
  weeklyToAnnual,
  weeklyToMonthly,
  type BuildIncidents,
  type BuildIncidentsInput,
  type Category,
  type ChildSignal,
  type Contributor,
  type CusumResult,
  type EvidenceItem,
  type Incident,
  type ISODateTime,
  type Ledger,
  type OneOffResult,
} from "@canary/shared";
import { compareContributors } from "./decompose.ts";
import { incidentIdFor } from "./ids.ts";
import {
  ONE_OFF_RULE_PARAMETERS,
  evaluateRateMateriality,
  runwayImpactMonths,
  severityFromRunwayImpact,
} from "./materiality.ts";

/** `Incident.entity` when a rate shift has no positive contributor to name. */
export const VARIABLE_SPEND_ENTITY = "variable_spend";

/** Everything a detector knows; identity and lifecycle are assigned during dedup. */
type IncidentCandidate = Omit<Incident, "id" | "status" | "first_detected" | "last_updated" | "last_notified">;

export const buildIncidents: BuildIncidents = (input: BuildIncidentsInput): Incident[] => {
  const { existing, now } = input;
  const candidates: IncidentCandidate[] = [];

  const rateShift = buildRateShiftCandidate(input);
  if (rateShift) candidates.push(rateShift);

  for (const oneOff of input.oneOffs) {
    if (oneOff.is_anomalous && oneOff.materiality.material) candidates.push(buildOneOffCandidate(oneOff));
  }

  const merged = [...existing];
  const claimed = new Set<number>();
  const created: Incident[] = [];

  for (const candidate of candidates) {
    const matchIndex = findMatch(merged, candidate, claimed);
    if (matchIndex === null) {
      created.push({
        ...candidate,
        id: incidentIdFor(candidate),
        status: "OPEN",
        first_detected: now,
        last_updated: now,
        last_notified: null,
      });
    } else {
      claimed.add(matchIndex);
      merged[matchIndex] = updateInPlace(merged[matchIndex]!, candidate, now);
    }
  }

  return [...merged, ...created];
};

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

function buildRateShiftCandidate(input: BuildIncidentsInput): IncidentCandidate | null {
  const { cusum, ledger, burnBefore, burnAfter } = input;
  if (!cusum.fired || cusum.delta_weekly_cents === null || cusum.estimated_change_point_week_start === null) return null;

  const materiality = evaluateRateMateriality(cusum.delta_weekly_cents, burnBefore, burnAfter);
  if (!materiality.material) return null;

  const categories = categoriesByEntity(ledger);
  const contributors: Contributor[] = input.contributors
    .map((c) => ({ ...c, category: c.category ?? categories[c.entity] ?? null }))
    .sort(compareContributors);

  const top = contributors.find((c) => c.delta_weekly_cents > 0) ?? null;
  const childSignals: ChildSignal[] = contributors
    .filter((c) => c !== top && c.delta_weekly_cents > 0)
    .map((c) => ({
      entity: c.entity,
      category: c.category,
      description: `${c.entity} variable spend rose ${formatSignedUsd(c.delta_weekly_cents, "/wk")} over the same period; folded into this incident.`,
      delta_weekly_cents: c.delta_weekly_cents,
    }));

  const deltaWeekly = cusum.delta_weekly_cents;
  const runwayImpact = runwayImpactMonths(burnBefore.runway_months, burnAfter.runway_months);
  const changePoint = cusum.estimated_change_point_week_start;

  return {
    type: "BURN_RATE_SHIFT",
    entity: top?.entity ?? VARIABLE_SPEND_ENTITY,
    title: "Sustained increase in variable spending",
    summary: rateShiftSummary(cusum, top, changePoint),
    estimated_change_point: changePoint,
    alarm_date: cusum.alarm_week_start,
    severity: severityFromRunwayImpact(runwayImpact),
    financial_impact: {
      delta_weekly_cents: deltaWeekly,
      delta_monthly_cents: weeklyToMonthly(deltaWeekly),
      delta_annualized_cents: weeklyToAnnual(deltaWeekly),
      runway_before_months: burnBefore.runway_months,
      runway_after_months: burnAfter.runway_months,
      runway_impact_months: runwayImpact,
    },
    contributors,
    child_signals: childSignals,
    detection: { cusum },
    materiality,
    evidence: rateShiftEvidence(cusum, top, changePoint),
  };
}

function buildOneOffCandidate(oneOff: OneOffResult): IncidentCandidate {
  return {
    type: "ONE_OFF_VENDOR_PAYMENT",
    entity: oneOff.entity,
    title: `Unusual one-off payment to ${oneOff.entity}`,
    summary: oneOffSummary(oneOff),
    // A one-off is a shock, not a regime change: it has no change point, and the
    // alarm date is the day the payment landed.
    estimated_change_point: null,
    alarm_date: oneOff.date,
    severity: oneOff.materiality.material ? "MEDIUM" : "LOW",
    financial_impact: {
      delta_weekly_cents: null,
      delta_monthly_cents: null,
      delta_annualized_cents: null,
      runway_before_months: null,
      runway_after_months: null,
      runway_impact_months: null,
      one_off_amount_cents: oneOff.current_amount_cents,
    },
    contributors: [],
    child_signals: [],
    detection: { one_off: oneOff },
    materiality: oneOff.materiality,
    evidence: oneOffEvidence(oneOff),
  };
}

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

/** Index of the best existing incident for this candidate, or null to create. */
function findMatch(existing: Incident[], candidate: IncidentCandidate, claimed: Set<number>): number | null {
  const candidateId = incidentIdFor(candidate);
  let best: { index: number; distanceWeeks: number } | null = null;

  for (let i = 0; i < existing.length; i++) {
    if (claimed.has(i)) continue;
    const incident = existing[i]!;
    if (incident.type !== candidate.type) continue;
    // Entity is an OUTPUT of decomposition for a rate shift (the top contributor can
    // drift as the regime matures), so it is not part of a rate shift's identity.
    // One-offs are identified by their vendor + transaction.
    if (candidate.type === "ONE_OFF_VENDOR_PAYMENT" && incident.entity !== candidate.entity) continue;

    // Same deterministic identity: the stored incident IS this detection, even if
    // its `detection` payload was dropped on the way through storage.
    if (incident.id === candidateId) return i;

    if (candidate.type === "ONE_OFF_VENDOR_PAYMENT") {
      const transactionId = candidate.detection.one_off?.transaction_id;
      if (transactionId !== undefined && incident.detection.one_off?.transaction_id === transactionId) return i;
      continue;
    }

    const distanceWeeks = changePointDistanceWeeks(incident.estimated_change_point, candidate.estimated_change_point);
    if (distanceWeeks === null || distanceWeeks > INCIDENT_DEDUP_WEEKS) continue;
    if (best === null || distanceWeeks < best.distanceWeeks) best = { index: i, distanceWeeks };
  }

  return best?.index ?? null;
}

/** Absolute weeks between two change points; null when either is unknown. */
function changePointDistanceWeeks(a: string | null, b: string | null): number | null {
  if (a === null || b === null) return null;
  return Math.abs(daysBetween(a, b)) / 7;
}

/**
 * Fresh numbers, stored identity and lifecycle. `status` and `last_notified`
 * belong to the user (acknowledged, resolved, already texted) and are never
 * reset by a re-detection.
 */
function updateInPlace(stored: Incident, candidate: IncidentCandidate, now: ISODateTime): Incident {
  return {
    ...candidate,
    id: stored.id,
    status: stored.status,
    first_detected: stored.first_detected,
    last_notified: stored.last_notified,
    last_updated: now,
  };
}

// ---------------------------------------------------------------------------
// Text — every figure is formatted from a computed number, never written by hand
// ---------------------------------------------------------------------------

function rateShiftSummary(cusum: CusumResult, top: Contributor | null, changePoint: string): string {
  const pre = formatUsdWhole(cusum.pre_change_rate_weekly_cents ?? 0);
  const post = formatUsdWhole(cusum.post_change_rate_weekly_cents ?? 0);
  const head = `Variable spend rose from ${pre}/week to ${post}/week beginning the week of ${changePoint}.`;
  if (!top) return head;
  return `${head} ${top.entity} is the largest contributor at ${formatSignedUsd(top.delta_weekly_cents, "/wk")}.`;
}

function rateShiftEvidence(cusum: CusumResult, top: Contributor | null, changePoint: string): EvidenceItem[] {
  const evidence: EvidenceItem[] = [];

  if (top) {
    evidence.push({
      kind: "OBSERVED",
      text: `${top.entity} averaged ${formatUsdWhole(top.pre_rate_weekly_cents)}/week before ${changePoint} and ${formatUsdWhole(top.post_rate_weekly_cents)}/week after (${formatSignedUsd(top.delta_weekly_cents, "/week")}).`,
    });
  }

  const preWeeks = (cusum.estimated_change_point_index ?? -1) + 1;
  const deltaWeekly = cusum.delta_weekly_cents ?? 0;
  evidence.push({
    kind: "OBSERVED",
    text: `Variable spend averaged ${formatUsdWhole(cusum.pre_change_rate_weekly_cents ?? 0)}/week across the ${preWeeks} weeks before ${changePoint} and ${formatUsdWhole(cusum.post_change_rate_weekly_cents ?? 0)}/week across the ${cusum.post_change_weeks ?? 0} weeks since (${formatSignedUsd(deltaWeekly, "/week")}, ${formatSignedUsd(weeklyToMonthly(deltaWeekly), "/month")}).`,
  });

  evidence.push({
    kind: "DETECTED",
    text: `Variable spend shifted upward; CUSUM alarm in week of ${cusum.alarm_week_start} (k=${formatUsdWhole(cusum.k_cents)}, h=${formatUsdWhole(cusum.h_cents)}, σ=${formatUsdWhole(cusum.sigma_cents)}, baseline ${cusum.baseline_weeks} weeks).`,
  });

  return evidence;
}

function oneOffSummary(oneOff: OneOffResult): string {
  const amount = formatUsdWhole(oneOff.current_amount_cents);
  if (oneOff.vendor_median_cents === null || oneOff.multiple_of_median === null) {
    return `${amount} paid to ${oneOff.entity} on ${oneOff.date} is the vendor's first significant payment.`;
  }
  return `${amount} paid to ${oneOff.entity} on ${oneOff.date} is ${formatMultiple(oneOff.multiple_of_median)}× this vendor's median of ${formatUsdWhole(oneOff.vendor_median_cents)} across ${oneOff.prior_payment_count} prior payments.`;
}

function oneOffEvidence(oneOff: OneOffResult): EvidenceItem[] {
  const evidence: EvidenceItem[] = [];
  const median = oneOff.vendor_median_cents;

  if (median !== null) {
    evidence.push({
      kind: "OBSERVED",
      text: `${oneOff.entity} had ${oneOff.prior_payment_count} prior payments with a median of ${formatUsdWhole(median)}; this payment was ${formatUsdWhole(oneOff.current_amount_cents)} (${formatSignedUsd(oneOff.current_amount_cents - median)} above median).`,
    });
  } else {
    evidence.push({
      kind: "OBSERVED",
      text: `${oneOff.entity} has ${oneOff.prior_payment_count} prior payments on record; this payment was ${formatUsdWhole(oneOff.current_amount_cents)}.`,
    });
  }

  evidence.push({
    kind: "DETECTED",
    text: `Vendor-relative one-off rule fired: amount is at least ${ONE_OFF_RULE_PARAMETERS.median_multiple}× the vendor median and at least ${formatUsdWhole(ONE_OFF_RULE_PARAMETERS.min_abs_diff_cents)} above it.`,
  });

  return evidence;
}

/** `3.2`, `40` — a ratio for display, not money. */
function formatMultiple(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

// ---------------------------------------------------------------------------
// Entity → category
// ---------------------------------------------------------------------------

/**
 * The weekly buckets have no entity → category mapping, so it is recovered from
 * the ledger: the category carrying the largest share of that entity's operating
 * outflow, ties broken alphabetically for determinism.
 */
export function categoriesByEntity(ledger: Ledger): Record<string, Category> {
  const totals = new Map<string, Map<Category, number>>();
  for (const tx of ledger.transactions) {
    if (tx.dropped || !tx.counts_in_burn || tx.flow_type !== "OPERATING_OUTFLOW") continue;
    const byCategory = totals.get(tx.merchant_normalized) ?? new Map<Category, number>();
    byCategory.set(tx.category, (byCategory.get(tx.category) ?? 0) + Math.abs(tx.amount_cents));
    totals.set(tx.merchant_normalized, byCategory);
  }

  const out: Record<string, Category> = {};
  for (const [entity, byCategory] of totals) {
    let best: { category: Category; total: number } | null = null;
    for (const [category, total] of byCategory) {
      if (best === null || total > best.total || (total === best.total && category < best.category)) {
        best = { category, total };
      }
    }
    if (best) out[entity] = best.category;
  }
  return out;
}
