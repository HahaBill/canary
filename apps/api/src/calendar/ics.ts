/**
 * The founder's private calendar feed — the only reason Canary ever holds an
 * alert back (docs/AGENT_BEHAVIOR.md §1: one message per material incident, and
 * not into the middle of a board meeting).
 *
 * Read-only, one private iCal URL (`CALENDAR_ICS_URL`), no OAuth, no vendor SDK.
 * Event titles never leave this module unless `CALENDAR_SHOW_TITLES === "1"`:
 * the calendar view renders "Busy", because availability is the only part of
 * the founder's day Canary has any business repeating.
 */
import type { ISODate, ISODateTime } from "@canary/shared";
import type { FetchLike } from "../sendblue/client.ts";
import { expand, parseEvents, type Occurrence } from "./parse.ts";

export type BusySource = "google" | "ics" | "none";

/** One occurrence of a calendar event, flattened to instants. */
export interface CalendarFeedEvent {
  uid: string;
  start: ISODateTime;
  end: ISODateTime;
  summary: string;
  allDay: boolean;
}

export interface CalendarFeedResult {
  events: CalendarFeedEvent[];
  /** `none` when no feed is configured, or the fetch/parse failed. */
  source: BusySource;
}

/** Availability at an instant, looking `LOOKAHEAD_MS` ahead. */
export interface BusyStatus {
  busy: boolean;
  /** End of the busy run containing `now` (back-to-back meetings merge into one run). */
  until: ISODateTime | null;
  /** Start of the next busy block inside the lookahead, when free. */
  next_busy_start: ISODateTime | null;
  source: BusySource;
}

export interface CalendarFeed {
  readonly configured: boolean;
  fetchEvents(from: ISODate, to: ISODate): Promise<CalendarFeedResult>;
  isBusyAt(now: ISODateTime): Promise<BusyStatus>;
}

const DAY_MS = 86_400_000;
export const CALENDAR_CACHE_TTL_MS = 5 * 60_000;
/** A failed fetch is cached briefly so a broken feed cannot be hammered per request. */
export const CALENDAR_ERROR_TTL_MS = 30_000;
/** How far ahead `isBusyAt` looks for the next meeting. */
export const LOOKAHEAD_MS = 24 * 60 * 60_000;

interface CacheEntry {
  text: string | null;
  fetchedAt: number;
}

/** Per isolate, keyed by feed URL. The feed is re-read at most every 5 minutes. */
const textCache = new Map<string, CacheEntry>();

/** Test seam: drop the isolate-level ICS cache. */
export function clearIcsCache(): void {
  textCache.clear();
}

export interface IcsCalendarConfig {
  url?: string;
  fetchImpl?: FetchLike;
  /** Injectable clock — the cache TTL must not depend on `Date.now()`. */
  now?: () => string;
  timeoutMs?: number;
}

/** A configured-but-empty feed: what every route sees when CALENDAR_ICS_URL is unset. */
export const NO_CALENDAR: CalendarFeed = {
  configured: false,
  async fetchEvents() {
    return { events: [], source: "none" };
  },
  async isBusyAt() {
    return { busy: false, until: null, next_busy_start: null, source: "none" };
  },
};

export class IcsCalendar implements CalendarFeed {
  constructor(private readonly config: IcsCalendarConfig = {}) {}

  get configured(): boolean {
    return Boolean(this.config.url?.trim());
  }

  private nowMs(): number {
    return new Date(this.config.now?.() ?? new Date().toISOString()).getTime();
  }

  /** Raw feed text, from the isolate cache when it is still fresh. */
  private async text(): Promise<string | null> {
    const url = this.config.url?.trim();
    if (!url) return null;

    const now = this.nowMs();
    const cached = textCache.get(url);
    if (cached && now - cached.fetchedAt < (cached.text === null ? CALENDAR_ERROR_TTL_MS : CALENDAR_CACHE_TTL_MS)) {
      return cached.text;
    }

    const doFetch = this.config.fetchImpl ?? ((req: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => fetch(req, init));
    let text: string | null = null;
    try {
      const res = await doFetch(url, {
        headers: { accept: "text/calendar" },
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 8_000),
      });
      // The URL is a secret; log the status only, never the URL or the body.
      if (res.ok) text = await res.text();
      else console.warn(JSON.stringify({ msg: "calendar_fetch_failed", status: res.status }));
    } catch (err) {
      console.warn(JSON.stringify({ msg: "calendar_fetch_error", error: err instanceof Error ? err.message : String(err) }));
    }

    textCache.set(url, { text, fetchedAt: now });
    return text;
  }

  /** Occurrences overlapping `[from 00:00Z, to+1d 00:00Z)`, in start order. */
  private async occurrences(rangeStart: Date, rangeEnd: Date): Promise<{ occurrences: Occurrence[]; source: BusySource }> {
    const text = await this.text();
    if (text === null) return { occurrences: [], source: "none" };
    try {
      const out = parseEvents(text).flatMap((event) => expand(event, rangeStart, rangeEnd));
      out.sort((a, b) => a.start.getTime() - b.start.getTime() || a.uid.localeCompare(b.uid));
      return { occurrences: out, source: "ics" };
    } catch (err) {
      console.warn(JSON.stringify({ msg: "calendar_parse_failed", error: err instanceof Error ? err.message : String(err) }));
      return { occurrences: [], source: "none" };
    }
  }

  async fetchEvents(from: ISODate, to: ISODate): Promise<CalendarFeedResult> {
    const rangeStart = new Date(`${from}T00:00:00.000Z`);
    const rangeEnd = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + DAY_MS);
    const { occurrences, source } = await this.occurrences(rangeStart, rangeEnd);
    return {
      source,
      events: occurrences.map((o) => ({
        uid: o.uid,
        start: o.start.toISOString(),
        end: o.end.toISOString(),
        summary: o.summary,
        allDay: o.allDay,
      })),
    };
  }

  async isBusyAt(now: ISODateTime): Promise<BusyStatus> {
    const at = new Date(now).getTime();
    // One day back so a block that started yesterday evening is still seen.
    const { occurrences, source } = await this.occurrences(new Date(at - DAY_MS), new Date(at + LOOKAHEAD_MS));
    if (source === "none") return { busy: false, until: null, next_busy_start: null, source };

    const runs = mergeRuns(occurrences);
    const current = runs.find((r) => r.start <= at && at < r.end);
    if (current) {
      return { busy: true, until: new Date(current.end).toISOString(), next_busy_start: null, source };
    }
    const next = runs.find((r) => r.start > at && r.start <= at + LOOKAHEAD_MS);
    return { busy: false, until: null, next_busy_start: next ? new Date(next.start).toISOString() : null, source };
  }
}

/** Overlapping and back-to-back events collapse into one busy run, so an alert waits for the last one. */
function mergeRuns(occurrences: Occurrence[]): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = [];
  for (const o of occurrences) {
    const start = o.start.getTime();
    const end = Math.max(o.end.getTime(), start);
    const last = runs[runs.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else runs.push({ start, end });
  }
  return runs;
}

/** Builds the feed a request should use: the configured one, or the empty stand-in. */
export function calendarFor(config: IcsCalendarConfig): CalendarFeed {
  const calendar = new IcsCalendar(config);
  return calendar.configured ? calendar : NO_CALENDAR;
}
