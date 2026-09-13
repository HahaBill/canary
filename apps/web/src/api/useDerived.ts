/**
 * Data hooks with loading/error state, and the single place that decides
 * whether the app is reading the real API or the offline fixtures.
 *
 * Resolution order:
 *   1. `VITE_USE_MOCK=1`        → fixtures ("mock-forced")
 *   2. API answers              → live data ("live")
 *   3. API unreachable, dev only → fixtures ("mock-fallback")
 *
 * The active source is returned so the UI can say which one is in play.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  AlertHistoryItem,
  AvailabilityResponse,
  CalendarConnectionResponse,
  CashCalendar,
  ClassificationOverrideRequest,
  ClassificationOverrideResponse,
  DemoResponse,
  Incident,
  IncidentDetailResponse,
  IncidentStatus,
  ISODate,
  LedgerPivot,
  NeedsReviewResponse,
  PivotCellDetail,
  PivotGranularity,
  ScoutPage,
  SimulateResponse,
  WhatIfRequest,
} from "@canary/shared";
import {
  ApiError,
  getAlertHistory,
  getAvailability,
  getCalendar,
  getCalendarConnection,
  getDemo,
  getIncident,
  getLedger,
  getLedgerCell,
  getNeedsReview,
  getScout,
  postClassificationOverride,
  refreshScout,
  setIncidentStatus,
  simulate,
} from "./client.ts";
import {
  mockAlertHistory,
  mockAvailability,
  mockCalendar,
  mockCalendarConnection,
  mockClassificationOverride,
  mockDemo,
  mockIncidentDetail,
  mockLedger,
  mockLedgerCell,
  mockNeedsReview,
  mockScout,
  mockSetIncidentStatus,
  mockSimulate,
} from "./mock.ts";

export type DataSource = "live" | "mock-forced" | "mock-fallback";

export interface AsyncResource<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  source: DataSource | null;
  reload: () => void;
}

interface Loaded<T> {
  data: T;
  source: DataSource;
}

/** Read at call time (not module load) so tests can stub the env. */
function forceMock(): boolean {
  // Fixtures can only ever be forced in dev; a production build ignores the flag.
  return import.meta.env.DEV && import.meta.env.VITE_USE_MOCK === "1";
}

/** Falling back to fixtures is a dev convenience; production shows the error. */
function fallbackAllowed(): boolean {
  return import.meta.env.DEV === true;
}

/** Sticks after a fallback so every later call agrees on the source. */
let activeSource: DataSource | null = null;
/** De-dupes concurrent/StrictMode-doubled loads of the same resource. */
let demoRequest: Promise<Loaded<DemoResponse>> | null = null;
const incidentRequests = new Map<string, Promise<Loaded<IncidentDetailResponse | null>>>();
/** One entry per resource key (granularity, date range, cell coordinates, …). */
const viewRequests = new Map<string, Promise<Loaded<unknown>>>();

/** Bumped on every cache clear so all mounted hooks re-run, not just the caller. */
let cacheVersion = 0;
const cacheListeners = new Set<() => void>();

function subscribeToCache(onChange: () => void): () => void {
  cacheListeners.add(onChange);
  return () => cacheListeners.delete(onChange);
}

/** Test-only window into cache notifications; production uses the hooks. */
export function subscribeToCacheForTests(onChange: () => void): () => void {
  return subscribeToCache(onChange);
}

/** Drop cached responses (used by the retry buttons and by tests). */
export function clearApiCache(): void {
  activeSource = null;
  demoRequest = null;
  incidentRequests.clear();
  viewRequests.clear();
  cacheVersion += 1;
  for (const listener of cacheListeners) listener();
}

function mockSource(): DataSource {
  return forceMock() ? "mock-forced" : "mock-fallback";
}

function usingFixtures(): boolean {
  return forceMock() || activeSource === "mock-fallback";
}

async function loadDemo(): Promise<Loaded<DemoResponse>> {
  if (usingFixtures()) {
    activeSource = mockSource();
    return { data: mockDemo(), source: activeSource };
  }
  try {
    const data = await getDemo();
    activeSource = "live";
    return { data, source: "live" };
  } catch (err) {
    if (fallbackAllowed() && err instanceof ApiError && err.isUnreachable) {
      activeSource = "mock-fallback";
      return { data: mockDemo(), source: "mock-fallback" };
    }
    throw err;
  }
}

async function loadIncident(id: string): Promise<Loaded<IncidentDetailResponse | null>> {
  if (usingFixtures()) {
    activeSource = mockSource();
    return { data: mockIncidentDetail(id), source: activeSource };
  }
  try {
    const data = await getIncident(id);
    activeSource = "live";
    return { data, source: "live" };
  } catch (err) {
    if (err instanceof ApiError && err.isNotFound) {
      activeSource = "live";
      return { data: null, source: "live" };
    }
    if (fallbackAllowed() && err instanceof ApiError && err.isUnreachable) {
      activeSource = "mock-fallback";
      return { data: mockIncidentDetail(id), source: "mock-fallback" };
    }
    throw err;
  }
}

async function runSimulate(req: WhatIfRequest): Promise<Loaded<SimulateResponse>> {
  if (usingFixtures()) {
    activeSource = mockSource();
    return { data: mockSimulate(req), source: activeSource };
  }
  try {
    const data = await simulate(req);
    activeSource = "live";
    return { data, source: "live" };
  } catch (err) {
    if (fallbackAllowed() && err instanceof ApiError && err.isUnreachable) {
      activeSource = "mock-fallback";
      return { data: mockSimulate(req), source: "mock-fallback" };
    }
    throw err;
  }
}

/** Routed through the same source resolution as reads. */
export async function updateIncidentStatus(id: string, status: IncidentStatus): Promise<Incident | null> {
  if (usingFixtures()) return mockSetIncidentStatus(id, status);
  return setIncidentStatus(id, status);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Shared loading/error/cancellation machinery. `key` identifies the resource.
 *
 * STALE-WHILE-REVALIDATE. The demo clock advances the backend a simulated day
 * at a time, and the live heartbeat (`startLiveRefresh`) clears the cache to
 * pick that up. A refresh must therefore keep showing the numbers it already
 * has while the new ones load — resetting to skeletons would make the whole
 * dashboard blink on every heartbeat, which reads as broken, not live. Data is
 * only dropped when the KEY changes (a different incident, a different range):
 * showing the previous resource under a new key would be showing the wrong data.
 */
function useAsyncResource<T>(key: string, load: () => Promise<Loaded<T>>): AsyncResource<T> {
  const loadRef = useRef(load);
  loadRef.current = load;

  const version = useSyncExternalStore(subscribeToCache, () => cacheVersion);
  const [state, setState] = useState<Omit<AsyncResource<T>, "reload">>({
    data: null,
    loading: true,
    error: null,
    source: null,
  });
  const lastKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    const keyChanged = lastKeyRef.current !== key;
    lastKeyRef.current = key;
    setState((prev) =>
      keyChanged || prev.data === null
        ? { data: null, loading: true, error: null, source: null }
        : { ...prev, loading: true, error: null },
    );
    loadRef
      .current()
      .then(({ data, source }) => {
        if (active) setState({ data, loading: false, error: null, source });
      })
      .catch((err: unknown) => {
        if (!active) return;
        setState((prev) => {
          // A failed BACKGROUND refresh keeps the numbers already on screen: a
          // blip in the heartbeat must never turn a working dashboard into an
          // error page mid-demo. The next heartbeat retries; the console keeps
          // the evidence. A failed FIRST load still reports normally.
          if (prev.data !== null) {
            console.warn(`canary: background refresh of ${key} failed; keeping previous data`, err);
            return { ...prev, loading: false };
          }
          return { data: null, loading: false, error: messageOf(err), source: null };
        });
      });
    return () => {
      active = false;
    };
  }, [key, version]);

  return { ...state, reload: clearApiCache };
}

/**
 * The heartbeat that makes the dashboard live. The backend's demo clock moves a
 * simulated day every thirty seconds; this clears the response cache on an
 * interval so every mounted hook re-fetches and the new day appears in place —
 * cash ticks, the "as of" date in the provenance banner rolls forward, and a
 * transaction posts while a founder watches. Hidden tabs skip the work.
 *
 * SEVEN SECONDS, not thirty. The interval has to be a fraction of a simulated
 * day or the page lags the backend by most of a day, and someone watching for
 * twenty seconds sees nothing change and reasonably concludes the numbers are
 * hardcoded. A refresh is cheap — one cached pipeline run the Worker already
 * keeps warm per simulated day — and it is invisible, because the data on
 * screen is kept until the new data lands.
 *
 * Started once from main.tsx. Never started by tests, which is the point of it
 * living behind an explicit call instead of a module side effect.
 */
export function startLiveRefresh(intervalMs = 7_000): () => void {
  const tick = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    clearApiCache();
  };
  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
}

/** The whole derived demo object: provenance, company, cash, burn, incidents. */
export function useDerived(): AsyncResource<DemoResponse> {
  return useAsyncResource("demo", () => {
    demoRequest ??= loadDemo().catch((err: unknown) => {
      demoRequest = null;
      throw err;
    });
    return demoRequest;
  });
}

/** `null` data with no error means "no such incident" → render the 404 state. */
export function useIncidentDetail(id: string): AsyncResource<IncidentDetailResponse | null> {
  return useAsyncResource(`incident:${id}`, () => {
    let pending = incidentRequests.get(id);
    if (!pending) {
      pending = loadIncident(id).catch((err: unknown) => {
        incidentRequests.delete(id);
        throw err;
      });
      incidentRequests.set(id, pending);
    }
    return pending;
  });
}

// ---------------------------------------------------------------------------
// Views (ledger sheet, cash calendar, needs review)
// ---------------------------------------------------------------------------

/**
 * Same three-way resolution as the reads above, for routes whose only
 * difference is the fetcher and the fixture builder.
 */
async function loadView<T>(fetchLive: () => Promise<T>, buildMock: () => T): Promise<Loaded<T>> {
  if (usingFixtures()) {
    activeSource = mockSource();
    return { data: buildMock(), source: activeSource };
  }
  try {
    const data = await fetchLive();
    activeSource = "live";
    return { data, source: "live" };
  } catch (err) {
    if (fallbackAllowed() && err instanceof ApiError && err.isUnreachable) {
      activeSource = "mock-fallback";
      return { data: buildMock(), source: "mock-fallback" };
    }
    throw err;
  }
}

/** De-dupes concurrent loads of the same view and feeds `useAsyncResource`. */
function useView<T>(key: string, fetchLive: () => Promise<T>, buildMock: () => T): AsyncResource<T> {
  return useAsyncResource(key, () => {
    let pending = viewRequests.get(key) as Promise<Loaded<T>> | undefined;
    if (!pending) {
      pending = loadView(fetchLive, buildMock).catch((err: unknown) => {
        viewRequests.delete(key);
        throw err;
      });
      viewRequests.set(key, pending as Promise<Loaded<unknown>>);
    }
    return pending;
  });
}

/** The ledger pivot at one granularity. */
export function useLedger(granularity: PivotGranularity): AsyncResource<LedgerPivot> {
  return useView(
    `ledger:${granularity}`,
    () => getLedger(granularity),
    () => mockLedger(granularity),
  );
}

/** Transactions behind one vendor × period cell. Mount only while the sheet is open. */
export function useLedgerCell(
  rowId: string,
  periodKey: string,
  granularity: PivotGranularity,
): AsyncResource<PivotCellDetail> {
  return useView(
    `ledger-cell:${granularity}:${rowId}:${periodKey}`,
    () => getLedgerCell(rowId, periodKey, granularity),
    () => mockLedgerCell(rowId, periodKey, granularity),
  );
}

/** Founder free/busy for an inclusive date range (one visible month). */
export function useCalendar(from: ISODate, to: ISODate): AsyncResource<CashCalendar> {
  return useView(
    `calendar:${from}:${to}`,
    () => getCalendar(from, to),
    () => mockCalendar(from, to),
  );
}

export function useCalendarConnection(): AsyncResource<CalendarConnectionResponse> {
  return useView("calendar-connection", getCalendarConnection, mockCalendarConnection);
}

export function useAvailability(): AsyncResource<AvailabilityResponse> {
  return useView("availability", getAvailability, mockAvailability);
}

export function useNeedsReview(): AsyncResource<NeedsReviewResponse> {
  return useView("needs-review", getNeedsReview, mockNeedsReview);
}

export function useScout(): AsyncResource<ScoutPage> {
  return useView("scout", getScout, mockScout);
}

export async function refreshScoutSources(): Promise<ScoutPage> {
  if (usingFixtures()) return mockScout();
  return refreshScout();
}

/** Routed through the same source resolution as reads. */
export async function submitClassificationOverride(
  req: ClassificationOverrideRequest,
): Promise<ClassificationOverrideResponse> {
  if (usingFixtures()) return mockClassificationOverride(req);
  return postClassificationOverride(req);
}

/**
 * Debounced what-if. Pass `null` to stay idle. The first request fires
 * immediately; later ones wait for the slider to settle.
 */
export function useSimulate(
  req: WhatIfRequest | null,
  debounceMs = 250,
): Omit<AsyncResource<SimulateResponse>, "reload"> {
  const [state, setState] = useState<Omit<AsyncResource<SimulateResponse>, "reload">>({
    data: null,
    loading: req !== null,
    error: null,
    source: null,
  });
  const firstRun = useRef(true);
  const key = req ? `${req.entity}:${req.percentage}` : null;
  const reqRef = useRef(req);
  reqRef.current = req;

  useEffect(() => {
    if (key === null) {
      setState({ data: null, loading: false, error: null, source: null });
      return;
    }
    let active = true;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    const delay = firstRun.current ? 0 : debounceMs;
    firstRun.current = false;

    const timer = setTimeout(() => {
      const pending = reqRef.current;
      if (!pending) return;
      runSimulate(pending)
        .then(({ data, source }) => {
          if (active) setState({ data, loading: false, error: null, source });
        })
        .catch((err: unknown) => {
          if (active) setState({ data: null, loading: false, error: messageOf(err), source: null });
        });
    }, delay);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [key, debounceMs]);

  return state;
}

async function loadAlertHistory(limit: number): Promise<Loaded<AlertHistoryItem[]>> {
  if (usingFixtures()) {
    activeSource = mockSource();
    return { data: mockAlertHistory(limit), source: activeSource };
  }
  try {
    const data = await getAlertHistory(limit);
    activeSource = "live";
    return { data, source: "live" };
  } catch (err) {
    if (fallbackAllowed() && err instanceof ApiError && err.isUnreachable) {
      activeSource = "mock-fallback";
      return { data: mockAlertHistory(limit), source: "mock-fallback" };
    }
    throw err;
  }
}

/**
 * The iMessage conversation. Optional chrome: the route is not implemented on
 * every deployment, so callers render nothing on error rather than an error
 * state. Not cached alongside the derived object — it changes independently.
 */
export function useAlertHistory(limit = 8): AsyncResource<AlertHistoryItem[]> {
  return useAsyncResource(`alerts:${limit}`, () => loadAlertHistory(limit));
}
