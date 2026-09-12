/**
 * Demo caches committed to the repo so the Worker and verification are deterministic
 * and offline: per-merchant classifications (from a live OpenAI+Tavily run) and vendor
 * enrichments. Populated by `npm run seed -w @canary/pipeline` (scripts/seed-demo-cache.ts).
 */
import type { Classification, VendorEnrichment } from "@canary/shared";

export interface DemoCaches {
  merchantClassificationCache: Record<string, Omit<Classification, "transaction_id">>;
  cachedEnrichments: VendorEnrichment[];
}

// Static JSON imports keep this importable from the Worker bundle (no fs).
import classificationsJson from "../cache/classifications.json" with { type: "json" };
import enrichmentsJson from "../cache/enrichments.json" with { type: "json" };

export async function loadDemoCaches(): Promise<DemoCaches> {
  return {
    merchantClassificationCache: classificationsJson as DemoCaches["merchantClassificationCache"],
    cachedEnrichments: enrichmentsJson as VendorEnrichment[],
  };
}
