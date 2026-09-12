/**
 * Test harness: a real Hono app wired to a MockDataProvider, an in-memory D1,
 * and a fetch that captures Sendblue traffic instead of making it. Runs in the
 * plain Node vitest environment.
 */
import { buildMockDerived } from "@canary/shared/fixtures";
import type { DerivedDemoObject, ISODate, ISODateTime } from "@canary/shared";
import type { PendingRunSummary } from "../alerts/pending.ts";
import { createApp, createScheduled, type AppDeps } from "../app.ts";
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
  body: Record<string, unknown> | null;
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
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const { env, sendblueResponse, ...deps } = options;
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
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
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
