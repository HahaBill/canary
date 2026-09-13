/**
 * Production `DataProvider`: the real Canary pipeline
 * (generator → classification → engine → detectors).
 *
 * GET handlers must not `runPipeline()` on a cold isolate. A full run is ~12ms
 * of CPU — over the Workers free-plan 10ms budget — and the request dies with
 * `exceededCpu` before the in-memory cache can ever warm. Production therefore
 * loads the as-of snapshot written at build time (same bytes `runPipeline`
 * would have produced) and keeps the whole demo-clock loop in isolate memory.
 * Tests and a missing snapshot still fall back to a live run.
 */
import type {
  CalendarEvent,
  ClassificationOverride,
  DerivedDemoObject,
  GeneratedCompany,
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
import { DEFAULT_DEMO_OPTIONS, generateDemoCompany } from "@canary/generator";
import { simulateCostChange } from "@canary/engine";
import { loadDemoCaches, runPipeline } from "@canary/pipeline";
import { buildCashCalendarEvents, pivotCell, pivotLedger, projectRecurring } from "@canary/engine";
import { addDays, DEMO } from "@canary/shared";
import type { Ledger, RecurringSeries } from "@canary/shared";
import { CYCLE_DAYS } from "../clock.ts";
import { noChangeExplanation, whatIfSpeech } from "../speech.ts";
import type { AsOfSnapshotLoaders } from "./as-of-snapshots.ts";
import { MockDataProvider, type DataProvider } from "./provider.ts";
import { listFromPostedTransactions, selectTransactions, type TransactionListQuery, type TransactionSelection } from "./transactions.ts";

/** The clock loops `CYCLE_DAYS` dates; keeping all of them avoids a miss on wrap-around. */
const MAX_CACHED_DAYS = CYCLE_DAYS;

type Rest = { transactions: Transaction[]; ledger: Ledger; recurring: RecurringSeries[] };
type Loaded = { provider: MockDataProvider; raw: string | null; rest: () => Promise<Rest> };

export class PipelineDataProvider implements DataProvider {
  /** Keyed by `asOf`: the demo clock moves, so one frozen result is not enough. */
  private readonly byAsOf = new Map<string, Promise<Loaded>>();
  /** Raw derived JSON, so `/api/demo` can pass it through without a parse/stringify. */
  private readonly rawDerived = new Map<string, string>();
  private generated: Promise<GeneratedCompany> | undefined;
  private allTransactions: Promise<Transaction[]> | undefined;

  /** Live `runPipeline` invocations in this isolate. Snapshots do not increment this. */
  pipelineRuns = 0;
  /** Successful snapshot loads (derived file present and dated correctly). */
  snapshotHits = 0;

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
      /** Production: Worker static assets. Tests inject in-memory objects. */
      snapshots?: AsOfSnapshotLoaders;
    } = {},
  ) {}

  private evict(map: Map<string, unknown>): void {
    if (map.size <= MAX_CACHED_DAYS) return;
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }

  private loadGenerated(): Promise<GeneratedCompany> {
    this.generated ??= Promise.resolve(
      generateDemoCompany({
        ...DEFAULT_DEMO_OPTIONS,
        seed: this.options.seed ?? DEMO.SEED,
        profile: "demo",
      }),
    );
    return this.generated;
  }

  private loadPostedTransactions(asOf: string | undefined): Promise<Transaction[]> {
    this.allTransactions ??= (async () => {
      const fromAssets = await this.options.snapshots?.transactions?.();
      if (fromAssets != null) return fromAssets;
      return (await this.loadGenerated()).transactions;
    })();
    return this.allTransactions.then((all) => {
      const cutoff = asOf ?? DEMO.END_DATE;
      return all.filter((tx) => tx.date <= cutoff);
    });
  }

  private async runFull(asOf: string | undefined): Promise<Loaded> {
    this.pipelineRuns += 1;
    const caches = await loadDemoCaches();
    const generated = await this.loadGenerated();
    const { derived, ledger } = await runPipeline({
      ...caches,
      generated,
      seed: this.options.seed,
      // Incident timestamps follow the simulated clock, so "first detected" is
      // the simulated day a detector saw it, not the day the Worker booted.
      now: this.options.now ?? (asOf ? `${asOf}T12:00:00.000Z` : undefined),
      // The demo clock never leaves history, so the unused horizon is not
      // generated. Calendar "expected" rows come from `projectRecurring`.
      ...(asOf ? { asOf } : {}),
    });
    const recurring = projectRecurring(ledger, { horizonEnd: addDays(ledger.history_end, 183) });
    const cutoff = asOf ?? generated.fixture.end_date;
    const posted = generated.transactions.filter((tx) => tx.date <= cutoff);
    return {
      provider: new MockDataProvider(derived),
      raw: null,
      rest: () => Promise.resolve({ transactions: posted, ledger, recurring }),
    };
  }

  private async trySnapshot(asOf: string): Promise<Loaded | null> {
    const loaders = this.options.snapshots;
    if (!loaders) return null;
    const result = this.rawDerived.get(asOf) ?? (await loaders.derived(asOf));
    if (!result) return null;
    const raw = typeof result === "string" ? result : null;
    const derived = typeof result === "string" ? (JSON.parse(result) as DerivedDemoObject) : result;
    if (derived.provenance.end_date !== asOf) return null;
    if (raw) this.rawDerived.set(asOf, raw);
    this.snapshotHits += 1;

    let restPromise: Promise<Rest> | undefined;
    const rest = (): Promise<Rest> => {
      restPromise ??= (async () => {
        const [pack, transactions] = await Promise.all([
          loaders.ledger?.(asOf) ?? Promise.resolve(null),
          this.loadPostedTransactions(asOf),
        ]);
        if (pack) return { ledger: pack.ledger, recurring: pack.recurring, transactions };
        // Derived hit but ledger file missing: finish from the live pipeline.
        return (await this.runFull(asOf)).rest();
      })();
      return restPromise;
    };

    return { provider: new MockDataProvider(derived), raw, rest };
  }

  private load(): Promise<Loaded> {
    const asOf = this.options.asOf?.();
    const key = asOf ?? "";
    let entry = this.byAsOf.get(key);
    if (entry) return entry;

    entry = (async () => {
      if (asOf) {
        const snap = await this.trySnapshot(asOf);
        if (snap) return snap;
      }
      return this.runFull(asOf);
    })();

    this.byAsOf.set(key, entry);
    this.evict(this.byAsOf);
    return entry;
  }

  private async ready(): Promise<MockDataProvider> {
    return (await this.load()).provider;
  }

  /**
   * Pre-serialized DemoResponse for the current as-of, when a snapshot exists.
   * Returning this from `/api/demo` skips JSON.parse + stringify on the path
   * the dashboard polls every two seconds.
   */
  async getDemoJson(): Promise<string | null> {
    const asOf = this.options.asOf?.();
    if (!asOf) return null;
    const warming = this.byAsOf.get(asOf);
    if (warming) return (await warming).raw;
    const cached = this.rawDerived.get(asOf);
    if (cached) return cached;
    const result = await this.options.snapshots?.derived(asOf);
    if (typeof result !== "string") return null;
    this.rawDerived.set(asOf, result);
    return result;
  }

  /** Sandbox bank ledger (`/api/bank/transactions`). */
  async getTransactions(): Promise<Transaction[]> {
    return (await (await this.load()).rest()).transactions;
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
    const { ledger } = await (await this.load()).rest();
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
    const { ledger } = await (await this.load()).rest();
    try {
      return pivotCell(ledger, rowId, periodKey, granularity);
    } catch {
      return null; // unknown row id / period key → 404 at the route
    }
  }

  async getCalendarEvents(from: ISODate, to: ISODate): Promise<CalendarEvent[]> {
    const { ledger, recurring } = await (await this.load()).rest();
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
    const { transactions } = await (await this.load()).rest();
    const derived = await this.getDerived();
    return selectTransactions(listFromPostedTransactions(transactions, derived.classifications), query);
  }
}
