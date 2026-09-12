/**
 * Canary API Worker — Hono + D1 + Sendblue + agent tools.
 *
 * The SPA is served from `./public` by Workers static assets; `/api/*` and
 * `/webhooks/*` always run the Worker first (see wrangler.jsonc).
 */
import { createApp } from "./app.ts";
import { PipelineDataProvider } from "./data/pipeline-provider.ts";
import type { Env } from "./env.ts";

export type { Env } from "./env.ts";
export { createApp, type AppDeps } from "./app.ts";

/**
 * Built once per isolate. Production serves the REAL pipeline (generator →
 * classification → engine → detectors) — never the mock fixture. Tests build
 * their own app with injected dependencies.
 */
const pipelineProvider = new PipelineDataProvider();
export const app = createApp({
  provider: pipelineProvider,
  bankTransactions: () => pipelineProvider.getTransactions(),
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  /** Cron wiring is P1 (docs/WORKSTREAMS.md E) — no triggers are configured. */
  async scheduled(event: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log(JSON.stringify({ msg: "scheduled_noop", cron: event.cron, scheduled_time: new Date(event.scheduledTime).toISOString() }));
  },
} satisfies ExportedHandler<Env>;
