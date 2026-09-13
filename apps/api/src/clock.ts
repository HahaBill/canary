/**
 * The demo clock: what "today" means to a founder watching the dashboard.
 *
 * Canary's ledger is a year of history. Advancing the clock re-runs the whole
 * pipeline at a different day, so cash moves, weeks close and the detectors
 * re-decide — the product working rather than a frozen snapshot.
 *
 * This is a PURE function of the wall clock. Given the same instant it always
 * returns the same date, so two Worker isolates serving the same second agree,
 * and the pipeline stays deterministic in its own `asOf` parameter.
 *
 * WHY IT WALKS BACKWARD INTO HISTORY AND NOT FORWARD INTO THE HORIZON.
 * `DEMO.END_DATE` is the last day of generated history and is also a real date.
 * A clock that ran PAST it made the dashboard state a balance "as of Sep 20"
 * while Sep 20 had not happened yet, which reads as a bug to anyone who checks
 * a calendar — and it is one: nobody's bank knows next week's balance. So the
 * loop runs through the final `CYCLE_DAYS` of history and ENDS on the last day
 * the company actually has, which never claims to know the future and lands on
 * the figures the README, the handoff and the demo script all quote.
 *
 * The generator's horizon still exists; it is simply not what the clock reveals.
 * Nothing dated after `asOf` reaches any surface (`data/pipeline-provider.ts`).
 */
import { DEMO, addDays, historyStart } from "@canary/shared";
import type { ISODate } from "@canary/shared";

/**
 * Real minutes per simulated day. A day every thirty seconds: fast enough that
 * a judge watching for a minute sees the account move, slow enough to read a
 * figure before it changes.
 */
export const DEFAULT_MINUTES_PER_DAY = 0.5;

/**
 * How many days of history the loop walks before returning to its start.
 *
 * Ten days at the default speed is a five-minute loop that always ends on
 * `DEMO.END_DATE`. Longer would spend most of the demo on dates nobody
 * documented; shorter would barely move.
 */
export const CYCLE_DAYS = 10;

const MS_PER_MINUTE = 60_000;

/** Real minutes one full loop takes. */
export function cycleMinutes(
  minutesPerDay: number = DEFAULT_MINUTES_PER_DAY,
  cycleDays: number = CYCLE_DAYS,
): number {
  return minutesPerDay * cycleDays;
}

/** First day of the loop. The clock never points before this. */
export function cycleStart(cycleDays: number = CYCLE_DAYS): ISODate {
  return addDays(DEMO.END_DATE, -(cycleDays - 1));
}

/** Last day the generator produced. Kept for the operator override's bound. */
export function horizonEnd(): ISODate {
  return addDays(DEMO.END_DATE, DEMO.HORIZON_WEEKS * 7);
}

export interface DemoClockOptions {
  /** Real minutes per simulated day. `0` freezes the clock at the end of history. */
  minutesPerDay?: number;
  /** Days of history the loop walks. */
  cycleDays?: number;
}

/**
 * The day the founder's account is current to, at real instant `now`.
 *
 * Always within `[END_DATE - (cycleDays - 1), END_DATE]`. The upper bound is the
 * contract: this function can never name a day that has not happened.
 *
 * `minutesPerDay: 0` pins it to the end of history, which is the right setting
 * for a screenshot, a recorded clip, or any run that must be reproducible.
 */
export function demoAsOf(now: Date, options: DemoClockOptions = {}): ISODate {
  const minutesPerDay = options.minutesPerDay ?? DEFAULT_MINUTES_PER_DAY;
  if (!Number.isFinite(minutesPerDay) || minutesPerDay <= 0) return DEMO.END_DATE;

  const cycleDays = Math.max(1, Math.floor(options.cycleDays ?? CYCLE_DAYS));
  const loopMinutes = cycleMinutes(minutesPerDay, cycleDays);

  // Fractional, because a day may be worth less than a minute.
  const minutes = now.getTime() / MS_PER_MINUTE;
  const intoCycle = ((minutes % loopMinutes) + loopMinutes) % loopMinutes;

  const dayIndex = Math.min(cycleDays - 1, Math.max(0, Math.floor(intoCycle / minutesPerDay)));
  // Ends ON `END_DATE`, never after it.
  return addDays(DEMO.END_DATE, dayIndex - (cycleDays - 1));
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
