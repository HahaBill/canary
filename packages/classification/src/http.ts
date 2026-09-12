/**
 * Minimal structural `fetch` seam. Providers take a `FetchLike` so tests can
 * inject a fake and so the same code runs on Node and on Cloudflare Workers
 * without depending on either runtime's `Response` type (and with no SDKs).
 */

export interface HttpRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: HttpRequestInit) => Promise<HttpResponseLike>;

/** Resolves `globalThis.fetch` at call time so a late polyfill still works. */
export function defaultFetch(): FetchLike {
  return (url, init) => {
    const f = (globalThis as { fetch?: unknown }).fetch;
    if (typeof f !== "function") {
      throw new Error("global fetch is unavailable; pass an explicit fetchImpl");
    }
    return (f as (u: string, i: HttpRequestInit) => Promise<HttpResponseLike>)(url, init);
  };
}

/** Collapse whitespace and hard-cap length. Keeps provider text safe for JSON columns and UI. */
export function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Model prose must never carry URLs or numeric self-confidence into our records (PRD §21). */
export function sanitizeModelText(text: string, max = 240): string {
  return truncate(text.replace(/https?:\/\/\S+/g, "").replace(/\bconfidence[:=]?\s*[\d.]+%?/gi, ""), max);
}

export function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\/\S+$/.test(value.trim());
}

/** `JSON.parse` that never throws; callers decide what a `null` body means. */
export function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
