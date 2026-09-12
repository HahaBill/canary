/**
 * Hono app factory. Every dependency is injectable so the whole API can be
 * exercised in plain Node with `app.request(...)` — no miniflare, no workerd,
 * no secrets.
 */
import type { BankProvider, ErrorResponse, Transaction } from "@canary/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv, CanaryApp } from "./context.ts";
import { D1Store, type SqlDatabase } from "./data/d1.ts";
import { MockDataProvider, withD1Overlay, type DataProvider } from "./data/provider.ts";
import type { Env } from "./env.ts";
import { sandboxBankFor } from "./bank/sandbox.ts";
import { registerAlertRoutes } from "./routes/alerts.ts";
import { registerCoreRoutes } from "./routes/core.ts";
import { registerDataRoutes } from "./routes/data.ts";
import { registerIncidentRoutes } from "./routes/incidents.ts";
import { registerToolRoutes } from "./routes/tools.ts";
import { registerWebhookRoutes } from "./routes/webhooks.ts";
import { SendblueClient, type FetchLike } from "./sendblue/client.ts";

export interface AppDeps {
  /** Defaults to `MockDataProvider` (+ D1 status overlay when `DB` is bound). */
  provider?: DataProvider;
  sendblue?: SendblueClient;
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

export function createApp(deps: AppDeps = {}): CanaryApp {
  const app = new Hono<AppEnv>();

  app.use("/api/*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["content-type", "x-canary-secret"] }));

  app.use("*", async (c, next) => {
    const appEnv = { ...(c.env ?? {}), ...(deps.env ?? {}) } as Env;
    const db = deps.db ?? (appEnv.DB as SqlDatabase | undefined);
    // The D1 overlay belongs to the app, not the provider: whatever data source
    // is injected, incident status and enrichments still persist.
    const base = resolveBaseProvider(deps);
    const provider = db ? withD1Overlay(base, db) : base;

    c.set("appEnv", appEnv);
    c.set("now", deps.now ?? (() => new Date().toISOString()));
    c.set("provider", provider);
    c.set("store", db ? new D1Store(db) : null);
    c.set("bank", deps.bank ?? sandboxBankFor(provider, deps.bankTransactions));
    c.set(
      "sendblue",
      deps.sendblue ??
        new SendblueClient({
          apiKey: appEnv.SENDBLUE_API_KEY,
          apiSecret: appEnv.SENDBLUE_API_SECRET,
          fromNumber: appEnv.SENDBLUE_FROM_NUMBER,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        }),
    );

    await next();
  });

  registerCoreRoutes(app);
  registerIncidentRoutes(app);
  registerDataRoutes(app);
  registerAlertRoutes(app);
  registerWebhookRoutes(app);
  registerToolRoutes(app);

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
