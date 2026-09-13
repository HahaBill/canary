/** `/api/health`, `/api/health-summary`, `/api/demo`. */
import type { DemoResponse, HealthResponse, HealthSummaryResponse } from "@canary/shared";
import type { CanaryApp } from "../context.ts";
import { API_VERSION } from "../env.ts";
import { getHealthSummary, stripFixture } from "../tools.ts";

export function registerCoreRoutes(app: CanaryApp): void {
  app.get("/api/health", (c) => {
    const body: HealthResponse = { ok: true, service: "canary-api", version: API_VERSION, time: c.get("now")() };
    return c.json(body);
  });

  app.get("/api/health-summary", async (c) => {
    c.header("Cache-Control", "no-store");
    const body: HealthSummaryResponse = await getHealthSummary(c.get("provider"));
    return c.json(body);
  });

  app.get("/api/demo", async (c) => {
    // This object advances with the injected demo clock. Intermediary or
    // browser caching would make the SPA's live refresh return the same day.
    c.header("Cache-Control", "no-store");
    const body: DemoResponse = stripFixture(await c.get("provider").getDerived());
    return c.json(body);
  });
}
