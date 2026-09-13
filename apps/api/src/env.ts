/**
 * Worker bindings. Field names are fixed by the deploy config and
 * `.dev.vars.example`; only the lead integrator adds new ones.
 */
export interface Env {
  DB: D1Database;
  /** Static assets (SPA + as-of snapshots). Set by wrangler `assets.binding`. */
  ASSETS?: Fetcher;
  SENDBLUE_API_KEY?: string;
  SENDBLUE_API_SECRET?: string;
  SENDBLUE_FROM_NUMBER?: string;
  OPENAI_API_KEY?: string;
  /** Chat model for conversational iMessage. Defaults to `gpt-4o-mini`. */
  OPENAI_MODEL?: string;
  TAVILY_API_KEY?: string;
  WEBHOOK_SECRET?: string;
  FOUNDER_PHONE?: string;
  /** Expected Google account for the calendar connection; a mismatch is flagged, not rejected. */
  FOUNDER_EMAIL?: string;
  /** Optional comma-separated extra E.164 numbers Canary will reply to (demo teammates). */
  ALLOWED_PHONES?: string;
  PUBLIC_BASE_URL?: string;
  /** ElevenLabs TTS for the iMessage voice note. Optional — alerts degrade to text only. */
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;
  /** Conversational agent for the Ask Canary web widget. Empty = the page stays silent. */
  ELEVENLABS_AGENT_ID?: string;
  /**
   * Private iCal (`.ics`) URL for the founder's calendar. Optional — without it
   * Canary has no availability signal and never defers an alert.
   */
  CALENDAR_ICS_URL?: string;
  /** `"1"` to show real event titles in the calendar view. Anything else renders "Busy". */
  CALENDAR_SHOW_TITLES?: string;
  /**
   * Demo clock speed: real minutes per simulated day. Unset → 1 (one day per
   * minute). `"0"` freezes the ledger at the end of history — the setting for a
   * recorded clip or any run that must reproduce exactly. Editable in the
   * Cloudflare dashboard, so no deploy is needed to freeze or unfreeze a demo.
   */
  DEMO_CLOCK_MINUTES_PER_DAY?: string;
  /**
   * Rho API access token (`rhobat_…`). Unset → `/api/bank/rho` reads Rho's
   * SANDBOX, which accepts any bearer token, so the integration is live with no
   * credentials. Set it and the same code reads production.
   */
  RHO_API_KEY?: string;
  /**
   * Google OAuth web client (one account: the founder's). With both set and a
   * connected `google_oauth` row, Google replaces the ICS feed and Canary can
   * also book the review. See `apps/api/README.md`.
   */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** IANA zone the review-slot business hours are read in. Default `America/New_York`. */
  CALENDAR_TIMEZONE?: string;
}

export const API_VERSION = "0.0.1";

/** Matches `.dev.vars.example` so `wrangler dev` links work without configuration. */
export const DEFAULT_PUBLIC_BASE_URL = "http://localhost:8787";

export function publicBaseUrl(env: Partial<Env>): string {
  return env.PUBLIC_BASE_URL?.trim() || DEFAULT_PUBLIC_BASE_URL;
}
