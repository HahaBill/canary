/**
 * Production `DataProvider`: the real Canary pipeline
 * (generator → classification → engine → detectors) run once per isolate,
 * fully offline and deterministic thanks to the committed demo caches.
 * What-if is `@canary/engine`'s `simulateCostChange` — never an LLM.
 */
import type { DerivedDemoObject, Incident, IncidentStatus, ISODateTime, Transaction, VendorEnrichment, WhatIfRequest, WhatIfResult } from "@canary/shared";
import { simulateCostChange } from "@canary/engine";
import { loadDemoCaches, runPipeline } from "@canary/pipeline";
import { whatIfSpeech } from "../speech.ts";
import { MockDataProvider, type DataProvider } from "./provider.ts";

export class PipelineDataProvider implements DataProvider {
  private inner: Promise<{ provider: MockDataProvider; transactions: Transaction[] }> | null = null;

  constructor(private readonly options: { seed?: number; now?: string } = {}) {}

  private load() {
    if (!this.inner) {
      this.inner = (async () => {
        const caches = await loadDemoCaches();
        const { derived, generated } = await runPipeline({ ...caches, seed: this.options.seed, now: this.options.now });
        // Reuse the in-memory status overlay machinery over the real derived object.
        return { provider: new MockDataProvider(derived), transactions: generated.transactions };
      })();
    }
    return this.inner;
  }

  private async ready(): Promise<MockDataProvider> {
    return (await this.load()).provider;
  }

  /** Sandbox bank ledger (`/api/bank/transactions`). */
  async getTransactions(): Promise<Transaction[]> {
    return (await this.load()).transactions;
  }

  async getDerived(): Promise<DerivedDemoObject> {
    return (await this.ready()).getDerived();
  }
  async getIncident(id: string): Promise<Incident | null> {
    return (await this.ready()).getIncident(id);
  }
  async updateIncidentStatus(id: string, status: IncidentStatus, now: ISODateTime): Promise<Incident | null> {
    return (await this.ready()).updateIncidentStatus(id, status, now);
  }
  async markNotified(id: string, now: ISODateTime): Promise<void> {
    return (await this.ready()).markNotified(id, now);
  }
  async getEnrichment(entity: string): Promise<VendorEnrichment | null> {
    return (await this.ready()).getEnrichment(entity);
  }
  async simulate(req: WhatIfRequest): Promise<WhatIfResult> {
    const derived = await this.getDerived();
    const result = simulateCostChange(derived.burn, req);
    return { ...result, speech: whatIfSpeech(result) };
  }
}
