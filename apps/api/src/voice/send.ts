/**
 * The one path that turns a script into a native iMessage voice memo.
 *
 * Alerts and inbound replies both use this: ElevenLabs PCM → loudness
 * normalize → CAF → Sendblue CDN → `media_url`. ElevenLabs only voices the
 * script; it never composes it (docs/AGENT_BEHAVIOR.md §3).
 */
import type { SendAlertVoiceResult } from "@canary/shared";
import type { SendblueClient } from "../sendblue/client.ts";
import { normalizePcm16, pcmDurationSeconds, pcmToCaf } from "./caf.ts";
import type { TextToSpeech } from "./elevenlabs.ts";

export const VOICE_NOTE_FILENAME = "CanaryAlert.caf";
export const REPLY_VOICE_NOTE_FILENAME = "CanaryReply.caf";

export interface VoiceNoteRuntime {
  tts: TextToSpeech;
  sendblue: SendblueClient;
}

/**
 * Best-effort: any failure is returned in `error` and the caller keeps the
 * text message that already went out.
 */
export async function sendVoiceNote(
  runtime: VoiceNoteRuntime,
  to: string,
  script: string,
  filename: string = VOICE_NOTE_FILENAME,
): Promise<SendAlertVoiceResult> {
  const { tts, sendblue } = runtime;
  if (!script.trim()) return { sent: false, transcript: script, error: "empty_script" };
  if (!tts.configured) return { sent: false, transcript: script, error: "ELEVENLABS_NOT_CONFIGURED" };

  const synth = await tts.synthesizePcm(script);
  if (!synth.ok || !synth.pcm) return { sent: false, transcript: script, error: `tts: ${synth.error ?? synth.status}` };

  // TTS output is quiet as a voice memo — bring the peak up to just under full scale.
  const { pcm } = normalizePcm16(synth.pcm);
  const caf = pcmToCaf(pcm, synth.sampleRate);
  const seconds = Math.round(pcmDurationSeconds(pcm.length, synth.sampleRate) * 10) / 10;

  const upload = await sendblue.uploadFile({ bytes: caf, filename, contentType: "audio/x-caf" });
  if (!upload.ok || !upload.media_url) return { sent: false, transcript: script, seconds, error: `upload: ${upload.error ?? upload.status}` };

  const sent = await sendblue.sendMessage({ to, media_url: upload.media_url });
  const result: SendAlertVoiceResult = { sent: sent.sent, transcript: script, media_url: upload.media_url, seconds };
  if (sent.provider_message_id) result.provider_message_id = sent.provider_message_id;
  if (!sent.sent) result.error = `send: ${sent.error ?? sent.status}`;
  return result;
}
