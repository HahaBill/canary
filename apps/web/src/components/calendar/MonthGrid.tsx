import type { CalendarDay, CalendarEvent, CashCalendar, ISODate } from "@canary/shared";
import { EventChip } from "@/components/calendar/EventChip.tsx";
import { formatDayOfMonth, WEEKDAY_LABELS } from "@/lib/format.ts";
import { isInMonth, monthGridDays, type MonthKey } from "@/lib/month.ts";
import { cn } from "@/lib/utils.ts";

const MAX_CHIPS = 3;

function interruptEvents(events: CalendarEvent[]): CalendarEvent[] {
  return events.filter((event) => event.kind === "busy" || event.kind === "canary");
}

export function MonthGrid({
  month,
  calendar,
  today,
  onSelectDay,
}: {
  month: MonthKey;
  calendar: CashCalendar;
  today: ISODate;
  onSelectDay: (date: ISODate) => void;
}) {
  const byDate = new Map(calendar.days.map((day) => [day.date, day]));
  const days = monthGridDays(month);
  const connected = calendar.busy_source !== "none";

  return (
    <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white">
      <div className="grid grid-cols-7 border-b border-neutral-200 bg-neutral-50">
        {WEEKDAY_LABELS.map((label) => (
          <div
            key={label}
            className="px-2 py-2 text-center text-[10px] font-medium uppercase tracking-wide text-neutral-500"
          >
            <span aria-hidden="true" className="sm:hidden">
              {label.charAt(0)}
            </span>
            <span className="hidden sm:inline">{label}</span>
            <span className="sr-only sm:hidden">{label}</span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {days.map((date) => (
          <DayCell
            key={date}
            date={date}
            day={byDate.get(date) ?? null}
            inMonth={isInMonth(date, month)}
            isToday={date === today}
            connected={connected}
            onSelect={() => onSelectDay(date)}
          />
        ))}
      </div>
    </div>
  );
}

function DayCell({
  date,
  day,
  inMonth,
  isToday,
  connected,
  onSelect,
}: {
  date: ISODate;
  day: CalendarDay | null;
  inMonth: boolean;
  isToday: boolean;
  connected: boolean;
  onSelect: () => void;
}) {
  const events = interruptEvents(day?.events ?? []);
  const shown = events.slice(0, MAX_CHIPS);
  const hidden = events.length - shown.length;
  const busy = events.some((event) => event.kind === "busy");
  const status = !connected ? "no calendar" : busy ? "in a meeting, Canary will wait" : "Canary can text";

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`${date}, ${status}`}
      className={cn(
        "flex min-h-24 flex-col gap-1 border-b border-r border-neutral-100 p-1.5 text-left transition-colors last:border-r-0 hover:bg-neutral-50/80",
        !inMonth && "bg-neutral-50/50",
        inMonth && busy && "bg-amber-50/70",
        inMonth && connected && !busy && "bg-white",
      )}
    >
      <span className="flex items-center justify-between">
        <span
          className={cn(
            "flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-medium tabular-nums",
            isToday ? "bg-canary-400 text-neutral-900" : inMonth ? "text-neutral-700" : "text-neutral-300",
          )}
        >
          {formatDayOfMonth(date)}
        </span>
      </span>

      <span className="flex flex-1 flex-col gap-0.5">
        {shown.map((event) => (
          <EventChip key={event.id} event={event} />
        ))}
        {hidden > 0 ? <span className="px-1.5 text-[10px] text-neutral-400">+{hidden} more</span> : null}
      </span>
    </button>
  );
}
