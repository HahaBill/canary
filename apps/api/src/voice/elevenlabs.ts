/**
 * ElevenLabs text-to-speech → raw S16LE PCM. Plain `fetch`, no SDK.
 * The script it speaks is rendered deterministically from engine output
 * (src/messages.ts) — ElevenLabs only voices it, it never composes it.
 */
import type { FetchLike } from "../sendblue/client.ts";

export const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
/** Calm, clear premade voice ("Sarah"). Override with ELEVENLABS_VOICE_ID. */
export const DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";
export const DEFAULT_MODEL_ID = "eleven_turbo_v2_5";
export const PCM_SAMPLE_RATE = 24_000;

export interface TtsConfig {
  apiKey?: string;
  voiceId?: string;
  modelId?: string;
  fetchImpl?: FetchLike;
  url?: string;
}

export interface TtsResult {
  ok: boolean;
  pcm?: Uint8Array;
  sampleRate: number;
  status: number;
  error?: string;
}

export interface TextToSpeech {
  readonly configured: boolean;
  synthesizePcm(text: string): Promise<TtsResult>;
}

export class ElevenLabsTts implements TextToSpeech {
  constructor(private readonly config: TtsConfig = {}) {}

  get configured(): boolean {
    return Boolean(this.config.apiKey);
  }

  async synthesizePcm(text: string): Promise<TtsResult> {
    if (!this.configured) return { ok: false, sampleRate: PCM_SAMPLE_RATE, status: 0, error: "ELEVENLABS_NOT_CONFIGURED" };
    const doFetch = this.config.fetchImpl ?? ((req: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => fetch(req, init));
    const voice = this.config.voiceId?.trim() || DEFAULT_VOICE_ID;
    const url = `${this.config.url ?? ELEVENLABS_TTS_URL}/${encodeURIComponent(voice)}?output_format=pcm_${PCM_SAMPLE_RATE}`;
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "xi-api-key": this.config.apiKey!, "content-type": "application/json", accept: "application/octet-stream" },
        body: JSON.stringify({ text, model_id: this.config.modelId ?? DEFAULT_MODEL_ID }),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 200);
        return { ok: false, sampleRate: PCM_SAMPLE_RATE, status: res.status, error: detail || `HTTP ${res.status}` };
      }
      const pcm = new Uint8Array(await res.arrayBuffer());
      if (pcm.length === 0) return { ok: false, sampleRate: PCM_SAMPLE_RATE, status: res.status, error: "empty audio" };
      return { ok: true, pcm, sampleRate: PCM_SAMPLE_RATE, status: res.status };
    } catch (err) {
      return { ok: false, sampleRate: PCM_SAMPLE_RATE, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
