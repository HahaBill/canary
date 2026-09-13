import type { Cents, DataProvenance } from "@canary/shared";
import { LiveBadge } from "@/components/LiveBadge.tsx";

/**
 * Thin strip for the demo clock. Cash figures move as the simulated date
 * advances; the badge names that movement without naming the fictional company.
 */
export function ProvenanceBanner({
  provenance,
  cashCents,
  refreshing,
}: {
  provenance: DataProvenance;
  /** Drives the live badge's movement line. */
  cashCents: Cents;
  refreshing?: boolean;
}) {
  return (
    <div className="border-b border-neutral-200 bg-white/80 backdrop-blur">
      <div
        role="region"
        aria-label="Live clock"
        className="mx-auto flex max-w-5xl items-center justify-end px-4 py-2"
      >
        <LiveBadge provenance={provenance} cashCents={cashCents} refreshing={refreshing} />
      </div>
    </div>
  );
}
