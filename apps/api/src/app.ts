/**
 * Hono app factory. Every dependency is injectable so the whole API can be
 * exercised in plain Node with `app.request(...)` — no miniflare, no workerd,
 * no secrets.
 *
 * The cron trigger runs outside any request, so dependency wiring lives in
 * `buildVariables` and is shared: a scheduled delivery and a routed one see
 * exactly the same provider, Sendblue client, calendar and clock.
 */
import type { BankProvider, ErrorResponse, Transaction } from "@canary/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { runPendingAlerts, type PendingRunSummary } from "./alerts/pending.ts";
import type { CalendarFeed } from "./calendar/ics.ts";
import { createCalendarResolver } from "./calendar/resolve.ts";
import { reviewEventStoreFor } from "./calendar/review-events.ts";
import { openAiClient, type LlmClient } from "./conversation/openai.ts";
import type { AppEnv, CanaryApp, Variables } from "./context.ts";
import { D1Store, type SqlDatabase } from "./data/d1.ts";
import { MockDataProvider, withD1Overlay, type DataProvider } from "./data/provider.ts";
import type { Env } from "./env.ts";
import { sandboxBankFor } from "./bank/sandbox.ts";
import { registerAlertRoutes } from "./routes/alerts.ts";
import { registerAskCanaryRoutes } from "./routes/ask-canary.ts";
import { registerCoreRoutes } from "./routes/core.ts";
import { registerDataRoutes } from "./routes/data.ts";
import { registerIncidentRoutes } from "./routes/incidents.ts";
import { registerOauthRoutes } from "./routes/oauth.ts";
import { registerScheduleRoutes } from "./routes/schedule.ts";
import { registerToolRoutes } from "./routes/tools.ts";
import { registerScoutRoutes } from "./routes/scout.ts";
import { registerViewRoutes } from "./routes/views.ts";
import { registerWebhookRoutes } from "./routes/webhooks.ts";
import { SendblueClient, type FetchLike } from "./sendblue/client.ts";
import { ElevenLabsTts, type TextToSpeech } from "./voice/elevenlabs.ts";

export interface AppDeps {
  /** Defaults to `MockDataProvider` (+ D1 status overlay when `DB` is bound). */
  provider?: DataProvider;
  sendblue?: SendblueClient;
  /** Defaults to ElevenLabs from env; unconfigured → alerts are text-only. */
  tts?: TextToSpeech;
  /**
   * Defaults to the resolver's feed (Google when connected, else the ICS feed at
   * `CALENDAR_ICS_URL`, else none → Canary never defers an alert).
   */
  calendar?: CalendarFeed;
  /** Defaults to OpenAI from env; unset key → conversational replies fall back to HELP. */
  llm?: LlmClient;
  bank?: BankProvider;
  /** Overrides the `DB` binding — tests pass an in-memory fake. */
  db?: SqlDatabase;
  /** Merged over the runtime bindings. */
  env?: Partial<Env>;
  /** Injectable clock. Production code never calls `Date.now()` directly. */
  now?: () => string;
  /** Injected into the default Sendblue client. */
  fetchImpl?: FetchLike;
  /** Sandbox bank ledger. Empty until the lead wires the generator's transactions. */
  bankTransactions?: () => Promise<Transaction[]>;
}

/** Cached per isolate: `buildMockDerived()` is deterministic, so this is safe. */
let cachedMockProvider: MockDataProvider | null = null;

function resolveBaseProvider(deps: AppDeps): DataProvider {
  if (deps.provider) return deps.provider;
  cachedMockProvider ??= new MockDataProvider();
  return cachedMockProvider;
}

/** Everything a request (or the cron) needs, built from the bindings plus test overrides. */
export function buildVariables(appEnv: Env, deps: AppDeps): Variables {
  const db = deps.db ?? (appEnv.DB as SqlDatabase | undefined);
  // The D1 overlay belongs to the app, not the provider: whatever data source
  // is injected, incident status and enrichments still persist.
  const base = resolveBaseProvider(deps);
  const provider = db ? withD1Overlay(base, db) : base;
  const now = deps.now ?? (() => new Date().toISOString());
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  // Google > ICS > none. The choice needs a D1 read, so the resolver hands back a
  // lazy feed and does it on first use (src/calendar/resolve.ts).
  const calendarResolver = createCalendarResolver({ appEnv, db, now, fetchImpl });

  return {
    appEnv,
    now,
    fetchImpl,
    provider,
    store: db ? new D1Store(db) : null,
    reviews: reviewEventStoreFor(db),
    bank: deps.bank ?? sandboxBankFor(provider, deps.bankTransactions),
    sendblue:
      deps.sendblue ??
      new SendblueClient({
        apiKey: appEnv.SENDBLUE_API_KEY,
        apiSecret: appEnv.SENDBLUE_API_SECRET,
        fromNumber: appEnv.SENDBLUE_FROM_NUMBER,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      }),
    tts:
      deps.tts ??
      new ElevenLabsTts({
        apiKey: appEnv.ELEVENLABS_API_KEY,
        voiceId: appEnv.ELEVENLABS_VOICE_ID,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      }),
    calendarResolver,
    calendar: deps.calendar ?? calendarResolver.feed,
    llm:
      deps.llm ??
      openAiClient({
        ...(appEnv.OPENAI_API_KEY ? { apiKey: appEnv.OPENAI_API_KEY } : {}),
        ...(appEnv.OPENAI_MODEL ? { model: appEnv.OPENAI_MODEL } : {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      }),
  };
}

export function createApp(deps: AppDeps = {}): CanaryApp {
  const app = new Hono<AppEnv>();

  app.use("/api/*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["content-type", "x-canary-secret"] }));

  app.use("*", async (c, next) => {
    const variables = buildVariables({ ...(c.env ?? {}), ...(deps.env ?? {}) } as Env, deps);
    // Setting them in bulk means a dependency added to `Variables` cannot be
    // wired into the cron and forgotten here (the cast is safe: the keys and
    // values both come from one typed object).
    for (const [key, value] of Object.entries(variables)) {
      c.set(key as keyof Variables, value as never);
    }
    await next();
  });

  registerCoreRoutes(app);
  registerIncidentRoutes(app);
  registerDataRoutes(app);
  registerViewRoutes(app);
  registerScoutRoutes(app);
  registerAlertRoutes(app);
  registerWebhookRoutes(app);
  registerToolRoutes(app);
  registerAskCanaryRoutes(app);
  registerOauthRoutes(app);
  registerScheduleRoutes(app);

  app.notFound((c) => {
    const body: ErrorResponse = { error: "not_found", detail: `${c.req.method} ${new URL(c.req.url).pathname}` };
    return c.json(body, 404);
  });

  app.onError((err, c) => {
    console.error("canary-api error", err);
    const body: ErrorResponse = { error: "internal_error", detail: err instanceof Error ? err.message : String(err) };
    return c.json(body, 500);
  });

  return app;
}

/**
 * The cron job, wired from the same deps as the app. Kept next to `createApp` so
 * a dependency added to one can never be forgotten by the other.
 */
export function createScheduled(deps: AppDeps = {}): (env: Env) => Promise<PendingRunSummary> {
  return (env: Env) => runPendingAlerts(buildVariables({ ...env, ...(deps.env ?? {}) } as Env, deps));
}
