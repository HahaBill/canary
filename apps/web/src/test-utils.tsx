/**
 * Shared test scaffolding: a fetch stub that answers the real routes from the
 * bundled fixtures, and a viewport helper.
 *
 * Going through `fetch` rather than `VITE_USE_MOCK` is deliberate — it is the
 * only way to assert what the client actually asks for (query params, method)
 * while the data stays deterministic.
 */
import { render, type RenderResult } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import {
  fakeLedgerProposer,
  interpretLedgerFilter,
  type AskCanaryResponse,
  type AvailabilityResponse,
  type CalendarConnectionResponse,
  type CashCalendar,
  type PivotGranularity,
  type ScoutPage,
} from "@canary/shared";
import App from "@/App.tsx";
import {
  mockAvailability,
  mockCalendar,
  mockCalendarConnection,
  mockClassificationOverride,
  mockDemo,
  mockIncidentDetail,
  mockIncidents,
  mockLedger,
  mockLedgerCell,
  mockNeedsReview,
  mockScout,
} from "@/api/mock.ts";

export interface RecordedRequest {
  method: string;
  path: string;
  params: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function headerRecord(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const headers = init?.headers;
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => (out[key.toLowerCase()] = value));
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key.toLowerCase()] = value;
  } else {
    for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = String(value);
  }
  return out;
}

/**
 * Installs a `fetch` that serves the view routes from `api/mock.ts` (which owns
 * the session snapshot, so overrides stick). Returns the recorded requests.
 */
export function installApiStub(
  options: {
    scout?: ScoutPage;
    scoutRefresh?: ScoutPage;
    refreshDelayMs?: number;
    askCanary?: AskCanaryResponse;
    askCanaryStatus?: number;
    calendarConnection?: CalendarConnectionResponse;
    availability?: AvailabilityResponse;
    calendar?: CashCalendar;
  } = {},
): { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];

  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = headerRecord(init);
    requests.push({ method, path: url.pathname, params: url.searchParams, headers, body });

    const granularity = (url.searchParams.get("granularity") ?? "month") as PivotGranularity;

    if (url.pathname === "/api/demo") return Promise.resolve(jsonResponse(mockDemo()));
    if (url.pathname === "/api/incidents") {
      return Promise.resolve(jsonResponse({ incidents: mockIncidents() }));
    }
    if (url.pathname.startsWith("/api/incidents/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/incidents/".length));
      const detail = mockIncidentDetail(id);
      return Promise.resolve(detail ? jsonResponse(detail) : jsonResponse({ error: "Not found" }, 404));
    }
    if (url.pathname === "/api/ledger") {
      return Promise.resolve(jsonResponse({ pivot: mockLedger(granularity) }));
    }
    if (url.pathname === "/api/ledger/query") {
      const payload = body as { q?: string; granularity?: string } | undefined;
      const q = typeof payload?.q === "string" ? payload.q : "";
      const grain = (typeof payload?.granularity === "string" ? payload.granularity : granularity) as PivotGranularity;
      const pivot = mockLedger(grain);
      return interpretLedgerFilter(q, pivot, fakeLedgerProposer).then((result) => jsonResponse(result));
    }
    if (url.pathname === "/api/ledger/cell") {
      const detail = mockLedgerCell(
        url.searchParams.get("row_id") ?? "",
        url.searchParams.get("period_key") ?? "",
        granularity,
      );
      return Promise.resolve(jsonResponse({ detail }));
    }
    if (url.pathname === "/api/calendar/connection") {
      return Promise.resolve(jsonResponse(options.calendarConnection ?? mockCalendarConnection()));
    }
    if (url.pathname === "/api/calendar") {
      const calendar =
        options.calendar ??
        mockCalendar(url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? "");
      return Promise.resolve(jsonResponse({ calendar }));
    }
    if (url.pathname === "/api/availability") {
      return Promise.resolve(jsonResponse(options.availability ?? mockAvailability()));
    }
    if (url.pathname === "/api/needs-review") return Promise.resolve(jsonResponse(mockNeedsReview()));
    if (url.pathname === "/api/scout") {
      return Promise.resolve(jsonResponse(options.scout ?? mockScout()));
    }
    if (url.pathname === "/api/scout/refresh") {
      const refreshBody = options.scoutRefresh ?? options.scout ?? mockScout();
      if (options.refreshDelayMs) {
        return new Promise((resolve) => {
          setTimeout(() => resolve(jsonResponse(refreshBody)), options.refreshDelayMs);
        });
      }
      return Promise.resolve(jsonResponse(refreshBody));
    }
    if (url.pathname === "/api/ask-canary") {
      if (options.askCanaryStatus && options.askCanaryStatus >= 400) {
        return Promise.resolve(jsonResponse({ error: "elevenlabs_unavailable", detail: "down" }, options.askCanaryStatus));
      }
      return Promise.resolve(jsonResponse(options.askCanary ?? { configured: false }));
    }
    if (url.pathname === "/api/classifications/override") {
      return Promise.resolve(jsonResponse(mockClassificationOverride(body)));
    }

    return Promise.resolve(jsonResponse({ error: `Unstubbed route ${url.pathname}` }, 404));
  });

  return { requests };
}

/** Drives `useMediaQuery` — both the `matchMedia` path and the width fallback. */
export function setViewport(width: number): void {
  window.innerWidth = width;
  vi.stubGlobal("matchMedia", (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    return {
      matches: min ? width >= Number(min[1]) : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });
}

export function renderApp(path: string): RenderResult {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}
