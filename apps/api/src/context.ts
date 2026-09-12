/** Hono context typing + the small helpers every route uses. */
import type { BankProvider, ErrorResponse } from "@canary/shared";
import type { Context, Hono } from "hono";
import type { D1Store } from "./data/d1.ts";
import type { DataProvider } from "./data/provider.ts";
import { publicBaseUrl, type Env } from "./env.ts";
import type { SendblueClient } from "./sendblue/client.ts";
import type { TextToSpeech } from "./voice/elevenlabs.ts";

export interface Variables {
  provider: DataProvider;
  sendblue: SendblueClient;
  tts: TextToSpeech;
  bank: BankProvider;
  /** Null when no D1 binding is available (unit tests, `wrangler dev` without D1). */
  store: D1Store | null;
  /** Runtime bindings merged with any test overrides. */
  appEnv: Env;
  /** Injectable clock — production code never calls `Date.now()` directly. */
  now: () => string;
}

export type AppEnv = { Bindings: Env; Variables: Variables };
export type CanaryApp = Hono<AppEnv>;
export type CanaryContext = Context<AppEnv>;

export type ErrorStatus = 400 | 401 | 404 | 409 | 500 | 502 | 503;

export function jsonError(c: CanaryContext, status: ErrorStatus, error: string, detail?: string): Response {
  const body: ErrorResponse = detail ? { error, detail } : { error };
  return c.json(body, status);
}

export function baseUrl(c: CanaryContext): string {
  return publicBaseUrl(c.get("appEnv"));
}

/** Parses a JSON body, tolerating an empty one. Returns null only on malformed JSON. */
export async function readJson(c: CanaryContext): Promise<Record<string, unknown> | null> {
  const raw = await c.req.text();
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
