/**
 * Scout browse surface. GET is cache-only. POST /refresh is the only live Tavily path.
 * Neither route writes incidents or vendor enrichments.
 */
import type { ScoutRefreshResponse, ScoutResponse } from "@canary/shared";
import { type CanaryApp } from "../context.ts";
import { readScoutPage } from "../scout/page.ts";
import { refreshScoutPage } from "../scout/refresh.ts";

export function registerScoutRoutes(app: CanaryApp): void {
  app.get("/api/scout", async (c) => {
    const derived = await c.get("provider").getDerived();
    const body: ScoutResponse = await readScoutPage(derived, c.get("store"), c.get("now")());
    return c.json(body);
  });

  app.post("/api/scout/refresh", async (c) => {
    const derived = await c.get("provider").getDerived();
    const body: ScoutRefreshResponse = await refreshScoutPage({
      derived,
      store: c.get("store"),
      now: c.get("now")(),
      tavilyKey: c.get("appEnv").TAVILY_API_KEY,
      fetchImpl: c.get("fetchImpl"),
    });
    return c.json(body);
  });
}
