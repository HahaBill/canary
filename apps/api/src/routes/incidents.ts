/** `/api/incidents*` — list, detail, evidence, status. */
import type { Incident, IncidentDetailResponse, IncidentEvidenceResponse, IncidentsResponse, IncidentStatus } from "@canary/shared";
import { jsonError, readJson, type CanaryApp } from "../context.ts";
import { getIncidentDetail } from "../tools.ts";

/** `IncidentStatus` is a type-only union in shared — see "contract gaps". */
const INCIDENT_STATUSES = ["OPEN", "ACKNOWLEDGED", "RESOLVED"] as const satisfies readonly IncidentStatus[];

export interface IncidentStatusResponse {
  incident: Incident;
}

export function registerIncidentRoutes(app: CanaryApp): void {
  app.get("/api/incidents", async (c) => {
    const derived = await c.get("provider").getDerived();
    const body: IncidentsResponse = { incidents: derived.incidents };
    return c.json(body);
  });

  app.get("/api/incidents/:id", async (c) => {
    const detail = await getIncidentDetail(c.get("provider"), c.req.param("id"));
    if (!detail) return jsonError(c, 404, "incident_not_found", `No incident with id ${c.req.param("id")}.`);
    const body: IncidentDetailResponse = detail;
    return c.json(body);
  });

  app.get("/api/incidents/:id/evidence", async (c) => {
    const detail = await getIncidentDetail(c.get("provider"), c.req.param("id"));
    if (!detail) return jsonError(c, 404, "incident_not_found", `No incident with id ${c.req.param("id")}.`);
    const body: IncidentEvidenceResponse = { evidence: detail.evidence };
    return c.json(body);
  });

  app.post("/api/incidents/:id/status", async (c) => {
    const body = await readJson(c);
    if (!body) return jsonError(c, 400, "invalid_json", "Request body must be a JSON object.");

    const status = body.status;
    if (typeof status !== "string" || !(INCIDENT_STATUSES as readonly string[]).includes(status)) {
      return jsonError(c, 400, "invalid_status", `\`status\` must be one of: ${INCIDENT_STATUSES.join(", ")}.`);
    }

    const id = c.req.param("id");
    const incident = await c.get("provider").updateIncidentStatus(id, status as IncidentStatus, c.get("now")());
    if (!incident) return jsonError(c, 404, "incident_not_found", `No incident with id ${id}.`);
    const response: IncidentStatusResponse = { incident };
    return c.json(response);
  });
}
