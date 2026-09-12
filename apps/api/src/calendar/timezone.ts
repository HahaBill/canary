/**
 * Named-IANA-zone wall time → UTC, using only `Intl` (no tzdata dependency,
 * works in workerd). iCal `DTSTART;TZID=America/New_York:20260914T090000` means
 * "9am as the clock reads in New York" — which UTC instant that is depends on
 * whether DST was in effect, so we have to ask the runtime.
 */

/** Fields of a wall-clock time, as written in the ICS file. */
export interface WallTime {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds (east positive). */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asIfUtc = Date.UTC(field("year"), field("month") - 1, field("day"), field("hour") % 24, field("minute"), field("second"));
  return asIfUtc - instant.getTime();
}

/**
 * The UTC instant at which the clock in `timeZone` reads `wall`.
 *
 * Two passes: guess with the offset at the naive instant, then re-measure the
 * offset at the guess. That converges for every real zone because offsets change
 * by at most a couple of hours and never twice within a day. Ambiguous times
 * (the repeated hour when clocks go back) resolve to the earlier instant;
 * skipped times (the missing hour when clocks go forward) resolve forward,
 * which is what calendar clients do too.
 */
export function wallTimeToUtc(wall: WallTime, timeZone: string): Date {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  let guess = naive - zoneOffsetMs(new Date(naive), timeZone);
  guess = naive - zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

/** True when `Intl` recognises the zone, so an unknown TZID can fall back instead of throwing. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    formatters.delete(timeZone);
    return false;
  }
}
