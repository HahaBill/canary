/**
 * Pivot columns: calendar weeks (Mon–Sun, the CUSUM grid) or calendar months.
 *
 * Weeks come from `@canary/shared/dates` so the sheet's columns are exactly the
 * engine's weekly buckets. Months are pure string math on `YYYY-MM` keys —
 * `start`/`end` are clipped to the history window so a partial month reports
 * the days it actually covers, while bucketing still uses the calendar month.
 */
import {
  compareISODate,
  parseISODate,
  weekEnd,
  weekIndexOf,
  weekStart,
  weekStartsEndingAt,
  type ISODate,
  type PivotGranularity,
  type PivotPeriod,
} from "@canary/shared";

export interface PeriodGrid {
  periods: PivotPeriod[];
  /** Index into `periods` for a transaction date, or −1 when outside history. */
  indexOf(date: ISODate): number;
}

export function buildPeriodGrid(
  granularity: PivotGranularity,
  historyStart: ISODate,
  historyEnd: ISODate,
  regimeStart: ISODate | null,
): PeriodGrid {
  return granularity === "week"
    ? weekGrid(historyStart, historyEnd, regimeStart)
    : monthGrid(historyStart, historyEnd, regimeStart);
}

function weekGrid(historyStart: ISODate, historyEnd: ISODate, regimeStart: ISODate | null): PeriodGrid {
  const firstMonday = weekStart(historyStart);
  const lastSunday = weekEnd(historyEnd);
  const count = weekIndexOf(lastSunday, firstMonday) + 1;
  const periods: PivotPeriod[] =
    count < 1
      ? []
      : weekStartsEndingAt(lastSunday, count).map((start) => {
          const end = weekEnd(start);
          return {
            key: start,
            start,
            end,
            partial: compareISODate(start, historyStart) < 0 || compareISODate(end, historyEnd) > 0,
            // The regime starts on a Monday, so a week is post-change as a whole.
            post_change: regimeStart !== null && compareISODate(start, regimeStart) >= 0,
          };
        });
  return {
    periods,
    indexOf(date) {
      const i = weekIndexOf(date, firstMonday);
      return i >= 0 && i < periods.length ? i : -1;
    },
  };
}

function monthGrid(historyStart: ISODate, historyEnd: ISODate, regimeStart: ISODate | null): PeriodGrid {
  const periods: PivotPeriod[] = [];
  const indexByKey = new Map<string, number>();
  if (compareISODate(historyStart, historyEnd) <= 0) {
    let key = monthKeyOf(historyStart);
    const lastKey = monthKeyOf(historyEnd);
    // Bounded by construction: `key` advances one month per iteration.
    while (key <= lastKey) {
      const first = firstDayOfMonth(key);
      const last = lastDayOfMonth(key);
      indexByKey.set(key, periods.length);
      periods.push({
        key,
        start: compareISODate(first, historyStart) < 0 ? historyStart : first,
        end: compareISODate(last, historyEnd) > 0 ? historyEnd : last,
        partial: compareISODate(first, historyStart) < 0 || compareISODate(last, historyEnd) > 0,
        // A month that contains the regime start is tinted: part of it is post-change.
        post_change: regimeStart !== null && compareISODate(last, regimeStart) >= 0,
      });
      key = nextMonthKey(key);
    }
  }
  return {
    periods,
    indexOf(date) {
      return indexByKey.get(monthKeyOf(date)) ?? -1;
    },
  };
}

export function monthKeyOf(date: ISODate): string {
  return date.slice(0, 7);
}

function firstDayOfMonth(key: string): ISODate {
  return `${key}-01`;
}

function lastDayOfMonth(key: string): ISODate {
  const { year, month } = splitMonthKey(key);
  // Day 0 of the following month is the last day of this one.
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${key}-${String(day).padStart(2, "0")}`;
}

function nextMonthKey(key: string): string {
  const { year, month } = splitMonthKey(key);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

function splitMonthKey(key: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) throw new Error(`Invalid month key: ${key}`);
  return { year: Number(m[1]), month: Number(m[2]) };
}

/** Day of the month, 1–31. */
export function dayOfMonth(date: ISODate): number {
  return parseISODate(date).getUTCDate();
}

/** `date` shifted by `months`, keeping `anchorDay` and clamping to the month length. */
export function addMonthsClamped(date: ISODate, months: number, anchorDay: number): ISODate {
  const d = parseISODate(date);
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const monthIndex = total - year * 12;
  const key = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
  const lastDay = Number(lastDayOfMonth(key).slice(8));
  const day = Math.min(anchorDay, lastDay);
  return `${key}-${String(day).padStart(2, "0")}`;
}
