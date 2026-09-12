/**
 * A deliberately small RFC 5545 (iCalendar) reader: enough of the spec to know
 * when the founder is in a meeting, and nothing more.
 *
 * Supported: line unfolding, VEVENT blocks, DTSTART/DTEND with `VALUE=DATE`,
 * `TZID=<IANA zone>`, UTC `Z` and floating forms, DURATION when DTEND is absent,
 * SUMMARY, STATUS (CANCELLED skipped), TRANSP (TRANSPARENT skipped), and
 * RRULE FREQ=DAILY|WEEKLY with BYDAY / INTERVAL / UNTIL / COUNT expanded inside
 * the requested window.
 *
 * Deliberately NOT supported (documented, not accidental):
 * - MONTHLY/YEARLY RRULEs yield only their first occurrence. A monthly meeting is
 *   not what a burn alert waits for, and BYSETPOS/BYMONTHDAY is a whole library.
 * - EXDATE removes an occurrence only on an exact start-instant match. A client
 *   that writes EXDATE in a different zone than DTSTART will not match.
 * - RECURRENCE-ID overrides (one moved occurrence of a series) are read as
 *   ordinary events, so a moved meeting can appear at both times.
 * - VALARM, ATTENDEE, and every other property is skipped.
 * - Floating times (no TZID, no `Z`) are read as UTC.
 */
import { isKnownTimeZone, wallTimeToUtc, type WallTime } from "./timezone.ts";

/** How a DTSTART/DTEND value was written, so recurrences step wall time rather than instants. */
export type TimeSpec =
  | { kind: "date"; wall: WallTime }
  | { kind: "utc"; wall: WallTime }
  | { kind: "zoned"; wall: WallTime; tzid: string };

export interface RecurrenceRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY" | "OTHER";
  interval: number;
  /** 0 = Monday … 6 = Sunday. Empty = "same weekday as DTSTART". */
  byDay: number[];
  /** Inclusive upper bound on occurrence starts. */
  until: Date | null;
  count: number | null;
}

export interface ParsedEvent {
  uid: string;
  summary: string;
  allDay: boolean;
  start: Date;
  end: Date;
  startSpec: TimeSpec;
  /** Nominal length, carried to every occurrence of a recurring event. */
  durationMs: number;
  rrule: RecurrenceRule | null;
  /** Excluded occurrence starts, as epoch ms. */
  exdates: number[];
}

/** One expanded occurrence of a (possibly recurring) VEVENT. */
export interface Occurrence {
  uid: string;
  summary: string;
  allDay: boolean;
  start: Date;
  end: Date;
}

const DAY_MS = 86_400_000;
/** Guards against a malformed COUNT/UNTIL turning expansion into a hang. */
const MAX_CYCLES = 4096;
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

/** RFC 5545 §3.1: a line beginning with a space or tab continues the previous one. */
export function unfold(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += raw.slice(1);
    } else if (raw.length > 0) {
      lines.push(raw);
    }
  }
  return lines;
}

export interface ContentLine {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** `DTSTART;TZID="America/New_York":20260914T090000` → name, params, value. */
export function parseLine(line: string): ContentLine | null {
  let colon = -1;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;

  const [name, ...paramParts] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name!.toUpperCase(), params, value: line.slice(colon + 1) };
}

/** `\n`, `\,`, `\;`, `\\` in TEXT values (RFC 5545 §3.3.11). */
export function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_, ch: string) => (ch === "n" || ch === "N" ? "\n" : ch));
}

function parseWall(value: string): WallTime | null {
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (date) return { year: +date[1]!, month: +date[2]!, day: +date[3]!, hour: 0, minute: 0, second: 0 };
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(value);
  if (!dt) return null;
  return { year: +dt[1]!, month: +dt[2]!, day: +dt[3]!, hour: +dt[4]!, minute: +dt[5]!, second: +dt[6]! };
}

/** A DTSTART/DTEND/EXDATE line → a resolvable time spec. */
export function parseTimeSpec(line: ContentLine): TimeSpec | null {
  const value = line.value.trim();
  const wall = parseWall(value);
  if (!wall) return null;
  if (line.params.VALUE === "DATE" || /^\d{8}$/.test(value)) return { kind: "date", wall };
  if (value.endsWith("Z")) return { kind: "utc", wall };
  const tzid = line.params.TZID;
  // An unrecognised TZID degrades to UTC rather than dropping the event: a busy
  // block at the wrong hour is a smaller failure than not knowing about it.
  if (tzid && isKnownTimeZone(tzid)) return { kind: "zoned", wall, tzid };
  return { kind: "utc", wall };
}

export function resolve(spec: TimeSpec): Date {
  if (spec.kind === "zoned") return wallTimeToUtc(spec.wall, spec.tzid);
  const { year, month, day, hour, minute, second } = spec.wall;
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

/** Shift a spec by whole calendar days, preserving its wall-clock time. */
function addWallDays(spec: TimeSpec, days: number): TimeSpec {
  const { wall } = spec;
  const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day) + days * DAY_MS);
  const next: WallTime = {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: wall.hour,
    minute: wall.minute,
    second: wall.second,
  };
  return spec.kind === "zoned" ? { kind: "zoned", wall: next, tzid: spec.tzid } : { ...spec, wall: next };
}

/** 0 = Monday … 6 = Sunday, from the wall date. */
function wallWeekday(spec: TimeSpec): number {
  const { wall } = spec;
  return (new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay() + 6) % 7;
}

/** `PT1H30M` / `P1D` / `P2W` → milliseconds. A negative duration is read as zero. */
export function parseDuration(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, sign, weeks, days, hours, minutes, seconds] = m;
  // `P`, `PT` and friends match the shape but carry no duration at all.
  if ([weeks, days, hours, minutes, seconds].every((part) => part === undefined)) return null;
  const total =
    (+(weeks ?? 0) * 7 + +(days ?? 0)) * DAY_MS + +(hours ?? 0) * 3_600_000 + +(minutes ?? 0) * 60_000 + +(seconds ?? 0) * 1_000;
  return sign === "-" ? 0 : total;
}

export function parseRRule(value: string): RecurrenceRule | null {
  const parts: Record<string, string> = {};
  for (const chunk of value.split(";")) {
    const eq = chunk.indexOf("=");
    if (eq > 0) parts[chunk.slice(0, eq).toUpperCase()] = chunk.slice(eq + 1);
  }
  if (!parts.FREQ) return null;

  const rawFreq = parts.FREQ.toUpperCase();
  const freq = rawFreq === "DAILY" || rawFreq === "WEEKLY" || rawFreq === "MONTHLY" || rawFreq === "YEARLY" ? rawFreq : "OTHER";
  const untilSpec = parts.UNTIL ? parseTimeSpec({ name: "UNTIL", params: {}, value: parts.UNTIL }) : null;
  const interval = Number.parseInt(parts.INTERVAL ?? "1", 10);
  const count = parts.COUNT ? Number.parseInt(parts.COUNT, 10) : null;

  return {
    freq,
    interval: Number.isFinite(interval) && interval > 0 ? interval : 1,
    byDay: (parts.BYDAY ?? "")
      .split(",")
      .map((d) => WEEKDAYS.indexOf(d.trim().toUpperCase().slice(-2) as (typeof WEEKDAYS)[number]))
      .filter((i) => i >= 0),
    until: untilSpec ? resolve(untilSpec) : null,
    count: count !== null && Number.isFinite(count) && count > 0 ? count : null,
  };
}

/** Every VEVENT in the feed, unexpanded. CANCELLED and TRANSPARENT events are dropped here. */
export function parseEvents(text: string): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  let current: Record<string, ContentLine> | null = null;
  let exdates: ContentLine[] = [];
  let nested: string | null = null;
  let index = 0;

  for (const line of unfold(text)) {
    const parsed = parseLine(line);
    if (!parsed) continue;

    if (parsed.name === "BEGIN" && parsed.value.toUpperCase() === "VEVENT") {
      current = {};
      exdates = [];
      nested = null;
      continue;
    }
    if (!current) continue;

    // VALARM (and friends) live inside VEVENT and carry their own properties.
    if (nested) {
      if (parsed.name === "END" && parsed.value.toUpperCase() === nested) nested = null;
      continue;
    }
    if (parsed.name === "BEGIN") {
      nested = parsed.value.toUpperCase();
      continue;
    }

    if (parsed.name === "END" && parsed.value.toUpperCase() === "VEVENT") {
      const event = buildEvent(current, exdates, index++);
      if (event) events.push(event);
      current = null;
      continue;
    }
    if (parsed.name === "EXDATE") exdates.push(parsed);
    else current[parsed.name] = parsed;
  }

  return events;
}

function buildEvent(props: Record<string, ContentLine>, exdateLines: ContentLine[], index: number): ParsedEvent | null {
  const dtstart = props.DTSTART;
  if (!dtstart) return null;
  const startSpec = parseTimeSpec(dtstart);
  if (!startSpec) return null;

  if ((props.STATUS?.value ?? "").trim().toUpperCase() === "CANCELLED") return null;
  // TRANSP:TRANSPARENT is the calendar's own "this does not make me busy" flag.
  if ((props.TRANSP?.value ?? "").trim().toUpperCase() === "TRANSPARENT") return null;

  const allDay = startSpec.kind === "date";
  const start = resolve(startSpec);

  let end: Date;
  const dtend = props.DTEND ? parseTimeSpec(props.DTEND) : null;
  if (dtend) {
    end = resolve(dtend);
  } else {
    const duration = props.DURATION ? parseDuration(props.DURATION.value) : null;
    end = new Date(start.getTime() + (duration ?? (allDay ? DAY_MS : 0)));
  }
  if (end.getTime() < start.getTime()) end = start;

  const exdates: number[] = [];
  for (const line of exdateLines) {
    for (const value of line.value.split(",")) {
      const spec = parseTimeSpec({ ...line, value });
      if (spec) exdates.push(resolve(spec).getTime());
    }
  }

  return {
    // A feed without UID is malformed but readable; the index keeps ids unique.
    uid: props.UID?.value.trim() || `canary-ics-${index}`,
    summary: unescapeText(props.SUMMARY?.value ?? "").trim(),
    allDay,
    start,
    end,
    startSpec,
    durationMs: end.getTime() - start.getTime(),
    rrule: props.RRULE ? parseRRule(props.RRULE.value) : null,
    exdates,
  };
}

/**
 * Occurrences of `event` that overlap `[rangeStart, rangeEnd)`, in start order.
 * DAILY/WEEKLY rules step wall time, so a 9am meeting stays 9am across a DST
 * boundary; other frequencies contribute their first occurrence only.
 */
export function expand(event: ParsedEvent, rangeStart: Date, rangeEnd: Date): Occurrence[] {
  const out: Occurrence[] = [];
  const emit = (spec: TimeSpec): void => {
    const start = resolve(spec);
    if (event.exdates.includes(start.getTime())) return;
    const end = new Date(start.getTime() + event.durationMs);
    if (start.getTime() >= rangeEnd.getTime()) return;
    if (end.getTime() < rangeStart.getTime()) return;
    // An event that ends exactly as the range opens does not overlap it.
    if (end.getTime() === rangeStart.getTime() && event.durationMs > 0) return;
    out.push({ uid: event.uid, summary: event.summary, allDay: event.allDay, start, end });
  };

  const rule = event.rrule;
  if (!rule || rule.freq === "MONTHLY" || rule.freq === "YEARLY" || rule.freq === "OTHER") {
    emit(event.startSpec);
    return out;
  }

  const stepDays = rule.freq === "DAILY" ? rule.interval : rule.interval * 7;
  const byDay = rule.byDay.length > 0 ? [...rule.byDay].sort((a, b) => a - b) : [wallWeekday(event.startSpec)];
  const firstStart = event.start.getTime();
  // Anchor weekly rules on the Monday of DTSTART's week so BYDAY days earlier in
  // that week are considered (and then skipped for falling before DTSTART).
  const anchor = rule.freq === "WEEKLY" ? addWallDays(event.startSpec, -wallWeekday(event.startSpec)) : event.startSpec;

  // A daily standup created two years ago must not cost two years of iterations
  // before the first in-range occurrence. Skipping ahead is exact only for an
  // unbounded series; with COUNT the loop is bounded by COUNT anyway.
  let cycle = 0;
  if (rule.count === null) {
    const behind = Math.floor((rangeStart.getTime() - event.durationMs - resolve(anchor).getTime()) / (stepDays * DAY_MS)) - 1;
    if (behind > 0) cycle = behind;
  }

  let emitted = 0;
  for (let step = 0; step < MAX_CYCLES; step++, cycle++) {
    const cycleStart = addWallDays(anchor, cycle * stepDays);
    if (resolve(cycleStart).getTime() >= rangeEnd.getTime()) break;

    const days = rule.freq === "WEEKLY" ? byDay.map((d) => addWallDays(cycleStart, d)) : [cycleStart];
    for (const spec of days) {
      const start = resolve(spec);
      if (start.getTime() < firstStart) continue;
      if (rule.freq === "DAILY" && rule.byDay.length > 0 && !byDay.includes(wallWeekday(spec))) continue;
      if (rule.until && start.getTime() > rule.until.getTime()) return out;
      if (rule.count !== null && emitted >= rule.count) return out;
      emitted++;
      emit(spec);
    }
  }

  return out;
}
