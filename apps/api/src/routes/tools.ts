/** `/api/tools/*` — the deterministic tool surface for ElevenLabs and OpenAI. */
import type {
  CreateAppLinkResponse,
  ToolGetHealthSummaryResponse,
  ToolGetIncidentResponse,
  ToolSimulateResponse,
} from "@canary/shared";
import { baseUrl, jsonError, readJson, type CanaryApp } from "../context.ts";
import {
  createLink,
  getHealthSummary,
  getIncidentTool,
  parseCreateAppLinkRequest,
  parseWhatIfRequest,
  simulateCostChange,
} from "../tools.ts";

export function registerToolRoutes(app: CanaryApp): void {
  app.post("/api/tools/get_health_summary", async (c) => {
    const body: ToolGetHealthSummaryResponse = await getHealthSummary(c.get("provider"));
    return c.json(body);
  });

  app.post("/api/tools/get_incident", async (c) => {
    const body = await readJson(c);
    if (!body) return jsonError(c, 400, "invalid_json", "Request body must be a JSON object.");
    const id = typeof body.id === "string" && body.id.trim().length > 0 ? body.id.trim() : undefined;

    const detail = await getIncidentTool(c.get("provider"), id);
    if (!detail) return jsonError(c, 404, "incident_not_found", id ? `No incident with id ${id}.` : "No incident is currently flagged.");
    const response: ToolGetIncidentResponse = detail;
    return c.json(response);
  });

  app.post("/api/tools/simulate_cost_change", async (c) => {
    const parsed = parseWhatIfRequest(await readJson(c));
    if (!parsed.ok) return jsonError(c, 400, parsed.error, parsed.detail);
    const body: ToolSimulateResponse = await simulateCostChange(c.get("provider"), parsed.value);
    return c.json(body);
  });

  app.post("/api/tools/create_app_link", async (c) => {
    const parsed = parseCreateAppLinkRequest(await readJson(c));
    if (!parsed.ok) return jsonError(c, 400, parsed.error, parsed.detail);
    const body: CreateAppLinkResponse = createLink(parsed.value, baseUrl(c));
    return c.json(body);
  });
}
