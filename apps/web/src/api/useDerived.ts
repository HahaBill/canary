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
  DemoResponse,
  Incident,
  IncidentDetailResponse,
  IncidentStatus,
  SimulateResponse,
  WhatIfRequest,
} from "@canary/shared";
import { ApiError, getDemo, getIncident, setIncidentStatus, simulate } from "./client.ts";
import { mockDemo, mockIncidentDetail, mockSetIncidentStatus, mockSimulate } from "./mock.ts";

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
  return import.meta.env.VITE_USE_MOCK === "1";
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

/** Bumped on every cache clear so all mounted hooks re-run, not just the caller. */
let cacheVersion = 0;
const cacheListeners = new Set<() => void>();

function subscribeToCache(onChange: () => void): () => void {
  cacheListeners.add(onChange);
  return () => cacheListeners.delete(onChange);
}

/** Drop cached responses (used by the retry buttons and by tests). */
export function clearApiCache(): void {
  activeSource = null;
  demoRequest = null;
  incidentRequests.clear();
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

/** Shared loading/error/cancellation machinery. `key` identifies the resource. */
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

  useEffect(() => {
    let active = true;
    setState({ data: null, loading: true, error: null, source: null });
    loadRef
      .current()
      .then(({ data, source }) => {
        if (active) setState({ data, loading: false, error: null, source });
      })
      .catch((err: unknown) => {
        if (active) setState({ data: null, loading: false, error: messageOf(err), source: null });
      });
    return () => {
      active = false;
    };
  }, [key, version]);

  return { ...state, reload: clearApiCache };
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
