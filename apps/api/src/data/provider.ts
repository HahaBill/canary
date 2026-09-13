/**
 * The ONLY seam between the Worker and Canary's financial data.
 *
 * Routes never touch fixtures, the pipeline, or D1 directly — they go through
 * `DataProvider`. `MockDataProvider` serves `buildMockDerived()` so the API can
 * ship before the pipeline exists; the lead swaps in a pipeline-backed
 * implementation without touching a single route.
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
  VendorEnrichment,
  WhatIfRequest,
  WhatIfResult,
} from "@canary/shared";
import { buildMockDerived, mockWhatIf } from "@canary/shared/fixtures";
import { noChangeExplanation, whatIfSpeech } from "../speech.ts";
import { D1Store, type SqlDatabase } from "./d1.ts";
import { mockCalendarEvents, mockLedgerPivot, mockPivotCell, needsReviewItems } from "./mock-views.ts";
import { listFromWeeklyBuckets, selectTransactions, type TransactionListQuery, type TransactionSelection } from "./transactions.ts";

export interface DataProvider {
  getDerived(): Promise<DerivedDemoObject>;
  /**
   * Pre-serialized `DemoResponse` for the current as-of, when a snapshot exists.
   * `null` → the route builds the body from `getDerived()` (tests, overlays).
   */
  getDemoJson(): Promise<string | null>;
  getIncident(id: string): Promise<Incident | null>;
  updateIncidentStatus(id: string, status: IncidentStatus, now: ISODateTime): Promise<Incident | null>;
  markNotified(id: string, now: ISODateTime): Promise<void>;
  getEnrichment(entity: string): Promise<VendorEnrichment | null>;
  /** Deterministic what-if. Backed by `@canary/engine`'s `simulateCostChange` at integration. */
  simulate(req: WhatIfRequest): Promise<WhatIfResult>;
  /** The ledger sheet. `@canary/engine`'s `pivotLedger` at integration. */
  getLedgerPivot(granularity: PivotGranularity): Promise<LedgerPivot>;
  /** Transactions behind one cell; null when the row or period does not exist. */
  getLedgerCell(rowId: string, periodKey: string, granularity: PivotGranularity): Promise<PivotCellDetail | null>;
  /** Actual + expected + canary events. Busy blocks come from the calendar feed, not here. */
  getCalendarEvents(from: ISODate, to: ISODate): Promise<CalendarEvent[]>;
  getNeedsReview(): Promise<NeedsReviewResponse["items"]>;
  /** Applies a reviewer's decision and returns the remaining Needs Review count. */
  applyClassificationOverride(o: ClassificationOverride): Promise<{ needs_review_count: number }>;
  /** Newest matching ledger rows. Capped — never the whole history. */
  listTransactions(query?: TransactionListQuery): Promise<TransactionSelection>;
}

interface StatusOverlay {
  status: IncidentStatus;
  last_updated: ISODateTime;
  last_notified: ISODateTime | null;
}

/** Re-project a derived object with per-incident status overrides applied. */
function applyOverlay(base: DerivedDemoObject, overlay: ReadonlyMap<string, StatusOverlay>): DerivedDemoObject {
  if (overlay.size === 0) return base;
  const byId = new Map<string, Incident>();
  const incidents = base.incidents.map((incident) => {
    const patch = overlay.get(incident.id);
    const next = patch ? { ...incident, ...patch } : incident;
    byId.set(next.id, next);
    return next;
  });
  const relink = (incident: Incident | null): Incident | null => (incident ? (byId.get(incident.id) ?? incident) : null);
  return {
    ...base,
    incidents,
    primary_incident: relink(base.primary_incident),
    one_off_incident: relink(base.one_off_incident),
  };
}

/**
 * In-memory provider over a `DerivedDemoObject` (mock fixture by default).
 * Status changes live in an overlay map so the underlying object stays pure —
 * two providers over the same fixture never leak state into each other.
 */
export class MockDataProvider implements DataProvider {
  private readonly base: DerivedDemoObject;
  private readonly overlay = new Map<string, StatusOverlay>();
  /** Transaction ids a reviewer has categorised, so they leave Needs Review. */
  private readonly reviewed = new Set<string>();
  /** Merchants categorised with `apply_to_merchant`. */
  private readonly reviewedMerchants = new Set<string>();

  constructor(derived: DerivedDemoObject = buildMockDerived()) {
    this.base = derived;
  }

  async getDerived(): Promise<DerivedDemoObject> {
    return applyOverlay(this.base, this.overlay);
  }

  async getDemoJson(): Promise<string | null> {
    return null;
  }

  async getIncident(id: string): Promise<Incident | null> {
    const derived = await this.getDerived();
    return derived.incidents.find((i) => i.id === id) ?? null;
  }

  async updateIncidentStatus(id: string, status: IncidentStatus, now: ISODateTime): Promise<Incident | null> {
    const current = await this.getIncident(id);
    if (!current) return null;
    this.overlay.set(id, { status, last_updated: now, last_notified: current.last_notified });
    return this.getIncident(id);
  }

  async markNotified(id: string, now: ISODateTime): Promise<void> {
    const current = await this.getIncident(id);
    if (!current) return;
    this.overlay.set(id, { status: current.status, last_updated: now, last_notified: now });
  }

  async getEnrichment(entity: string): Promise<VendorEnrichment | null> {
    const derived = await this.getDerived();
    return derived.vendor_enrichments.find((e) => e.merchant_normalized === entity) ?? null;
  }

  async simulate(req: WhatIfRequest): Promise<WhatIfResult> {
    const derived = await this.getDerived();
    const result = mockWhatIf(derived, req.entity, req.percentage) as WhatIfResult;
    // The fixture ships placeholder speech; render it from shared helpers instead.
    const noChangeReason = noChangeExplanation(derived, req.entity, req.percentage);
    return {
      ...result,
      no_change_reason: noChangeReason,
      speech: whatIfSpeech(result, noChangeReason),
    };
  }

  async getLedgerPivot(granularity: PivotGranularity): Promise<LedgerPivot> {
    return mockLedgerPivot(await this.getDerived(), granularity);
  }

  async getLedgerCell(rowId: string, periodKey: string, granularity: PivotGranularity): Promise<PivotCellDetail | null> {
    return mockPivotCell(await this.getDerived(), rowId, periodKey, granularity);
  }

  async getCalendarEvents(from: ISODate, to: ISODate): Promise<CalendarEvent[]> {
    return mockCalendarEvents(await this.getDerived(), from, to);
  }

  async getNeedsReview(): Promise<NeedsReviewResponse["items"]> {
    const items = needsReviewItems(await this.getDerived());
    return items.filter((i) => !this.reviewed.has(i.transaction_id) && !this.reviewedMerchants.has(i.merchant_normalized));
  }

  async applyClassificationOverride(o: ClassificationOverride): Promise<{ needs_review_count: number }> {
    this.reviewed.add(o.transaction_id);
    if (o.apply_to_merchant && o.merchant_normalized) this.reviewedMerchants.add(o.merchant_normalized);
    return { needs_review_count: (await this.getNeedsReview()).length };
  }

  async listTransactions(query: TransactionListQuery = {}): Promise<TransactionSelection> {
    return selectTransactions(listFromWeeklyBuckets(await this.getDerived()), query);
  }
}

/**
 * Wraps any provider so incident status / last_notified and vendor
 * enrichments survive a Worker restart. Reads fall back to the inner provider;
 * D1 failures degrade to in-memory rather than failing the request.
 */
export function withD1Overlay(provider: DataProvider, db: SqlDatabase): DataProvider {
  const store = new D1Store(db);

  const overlays = async (): Promise<ReadonlyMap<string, StatusOverlay>> => {
    try {
      return await store.listIncidentOverlays();
    } catch {
      return new Map();
    }
  };

  const persist = async (incident: Incident | null): Promise<void> => {
    if (!incident) return;
    try {
      await store.saveIncident(incident);
    } catch {
      // Non-fatal: the in-memory overlay still reflects the change.
    }
  };

  const getDerived = async (): Promise<DerivedDemoObject> => applyOverlay(await provider.getDerived(), await overlays());

  const getDemoJson = async (): Promise<string | null> => {
    // A raw snapshot would skip status overlays. Only pass it through when D1
    // has nothing to apply — the usual demo isolate.
    if ((await overlays()).size > 0) return null;
    return provider.getDemoJson();
  };

  const getIncident = async (id: string): Promise<Incident | null> => {
    const derived = await getDerived();
    return derived.incidents.find((i) => i.id === id) ?? null;
  };

  return {
    getDerived,
    getDemoJson,
    getIncident,
    // Writes are resolved through the OVERLAY-AWARE view, never the inner provider's
    // pristine base object: on a cold isolate the inner provider knows nothing about a
    // status persisted by a previous isolate, and would otherwise clobber it.
    async updateIncidentStatus(id, status, now) {
      const current = await getIncident(id);
      if (!current) return null;
      const updated: Incident = { ...current, status, last_updated: now };
      await provider.updateIncidentStatus(id, status, now); // keep in-memory overlay warm
      await persist(updated);
      return updated;
    },
    async markNotified(id, now) {
      const current = await getIncident(id);
      if (!current) return;
      await provider.markNotified(id, now);
      await persist({ ...current, last_notified: now, last_updated: now });
    },
    async getEnrichment(entity) {
      try {
        const cached = await store.getEnrichment(entity);
        if (cached) return cached;
      } catch {
        // fall through to the inner provider
      }
      const enrichment = await provider.getEnrichment(entity);
      if (enrichment) {
        try {
          await store.saveEnrichment(enrichment);
        } catch {
          // Cache fill is best-effort.
        }
      }
      return enrichment;
    },
    simulate: (req) => provider.simulate(req),
    // Views are pure projections of the ledger — nothing for D1 to overlay.
    getLedgerPivot: (granularity) => provider.getLedgerPivot(granularity),
    getLedgerCell: (rowId, periodKey, granularity) => provider.getLedgerCell(rowId, periodKey, granularity),
    getCalendarEvents: (from, to) => provider.getCalendarEvents(from, to),
    getNeedsReview: () => provider.getNeedsReview(),
    applyClassificationOverride: (o) => provider.applyClassificationOverride(o),
    listTransactions: (query) => provider.listTransactions(query),
  };
}
