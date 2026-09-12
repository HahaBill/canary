import type { CompanyProfile, DataProvenance, HistorySource } from "@canary/shared";
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
}: {
  provenance: DataProvenance;
  company: CompanyProfile;
}) {
  const parts = [
    company.name,
    "fictional company",
    HISTORY_LABEL[provenance.history_source],
    `${company.bank_name} balance as of ${formatDateMedium(provenance.end_date)}`,
  ];

  return (
    <div className="border-b border-neutral-200 bg-white/80 backdrop-blur">
      <p className="mx-auto max-w-5xl px-4 py-2 text-[11px] leading-snug text-neutral-500 sm:text-xs">
        {parts.join(" · ")}
      </p>
    </div>
  );
}
