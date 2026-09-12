/**
 * Worker bindings. Field names are fixed by the deploy config and
 * `.dev.vars.example`; only the lead integrator adds new ones.
 */
export interface Env {
  DB: D1Database;
  SENDBLUE_API_KEY?: string;
  SENDBLUE_API_SECRET?: string;
  SENDBLUE_FROM_NUMBER?: string;
  OPENAI_API_KEY?: string;
  /** Chat model for conversational iMessage. Defaults to `gpt-4o-mini`. */
  OPENAI_MODEL?: string;
  TAVILY_API_KEY?: string;
  WEBHOOK_SECRET?: string;
  FOUNDER_PHONE?: string;
  /** Optional comma-separated extra E.164 numbers Canary will reply to (demo teammates). */
  ALLOWED_PHONES?: string;
  PUBLIC_BASE_URL?: string;
  /** ElevenLabs TTS for the iMessage voice note. Optional — alerts degrade to text only. */
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;
  /**
   * Private iCal (`.ics`) URL for the founder's calendar. Optional — without it
   * Canary has no availability signal and never defers an alert.
   */
  CALENDAR_ICS_URL?: string;
  /** `"1"` to show real event titles in the calendar view. Anything else renders "Busy". */
  CALENDAR_SHOW_TITLES?: string;
}

export const API_VERSION = "0.0.1";

/** Matches `.dev.vars.example` so `wrangler dev` links work without configuration. */
export const DEFAULT_PUBLIC_BASE_URL = "http://localhost:8787";

export function publicBaseUrl(env: Partial<Env>): string {
  return env.PUBLIC_BASE_URL?.trim() || DEFAULT_PUBLIC_BASE_URL;
}
