/**
 * Canary API Worker — Hono + D1 + Sendblue + agent tools.
 *
 * The SPA is served from `./public` by Workers static assets; `/api/*` and
 * `/webhooks/*` always run the Worker first (see wrangler.jsonc).
 */
import { createApp, createScheduled } from "./app.ts";
import { PipelineDataProvider } from "./data/pipeline-provider.ts";
import type { Env } from "./env.ts";

export type { Env } from "./env.ts";
export { createApp, createScheduled, type AppDeps } from "./app.ts";

/**
 * Built once per isolate. Production serves the REAL pipeline (generator →
 * classification → engine → detectors) — never the mock fixture. Tests build
 * their own app with injected dependencies.
 */
const pipelineProvider = new PipelineDataProvider();
const deps = {
  provider: pipelineProvider,
  bankTransactions: () => pipelineProvider.getTransactions(),
};
export const app = createApp(deps);
const deliverPendingAlerts = createScheduled(deps);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
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
