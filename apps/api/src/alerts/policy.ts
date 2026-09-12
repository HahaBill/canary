/**
 * When Canary is allowed to speak unprompted (docs/AGENT_BEHAVIOR.md §1).
 *
 * Until now the route texted whatever the primary incident was; §1 rules 3 and 4
 * ("the incident is OPEN", "last_notified is null") were left to the operator,
 * recorded as a gap in docs/ALFREDO-LOGIC-AUDIT.md §3.3. This function is that
 * guard, plus one addition: if the founder is in a meeting the alert is deferred
 * rather than dropped, because a material shift does not stop being material.
 *
 * A pure function of an incident, the founder's availability and the clock — no
 * I/O, no model, no thresholds of its own. Materiality was decided by the
 * detectors using the constants in `config.ts`; this only reads the verdict.
 */
import type { AvailabilityResponse, Incident, ISODateTime, NotifyDecision } from "@canary/shared";

export interface NotifyPolicyInput {
  incident: Incident;
  /** Operator/demo override: send regardless of every rule below. */
  force?: boolean;
  /** Null when no calendar feed is configured — absence of a signal never blocks an alert. */
  availability?: Pick<AvailabilityResponse, "busy" | "until"> | null;
  now: ISODateTime;
}

/**
 * Checked in the order a founder would ask about them: is this news, is it big
 * enough, have you already told me, and is now a sane moment.
 */
export function decideNotify({ incident, force, availability, now }: NotifyPolicyInput): NotifyDecision {
  if (force) return { send: true };
  // Rule 3: acknowledged or resolved means the founder already answered.
  if (incident.status !== "OPEN") return { send: false, reason: "not_open" };
  // Rule 2: the thresholds in config.ts decide this, never a model.
  if (!incident.materiality.material) return { send: false, reason: "not_material" };
  // Rule 4: re-texting the same incident with the same numbers is spam.
  if (incident.last_notified !== null) return { send: false, reason: "already_notified" };
  if (availability?.busy) {
    // A busy block with no known end defers to `now`: the next cron pass re-checks
    // and pushes it out again, so an open-ended meeting cannot silently swallow the alert.
    return { send: false, reason: "calendar_busy", until: availability.until ?? now };
  }
  return { send: true };
}

/** Earliest time a deferred alert may be delivered. */
export function deliverAfter(decision: NotifyDecision, now: ISODateTime): ISODateTime {
  return decision.send ? now : (decision.until ?? now);
}

/** True when the alert should be queued rather than dropped. */
export function isDeferred(decision: NotifyDecision): boolean {
  return !decision.send && decision.reason === "calendar_busy";
}
