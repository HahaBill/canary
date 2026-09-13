/**
 * Day-by-day calendar the SPA renders. The `/api/calendar` route now only
 * passes founder busy blocks plus reviews Canary booked — cash actuals and
 * projections stay on the ledger. `net_*_cents` still sum whatever events
 * happen to carry amounts (reviews do not).
 */
import { addDays, compareISODate, daysBetween, type CalendarDay, type CalendarEvent, type CashCalendar, type ISODate } from "@canary/shared";
import type { BusySource, CalendarFeedEvent } from "./ics.ts";

/** Longest range the calendar route will serve — three months plus slack. */
export const MAX_CALENDAR_SPAN_DAYS = 92;

const KIND_ORDER: Record<CalendarEvent["kind"], number> = { canary: 0, actual: 1, expected: 2, busy: 3 };

export interface BuildCashCalendarInput {
  from: ISODate;
  to: ISODate;
  /** Actual + expected + canary events from the provider. */
  events: CalendarEvent[];
  /** Raw feed occurrences, already limited to the range. */
  busy: CalendarFeedEvent[];
  busySource: BusySource;
  /** `CALENDAR_SHOW_TITLES === "1"`. Off by default: availability is all Canary needs to repeat. */
  showTitles: boolean;
}

/** Every date the event covers, clipped to `[from, to]`. */
function coveredDates(event: CalendarFeedEvent, from: ISODate, to: ISODate): ISODate[] {
  const startDate = event.start.slice(0, 10);
  // A block ending exactly at midnight belongs to the previous day only.
  const endMs = new Date(event.end).getTime();
  const lastDate = new Date(Math.max(new Date(event.start).getTime(), endMs - 1)).toISOString().slice(0, 10);
  const out: ISODate[] = [];
  for (let date = startDate; compareISODate(date, lastDate) <= 0; date = addDays(date, 1)) {
    if (compareISODate(date, from) >= 0 && compareISODate(date, to) <= 0) out.push(date);
  }
  return out;
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 48);
}

/** Feed occurrences → `busy` calendar events, one per day covered. */
export function busyEvents(input: Pick<BuildCashCalendarInput, "busy" | "from" | "to" | "showTitles">): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const event of input.busy) {
    const hhmm = event.start.slice(11, 16).replace(":", "");
    for (const date of coveredDates(event, input.from, input.to)) {
      out.push({
        id: `busy_${slug(event.uid)}_${date}_${hhmm}`,
        kind: "busy",
        date,
        start: event.start,
        end: event.end,
        // The founder's meeting titles are none of Canary's business by default.
        title: input.showTitles ? event.summary || "Busy" : "Busy",
      });
    }
  }
  return out;
}

export function buildCashCalendar(input: BuildCashCalendarInput): CashCalendar {
  const all = [...input.events.filter((e) => e.kind !== "busy"), ...busyEvents(input)];
  const byDate = new Map<ISODate, CalendarEvent[]>();
  for (const event of all) {
    if (compareISODate(event.date, input.from) < 0 || compareISODate(event.date, input.to) > 0) continue;
    const list = byDate.get(event.date);
    if (list) list.push(event);
    else byDate.set(event.date, [event]);
  }

  const days: CalendarDay[] = [];
  const span = daysBetween(input.from, input.to);
  for (let i = 0; i <= span; i++) {
    const date = addDays(input.from, i);
    const events = (byDate.get(date) ?? []).sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id));
    const sum = (kind: CalendarEvent["kind"]): number =>
      events.reduce((total, e) => (e.kind === kind ? total + (e.amount_cents ?? 0) : total), 0);
    days.push({ date, events, net_actual_cents: sum("actual"), net_expected_cents: sum("expected") });
  }

  return { from: input.from, to: input.to, days, busy_source: input.busySource };
}
