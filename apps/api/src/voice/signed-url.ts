/**
 * Short-lived ElevenLabs conversation ticket for the Ask Canary widget.
 * The API key stays on the Worker; the browser only sees `signed_url`.
 */
import type { FetchLike } from "../sendblue/client.ts";

export const ELEVENLABS_SIGNED_URL = "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url";

export interface SignedUrlResult {
  ok: boolean;
  signed_url?: string;
  status: number;
  error?: string;
}

export async function getConversationSignedUrl(options: {
  apiKey: string;
  agentId: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  url?: string;
}): Promise<SignedUrlResult> {
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const endpoint = new URL(options.url ?? ELEVENLABS_SIGNED_URL);
  endpoint.searchParams.set("agent_id", options.agentId);

  try {
    const res = await doFetch(endpoint.toString(), {
      method: "GET",
      headers: { "xi-api-key": options.apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, error: text.slice(0, 200) || `HTTP ${res.status}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, status: res.status, error: "invalid_json" };
    }
    const signedUrl = readSignedUrl(parsed);
    if (!signedUrl) return { ok: false, status: res.status, error: "missing_signed_url" };
    return { ok: true, signed_url: signedUrl, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

function readSignedUrl(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const url = (payload as { signed_url?: unknown }).signed_url;
  if (typeof url !== "string" || url.length === 0 || url.length > 2048) return null;
  if (!url.startsWith("wss://") && !url.startsWith("https://")) return null;
  return url;
}
