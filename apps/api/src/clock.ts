/**
 * The demo clock: what "now" means to a founder watching the dashboard.
 *
 * Canary's ledger is a year of history plus a horizon of transactions that have
 * been generated but have not posted yet (`DEMO.HORIZON_WEEKS`). Advancing the
 * clock reveals that horizon one day at a time, so cash falls, weeks accumulate
 * and the detectors re-run — the product working rather than a frozen snapshot.
 *
 * This is a PURE function of the wall clock. Given the same instant it always
 * returns the same date, so two Worker isolates serving the same second agree,
 * and the pipeline stays deterministic in its own `asOf` parameter.
 *
 * WHY A CYCLE. Simulated time runs far faster than real time, or a demo would
 * show nothing moving. Running monotonically from a fixed epoch would therefore
 * sprint through the horizon within hours and then sit clamped months in the
 * future, showing a cash position nobody recognises. Anchoring instead to the
 * top of each cycle keeps the picture recent: the clock always starts at the end
 * of history and never runs past the horizon, whenever anyone opens the page.
 */
import { DEMO, addDays, historyStart } from "@canary/shared";
import type { ISODate } from "@canary/shared";

/** One simulated day per real minute: slow enough to read, fast enough to see. */
export const DEFAULT_MINUTES_PER_DAY = 1;

/**
 * How long the clock runs before returning to the end of history.
 *
 * Ten minutes at the default speed means the account is never more than ten days
 * past "today". That bound is the point. A longer cycle drifts months ahead, and
 * then the dashboard, the demo script and the calendar all disagree about what
 * day it is — the calendar opens on a month nobody expected and the documented
 * figures match nothing on screen. Ten days keeps every surface in the same week
 * while still posting a transaction every minute or two, which is what makes the
 * page look alive.
 */
export const CYCLE_MINUTES = 10;

const MS_PER_MINUTE = 60_000;

/** Last day the generator produced. The clock never advances past it. */
export function horizonEnd(): ISODate {
  return addDays(DEMO.END_DATE, DEMO.HORIZON_WEEKS * 7);
}

export interface DemoClockOptions {
  /** Real minutes per simulated day. `0` freezes the clock at the end of history. */
  minutesPerDay?: number;
  cycleMinutes?: number;
}

/**
 * The date the founder's account is current to, at real instant `now`.
 *
 * `minutesPerDay: 0` pins it to the end of history, which is exactly how Canary
 * behaved before the clock existed. That is the safe setting for a screenshot,
 * a recorded demo, or any run that must be reproducible.
 */
export function demoAsOf(now: Date, options: DemoClockOptions = {}): ISODate {
  const minutesPerDay = options.minutesPerDay ?? DEFAULT_MINUTES_PER_DAY;
  if (!Number.isFinite(minutesPerDay) || minutesPerDay <= 0) return DEMO.END_DATE;

  const cycleMinutes = options.cycleMinutes ?? CYCLE_MINUTES;
  const minutes = Math.floor(now.getTime() / MS_PER_MINUTE);
  const intoCycle = ((minutes % cycleMinutes) + cycleMinutes) % cycleMinutes;

  const days = Math.floor(intoCycle / minutesPerDay);
  const maxDays = DEMO.HORIZON_WEEKS * 7;
  return addDays(DEMO.END_DATE, Math.min(days, maxDays));
}

/**
 * Reads the speed an operator asked for. Anything unparseable or negative falls
 * back to the default rather than freezing or racing: a bad query string must
 * never be able to change what the dashboard claims about the money.
 */
export function parseMinutesPerDay(raw: string | null | undefined, fallback = DEFAULT_MINUTES_PER_DAY): number {
  if (raw === null || raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/** `YYYY-MM-DD`, inside the generated span. Anything else is ignored. */
export function parseAsOfOverride(raw: string | null | undefined): ISODate | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  // `historyStart` is the generator's own first day: it snaps back to the Monday
  // of the earliest week, which is not the same as subtracting WEEKS*7 from a
  // Sunday end date. Re-deriving the arithmetic here was one day too generous
  // and accepted a date before any transaction exists.
  if (raw < historyStart(DEMO.END_DATE, DEMO.WEEKS) || raw > horizonEnd()) return null;
  return raw;
}
