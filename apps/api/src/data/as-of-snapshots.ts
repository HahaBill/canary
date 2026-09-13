/**
 * Precomputed demo-clock snapshots.
 *
 * A cold isolate that `runPipeline()`s on GET burns ~12ms of CPU — over the
 * Workers free-plan 10ms budget (`exceededCpu` → 503). These files are the
 * same `DerivedDemoObject` / ledger the pipeline would have produced for each
 * day of the clock loop, written at build time so a request only fetches and
 * (if needed) parses JSON.
 *
 * Layout under the Worker assets root (`apps/api/public` after the SPA build):
 *   _canary/transactions.json
 *   _canary/as-of/YYYY-MM-DD.derived.json
 *   _canary/as-of/YYYY-MM-DD.ledger.json
 */
import type { DerivedDemoObject, Ledger, RecurringSeries, Transaction } from "@canary/shared";
import type { Env } from "../env.ts";

export const CANARY_ASSET_PREFIX = "_canary";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface LedgerSnapshot {
  ledger: Ledger;
  recurring: RecurringSeries[];
}

export interface AsOfSnapshotLoaders {
  /** Raw JSON text or an already-parsed object. `null` → fall back to the pipeline. */
  derived: (asOf: string) => Promise<DerivedDemoObject | string | null>;
  ledger?: (asOf: string) => Promise<LedgerSnapshot | null>;
  transactions?: () => Promise<Transaction[] | null>;
}

export function snapshotLoadersFromAssets(getEnv: () => Env | undefined): AsOfSnapshotLoaders {
  const fetchAsset = async (path: string): Promise<Response | null> => {
    const assets = getEnv()?.ASSETS;
    if (!assets) return null;
    const res = await assets.fetch(`https://assets.local/${path}`);
    return res.ok ? res : null;
  };

  let transactions: Promise<Transaction[] | null> | undefined;

  return {
    async derived(asOf) {
      if (!ISO_DATE.test(asOf)) return null;
      const res = await fetchAsset(`${CANARY_ASSET_PREFIX}/as-of/${asOf}.derived.json`);
      return res ? res.text() : null;
    },
    async ledger(asOf) {
      if (!ISO_DATE.test(asOf)) return null;
      const res = await fetchAsset(`${CANARY_ASSET_PREFIX}/as-of/${asOf}.ledger.json`);
      if (!res) return null;
      const body = (await res.json()) as LedgerSnapshot;
      if (!body?.ledger || !Array.isArray(body.recurring)) return null;
      return body;
    },
    transactions() {
      transactions ??= (async () => {
        const res = await fetchAsset(`${CANARY_ASSET_PREFIX}/transactions.json`);
        if (!res) return null;
        const body: unknown = await res.json();
        return Array.isArray(body) ? (body as Transaction[]) : null;
      })();
      return transactions;
    },
  };
}
