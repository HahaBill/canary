/**
 * The one code path that actually sends an alert.
 *
 * `POST /api/alerts/send` uses it, and so does the cron that drains alerts
 * deferred while the founder was in a meeting — a deferred alert must be
 * byte-identical to one sent immediately, so there is exactly one renderer
 * (`renderAlert`), one Sendblue call pair, and one audit-log shape.
 *
 * Text and voice come from the SAME incident object, so they cannot disagree
 * (docs/AGENT_BEHAVIOR.md §3). The voice note is best-effort: any failure leaves
 * the text alert delivered and is reported in `voice.error`.
 */
import type { Incident, SendAlertVoiceResult } from "@canary/shared";
import type { Variables } from "../context.ts";
import { VOICE_LOG_PREFIX } from "../data/d1.ts";
import { publicBaseUrl } from "../env.ts";
import { renderAlert } from "../messages.ts";
import { sendVoiceNote } from "../voice/send.ts";

/** Everything sending an alert needs, and nothing else. Satisfied by the Hono context and by the cron. */
export type AlertRuntime = Pick<Variables, "provider" | "sendblue" | "tts" | "store" | "now" | "appEnv">;

export interface DeliverAlertInput {
  incident: Incident;
  to: string;
  voice: boolean;
}

export interface DeliverAlertOutcome {
  sent: boolean;
  /** The exact text that was sent (or would have been). */
  message: string;
  provider_message_id?: string;
  error?: string;
  voice?: SendAlertVoiceResult;
}

/**
 * Renders the incident, texts it, logs it, marks the incident notified, then
 * (optionally) follows with the voice note. `sent` refers to the TEXT: a failed
 * voice note never marks the alert undelivered, and a failed text never marks
 * the incident notified.
 */
export async function deliverAlert(runtime: AlertRuntime, { incident, to, voice }: DeliverAlertInput): Promise<DeliverAlertOutcome> {
  const rendering = renderAlert(incident, publicBaseUrl(runtime.appEnv));
  const message = rendering.text_summary;
  const result = await runtime.sendblue.sendMessage({ to, content: message });
  const now = runtime.now();

  if (!result.sent) return { sent: false, message, error: result.error ?? "send_failed" };

  const store = runtime.store;
  await store?.logMessage({
    direction: "outbound",
    phone: to,
    body: message,
    created_at: now,
    command: null,
    provider_message_id: result.provider_message_id ?? null,
  });
  await runtime.provider.markNotified(incident.id, now);

  const outcome: DeliverAlertOutcome = { sent: true, message };
  if (result.provider_message_id) outcome.provider_message_id = result.provider_message_id;

  if (voice) {
    const spoken = await sendVoiceNote(runtime, to, rendering.voice_summary);
    outcome.voice = spoken;
    if (spoken.sent) {
      await store?.logMessage({
        direction: "outbound",
        phone: to,
        body: `${VOICE_LOG_PREFIX} ${spoken.seconds ?? "?"}s] ${spoken.transcript}`,
        created_at: now,
        command: null,
        provider_message_id: spoken.provider_message_id ?? null,
      });
    }
  }

  return outcome;
}
