/**
 * Typed fetchers for the Worker API. Paths are derived from `API_ROUTES` in
 * `@canary/shared` so the client cannot drift from the contract, and they stay
 * relative so the SPA works wherever the Worker mounts it.
 */
import {
  API_ROUTES,
  type AlertHistoryItem,
  type AlertHistoryResponse,
  type AskCanaryResponse,
  type AvailabilityResponse,
  type CalendarResponse,
  type CashCalendar,
  type ClassificationOverrideRequest,
  type ClassificationOverrideResponse,
  type DemoResponse,
  type ErrorResponse,
  type Incident,
  type IncidentDetailResponse,
  type IncidentStatus,
  type IncidentStatusRequest,
  type IncidentsResponse,
  type ISODate,
  type LedgerCellResponse,
  type LedgerFilterQueryResponse,
  type LedgerResponse,
  type LedgerPivot,
  type NeedsReviewResponse,
  type PivotCellDetail,
  type PivotGranularity,
  type ScoutRefreshResponse,
  type ScoutResponse,
  type SimulateRequest,
  type SimulateResponse,
  type WhatIfRequest,
} from "@canary/shared";

/** Why a call failed — `useDerived` uses this to decide whether to fall back to fixtures. */
export type ApiErrorKind = "network" | "http" | "parse";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly detail?: string;

  constructor(message: string, kind: ApiErrorKind, status = 0, detail?: string) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    if (detail !== undefined) this.detail = detail;
  }

  /** A 404 is a real answer ("no such incident"), not a dead backend. */
  get isNotFound(): boolean {
    return this.kind === "http" && this.status === 404;
  }

  /** Nothing usable came back, so serving fixtures instead is reasonable in dev. */
  get isUnreachable(): boolean {
    return this.kind !== "http" || this.status >= 500;
  }
}

/** `"GET /api/incidents/:id"` + `{ id }` → `"/api/incidents/inc_x"`. */
function routePath(route: string, params: Record<string, string> = {}): string {
  const path = route.slice(route.indexOf(" ") + 1);
  return path.replace(/:([A-Za-z_]+)/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) throw new Error(`Missing route param "${key}" for ${route}`);
    return encodeURIComponent(value);
  });
}

/** Appends only the params that are set, so defaults stay the server's business. */
function withQuery(path: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, value);
  }
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
    });
  } catch (cause) {
    throw new ApiError(`Could not reach ${path}`, "network", 0, cause instanceof Error ? cause.message : undefined);
  }

  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    // A built SPA without the Worker in front of it answers /api/* with index.html.
    throw new ApiError(`${path} did not return JSON`, "parse", response.status);
  }

  if (!response.ok) {
    const err = parsed as ErrorResponse | null;
    throw new ApiError(err?.error ?? `Request failed (${response.status})`, "http", response.status, err?.detail);
  }
  return parsed as T;
}

export function getDemo(signal?: AbortSignal): Promise<DemoResponse> {
  return request<DemoResponse>(routePath(API_ROUTES.demo), signal ? { signal } : undefined);
}

export function getIncidents(signal?: AbortSignal): Promise<Incident[]> {
  return request<IncidentsResponse>(routePath(API_ROUTES.incidents), signal ? { signal } : undefined).then(
    (r) => r.incidents,
  );
}

export function getIncident(id: string, signal?: AbortSignal): Promise<IncidentDetailResponse> {
  return request<IncidentDetailResponse>(
    routePath(API_ROUTES.incident, { id }),
    signal ? { signal } : undefined,
  );
}

export function simulate(req: WhatIfRequest, signal?: AbortSignal): Promise<SimulateResponse> {
  const body: SimulateRequest = req;
  return request<SimulateResponse>(routePath(API_ROUTES.simulate), {
    method: "POST",
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

/**
 * `api.ts` declares the request body but no response type for this route, so we
 * accept either `{ incident }` or a bare `Incident` (see "Contract gaps").
 */
export async function setIncidentStatus(id: string, status: IncidentStatus): Promise<Incident | null> {
  const body: IncidentStatusRequest = { status };
  const result = await request<{ incident?: Incident } | Incident>(
    routePath(API_ROUTES.incidentStatus, { id }),
    { method: "POST", body: JSON.stringify(body) },
  );
  if (result && typeof result === "object" && "incident" in result) return result.incident ?? null;
  return (result as Incident) ?? null;
}

/**
 * Outbound alerts and inbound founder replies, newest first. Optional chrome:
 * callers hide the strip on failure rather than surfacing an error.
 */
export function getAlertHistory(limit = 8, signal?: AbortSignal): Promise<AlertHistoryItem[]> {
  const path = `${routePath(API_ROUTES.alertHistory)}?limit=${encodeURIComponent(String(limit))}`;
  return request<AlertHistoryResponse>(path, signal ? { signal } : undefined).then((r) => r.items ?? []);
}

/**
 * The rendered voice note for an incident as `audio/mpeg`. `API_ROUTES` has no
 * entry for it (see "Contract gaps"), so the path is composed from the incident
 * route rather than hand-written. A 503 means TTS is not configured, which is a
 * normal deployment state, not a failure.
 */
export async function getIncidentVoice(id: string, signal?: AbortSignal): Promise<Blob> {
  const path = `${routePath(API_ROUTES.incident, { id })}/voice`;

  let response: Response;
  try {
    response = await fetch(path, { headers: { Accept: "audio/mpeg" }, ...(signal ? { signal } : {}) });
  } catch (cause) {
    throw new ApiError(`Could not reach ${path}`, "network", 0, cause instanceof Error ? cause.message : undefined);
  }

  if (!response.ok) {
    throw new ApiError(
      response.status === 503 ? "Voice not configured" : `Request failed (${response.status})`,
      "http",
      response.status,
    );
  }
  return response.blob();
}

// ---------------------------------------------------------------------------
// Views (ledger sheet, cash calendar, needs review)
// ---------------------------------------------------------------------------

export function getLedger(granularity: PivotGranularity, signal?: AbortSignal): Promise<LedgerPivot> {
  const path = withQuery(routePath(API_ROUTES.ledger), { granularity });
  return request<LedgerResponse>(path, signal ? { signal } : undefined).then((r) => r.pivot);
}

export function getLedgerCell(
  rowId: string,
  periodKey: string,
  granularity: PivotGranularity,
  signal?: AbortSignal,
): Promise<PivotCellDetail> {
  const path = withQuery(routePath(API_ROUTES.ledgerCell), {
    row_id: rowId,
    period_key: periodKey,
    granularity,
  });
  return request<LedgerCellResponse>(path, signal ? { signal } : undefined).then((r) => r.detail);
}

export function queryLedgerFilter(q: string, granularity: PivotGranularity): Promise<LedgerFilterQueryResponse> {
  return request<LedgerFilterQueryResponse>(routePath(API_ROUTES.ledgerQuery), {
    method: "POST",
    body: JSON.stringify({ q, granularity }),
  });
}

export function getCalendar(from: ISODate, to: ISODate, signal?: AbortSignal): Promise<CashCalendar> {
  const path = withQuery(routePath(API_ROUTES.calendar), { from, to });
  return request<CalendarResponse>(path, signal ? { signal } : undefined).then((r) => r.calendar);
}

export function getAvailability(signal?: AbortSignal): Promise<AvailabilityResponse> {
  return request<AvailabilityResponse>(routePath(API_ROUTES.availability), signal ? { signal } : undefined);
}

export function getNeedsReview(signal?: AbortSignal): Promise<NeedsReviewResponse> {
  return request<NeedsReviewResponse>(routePath(API_ROUTES.needsReview), signal ? { signal } : undefined);
}

export function getScout(signal?: AbortSignal): Promise<ScoutResponse> {
  return request<ScoutResponse>(routePath(API_ROUTES.scout), signal ? { signal } : undefined);
}

export function refreshScout(signal?: AbortSignal): Promise<ScoutRefreshResponse> {
  return request<ScoutRefreshResponse>(routePath(API_ROUTES.scoutRefresh), {
    method: "POST",
    ...(signal ? { signal } : {}),
  });
}

/** Fresh on every call — the signed URL expires in minutes and must not be cached. */
export function getAskCanary(signal?: AbortSignal): Promise<AskCanaryResponse> {
  return request<AskCanaryResponse>(routePath(API_ROUTES.askCanary), signal ? { signal } : undefined);
}

/**
 * Writes are guarded by the shared operator secret (the same one the Sendblue
 * webhook checks), so the header is required rather than optional.
 */
export function postClassificationOverride(
  body: ClassificationOverrideRequest,
  secret: string,
): Promise<ClassificationOverrideResponse> {
  return request<ClassificationOverrideResponse>(routePath(API_ROUTES.classificationOverride), {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "x-canary-secret": secret },
  });
}
