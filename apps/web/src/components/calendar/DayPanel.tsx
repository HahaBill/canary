import type { CalendarDay, CalendarEvent, CalendarEventKind } from "@canary/shared";
import { Link } from "react-router-dom";
import { CANARY_GLYPHS, canaryMarker, eventLabel } from "@/components/calendar/EventChip.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  SideSheet,
  SideSheetBody,
  SideSheetContent,
  SideSheetDescription,
  SideSheetHeader,
  SideSheetTitle,
} from "@/components/ui/side-sheet.tsx";
import {
  categoryLabel,
  formatDateMedium,
  formatSignedUsd,
  formatTimeRange,
  formatUsdCompact,
} from "@/lib/format.ts";

/** Reading order: what happened, what is coming, what Canary noticed, what is booked. */
const KIND_ORDER: readonly CalendarEventKind[] = ["actual", "expected", "canary", "busy"];

const KIND_HEADINGS: Record<CalendarEventKind, string> = {
  actual: "Posted",
  expected: "Expected · from history",
  canary: "Canary markers",
  busy: "Calendar",
};

export function DayPanel({
  day,
  onClose,
}: {
  day: CalendarDay | null;
  onClose: () => void;
}) {
  const hasCanary = day?.events.some((event) => event.kind === "canary") ?? false;

  return (
    <SideSheet open={day !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      {day ? (
        <SideSheetContent aria-describedby="calendar-day-description">
          <SideSheetHeader>
            <SideSheetTitle>{formatDateMedium(day.date)}</SideSheetTitle>
            <SideSheetDescription id="calendar-day-description">
              {day.net_actual_cents !== 0 ? `Net posted ${formatUsdCompact(day.net_actual_cents)}` : null}
              {day.net_actual_cents !== 0 && day.net_expected_cents !== 0 ? " · " : null}
              {day.net_expected_cents !== 0
                ? `Net expected ${formatUsdCompact(day.net_expected_cents)}`
                : null}
              {day.net_actual_cents === 0 && day.net_expected_cents === 0 ? "No cash movement." : null}
            </SideSheetDescription>
          </SideSheetHeader>

          <SideSheetBody className="space-y-5">
            {day.events.length === 0 ? (
              <p className="text-sm text-neutral-500">Nothing on this day.</p>
            ) : (
              KIND_ORDER.map((kind) => {
                const events = day.events.filter((event) => event.kind === kind);
                if (events.length === 0) return null;
                return (
                  <section key={kind}>
                    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                      {KIND_HEADINGS[kind]}
                    </h3>
                    <ul className="mt-2 divide-y divide-neutral-100">
                      {events.map((event) => (
                        <EventRow key={event.id} event={event} />
                      ))}
                    </ul>
                  </section>
                );
              })
            )}

            {hasCanary ? (
              <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3">
                <Button variant="outline" size="sm" disabled className="w-full">
                  Schedule review
                </Button>
                <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-400">
                  Booking time against a Canary marker is not wired up in this build.
                </p>
              </div>
            ) : null}
          </SideSheetBody>
        </SideSheetContent>
      ) : null}
    </SideSheet>
  );
}

function EventRow({ event }: { event: CalendarEvent }) {
  return (
    <li className="py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-medium text-neutral-900">
            {event.kind === "canary" ? (
              <span aria-hidden="true" className="text-[10px] text-canary-600">
                {CANARY_GLYPHS[canaryMarker(event)]}
              </span>
            ) : null}
            <span className="truncate">{event.kind === "busy" ? "Busy" : eventLabel(event)}</span>
          </p>
          <p className="mt-0.5 text-xs text-neutral-500">
            {event.kind === "busy" && event.start ? formatTimeRange(event.start, event.end) : null}
            {event.kind !== "busy" ? (categoryLabel(event.category) ?? event.title) : null}
          </p>
        </div>
        {event.amount_cents !== undefined ? (
          <span className="shrink-0 text-sm font-semibold tabular-nums text-neutral-900">
            {formatSignedUsd(event.amount_cents)}
          </span>
        ) : null}
      </div>

      {event.kind === "expected" ? (
        <p className="mt-1 text-[11px] leading-relaxed text-neutral-400">
          Projected from the observed {event.cadence ?? "recurring"} cadence
          {event.confidence_n ? ` across ${event.confidence_n} prior charges` : ""}. An estimate, not a
          commitment.
        </p>
      ) : null}

      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {event.entity ? (
          <Link
            to={`/ledger?focus=vendor:${encodeURIComponent(event.entity)}`}
            className="text-[11px] font-medium text-neutral-600 underline-offset-2 hover:text-neutral-900 hover:underline"
          >
            View in ledger
          </Link>
        ) : null}
        {event.incident_id ? (
          <Link
            to={`/incidents/${event.incident_id}`}
            className="text-[11px] font-medium text-canary-700 underline-offset-2 hover:underline"
          >
            Open incident
          </Link>
        ) : null}
        {event.kind === "actual" && event.category === "NEEDS_REVIEW" ? (
          <Badge variant="warn">needs review</Badge>
        ) : null}
      </div>
    </li>
  );
}
