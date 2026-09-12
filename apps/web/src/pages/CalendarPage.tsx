import { useState } from "react";
import type { ISODate } from "@canary/shared";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useAvailability, useCalendar, useDerived } from "@/api/useDerived.ts";
import { AvailabilityPill } from "@/components/calendar/AvailabilityPill.tsx";
import { CalendarLegend } from "@/components/calendar/CalendarLegend.tsx";
import { DayPanel } from "@/components/calendar/DayPanel.tsx";
import { MonthGrid } from "@/components/calendar/MonthGrid.tsx";
import { ErrorState, PanelSkeleton } from "@/components/States.tsx";
import { Button } from "@/components/ui/button.tsx";
import { formatDateMedium, formatMonthLong } from "@/lib/format.ts";
import { addMonths, firstDayOfMonth, lastDayOfMonth, monthKeyOf } from "@/lib/month.ts";

export function CalendarPage() {
  const { data: derived, loading: derivedLoading, error: derivedError, reload } = useDerived();
  // The demo clock is the end of history, not the wall clock.
  const today: ISODate | null = derived?.provenance.end_date ?? null;

  const [month, setMonth] = useState<string | null>(null);
  const visibleMonth = month ?? (today ? monthKeyOf(today) : null);

  if (derivedError) return <ErrorState message={derivedError} onRetry={reload} />;
  if (derivedLoading || !derived || !visibleMonth || !today) {
    return (
      <div className="space-y-5">
        <PanelSkeleton className="h-12" />
        <PanelSkeleton className="h-[28rem]" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
            Cash calendar
          </h1>
          <p className="mt-1 text-sm text-neutral-500">as of {formatDateMedium(today)}</p>
        </div>
        <Availability />
      </header>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-neutral-900">{formatMonthLong(visibleMonth)}</h2>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="icon"
            aria-label="Previous month"
            onClick={() => setMonth(addMonths(visibleMonth, -1))}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMonth(monthKeyOf(today))}
            disabled={visibleMonth === monthKeyOf(today)}
          >
            Today
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Next month"
            onClick={() => setMonth(addMonths(visibleMonth, 1))}
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <MonthView key={visibleMonth} month={visibleMonth} today={today} />

      <CalendarLegend />

      <p className="text-[11px] leading-relaxed text-neutral-400">
        Posted amounts are reconciled transactions. Expected amounts are projections of charges that
        have already recurred — an estimate of timing and size, never a commitment. Canary markers
        point at the change point, the detector alarm and one-off payments.
      </p>
    </div>
  );
}

function Availability() {
  const { data, loading } = useAvailability();
  return <AvailabilityPill availability={data} loading={loading} />;
}

/** Keyed on the month, so a stale day selection cannot survive navigation. */
function MonthView({ month, today }: { month: string; today: ISODate }) {
  const from = firstDayOfMonth(month);
  const to = lastDayOfMonth(month);
  const { data: calendar, loading, error, reload } = useCalendar(from, to);
  const [selectedDate, setSelectedDate] = useState<ISODate | null>(null);

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !calendar) return <PanelSkeleton className="h-[28rem]" />;

  const selectedDay = selectedDate
    ? (calendar.days.find((day) => day.date === selectedDate) ?? {
        date: selectedDate,
        events: [],
        net_actual_cents: 0,
        net_expected_cents: 0,
      })
    : null;

  return (
    <>
      <MonthGrid month={month} calendar={calendar} today={today} onSelectDay={setSelectedDate} />
      <DayPanel day={selectedDay} onClose={() => setSelectedDate(null)} />
    </>
  );
}
