/**
 * `POST /api/alerts/send` — the outbound iMessage that opens the demo — plus the
 * deferred-alert queue and the alert log.
 *
 * The route decides WHETHER to speak (`decideNotify`, docs/AGENT_BEHAVIOR.md §1);
 * `src/alerts/deliver.ts` decides HOW, and is shared with the cron. Three
 * outcomes:
 *   200 `{ sent: true, … }`   — text (and voice note) delivered.
 *   200 `{ sent: false, decision }` — the policy declined; nothing was sent and
 *                                     no Sendblue credit was spent.
 *   202 `{ sent: false, decision, pending }` — the founder is in a meeting; the
 *                                     alert is queued for the cron.
 */
import type { AlertHistoryResponse, AlertsPendingResponse, SendAlertResponse } from "@canary/shared";
import { deliverAlert, type AlertRuntime } from "../alerts/deliver.ts";
import { listPending, queuePendingAlert, runPendingAlerts, type PendingRunSummary } from "../alerts/pending.ts";
import { decideNotify, deliverAfter, isDeferred } from "../alerts/policy.ts";
import { IGNORED_SENDER_PREFIX } from "../conversation/memory.ts";
import { baseUrl, jsonError, readJson, type CanaryApp, type CanaryContext } from "../context.ts";
import { primaryIncident } from "../derive.ts";
import { renderAlert } from "../messages.ts";
import { requestAuthorized } from "../security.ts";

export const DEFAULT_ALERT_HISTORY_LIMIT = 50;
export const MAX_ALERT_HISTORY_LIMIT = 200;

export type DeliverPendingResponse = { ok: true; result: PendingRunSummary };

/** The subset of the request context that sending an alert needs. */
function runtimeOf(c: CanaryContext): AlertRuntime {
  return {
    provider: c.get("provider"),
    sendblue: c.get("sendblue"),
    tts: c.get("tts"),
    store: c.get("store"),
    now: c.get("now"),
    appEnv: c.get("appEnv"),
  };
}

/** Shared-secret gate for the routes that spend credit or text a real phone. */
function authorize(c: CanaryContext): Response | null {
  const auth = requestAuthorized(c.req.raw.headers, c.get("appEnv").WEBHOOK_SECRET);
  if (auth === "unconfigured") return jsonError(c, 503, "webhook_not_configured", "WEBHOOK_SECRET is not set.");
  if (auth === "unauthorized") return jsonError(c, 401, "unauthorized", "Missing or invalid x-canary-secret.");
  return null;
}

export function registerAlertRoutes(app: CanaryApp): void {
  app.post("/api/alerts/send", async (c) => {
    // Privileged: this route spends Sendblue/ElevenLabs credit and texts a real phone.
    // Requires the shared secret in `x-canary-secret` (public URL, PRD §31 exemption does not apply).
    const unauthorized = authorize(c);
    if (unauthorized) return unauthorized;

    const body = await readJson(c);
    if (!body) return jsonError(c, 400, "invalid_json", "Request body must be a JSON object.");

    const requestedTo = typeof body.to === "string" ? body.to.trim() : "";
    const to = requestedTo || c.get("appEnv").FOUNDER_PHONE?.trim() || "";
    if (!to) return jsonError(c, 400, "missing_recipient", "Provide `to`, or set FOUNDER_PHONE.");

    const incidentId = typeof body.incident_id === "string" ? body.incident_id.trim() : "";
    const wantVoice = body.voice === undefined ? true : body.voice === true;
    const force = body.force === true;

    const provider = c.get("provider");
    const derived = await provider.getDerived();
    const incident = incidentId ? (derived.incidents.find((i) => i.id === incidentId) ?? null) : primaryIncident(derived);
    if (!incident) {
      return jsonError(c, 404, "incident_not_found", incidentId ? `No incident with id ${incidentId}.` : "No incident to alert on.");
    }

    const now = c.get("now")();
    // Availability is only consulted when the alert would otherwise go out, so a
    // declined alert never costs a calendar fetch.
    const availability = force ? null : await c.get("calendar").isBusyAt(now);
    const decision = decideNotify({ incident, force, availability, now });

    // A withheld alert still reports the text it would have sent, so whoever asked
    // can see exactly what was held back. Rendering has no side effects.
    const withheldMessage = () => renderAlert(incident, baseUrl(c)).text_summary;

    if (isDeferred(decision)) {
      const pending = await queuePendingAlert(c.get("store"), {
        incident_id: incident.id,
        to,
        voice: wantVoice,
        now,
        deliver_after: deliverAfter(decision, now),
      });
      const deferredResponse: SendAlertResponse = {
        sent: false,
        to,
        message: withheldMessage(),
        decision,
        ...(pending ? { pending } : {}),
      };
      return c.json(deferredResponse, 202);
    }

    if (!decision.send) {
      // Deliberately not an error: the caller asked a reasonable question and the
      // answer is "not now".
      const declined: SendAlertResponse = { sent: false, to, message: withheldMessage(), decision };
      return c.json(declined);
    }

    const outcome = await deliverAlert(runtimeOf(c), { incident, to, voice: wantVoice });
    if (!outcome.sent) {
      const failed: SendAlertResponse = { sent: false, to, message: outcome.message, error: outcome.error ?? "send_failed" };
      return c.json(failed, outcome.error === "SENDBLUE_NOT_CONFIGURED" ? 503 : 502);
    }

    const response: SendAlertResponse = { sent: true, to, message: outcome.message };
    if (outcome.provider_message_id) response.provider_message_id = outcome.provider_message_id;
    if (outcome.voice) response.voice = outcome.voice;
    return c.json(response);
  });

  app.get("/api/alerts/history", async (c) => {
    const raw = Number.parseInt(c.req.query("limit") ?? "", 10);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_ALERT_HISTORY_LIMIT) : DEFAULT_ALERT_HISTORY_LIMIT;
    // A message from a number Canary refused to talk to is a rejection RECORD,
    // not a turn in the founder's conversation. `conversation/memory.ts` already
    // refuses to feed these to the agent for the same reason; the dashboard's
    // conversation strip was the one surface still rendering them, which put a
    // stranger's message text — whatever they chose to type — on the founder's
    // screen under the heading "Conversation". The rows stay in `imessage_log`,
    // so the rejection is still auditable; they just are not conversation.
    //
    // Over-fetch first, so filtering cannot return fewer items than asked for.
    const stored = (await c.get("store")?.listMessages(limit * 2)) ?? [];
    const items = stored.filter((m) => !m.body.startsWith(IGNORED_SENDER_PREFIX)).slice(0, limit);
    const body: AlertHistoryResponse = { items };
    return c.json(body);
  });

  app.get("/api/alerts/pending", async (c) => {
    const body: AlertsPendingResponse = { pending: await listPending(c.get("store")) };
    return c.json(body);
  });

  app.post("/api/alerts/deliver-pending", async (c) => {
    // Same job the cron runs. Privileged for the same reason as /alerts/send.
    const unauthorized = authorize(c);
    if (unauthorized) return unauthorized;
    const result = await runPendingAlerts({ ...runtimeOf(c), calendar: c.get("calendar") });
    const body: DeliverPendingResponse = { ok: true, result };
    return c.json(body);
  });
}
