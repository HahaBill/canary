/**
 * Calendar-week helpers. Weeks start Monday and end Sunday. All packages must
 * use these so the generator, engine, and detectors bucket identically.
 * All functions are pure and operate on `YYYY-MM-DD` strings in UTC.
 */
import type { ISODate } from "./types.ts";

const DAY_MS = 86_400_000;

export function parseISODate(d: ISODate): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) throw new Error(`Invalid ISO date: ${d}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export function toISODate(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: ISODate, days: number): ISODate {
  return toISODate(new Date(parseISODate(d).getTime() + days * DAY_MS));
}

export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((parseISODate(b).getTime() - parseISODate(a).getTime()) / DAY_MS);
}

/** 0 = Monday … 6 = Sunday */
export function isoWeekday(d: ISODate): number {
  return (parseISODate(d).getUTCDay() + 6) % 7;
}

/** Monday of the week containing `d`. */
export function weekStart(d: ISODate): ISODate {
  return addDays(d, -isoWeekday(d));
}

/** Sunday of the week containing `d`. */
export function weekEnd(d: ISODate): ISODate {
  return addDays(weekStart(d), 6);
}

/**
 * Build the list of week starts for `weeks` complete Mon–Sun weeks ending on
 * the week that contains `endDate`. `endDate` should be a Sunday for a
 * complete final week; if not, the final week is still the week containing it.
 */
export function weekStartsEndingAt(endDate: ISODate, weeks: number): ISODate[] {
  if (weeks < 1) throw new Error("weeks must be ≥ 1");
  const lastStart = weekStart(endDate);
  const out: ISODate[] = [];
  for (let i = weeks - 1; i >= 0; i--) out.push(addDays(lastStart, -7 * i));
  return out;
}

/** First day of history for `weeks` weeks ending at `endDate`. */
export function historyStart(endDate: ISODate, weeks: number): ISODate {
  return weekStartsEndingAt(endDate, weeks)[0]!;
}

/** 0-based index of the week containing `d`, relative to `historyStartMonday`. May be negative or ≥ weeks if out of range. */
export function weekIndexOf(d: ISODate, historyStartMonday: ISODate): number {
  return Math.floor(daysBetween(historyStartMonday, d) / 7);
}

export function compareISODate(a: ISODate, b: ISODate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function nowISO(): string {
  return new Date().toISOString();
}
