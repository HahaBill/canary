/**
 * Picking a time for the review — deterministically, from busy blocks alone.
 *
 * No model chooses the slot: it is the first quarter-hour inside business hours,
 * at least `leadMinutes` from now, that no busy block touches. Same input, same
 * answer, which is what lets the iMessage reply and the API route agree.
 *
 * Business hours are wall-clock hours in the founder's zone, resolved through
 * `Intl` by `wallTimeToUtc` — so 09:00 means 09:00 in New York whether or not
 * daylight saving is in effect.
 */
import type { ISODateTime } from "@canary/shared";
import { wallTimeToUtc, zoneOffsetMs } from "../timezone.ts";

export const DEFAULT_REVIEW_MINUTES = 15;
/** Never book on top of the founder: the soonest a review may start. */
export const DEFAULT_LEAD_MINUTES = 30;
export const DEFAULT_BUSINESS_DAYS = 3;
export const DEFAULT_DAY_START_HOUR = 9;
export const DEFAULT_DAY_END_HOUR = 18;
/** Candidate starts land on :00/:15/:30/:45 — a slot a human would have picked. */
export const SLOT_GRID_MS = 15 * 60_000;

const MINUTE_MS = 60_000;
/** Enough calendar days to contain three business days plus a long weekend. */
const MAX_CALENDAR_DAYS = 10;

export interface BusyRange {
  start: ISODateTime;
  end: ISODateTime;
}

interface MsRange {
  start: number;
  end: number;
}

/**
 * Overlapping and back-to-back blocks collapse into one, exactly as `ics.ts`
 * merges runs: two adjacent meetings are one unavailable stretch, not a gap.
 */
export function mergeBusyRanges(ranges: readonly BusyRange[]): MsRange[] {
  const parsed = ranges
    .map((r) => ({ start: new Date(r.start).getTime(), end: new Date(r.end).getTime() }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end))
    .map((r) => ({ start: r.start, end: Math.max(r.end, r.start) }))
    .sort((a, b) => a.start - b.start);

  const out: MsRange[] = [];
  for (const range of parsed) {
    const last = out[out.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else out.push({ ...range });
  }
  return out;
}

export interface NextFreeSlotInput {
  now: ISODateTime;
  /** Busy blocks from freeBusy. Unmerged and unsorted is fine. */
  busy: readonly BusyRange[];
  /** IANA zone the business hours are expressed in. */
  timeZone: string;
  durationMinutes?: number;
  leadMinutes?: number;
  /** How many Mon–Fri days to search before giving up. */
  businessDays?: number;
  dayStartHour?: number;
  dayEndHour?: number;
}

export interface FreeSlot {
  start: ISODateTime;
  end: ISODateTime;
}

/** Wall-clock Y/M/D + weekday of an instant, as the clock in `timeZone` reads it. */
function localDay(ms: number, timeZone: string): { year: number; month: number; day: number; weekday: number } {
  const shifted = new Date(ms + zoneOffsetMs(new Date(ms), timeZone));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), weekday: shifted.getUTCDay() };
}

function alignUp(ms: number, grid: number): number {
  return Math.ceil(ms / grid) * grid;
}

/**
 * The first free slot, or null when the search window holds none — the caller
 * says so out loud rather than inventing a time (docs/AGENT_BEHAVIOR.md §4).
 */
export function nextFreeSlot(input: NextFreeSlotInput): FreeSlot | null {
  const durationMs = (input.durationMinutes ?? DEFAULT_REVIEW_MINUTES) * MINUTE_MS;
  const leadMs = (input.leadMinutes ?? DEFAULT_LEAD_MINUTES) * MINUTE_MS;
  const businessDays = input.businessDays ?? DEFAULT_BUSINESS_DAYS;
  const startHour = input.dayStartHour ?? DEFAULT_DAY_START_HOUR;
  const endHour = input.dayEndHour ?? DEFAULT_DAY_END_HOUR;

  const nowMs = new Date(input.now).getTime();
  if (!Number.isFinite(nowMs) || durationMs <= 0 || businessDays <= 0) return null;

  const earliest = nowMs + leadMs;
  const busy = mergeBusyRanges(input.busy);

  let day = localDay(earliest, input.timeZone);
  let daysSearched = 0;

  for (let i = 0; i < MAX_CALENDAR_DAYS && daysSearched < businessDays; i++) {
    if (i > 0) {
      // Step one calendar day by re-reading the wall date 24h later: month ends
      // and DST shifts are then the runtime's problem, not ours.
      day = localDay(wallTimeToUtc({ ...day, hour: 12, minute: 0, second: 0 }, input.timeZone).getTime() + 24 * 60 * MINUTE_MS, input.timeZone);
    }
    // Saturday and Sunday are not when a founder reviews a burn incident.
    if (day.weekday === 0 || day.weekday === 6) continue;
    daysSearched++;

    const windowStart = wallTimeToUtc({ ...day, hour: startHour, minute: 0, second: 0 }, input.timeZone).getTime();
    const windowEnd = wallTimeToUtc({ ...day, hour: endHour, minute: 0, second: 0 }, input.timeZone).getTime();

    let cursor = alignUp(Math.max(windowStart, earliest), SLOT_GRID_MS);
    while (cursor + durationMs <= windowEnd) {
      const clash = busy.find((block) => cursor < block.end && block.start < cursor + durationMs);
      if (!clash) return { start: new Date(cursor).toISOString(), end: new Date(cursor + durationMs).toISOString() };
      cursor = alignUp(clash.end, SLOT_GRID_MS);
    }
  }

  return null;
}
