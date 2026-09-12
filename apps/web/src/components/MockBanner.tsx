import { AlertTriangle } from "lucide-react";
import type { DataProvenance } from "@canary/shared";
import type { DataSource } from "@/api/useDerived.ts";

const REASON: Record<DataSource, string> = {
  "mock-forced": "Forced by VITE_USE_MOCK=1.",
  "mock-fallback": "The API was unreachable, so the app fell back to bundled fixtures.",
  live: "The API served fixture data.",
};

/**
 * Loud, deliberately ugly warning. Renders only when the data really is the
 * mock fixture, so a demo can never be mistaken for generator output.
 */
export function MockBanner({
  provenance,
  source,
}: {
  provenance: DataProvenance;
  source?: DataSource | null;
}) {
  if (provenance.history_source !== "mock") return null;

  return (
    <div role="alert" className="bg-red-600 text-white">
      <div className="mx-auto flex max-w-5xl items-start gap-2 px-4 py-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="text-xs font-semibold uppercase tracking-wide sm:text-sm">
          MOCK DATA — not generator output
          {source ? <span className="ml-2 font-normal normal-case tracking-normal">{REASON[source]}</span> : null}
        </p>
      </div>
    </div>
  );
}
