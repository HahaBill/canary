/**
 * The deferred-alert queue and the job that drains it.
 *
 * An alert the policy deferred (founder in a meeting) is stored in D1 and
 * delivered by the five-minute cron trigger once they are free, through the
 * same `deliverAlert` path a live alert takes. `POST /api/alerts/deliver-pending`
 * runs the identical job on demand, which is how the demo shows the deferral
 * without waiting for the clock.
 *
 * Re-checks the policy at delivery time: a founder who acknowledged the incident
 * during the meeting has already answered, and the queued text is dropped rather
 * than sent late (docs/AGENT_BEHAVIOR.md §1 rule 3). The row stores only the
 * incident id, so the text and voice note are rendered from the incident as it
 * stands when it finally goes out, never from a stale copy.
 */
import type { ISODateTime, PendingAlert } from "@canary/shared";
import type { Variables } from "../context.ts";
import { pendingAlertId, type D1Store, type PendingAlertRow } from "../data/d1.ts";
import { deliverAlert, type AlertRuntime } from "./deliver.ts";
import { decideNotify } from "./policy.ts";

export type PendingRuntime = AlertRuntime & Pick<Variables, "calendar">;

export interface PendingRunSummary {
  /** Queued alerts whose `deliver_after` had passed. */
  due: number;
  delivered: string[];
  /** Still busy — `deliver_after` pushed to the end of the current block. */
  deferred: string[];
  /** Dropped because the policy no longer allows the alert, with the reason. */
  dropped: Array<{ incident_id: string; reason: string }>;
  failed: Array<{ incident_id: string; error: string }>;
}

/** The stored row as the API exposes it (contract shape in `packages/shared/src/views.ts`). */
export function toPendingAlert(row: PendingAlertRow): PendingAlert {
  return {
    incident_id: row.incident_id,
    to: row.to_phone,
    voice: row.voice,
    created_at: row.created_at,
    deliver_after: row.deliver_after,
    attempts: row.attempts,
  };
}

export interface QueueAlertInput {
  incident_id: string;
  to: string;
  voice: boolean;
  now: ISODateTime;
  deliver_after: ISODateTime;
}

/** Queues (or re-queues) a deferred alert. Returns null when there is no D1 to queue into. */
export async function queuePendingAlert(store: D1Store | null, input: QueueAlertInput): Promise<PendingAlert | null> {
  const row: PendingAlertRow = {
    id: pendingAlertId(input.incident_id, input.now),
    incident_id: input.incident_id,
    to_phone: input.to,
    voice: input.voice,
    created_at: input.now,
    deliver_after: input.deliver_after,
    attempts: 0,
    delivered_at: null,
  };
  if (!store) return toPendingAlert(row);
  await store.savePendingAlert(row);
  return toPendingAlert(row);
}

export async function listPending(store: D1Store | null): Promise<PendingAlert[]> {
  if (!store) return [];
  return (await store.listUndeliveredAlerts()).map(toPendingAlert);
}

/** Delivers every queued alert that is due, or pushes it out again if the founder is still busy. */
export async function runPendingAlerts(runtime: PendingRuntime): Promise<PendingRunSummary> {
  const summary: PendingRunSummary = { due: 0, delivered: [], deferred: [], dropped: [], failed: [] };
  const store = runtime.store;
  if (!store) return summary;

  const now = runtime.now();
  const queued = await store.listUndeliveredAlerts();
  const due = queued.filter((row) => row.deliver_after <= now);
  summary.due = due.length;
  if (due.length === 0) return summary;

  // One availability check for the whole batch: the founder is either in a
  // meeting or not, and the ICS text is cached per isolate anyway.
  const availability = await runtime.calendar.isBusyAt(now);

  for (const row of due) {
    const incident = await runtime.provider.getIncident(row.incident_id);
    if (!incident) {
      await store.savePendingAlert({ ...row, attempts: row.attempts + 1, delivered_at: now });
      summary.dropped.push({ incident_id: row.incident_id, reason: "incident_not_found" });
      continue;
    }

    const decision = decideNotify({ incident, availability, now });
    if (!decision.send && decision.reason === "calendar_busy") {
      await store.savePendingAlert({ ...row, attempts: row.attempts + 1, deliver_after: decision.until ?? now });
      summary.deferred.push(row.incident_id);
      continue;
    }
    if (!decision.send) {
      await store.savePendingAlert({ ...row, attempts: row.attempts + 1, delivered_at: now });
      summary.dropped.push({ incident_id: row.incident_id, reason: decision.reason });
      continue;
    }

    const outcome = await deliverAlert(runtime, { incident, to: row.to_phone, voice: row.voice });
    if (outcome.sent) {
      await store.savePendingAlert({ ...row, attempts: row.attempts + 1, delivered_at: now });
      summary.delivered.push(row.incident_id);
    } else {
      // Leave `deliver_after` alone so the next cron pass retries.
      await store.savePendingAlert({ ...row, attempts: row.attempts + 1 });
      summary.failed.push({ incident_id: row.incident_id, error: outcome.error ?? "send_failed" });
    }
  }

  return summary;
}
