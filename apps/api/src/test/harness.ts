/**
 * Test harness: a real Hono app wired to a MockDataProvider, an in-memory D1,
 * and a fetch that captures Sendblue traffic instead of making it. Runs in the
 * plain Node vitest environment.
 */
import { buildMockDerived } from "@canary/shared/fixtures";
import type { DerivedDemoObject, ISODate, ISODateTime } from "@canary/shared";
import type { PendingRunSummary } from "../alerts/pending.ts";
import { createApp, createScheduled, type AppDeps } from "../app.ts";
import { GOOGLE_SCOPE_PARAM } from "../calendar/google/oauth.ts";
import { GoogleOauthStore } from "../calendar/google/store.ts";
import type { BusyStatus, CalendarFeed, CalendarFeedEvent, CalendarFeedResult } from "../calendar/ics.ts";
import type { CanaryApp } from "../context.ts";
import { MockDataProvider } from "../data/provider.ts";
import type { Env } from "../env.ts";
import type { FetchLike } from "../sendblue/client.ts";
import type { TextToSpeech, TtsMp3Result, TtsResult } from "../voice/elevenlabs.ts";
import { FakeD1 } from "./fake-d1.ts";

export const TEST_ENV = {
  PUBLIC_BASE_URL: "https://canary.test",
  WEBHOOK_SECRET: "test-webhook-secret",
  FOUNDER_PHONE: "+15550001111",
  SENDBLUE_API_KEY: "test-key-id",
  SENDBLUE_API_SECRET: "test-secret-key",
  SENDBLUE_FROM_NUMBER: "+15550002222",
} satisfies Partial<Env>;

/** `TEST_ENV` plus an OAuth client, so the Google provider can be resolved. */
export const GOOGLE_TEST_ENV = {
  GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  CALENDAR_TIMEZONE: "America/New_York",
} satisfies Partial<Env>;

export const FIXED_NOW = "2026-09-14T12:00:00.000Z";

/**
 * A calendar you can flip mid-test: `feed.busy = {...}` makes the founder busy,
 * `feed.busy = null` frees them. `source: "none"` reproduces an unconfigured feed.
 */
export class FakeCalendar implements CalendarFeed {
  configured = true;
  /** Busy block covering "now", or null when free. */
  busy: { until: ISODateTime | null } | null = null;
  next_busy_start: ISODateTime | null = null;
  source: BusyStatus["source"] = "ics";
  events: CalendarFeedEvent[] = [];
  /** Every range `fetchEvents` was asked for. */
  readonly requested: Array<{ from: ISODate; to: ISODate }> = [];

  async fetchEvents(from: ISODate, to: ISODate): Promise<CalendarFeedResult> {
    this.requested.push({ from, to });
    return { events: this.source === "none" ? [] : this.events, source: this.source };
  }

  async isBusyAt(): Promise<BusyStatus> {
    if (this.source === "none") return { busy: false, until: null, next_busy_start: null, source: "none" };
    return this.busy
      ? { busy: true, until: this.busy.until, next_busy_start: null, source: this.source }
      : { busy: false, until: null, next_busy_start: this.next_busy_start, source: this.source };
  }
}

export interface FakeTtsOptions {
  configured?: boolean;
  pcm?: () => TtsResult;
  mp3?: () => TtsMp3Result;
}

/** A TTS that records what it was asked to speak. */
export interface FakeTts extends TextToSpeech {
  spoken: string[];
  spokenMp3: string[];
}

export function fakeTts(options: FakeTtsOptions = {}): FakeTts {
  const silence = new Uint8Array(48_000); // 1s at 24kHz S16LE
  return {
    configured: options.configured ?? true,
    spoken: [],
    spokenMp3: [],
    async synthesizePcm(text: string) {
      this.spoken.push(text);
      return options.pcm ? options.pcm() : { ok: true, pcm: silence, sampleRate: 24_000, status: 200 };
    },
    async synthesizeMp3(text: string) {
      this.spokenMp3.push(text);
      return options.mp3 ? options.mp3() : { ok: true, mp3: new Uint8Array([0xff, 0xfb, 0x90, 0x64]), status: 200 };
    },
  };
}

export interface CapturedFetch {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** JSON bodies as parsed; `application/x-www-form-urlencoded` ones (Google's token endpoint) as their fields. */
  body: Record<string, unknown> | null;
}

function parseBody(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Not JSON — fall through to the form encoding OAuth uses.
  }
  return Object.fromEntries(new URLSearchParams(body));
}

export interface Harness {
  app: CanaryApp;
  provider: MockDataProvider;
  derived: DerivedDemoObject;
  db: FakeD1;
  /** The injected calendar, so a test can flip the founder busy or free. */
  calendar: FakeCalendar;
  /** Every outbound HTTP call the Sendblue client attempted. */
  calls: CapturedFetch[];
  /** Convenience view of the Sendblue message bodies. */
  messages: Array<{ number: string; content: string; from_number: string }>;
  json<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }>;
  post<T>(path: string, body?: unknown, init?: RequestInit): Promise<{ status: number; body: T }>;
  /** POST with the shared secret in `x-canary-secret` (privileged routes: webhook, alerts). */
  authed<T>(path: string, body?: unknown, init?: RequestInit): Promise<{ status: number; body: T }>;
  /** Runs the cron handler's job against the same dependencies as the app. */
  runScheduled(): Promise<PendingRunSummary>;
}

export interface HarnessOptions extends Omit<AppDeps, "env" | "fetchImpl"> {
  env?: Partial<Env>;
  /** Response the fake Sendblue endpoint returns. Defaults to 200 + a message handle. */
  sendblueResponse?: () => Response;
  /**
   * Consulted before the Sendblue stubs — this is where a test scripts Google's
   * OAuth/Calendar endpoints. Return null to fall through.
   */
  fetchHandler?: (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => Promise<Response | null> | Response | null;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const { env, sendblueResponse, fetchHandler, ...deps } = options;
  const derived = buildMockDerived();
  const provider = (deps.provider as MockDataProvider | undefined) ?? new MockDataProvider(derived);
  const db = (deps.db as FakeD1 | undefined) ?? new FakeD1();
  const calendar = (deps.calendar as FakeCalendar | undefined) ?? new FakeCalendar();
  const calls: CapturedFetch[] = [];

  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: parseBody(init?.body),
    });
    const scripted = await fetchHandler?.(input, init);
    if (scripted) return scripted;
    if (String(input).endsWith("/api/upload-file")) {
      return new Response(JSON.stringify({ status: "OK", media_url: "https://storage.test/inbound-file-store/abc_CanaryAlert.caf" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    return sendblueResponse
      ? sendblueResponse()
      : new Response(JSON.stringify({ status: "QUEUED", message_handle: "msg_test_handle" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
  };

  const appDeps: AppDeps = {
    ...deps,
    provider,
    db,
    calendar,
    fetchImpl,
    now: deps.now ?? (() => FIXED_NOW),
    env: { ...TEST_ENV, ...env },
  };
  const app = createApp(appDeps);

  const json = async <T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
    const res = await app.request(path, init);
    return { status: res.status, body: (await res.json()) as T };
  };
  const post = <T>(path: string, body?: unknown, init?: RequestInit) =>
    json<T>(path, {
      ...init,
      method: "POST",
      headers: { "content-type": "application/json", ...((init?.headers ?? {}) as Record<string, string>) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  return {
    app,
    provider,
    derived,
    db,
    calendar,
    calls,
    get messages() {
      return calls.map((c) => c.body as { number: string; content: string; from_number: string });
    },
    json,
    post,
    authed: <T>(path: string, body?: unknown, init?: RequestInit) =>
      post<T>(path, body, { ...init, headers: { "x-canary-secret": TEST_ENV.WEBHOOK_SECRET, ...((init?.headers ?? {}) as Record<string, string>) } }),
    runScheduled: () => createScheduled(appDeps)({ ...TEST_ENV, ...env } as unknown as Env),
  };
}

// ---------------------------------------------------------------------------
// Google Calendar
// ---------------------------------------------------------------------------

export interface ConnectGoogleOptions {
  refreshToken?: string;
  accessToken?: string;
  /** Expiry of the stored access token. Default: an hour after `FIXED_NOW`. */
  expiresAt?: ISODateTime;
  scope?: string;
  accountEmail?: string | null;
  connectedAt?: ISODateTime;
  now?: ISODateTime;
}

/**
 * Seeds a connected `google_oauth` row exactly as the callback writes one —
 * encrypted, under `TEST_ENV.WEBHOOK_SECRET`.
 */
export async function connectGoogle(db: FakeD1, options: ConnectGoogleOptions = {}): Promise<void> {
  const now = options.now ?? FIXED_NOW;
  const store = new GoogleOauthStore(db, TEST_ENV.WEBHOOK_SECRET);
  await store.save({
    refresh_token: options.refreshToken ?? "test-refresh-token",
    access_token: options.accessToken ?? "test-access-token",
    expires_at: options.expiresAt ?? new Date(new Date(now).getTime() + 3_600_000).toISOString(),
    scope: options.scope ?? GOOGLE_SCOPE_PARAM,
    account_email: options.accountEmail === undefined ? "founder@perchanalytics.test" : options.accountEmail,
    now,
    ...(options.connectedAt ? { connected_at: options.connectedAt } : {}),
  });
}

export interface GoogleScript {
  /** Busy ranges `freeBusy` reports. */
  busy?: Array<{ start: string; end: string }>;
  /** Raw items the events list returns (Google's own shape). */
  events?: Array<Record<string, unknown>>;
  /** Token endpoint response fields. */
  accessToken?: string;
  refreshToken?: string | null;
  expiresIn?: number;
  scope?: string;
  accountEmail?: string | null;
  createdEventId?: string;
  createdHtmlLink?: string;
  /** Runs first: return a `Response` to replace the default for that endpoint. */
  override?: (url: string, init?: Parameters<FetchLike>[1]) => Response | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Every Google endpoint Canary touches, answered from a plain object. */
export function googleFetchHandler(script: GoogleScript = {}): NonNullable<HarnessOptions["fetchHandler"]> {
  return (input, init) => {
    const url = String(input);
    if (!url.includes("google")) return null;

    const replaced = script.override?.(url, init);
    if (replaced) return replaced;

    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return jsonResponse({
        access_token: script.accessToken ?? "fresh-access-token",
        ...(script.refreshToken === null ? {} : { refresh_token: script.refreshToken ?? "test-refresh-token" }),
        expires_in: script.expiresIn ?? 3600,
        scope: script.scope ?? GOOGLE_SCOPE_PARAM,
        token_type: "Bearer",
      });
    }
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) return new Response("", { status: 200 });
    if (url.startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
      const email = script.accountEmail === undefined ? "founder@perchanalytics.test" : script.accountEmail;
      return jsonResponse(email === null ? {} : { email, sub: "1234567890" });
    }
    if (url.startsWith("https://www.googleapis.com/calendar/v3/freeBusy")) {
      return jsonResponse({ calendars: { primary: { busy: script.busy ?? [] } } });
    }
    if (url.includes("/calendar/v3/calendars/primary/events")) {
      if ((init?.method ?? "GET").toUpperCase() === "POST") {
        const body = parseBody(init?.body) ?? {};
        return jsonResponse({
          id: script.createdEventId ?? "evt_test_review",
          htmlLink: script.createdHtmlLink ?? "https://calendar.google.com/event?eid=evt_test_review",
          summary: body.summary,
          status: "confirmed",
        });
      }
      return jsonResponse({ items: script.events ?? [] });
    }
    return null;
  };
}

/** Sendblue inbound webhook body. */
export function inbound(content: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content,
    from_number: "+15550001111",
    number: "+15550001111",
    is_outbound: false,
    status: "RECEIVED",
    message_handle: "inbound_handle_1",
    ...overrides,
  };
}
