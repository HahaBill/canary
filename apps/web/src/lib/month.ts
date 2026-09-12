/**
 * Calendar-month helpers for the ledger pivot and the cash calendar.
 *
 * `@canary/shared/dates.ts` owns Mon–Sun week arithmetic (the unit the engine
 * buckets on) but has no month helpers, so the month grid keeps its own here.
 * Same rules as shared: pure functions over `YYYY-MM-DD` strings in UTC, so a
 * calendar date never shifts a day depending on where the browser is.
 */
import { parseISODate, toISODate, type ISODate } from "@canary/shared";

/** `2026-09-13` → `2026-09`. */
export type MonthKey = string;

export function monthKeyOf(date: ISODate): MonthKey {
  return date.slice(0, 7);
}

export function firstDayOfMonth(month: MonthKey): ISODate {
  return `${month}-01`;
}

export function lastDayOfMonth(month: MonthKey): ISODate {
  const [year, mon] = splitMonth(month);
  // Day 0 of the next month is the last day of this one.
  return toISODate(new Date(Date.UTC(year, mon, 0)));
}

export function addMonths(month: MonthKey, delta: number): MonthKey {
  const [year, mon] = splitMonth(month);
  const d = new Date(Date.UTC(year, mon - 1 + delta, 1));
  return toISODate(d).slice(0, 7);
}

/** True when `date` falls inside `month`. */
export function isInMonth(date: ISODate, month: MonthKey): boolean {
  return monthKeyOf(date) === month;
}

/**
 * The Mon–Sun grid covering `month`, padded with the trailing days of the
 * previous month and the leading days of the next so every row has 7 cells.
 */
export function monthGridDays(month: MonthKey): ISODate[] {
  const first = parseISODate(firstDayOfMonth(month));
  const last = parseISODate(lastDayOfMonth(month));
  // 0 = Monday … 6 = Sunday, matching `isoWeekday` in shared.
  const lead = (first.getUTCDay() + 6) % 7;
  const trail = 6 - ((last.getUTCDay() + 6) % 7);
  const days: ISODate[] = [];
  const start = first.getTime() - lead * 86_400_000;
  const total = lead + last.getUTCDate() + trail;
  for (let i = 0; i < total; i++) days.push(toISODate(new Date(start + i * 86_400_000)));
  return days;
}

function splitMonth(month: MonthKey): [number, number] {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`Invalid month key: ${month}`);
  return [Number(m[1]), Number(m[2])];
}
