/**
 * `POST /webhooks/sendblue` — inbound iMessage.
 *
 * Auth: `sb-signing-secret` (what Sendblue sends for the dashboard "Global
 * Secret") or `x-canary-secret` must equal `WEBHOOK_SECRET` (constant-time).
 * The query string is deliberately NOT accepted (it would land in request logs).
 * Replies go only to FOUNDER_PHONE / ALLOWED_PHONES. Outbound echoes and empty messages are ignored so Canary
 * never replies to itself.
 *
 * Two reply paths, keyword first:
 *   - `matchCommand` hits → the deterministic keyword reply (WHY / SHOW ME /
 *     SOURCES / HELP). No model is involved. This is the demo's guaranteed path
 *     and it behaves exactly as it did before conversation existed.
 *   - `matchCommand` misses → `src/conversation`: OpenAI tool-calling over
 *     Canary's deterministic tools, with per-phone memory in D1.
 */
import type { IMessageCommand } from "@canary/shared";
import { CONVERSATION } from "../conversation/config.ts";
import { compactIfNeeded } from "../conversation/compaction.ts";
import { countRecentConversationalReplies, loadThread } from "../conversation/memory.ts";
import { answerConversationally, isHelpFallback, type ConversationReply } from "../conversation/router.ts";
import { baseUrl, jsonError, type CanaryApp, type CanaryContext } from "../context.ts";
import { primaryIncident } from "../derive.ts";
import { isAllowedSender, matchCommand, replyFor, replyTarget, shouldIgnoreInbound } from "../imessage/router.ts";
import { scheduleReviewReply } from "../calendar/schedule-command.ts";
import { helpMessage } from "../messages.ts";
import type { SendblueInboundPayload } from "../sendblue/client.ts";
import { requestAuthorized } from "../security.ts";

export interface SendblueWebhookResponse {
  ok: boolean;
  ignored?: boolean;
  reason?: string;
  /** The keyword whose reply was sent. Absent when a model wrote the reply. */
  command?: IMessageCommand;
  mode?: "keyword" | "conversation";
  /** Deterministic tools behind a conversational reply, in call order. */
  tool_calls?: string[];
  refused?: boolean;
  reply?: string;
  reply_sent?: boolean;
  error?: string;
}

/** Start of the rolling rate-limit window, as an ISO timestamp. */
function oneHourBefore(now: string): string {
  return new Date(new Date(now).getTime() - 3_600_000).toISOString();
}

/**
 * Compaction runs after the reply is stored, so it never delays the founder.
 * Hono only exposes `executionCtx` on a real Workers request; in tests (and in
 * `app.request()`) it throws, so we await instead.
 */
function afterReply(c: CanaryContext, work: Promise<unknown>): Promise<unknown> {
  try {
    c.executionCtx.waitUntil(work);
    return Promise.resolve();
  } catch {
    return work;
  }
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
    const command = matchCommand(content);

    // ---- Keyword path: unchanged, deterministic, no model. --------------------
    if (command !== null) {
      await store?.logMessage({ direction: "inbound", phone: to, body: content, created_at: now, command });

      const derived = await c.get("provider").getDerived();
      const reply = await replyFor(command, {
        derived,
        incident: primaryIncident(derived),
        baseUrl: baseUrl(c),
        schedule: async (incident) => {
          const { provider: calendarProvider, google } = await c.get("calendarResolver").resolve();
          return scheduleReviewReply({ provider: calendarProvider, calendar: google, incident, baseUrl: baseUrl(c), now, reviews: c.get("reviews") });
        },
      });
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

      const body: SendblueWebhookResponse = { ok: true, mode: "keyword", command, reply, reply_sent: result.sent };
      if (!result.sent && result.error) body.error = result.error;
      return c.json(body);
    }

    // ---- Conversational path. -------------------------------------------------
    // `command: null` on both rows is what marks a turn as conversational; the
    // outbound row's `tool_calls` is what the hourly cap counts.
    await store?.logMessage({ direction: "inbound", phone: to, body: content, created_at: now, command: null });

    const overLimit = (await countRecentConversationalReplies(store, to, oneHourBefore(now))) >= CONVERSATION.MAX_PER_HOUR;
    const answer: ConversationReply = overLimit
      ? { reply: helpMessage(), tool_calls: [], fallback: "rate_limited" }
      : await answerConversationally({
          text: content,
          phone: to,
          thread: await loadThread(store, to),
          provider: c.get("provider"),
          baseUrl: baseUrl(c),
          llm: c.get("llm"),
          now,
        });

    const result = await c.get("sendblue").sendMessage({ to, content: answer.reply });

    if (result.sent) {
      await store?.logMessage({
        direction: "outbound",
        phone: to,
        body: answer.reply,
        created_at: now,
        command: null,
        provider_message_id: result.provider_message_id ?? null,
        tool_calls: answer.tool_calls,
      });
      // No point spending an OpenAI call compacting a thread whose last turn
      // never reached OpenAI (unconfigured, errored, or rate-limited).
      if (!isHelpFallback(answer.fallback)) {
        await afterReply(c, compactIfNeeded({ store, llm: c.get("llm"), now: c.get("now") }, to));
      }
    }

    const body: SendblueWebhookResponse = {
      ok: true,
      mode: "conversation",
      tool_calls: answer.tool_calls,
      reply: answer.reply,
      reply_sent: result.sent,
    };
    // The degraded replies ARE the HELP message, so they report as the HELP
    // command — an unrecognised message without a model behind it behaves
    // exactly as it did before this path existed.
    if (isHelpFallback(answer.fallback)) body.command = "HELP";
    if (answer.refused) body.refused = true;
    if (answer.fallback) body.reason = answer.fallback;
    if (!result.sent && result.error) body.error = result.error;
    return c.json(body);
  });
}
