/**
 * The founder's Google Calendar, behind the exact interface the ICS feed
 * implements (`CalendarFeed`) — so the alert policy, `/api/availability` and
 * `/api/calendar` cannot tell which one they are talking to.
 *
 * What Google adds over the read-only iCal feed is write access: Canary can book
 * the 15 minutes to review an incident. Everything else is the same contract,
 * including the failure mode — if Google cannot be reached the provider reports
 * `source: "none"` and the founder looks free, because a broken calendar must
 * never be the reason a material incident goes unsaid.
 *
 * Titles stay inside this module unless `CALENDAR_SHOW_TITLES === "1"`; the
 * calendar view renders "Busy".
 */
import { formatMonths, formatSignedUsd, formatUsdWhole, type Incident, type ISODate, type ISODateTime } from "@canary/shared";
import { displayName } from "../../format.ts";
import type { FetchLike } from "../../sendblue/client.ts";
import {
  CALENDAR_CACHE_TTL_MS,
  CALENDAR_ERROR_TTL_MS,
  LOOKAHEAD_MS,
  type BusyStatus,
  type CalendarFeed,
  type CalendarFeedEvent,
  type CalendarFeedResult,
} from "../ics.ts";
import { mergeBusyRanges, type BusyRange } from "./slots.ts";
import { getAccessToken, type AccessTokenEnv } from "./tokens.ts";
import type { GoogleOauthStore } from "./store.ts";

export const GOOGLE_FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
export const GOOGLE_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

/** Availability is asked on every alert decision, so it gets the shorter cache. */
export const FREEBUSY_CACHE_TTL_MS = 60_000;
export const DEFAULT_CALENDAR_TIMEZONE = "America/New_York";
/** Google's page limit for a single event list; a founder's week does not come close. */
export const EVENTS_MAX_RESULTS = 250;

const DAY_MS = 86_400_000;
const TIMEOUT_MS = 10_000;
/** Only the calendar Canary was connected to. "primary" is the account's own calendar. */
const CALENDAR_ID = "primary";

interface CacheEntry<T> {
  value: T | null;
  fetchedAt: number;
}

/** Per isolate. Keyed by the request that produced it, so two windows never share an answer. */
const freeBusyCache = new Map<string, CacheEntry<BusyRange[]>>();
const eventsCache = new Map<string, CacheEntry<CalendarFeedEvent[]>>();

/** Test seam: drop the isolate-level Google caches. */
export function clearGoogleCalendarCache(): void {
  freeBusyCache.clear();
  eventsCache.clear();
}

export interface GoogleCalendarConfig {
  store: GoogleOauthStore;
  env: AccessTokenEnv & { CALENDAR_SHOW_TITLES?: string; CALENDAR_TIMEZONE?: string };
  fetchImpl: FetchLike;
  /** Injectable clock — cache TTLs must not depend on `Date.now()`. */
  now: () => string;
  /** Distinguishes cache entries between accounts/apps. */
  accountKey?: string;
}

export interface CreatedReviewEvent {
  id: string;
  /** Google's UI link. Null when Google omits it (it never does in practice). */
  htmlLink: string | null;
  start: ISODateTime;
  end: ISODateTime;
  summary: string;
}

export type CreateReviewEventResult =
  | { ok: true; event: CreatedReviewEvent }
  | { ok: false; error: "not_connected" | "insert_failed"; detail?: string };

export interface CreateReviewEventInput {
  incident: Incident;
  /** Deep link from `buildAppPath` — the model never writes a URL (docs/AGENT_BEHAVIOR.md §4). */
  appUrl: string;
  start: ISODateTime;
  durationMinutes?: number;
}

/**
 * One OBSERVED line for the invite body, straight off the incident. No
 * arithmetic, no adjectives, no suggestion — the incident page carries the rest.
 */
export function observedLine(incident: Incident): string {
  if (incident.type === "ONE_OFF_VENDOR_PAYMENT") {
    const amount = incident.financial_impact.one_off_amount_cents;
    return amount
      ? `OBSERVED — One-off payment to ${displayName(incident.entity)}: ${formatUsdWhole(amount)}, well above this vendor's usual payments.`
      : `OBSERVED — One-off payment to ${displayName(incident.entity)} flagged against this vendor's own history.`;
  }
  const { delta_weekly_cents, runway_before_months, runway_after_months } = incident.financial_impact;
  const parts: string[] = [];
  if (delta_weekly_cents !== null) parts.push(`variable spending ${formatSignedUsd(delta_weekly_cents, "/wk")} versus the previous regime`);
  if (runway_before_months !== null && runway_after_months !== null) {
    parts.push(`modeled runway ${formatMonths(runway_before_months)} → ${formatMonths(runway_after_months)}`);
  }
  return parts.length > 0 ? `OBSERVED — ${parts.join("; ")}.` : `OBSERVED — ${incident.summary}`;
}

interface GoogleEvent {
  id?: unknown;
  status?: unknown;
  summary?: unknown;
  transparency?: unknown;
  htmlLink?: unknown;
  start?: { date?: unknown; dateTime?: unknown };
  end?: { date?: unknown; dateTime?: unknown };
  attendees?: Array<{ self?: unknown; responseStatus?: unknown }>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** All-day dates and RFC3339 timestamps both land as instants; anything unparseable is dropped. */
function instant(part: { date?: unknown; dateTime?: unknown } | undefined): { ms: number; allDay: boolean } | null {
  const dateTime = str(part?.dateTime);
  if (dateTime) {
    const ms = new Date(dateTime).getTime();
    return Number.isFinite(ms) ? { ms, allDay: false } : null;
  }
  const date = str(part?.date);
  if (date) {
    const ms = new Date(`${date}T00:00:00.000Z`).getTime();
    return Number.isFinite(ms) ? { ms, allDay: true } : null;
  }
  return null;
}

/** The founder said no: their calendar shows it, so it is not a busy block. */
function declinedBySelf(event: GoogleEvent): boolean {
  return (event.attendees ?? []).some((a) => a.self === true && a.responseStatus === "declined");
}

export class GoogleCalendarProvider implements CalendarFeed {
  constructor(private readonly config: GoogleCalendarConfig) {}

  /** Constructed only once a usable connection exists (see `calendar/resolve.ts`). */
  get configured(): boolean {
    return true;
  }

  get timeZone(): string {
    return this.config.env.CALENDAR_TIMEZONE?.trim() || DEFAULT_CALENDAR_TIMEZONE;
  }

  private get showTitles(): boolean {
    return this.config.env.CALENDAR_SHOW_TITLES === "1";
  }

  private nowMs(): number {
    return new Date(this.config.now()).getTime();
  }

  private cacheKey(suffix: string): string {
    return `${this.config.accountKey ?? this.config.env.GOOGLE_CLIENT_ID ?? "founder"}|${suffix}`;
  }

  private async authorizedFetch(url: string, init: RequestInit = {}): Promise<Response | null> {
    const token = await getAccessToken(this.config.store, this.config.env, this.config.fetchImpl, this.config.now);
    if (!token.ok) {
      console.warn(JSON.stringify({ msg: "google_calendar_unauthorized", reason: token.error }));
      return null;
    }
    try {
      return await this.config.fetchImpl(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token.access_token}`, accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Never log the URL or the body: both can carry meeting details.
      console.warn(JSON.stringify({ msg: "google_calendar_fetch_error", error: err instanceof Error ? err.message : String(err) }));
      return null;
    }
  }

  /**
   * Busy ranges in `[from, to)`, merged. Null — not an empty list — when Google
   * could not be asked, so a caller can tell "nothing booked" from "don't know".
   */
  async busyBetween(from: ISODateTime, to: ISODateTime): Promise<BusyRange[] | null> {
    const key = this.cacheKey(`freebusy|${from}|${to}`);
    const now = this.nowMs();
    const cached = freeBusyCache.get(key);
    if (cached && now - cached.fetchedAt < (cached.value === null ? CALENDAR_ERROR_TTL_MS : FREEBUSY_CACHE_TTL_MS)) {
      return cached.value;
    }

    const res = await this.authorizedFetch(GOOGLE_FREEBUSY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeMin: from, timeMax: to, items: [{ id: CALENDAR_ID }] }),
    });

    let ranges: BusyRange[] | null = null;
    if (res?.ok) {
      try {
        const body = (await res.json()) as { calendars?: Record<string, { busy?: Array<{ start?: unknown; end?: unknown }>; errors?: unknown[] }> };
        const calendar = body.calendars?.[CALENDAR_ID];
        if (calendar?.errors && calendar.errors.length > 0) {
          console.warn(JSON.stringify({ msg: "google_freebusy_calendar_error" }));
        } else {
          const raw = (calendar?.busy ?? []).flatMap((block) => {
            const start = str(block.start);
            const end = str(block.end);
            return start && end ? [{ start, end }] : [];
          });
          ranges = mergeBusyRanges(raw).map((r) => ({ start: new Date(r.start).toISOString(), end: new Date(r.end).toISOString() }));
        }
      } catch (err) {
        console.warn(JSON.stringify({ msg: "google_freebusy_parse_failed", error: err instanceof Error ? err.message : String(err) }));
      }
    } else if (res) {
      console.warn(JSON.stringify({ msg: "google_freebusy_failed", status: res.status }));
    }

    freeBusyCache.set(key, { value: ranges, fetchedAt: now });
    return ranges;
  }

  /**
   * Same semantics as the ICS feed: busy runs merge, `until` is the end of the
   * run containing `now`, and `next_busy_start` only looks 24 hours ahead.
   *
   * The window is snapped to a minute so every request inside the same minute
   * shares one freeBusy call (the 60-second cache the availability check needs).
   */
  async isBusyAt(now: ISODateTime): Promise<BusyStatus> {
    const at = new Date(now).getTime();
    const windowStart = Math.floor(at / FREEBUSY_CACHE_TTL_MS) * FREEBUSY_CACHE_TTL_MS;
    const ranges = await this.busyBetween(new Date(windowStart).toISOString(), new Date(windowStart + LOOKAHEAD_MS).toISOString());
    if (ranges === null) return { busy: false, until: null, next_busy_start: null, source: "none" };

    // `source` says `ics` because `AvailabilityResponse.source` in packages/shared
    // does not admit `google` yet (reported as a contract gap).
    // `/api/calendar/connection` is where the real provider is named.
    const runs = mergeBusyRanges(ranges);
    const current = runs.find((r) => r.start <= at && at < r.end);
    if (current) return { busy: true, until: new Date(current.end).toISOString(), next_busy_start: null, source: "google" };

    const next = runs.find((r) => r.start > at && r.start <= at + LOOKAHEAD_MS);
    return { busy: false, until: null, next_busy_start: next ? new Date(next.start).toISOString() : null, source: "google" };
  }

  /** Busy events overlapping `[from 00:00Z, to+1d 00:00Z)`, in start order. */
  async fetchEvents(from: ISODate, to: ISODate): Promise<CalendarFeedResult> {
    const key = this.cacheKey(`events|${from}|${to}|${this.showTitles ? "titles" : "busy"}`);
    const now = this.nowMs();
    const cached = eventsCache.get(key);
    if (cached && now - cached.fetchedAt < (cached.value === null ? CALENDAR_ERROR_TTL_MS : CALENDAR_CACHE_TTL_MS)) {
      return { events: cached.value ?? [], source: cached.value === null ? "none" : "ics" };
    }

    const timeMin = new Date(`${from}T00:00:00.000Z`);
    const timeMax = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + DAY_MS);
    const params = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(EVENTS_MAX_RESULTS),
    });

    const res = await this.authorizedFetch(`${GOOGLE_EVENTS_URL}?${params.toString()}`);
    let events: CalendarFeedEvent[] | null = null;
    if (res?.ok) {
      try {
        const body = (await res.json()) as { items?: GoogleEvent[] };
        events = this.mapEvents(body.items ?? []);
      } catch (err) {
        console.warn(JSON.stringify({ msg: "google_events_parse_failed", error: err instanceof Error ? err.message : String(err) }));
      }
    } else if (res) {
      console.warn(JSON.stringify({ msg: "google_events_failed", status: res.status }));
    }

    eventsCache.set(key, { value: events, fetchedAt: now });
    return { events: events ?? [], source: events === null ? "none" : "ics" };
  }

  private mapEvents(items: GoogleEvent[]): CalendarFeedEvent[] {
    const out: CalendarFeedEvent[] = [];
    for (const item of items) {
      // Cancelled is not busy; `transparent` is Google's "free" flag; a declined
      // invitation is a meeting the founder is not in.
      if (item.status === "cancelled" || item.transparency === "transparent" || declinedBySelf(item)) continue;

      const start = instant(item.start);
      const end = instant(item.end);
      if (!start || !end) continue;

      out.push({
        uid: str(item.id) ?? `google_${start.ms}`,
        start: new Date(start.ms).toISOString(),
        end: new Date(Math.max(end.ms, start.ms)).toISOString(),
        // The founder's meeting titles are none of Canary's business by default.
        summary: this.showTitles ? (str(item.summary) ?? "Busy") : "Busy",
        allDay: start.allDay,
      });
    }
    out.sort((a, b) => a.start.localeCompare(b.start) || a.uid.localeCompare(b.uid));
    return out;
  }

  /** Books the review. The only write Canary ever makes to the founder's calendar. */
  async createReviewEvent(input: CreateReviewEventInput): Promise<CreateReviewEventResult> {
    const durationMinutes = input.durationMinutes ?? 15;
    const startMs = new Date(input.start).getTime();
    if (!Number.isFinite(startMs)) return { ok: false, error: "insert_failed", detail: "`start` is not a valid timestamp." };
    const end = new Date(startMs + durationMinutes * 60_000).toISOString();
    const summary = `Review: ${input.incident.title} — Canary`;

    const res = await this.authorizedFetch(GOOGLE_EVENTS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        summary,
        description: [observedLine(input.incident), input.appUrl].join("\n\n"),
        start: { dateTime: new Date(startMs).toISOString(), timeZone: this.timeZone },
        end: { dateTime: end, timeZone: this.timeZone },
        reminders: { useDefault: true },
        source: { title: "Canary", url: input.appUrl },
      }),
    });

    if (!res) return { ok: false, error: "not_connected", detail: "No usable Google access token." };
    if (!res.ok) {
      console.warn(JSON.stringify({ msg: "google_event_insert_failed", status: res.status }));
      return { ok: false, error: "insert_failed", detail: `Google returned ${res.status}.` };
    }

    let created: GoogleEvent = {};
    try {
      created = (await res.json()) as GoogleEvent;
    } catch {
      // A 200 with an unreadable body still means the event exists; carry on with what we asked for.
    }

    // A new event invalidates the caches it would otherwise be missing from.
    clearGoogleCalendarCache();

    return {
      ok: true,
      event: {
        id: str(created.id) ?? "",
        htmlLink: str(created.htmlLink),
        start: new Date(startMs).toISOString(),
        end,
        summary,
      },
    };
  }
}
