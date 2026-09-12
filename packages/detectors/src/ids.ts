/**
 * Deterministic incident ids. No randomness, no clock: the same detection on
 * the same data always produces the same id, which is what lets the dedup
 * contract (§11) survive a process restart with no database.
 */
import type { Incident } from "@canary/shared";

/** FNV-1a, 32-bit. Chosen for being short, dependency-free and stable across runtimes. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function fnv1a32Hex(input: string): string {
  return fnv1a32(input).toString(16).padStart(8, "0");
}

/**
 * `inc_` + 8 hex chars over the incident's stable identity:
 *   - BURN_RATE_SHIFT: type + entity + the change point AT CREATION TIME.
 *     Later re-detections whose change point drifted by ≤ INCIDENT_DEDUP_WEEKS
 *     reuse the stored id instead of minting one (see `buildIncidents`).
 *   - ONE_OFF_VENDOR_PAYMENT: type + entity + transaction id.
 */
export function incidentIdFor(candidate: Pick<Incident, "type" | "entity" | "estimated_change_point" | "detection">): string {
  const key =
    candidate.type === "ONE_OFF_VENDOR_PAYMENT"
      ? candidate.detection.one_off?.transaction_id ?? ""
      : candidate.estimated_change_point ?? "";
  return `inc_${fnv1a32Hex(`${candidate.type}|${candidate.entity}|${key}`)}`;
}
