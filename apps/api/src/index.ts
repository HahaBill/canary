/**
 * Canary API Worker — Hono + D1 + Sendblue + agent tools.
 *
 * The SPA is served from `./public` by Workers static assets; `/api/*` and
 * `/webhooks/*` always run the Worker first (see wrangler.jsonc).
 */
import { createApp, createScheduled } from "./app.ts";
import { demoAsOf, parseMinutesPerDay } from "./clock.ts";
import { PipelineDataProvider } from "./data/pipeline-provider.ts";
import type { Env } from "./env.ts";

export type { Env } from "./env.ts";
export { createApp, createScheduled, type AppDeps } from "./app.ts";

/**
 * Built once per isolate. Production serves the REAL pipeline (generator →
 * classification → engine → detectors) — never the mock fixture. Tests build
 * their own app with injected dependencies.
 */
// The demo clock advances the founder's "today" through the generated horizon,
// so the dashboard keeps moving instead of stopping at the end of history. Pure
// function of the wall clock, re-read per request — see clock.ts.
//
// The speed comes from DEMO_CLOCK_MINUTES_PER_DAY, captured from the latest
// request's env: bindings only exist per-request in Workers, and reading them
// this way lets an operator freeze the clock ("0") from the Cloudflare
// dashboard without a deploy — a recorded clip needs the ledger to hold still.
let clockEnv: Env | undefined;
const pipelineProvider = new PipelineDataProvider({
  asOf: () => demoAsOf(new Date(), { minutesPerDay: parseMinutesPerDay(clockEnv?.DEMO_CLOCK_MINUTES_PER_DAY) }),
});
const deps = {
  provider: pipelineProvider,
  bankTransactions: () => pipelineProvider.getTransactions(),
};
export const app = createApp(deps);
const deliverPendingAlerts = createScheduled(deps);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    clockEnv = env;
    return app.fetch(request, env, ctx);
  },

  /**
   * Every five minutes: deliver alerts the notification policy deferred while the
   * founder was in a meeting. Same job as `POST /api/alerts/deliver-pending`.
   */
  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const scheduled_time = new Date(event.scheduledTime).toISOString();
    try {
      const result = await deliverPendingAlerts(env);
      // Nothing due is the normal case; log it only when there was work to do.
      if (result.due > 0) console.log(JSON.stringify({ msg: "pending_alerts_run", cron: event.cron, scheduled_time, ...result }));
    } catch (err) {
      console.error(JSON.stringify({ msg: "pending_alerts_failed", cron: event.cron, scheduled_time, error: err instanceof Error ? err.message : String(err) }));
    }
  },
} satisfies ExportedHandler<Env>;
