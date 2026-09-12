/**
 * The ONLY seam between the Worker and Canary's financial data.
 *
 * Routes never touch fixtures, the pipeline, or D1 directly — they go through
 * `DataProvider`. `MockDataProvider` serves `buildMockDerived()` so the API can
 * ship before the pipeline exists; the lead swaps in a pipeline-backed
 * implementation without touching a single route.
 */
import type {
  DerivedDemoObject,
  Incident,
  IncidentStatus,
  ISODateTime,
  VendorEnrichment,
  WhatIfRequest,
  WhatIfResult,
} from "@canary/shared";
import { buildMockDerived, mockWhatIf } from "@canary/shared/fixtures";
import { whatIfSpeech } from "../speech.ts";
import { D1Store, type SqlDatabase } from "./d1.ts";

export interface DataProvider {
  getDerived(): Promise<DerivedDemoObject>;
  getIncident(id: string): Promise<Incident | null>;
  updateIncidentStatus(id: string, status: IncidentStatus, now: ISODateTime): Promise<Incident | null>;
  markNotified(id: string, now: ISODateTime): Promise<void>;
  getEnrichment(entity: string): Promise<VendorEnrichment | null>;
  /** Deterministic what-if. Backed by `@canary/engine`'s `simulateCostChange` at integration. */
  simulate(req: WhatIfRequest): Promise<WhatIfResult>;
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

  constructor(derived: DerivedDemoObject = buildMockDerived()) {
    this.base = derived;
  }

  async getDerived(): Promise<DerivedDemoObject> {
    return applyOverlay(this.base, this.overlay);
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
    return { ...result, speech: whatIfSpeech(result) };
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

  return {
    getDerived,
    async getIncident(id) {
      const derived = await getDerived();
      return derived.incidents.find((i) => i.id === id) ?? null;
    },
    async updateIncidentStatus(id, status, now) {
      const updated = await provider.updateIncidentStatus(id, status, now);
      await persist(updated);
      return updated;
    },
    async markNotified(id, now) {
      await provider.markNotified(id, now);
      await persist(await provider.getIncident(id));
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
  };
}
