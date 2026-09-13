import type { Cents, CompanyProfile, DataProvenance, HistorySource } from "@canary/shared";
import { LiveBadge } from "@/components/LiveBadge.tsx";
import { formatDateMedium } from "@/lib/format.ts";

const HISTORY_LABEL: Record<HistorySource, string> = {
  synthetic: "synthetic history",
  sandbox_bank: "sandbox bank history",
  mock: "mock history",
};

/**
 * Always-visible disclosure strip. The demo runs on a fictional company and a
 * sandbox bank, and the UI must never let a viewer forget that.
 */
export function ProvenanceBanner({
  provenance,
  company,
  cashCents,
  refreshing,
}: {
  provenance: DataProvenance;
  company: CompanyProfile;
  /** Drives the live badge's movement line. */
  cashCents: Cents;
  refreshing?: boolean;
}) {
  const parts = [
    company.name,
    "fictional company",
    HISTORY_LABEL[provenance.history_source],
    `${company.bank_name} balance as of ${formatDateMedium(provenance.end_date)}`,
  ];

  return (
    <div className="border-b border-neutral-200 bg-white/80 backdrop-blur">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2">
        <p className="text-[11px] leading-snug text-neutral-500 sm:text-xs">{parts.join(" · ")}</p>
        <LiveBadge provenance={provenance} cashCents={cashCents} refreshing={refreshing} />
      </div>
    </div>
  );
}
