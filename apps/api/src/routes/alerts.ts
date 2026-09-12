/** `POST /api/alerts/send` — the outbound iMessage that opens the demo. */
import type { SendAlertResponse } from "@canary/shared";
import { jsonError, readJson, type CanaryApp } from "../context.ts";
import { primaryIncident } from "../derive.ts";
import { alertMessage } from "../messages.ts";

export function registerAlertRoutes(app: CanaryApp): void {
  app.post("/api/alerts/send", async (c) => {
    const body = await readJson(c);
    if (!body) return jsonError(c, 400, "invalid_json", "Request body must be a JSON object.");

    const requestedTo = typeof body.to === "string" ? body.to.trim() : "";
    const to = requestedTo || c.get("appEnv").FOUNDER_PHONE?.trim() || "";
    if (!to) return jsonError(c, 400, "missing_recipient", "Provide `to`, or set FOUNDER_PHONE.");

    const incidentId = typeof body.incident_id === "string" ? body.incident_id.trim() : "";
    const provider = c.get("provider");
    const derived = await provider.getDerived();
    const incident = incidentId ? (derived.incidents.find((i) => i.id === incidentId) ?? null) : primaryIncident(derived);
    if (!incident) {
      return jsonError(c, 404, "incident_not_found", incidentId ? `No incident with id ${incidentId}.` : "No incident to alert on.");
    }

    const message = alertMessage(incident);
    const result = await c.get("sendblue").sendMessage({ to, content: message });
    const now = c.get("now")();

    if (!result.sent) {
      const response: SendAlertResponse = { sent: false, to, message, error: result.error ?? "send_failed" };
      return c.json(response, result.error === "SENDBLUE_NOT_CONFIGURED" ? 503 : 502);
    }

    await c.get("store")?.logMessage({
      direction: "outbound",
      phone: to,
      body: message,
      created_at: now,
      command: null,
      provider_message_id: result.provider_message_id ?? null,
    });
    await provider.markNotified(incident.id, now);

    const response: SendAlertResponse = { sent: true, to, message };
    if (result.provider_message_id) response.provider_message_id = result.provider_message_id;
    return c.json(response);
  });
}
