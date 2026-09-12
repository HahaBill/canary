/**
 * Sendblue iMessage transport. Plain `fetch`, no SDK.
 * Outbound: POST https://api.sendblue.co/api/send-message
 */
export const SENDBLUE_SEND_URL = "https://api.sendblue.co/api/send-message";

export type FetchLike = typeof fetch;

export interface SendblueConfig {
  apiKey?: string;
  apiSecret?: string;
  fromNumber?: string;
  fetchImpl?: FetchLike;
  sendUrl?: string;
  uploadUrl?: string;
}

export interface SendMessageInput {
  /** E.164 destination. */
  to: string;
  /** Optional when `media_url` is provided. */
  content?: string;
  /** Public URL. A `.caf` renders as a native iMessage voice memo. */
  media_url?: string;
}

export const SENDBLUE_UPLOAD_URL = "https://api.sendblue.com/api/upload-file";

export interface UploadFileInput {
  bytes: Uint8Array;
  /** Must carry the right extension (`CanaryAlert.caf`) — iMessage keys rendering off it. */
  filename: string;
  contentType: string;
}

export interface UploadFileResult {
  ok: boolean;
  status: number;
  media_url?: string;
  error?: string;
}

export interface SendMessageResult {
  sent: boolean;
  /** HTTP status, or 0 when the request never left the Worker. */
  status: number;
  provider_message_id?: string;
  error?: string;
}

/** Shape of the inbound webhook body. Everything is optional — Sendblue is upstream. */
export interface SendblueInboundPayload {
  content?: string;
  from_number?: string;
  number?: string;
  is_outbound?: boolean;
  status?: string;
  message_handle?: string;
  date_sent?: string;
  media_url?: string;
}

export class SendblueClient {
  constructor(private readonly config: SendblueConfig = {}) {}

  /** False when credentials are absent — callers surface this instead of pretending to send. */
  get configured(): boolean {
    return Boolean(this.config.apiKey && this.config.apiSecret && this.config.fromNumber);
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    if (!this.configured) {
      return { sent: false, status: 0, error: "SENDBLUE_NOT_CONFIGURED" };
    }
    const doFetch = this.config.fetchImpl ?? ((req: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => fetch(req, init));
    try {
      const res = await doFetch(this.config.sendUrl ?? SENDBLUE_SEND_URL, {
        method: "POST",
        headers: {
          "sb-api-key-id": this.config.apiKey!,
          "sb-api-secret-key": this.config.apiSecret!,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          number: input.to,
          from_number: this.config.fromNumber,
          ...(input.content !== undefined ? { content: input.content } : {}),
          ...(input.media_url ? { media_url: input.media_url } : {}),
        }),
      });
      const text = await res.text();
      const payload = safeJson(text);
      if (!res.ok) {
        return { sent: false, status: res.status, error: payload?.error ?? text.slice(0, 200) };
      }
      return { sent: true, status: res.status, provider_message_id: payload?.message_handle };
    } catch (err) {
      return { sent: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Re-hosts a file on Sendblue's CDN and returns its public `media_url`. */
  async uploadFile(input: UploadFileInput): Promise<UploadFileResult> {
    if (!this.configured) return { ok: false, status: 0, error: "SENDBLUE_NOT_CONFIGURED" };
    const doFetch = this.config.fetchImpl ?? ((req: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => fetch(req, init));
    try {
      const form = new FormData();
      form.append("file", new Blob([input.bytes as unknown as ArrayBuffer], { type: input.contentType }), input.filename);
      const res = await doFetch(this.config.uploadUrl ?? SENDBLUE_UPLOAD_URL, {
        method: "POST",
        headers: { "sb-api-key-id": this.config.apiKey!, "sb-api-secret-key": this.config.apiSecret! },
        body: form,
      });
      const text = await res.text();
      const payload = safeJson(text);
      if (!res.ok || !payload?.media_url) {
        return { ok: false, status: res.status, error: payload?.message ?? payload?.error ?? text.slice(0, 200) };
      }
      return { ok: true, status: res.status, media_url: payload.media_url };
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function safeJson(text: string): { error?: string; message?: string; message_handle?: string; media_url?: string } | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as ReturnType<typeof safeJson>) : null;
  } catch {
    return null;
  }
}
