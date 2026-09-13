/**
 * Production `DataProvider`: the real Canary pipeline
 * (generator → classification → engine → detectors) run once per isolate,
 * fully offline and deterministic thanks to the committed demo caches.
 * What-if is `@canary/engine`'s `simulateCostChange` — never an LLM.
 */
import type {
  CalendarEvent,
  ClassificationOverride,
  DerivedDemoObject,
  Incident,
  IncidentStatus,
  ISODate,
  ISODateTime,
  LedgerPivot,
  NeedsReviewResponse,
  PivotCellDetail,
  PivotGranularity,
  Transaction,
  VendorEnrichment,
  WhatIfRequest,
  WhatIfResult,
} from "@canary/shared";
import { simulateCostChange } from "@canary/engine";
import { loadDemoCaches, runPipeline } from "@canary/pipeline";
import { buildCashCalendarEvents, pivotCell, pivotLedger, projectRecurring } from "@canary/engine";
import { addDays, DEMO } from "@canary/shared";
import type { Ledger, RecurringSeries } from "@canary/shared";
import { noChangeExplanation, whatIfSpeech } from "../speech.ts";
import { MockDataProvider, type DataProvider } from "./provider.ts";
import { listFromPostedTransactions, selectTransactions, type TransactionListQuery, type TransactionSelection } from "./transactions.ts";

/** Simulated days kept warm at once. */
const MAX_CACHED_DAYS = 4;

type Loaded = { provider: MockDataProvider; transactions: Transaction[]; ledger: Ledger; recurring: RecurringSeries[] };

export class PipelineDataProvider implements DataProvider {
  /** Keyed by `asOf`: the demo clock moves, so one frozen result is not enough. */
  private readonly byAsOf = new Map<string, Promise<Loaded>>();

  constructor(
    private readonly options: {
      seed?: number;
      now?: string;
      /**
       * The day the founder's account is current to, re-read on every request.
       * Omitted → the end of history, which is how Canary behaved before the
       * demo clock existed.
       */
      asOf?: () => string;
    } = {},
  ) {}

  private load(): Promise<Loaded> {
    const asOf = this.options.asOf?.();
    const key = asOf ?? "";
    let entry = this.byAsOf.get(key);
    if (entry) return entry;

    entry = (async () => {
      const caches = await loadDemoCaches();
      const { derived, generated, ledger } = await runPipeline({
        ...caches,
        seed: this.options.seed,
        // Incident timestamps follow the simulated clock, so "first detected" is
        // the simulated day a detector saw it, not the day the Worker booted.
        now: this.options.now ?? (asOf ? `${asOf}T12:00:00.000Z` : undefined),
        ...(asOf ? { asOf, horizonWeeks: DEMO.HORIZON_WEEKS } : {}),
      });
      // Project recurring charges ~6 months past history end for the cash calendar.
      const recurring = projectRecurring(ledger, { horizonEnd: addDays(ledger.history_end, 183) });
      // POSTED rows only. The generator's horizon (transactions dated after the
      // demo clock's "today") is fuel for the moving ledger, not history: it
      // must never be listable by the bank endpoint or the conversation tools.
      // The future does not exist yet — only labelled projections may mention
      // it. Clip by the exact asOf, not ledger.history_end, which is widened to
      // the Sunday of the asOf week and would leak up to six future days.
      const cutoff = asOf ?? generated.fixture.end_date;
      const posted = generated.transactions.filter((tx) => tx.date <= cutoff);
      // Reuse the in-memory status overlay machinery over the real derived object.
      return { provider: new MockDataProvider(derived), transactions: posted, ledger, recurring };
    })();

    this.byAsOf.set(key, entry);
    // A full run is ~12ms, so this only stops a burst of requests inside one
    // simulated day from repeating the work.
    if (this.byAsOf.size > MAX_CACHED_DAYS) {
      const oldest = this.byAsOf.keys().next().value;
      if (oldest !== undefined) this.byAsOf.delete(oldest);
    }
    return entry;
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
    const noChangeReason = noChangeExplanation(derived, req.entity, req.percentage);
    return {
      ...result,
      no_change_reason: noChangeReason,
      speech: whatIfSpeech(result, noChangeReason),
    };
  }

  // ---------------------------------------------------------------------------
  // Views. The engine's `pivotLedger` / `pivotCell` / `projectRecurring` /
  // `buildCashCalendarEvents` need the full `Ledger` (transactions included),
  // which `runPipeline` does not hand back yet. The lead wires these three at
  // integration; failing loudly beats serving the dev mock's shapes as if they
  // were pipeline output.
  // ---------------------------------------------------------------------------

  async getLedgerPivot(granularity: PivotGranularity): Promise<LedgerPivot> {
    const { ledger } = await this.load();
    const derived = await this.getDerived();
    const cusum = derived.primary_incident?.detection.cusum;
    const regimeStart = cusum?.estimated_change_point_week_start ?? null;
    const incidentByEntity: Record<string, string> = {};
    for (const inc of derived.incidents) {
      incidentByEntity[inc.entity] ??= inc.id;
      for (const c of inc.contributors) if (c.delta_weekly_cents > 0) incidentByEntity[c.entity] ??= inc.id;
    }
    return pivotLedger(ledger, { granularity, regimeStart, incidentByEntity });
  }

  async getLedgerCell(rowId: string, periodKey: string, granularity: PivotGranularity): Promise<PivotCellDetail | null> {
    const { ledger } = await this.load();
    try {
      return pivotCell(ledger, rowId, periodKey, granularity);
    } catch {
      return null; // unknown row id / period key → 404 at the route
    }
  }

  async getCalendarEvents(from: ISODate, to: ISODate): Promise<CalendarEvent[]> {
    const { ledger, recurring } = await this.load();
    const derived = await this.getDerived();
    return buildCashCalendarEvents({ ledger, incidents: derived.incidents, recurring, from, to });
  }

  /** Real pipeline data: `needs_review` + `classifications` are already in the derived object. */
  async getNeedsReview(): Promise<NeedsReviewResponse["items"]> {
    return (await this.ready()).getNeedsReview();
  }

  async applyClassificationOverride(o: ClassificationOverride): Promise<{ needs_review_count: number }> {
    return (await this.ready()).applyClassificationOverride(o);
  }

  async listTransactions(query: TransactionListQuery = {}): Promise<TransactionSelection> {
    const { transactions } = await this.load();
    const derived = await this.getDerived();
    return selectTransactions(listFromPostedTransactions(transactions, derived.classifications), query);
  }
}
