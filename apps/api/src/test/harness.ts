/**
 * Test harness: a real Hono app wired to a MockDataProvider, an in-memory D1,
 * and a fetch that captures Sendblue traffic instead of making it. Runs in the
 * plain Node vitest environment.
 */
import { buildMockDerived } from "@canary/shared/fixtures";
import type { DerivedDemoObject } from "@canary/shared";
import { createApp, type AppDeps } from "../app.ts";
import type { CanaryApp } from "../context.ts";
import { MockDataProvider } from "../data/provider.ts";
import type { Env } from "../env.ts";
import type { FetchLike } from "../sendblue/client.ts";
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
  /** Every outbound HTTP call the Sendblue client attempted. */
  calls: CapturedFetch[];
  /** Convenience view of the Sendblue message bodies. */
  messages: Array<{ number: string; content: string; from_number: string }>;
  json<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }>;
  post<T>(path: string, body?: unknown, init?: RequestInit): Promise<{ status: number; body: T }>;
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

  const app = createApp({
    ...deps,
    provider,
    db,
    fetchImpl,
    now: deps.now ?? (() => FIXED_NOW),
    env: { ...TEST_ENV, ...env },
  });

  const json = async <T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
    const res = await app.request(path, init);
    return { status: res.status, body: (await res.json()) as T };
  };

  return {
    app,
    provider,
    derived,
    db,
    calls,
    get messages() {
      return calls.map((c) => c.body as { number: string; content: string; from_number: string });
    },
    json,
    post: <T>(path: string, body?: unknown, init?: RequestInit) =>
      json<T>(path, {
        ...init,
        method: "POST",
        headers: { "content-type": "application/json", ...((init?.headers ?? {}) as Record<string, string>) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
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
