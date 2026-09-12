/**
 * `POST /api/alerts/send` — the outbound iMessage that opens the demo.
 *
 * Material incident → one `AlertRendering` (text + voice script from the same
 * incident) → Sendblue text → ElevenLabs PCM → CAF → Sendblue-hosted media →
 * native iMessage voice note. The voice note is best-effort: any failure
 * leaves the text alert delivered and is reported in `voice.error`.
 */
import type { SendAlertResponse, SendAlertVoiceResult } from "@canary/shared";
import { baseUrl, jsonError, readJson, type CanaryApp, type CanaryContext } from "../context.ts";
import { primaryIncident } from "../derive.ts";
import { renderAlert } from "../messages.ts";
import { normalizePcm16, pcmDurationSeconds, pcmToCaf } from "../voice/caf.ts";

export const VOICE_NOTE_FILENAME = "CanaryAlert.caf";

async function sendVoiceNote(c: CanaryContext, to: string, script: string): Promise<SendAlertVoiceResult> {
  const tts = c.get("tts");
  if (!tts.configured) return { sent: false, transcript: script, error: "ELEVENLABS_NOT_CONFIGURED" };

  const synth = await tts.synthesizePcm(script);
  if (!synth.ok || !synth.pcm) return { sent: false, transcript: script, error: `tts: ${synth.error ?? synth.status}` };

  // TTS output is quiet as a voice memo — bring the peak up to just under full scale.
  const { pcm } = normalizePcm16(synth.pcm);
  const caf = pcmToCaf(pcm, synth.sampleRate);
  const seconds = Math.round(pcmDurationSeconds(pcm.length, synth.sampleRate) * 10) / 10;

  const sendblue = c.get("sendblue");
  const upload = await sendblue.uploadFile({ bytes: caf, filename: VOICE_NOTE_FILENAME, contentType: "audio/x-caf" });
  if (!upload.ok || !upload.media_url) return { sent: false, transcript: script, seconds, error: `upload: ${upload.error ?? upload.status}` };

  const sent = await sendblue.sendMessage({ to, media_url: upload.media_url });
  const result: SendAlertVoiceResult = { sent: sent.sent, transcript: script, media_url: upload.media_url, seconds };
  if (sent.provider_message_id) result.provider_message_id = sent.provider_message_id;
  if (!sent.sent) result.error = `send: ${sent.error ?? sent.status}`;
  return result;
}

export function registerAlertRoutes(app: CanaryApp): void {
  app.post("/api/alerts/send", async (c) => {
    const body = await readJson(c);
    if (!body) return jsonError(c, 400, "invalid_json", "Request body must be a JSON object.");

    const requestedTo = typeof body.to === "string" ? body.to.trim() : "";
    const to = requestedTo || c.get("appEnv").FOUNDER_PHONE?.trim() || "";
    if (!to) return jsonError(c, 400, "missing_recipient", "Provide `to`, or set FOUNDER_PHONE.");

    const incidentId = typeof body.incident_id === "string" ? body.incident_id.trim() : "";
    const wantVoice = body.voice === undefined ? true : body.voice === true;

    const provider = c.get("provider");
    const derived = await provider.getDerived();
    const incident = incidentId ? (derived.incidents.find((i) => i.id === incidentId) ?? null) : primaryIncident(derived);
    if (!incident) {
      return jsonError(c, 404, "incident_not_found", incidentId ? `No incident with id ${incidentId}.` : "No incident to alert on.");
    }

    const rendering = renderAlert(incident, baseUrl(c));
    const message = rendering.text_summary;
    const result = await c.get("sendblue").sendMessage({ to, content: message });
    const now = c.get("now")();

    if (!result.sent) {
      const response: SendAlertResponse = { sent: false, to, message, error: result.error ?? "send_failed" };
      return c.json(response, result.error === "SENDBLUE_NOT_CONFIGURED" ? 503 : 502);
    }

    const store = c.get("store");
    await store?.logMessage({
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

    if (wantVoice) {
      const voice = await sendVoiceNote(c, to, rendering.voice_summary);
      response.voice = voice;
      if (voice.sent) {
        await store?.logMessage({
          direction: "outbound",
          phone: to,
          body: `[voice note ${voice.seconds ?? "?"}s] ${voice.transcript}`,
          created_at: now,
          command: null,
          provider_message_id: voice.provider_message_id ?? null,
        });
      }
    }

    return c.json(response);
  });
}
