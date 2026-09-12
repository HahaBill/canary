/**
 * `POST /webhooks/sendblue` — inbound iMessage.
 *
 * Auth: `sb-signing-secret` (what Sendblue sends for the dashboard "Global
 * Secret") or `x-canary-secret` must equal `WEBHOOK_SECRET` (constant-time).
 * The query string is deliberately NOT accepted (it would land in request logs).
 * Replies go only to FOUNDER_PHONE / ALLOWED_PHONES. Outbound echoes and empty messages are ignored so Canary
 * never replies to itself.
 */
import type { IMessageCommand } from "@canary/shared";
import { baseUrl, jsonError, type CanaryApp } from "../context.ts";
import { primaryIncident } from "../derive.ts";
import { isAllowedSender, matchCommand, replyFor, replyTarget, shouldIgnoreInbound } from "../imessage/router.ts";
import type { SendblueInboundPayload } from "../sendblue/client.ts";
import { requestAuthorized } from "../security.ts";

export interface SendblueWebhookResponse {
  ok: boolean;
  ignored?: boolean;
  reason?: string;
  command?: IMessageCommand;
  reply?: string;
  reply_sent?: boolean;
  error?: string;
}

export function registerWebhookRoutes(app: CanaryApp): void {
  app.post("/webhooks/sendblue", async (c) => {
    const appEnv = c.get("appEnv");
    const auth = requestAuthorized(c.req.raw.headers, appEnv.WEBHOOK_SECRET);
    // Unauthenticated callers always see 401 — never learn whether the secret is configured.
    if (auth !== "ok") {
      if (auth === "unconfigured" && c.req.header("sb-signing-secret") === undefined && c.req.header("x-canary-secret") === undefined) {
        return jsonError(c, 401, "unauthorized", "Invalid webhook secret.");
      }
      return auth === "unconfigured"
        ? jsonError(c, 503, "webhook_not_configured", "WEBHOOK_SECRET is not set.")
        : jsonError(c, 401, "unauthorized", "Invalid webhook secret.");
    }

    let payload: SendblueInboundPayload;
    try {
      payload = (await c.req.json()) as SendblueInboundPayload;
    } catch {
      return jsonError(c, 400, "invalid_json", "Webhook body must be JSON.");
    }

    if (shouldIgnoreInbound(payload, appEnv.SENDBLUE_FROM_NUMBER)) {
      const body: SendblueWebhookResponse = { ok: true, ignored: true, reason: payload.is_outbound ? "outbound" : "empty_content" };
      return c.json(body);
    }

    const to = replyTarget(payload);
    if (!to) {
      const body: SendblueWebhookResponse = { ok: true, ignored: true, reason: "no_reply_target" };
      return c.json(body);
    }

    if (!isAllowedSender(to, appEnv)) {
      // Strangers texting the line get no financial data and cost no Sendblue credit.
      await c.get("store")?.logMessage({ direction: "inbound", phone: to, body: `[ignored: not an allowed sender] ${payload.content ?? ""}`, created_at: c.get("now")(), command: null });
      const body: SendblueWebhookResponse = { ok: true, ignored: true, reason: "sender_not_allowed" };
      return c.json(body);
    }

    const content = payload.content ?? "";
    const now = c.get("now")();
    const store = c.get("store");
    const command = matchCommand(content) ?? "HELP";

    await store?.logMessage({ direction: "inbound", phone: to, body: content, created_at: now, command });

    const derived = await c.get("provider").getDerived();
    const reply = replyFor(command, { derived, incident: primaryIncident(derived), baseUrl: baseUrl(c) });
    const result = await c.get("sendblue").sendMessage({ to, content: reply });

    if (result.sent) {
      await store?.logMessage({
        direction: "outbound",
        phone: to,
        body: reply,
        created_at: now,
        command,
        provider_message_id: result.provider_message_id ?? null,
      });
    }

    const body: SendblueWebhookResponse = { ok: true, command, reply, reply_sent: result.sent };
    if (!result.sent && result.error) body.error = result.error;
    return c.json(body);
  });
}
