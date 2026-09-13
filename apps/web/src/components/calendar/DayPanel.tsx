import type { CalendarConnectionResponse, CalendarDay, CalendarEvent, CashCalendar } from "@canary/shared";
import { Link } from "react-router-dom";
import { eventLabel } from "@/components/calendar/EventChip.tsx";
import {
  SideSheet,
  SideSheetBody,
  SideSheetContent,
  SideSheetDescription,
  SideSheetHeader,
  SideSheetTitle,
} from "@/components/ui/side-sheet.tsx";
import { formatDateMedium, formatTimeRange } from "@/lib/format.ts";

export function DayPanel({
  day,
  busySource,
  connection,
  onClose,
}: {
  day: CalendarDay | null;
  busySource: CashCalendar["busy_source"];
  connection: CalendarConnectionResponse | null;
  onClose: () => void;
}) {
  const blocks = day?.events.filter((event) => event.kind === "busy" || event.kind === "canary") ?? [];
  const feedLive = busySource !== "none";
  const linked = Boolean(connection && (connection.provider !== "none" || connection.revoked_at));

  return (
    <SideSheet open={day !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      {day ? (
        <SideSheetContent aria-describedby="calendar-day-description">
          <SideSheetHeader>
            <SideSheetTitle>{formatDateMedium(day.date)}</SideSheetTitle>
            <SideSheetDescription id="calendar-day-description">
              {feedLive
                ? blocks.some((event) => event.kind === "busy")
                  ? "Canary will hold iMessage alerts during these blocks."
                  : "No meetings on the founder calendar. Canary can text if something is flagged."
                : linked
                  ? "Could not read the founder calendar just now. Canary treats the founder as free and will text."
                  : "No calendar connected — Canary cannot see meetings and will text as soon as an incident is material."}
            </SideSheetDescription>
          </SideSheetHeader>

          <SideSheetBody className="space-y-5">
            {feedLive && blocks.length === 0 ? (
              <p className="text-sm text-neutral-500">Free all day. Canary can text.</p>
            ) : null}

            {blocks.length > 0 ? (
              <ul className="divide-y divide-neutral-100">
                {blocks.map((event) => (
                  <BlockRow key={event.id} event={event} />
                ))}
              </ul>
            ) : null}
          </SideSheetBody>
        </SideSheetContent>
      ) : null}
    </SideSheet>
  );
}

function BlockRow({ event }: { event: CalendarEvent }) {
  const review = event.kind === "canary";
  return (
    <li className="py-2.5">
      <p className="text-sm font-medium text-neutral-900">{review ? event.title : "Busy"}</p>
      <p className="mt-0.5 text-xs text-neutral-500">
        {event.start ? formatTimeRange(event.start, event.end) : eventLabel(event)}
        {review ? " · Canary booked this" : " · alerts wait"}
      </p>
      {event.incident_id ? (
        <Link
          to={`/incidents/${event.incident_id}`}
          className="mt-1.5 inline-flex text-[11px] font-medium text-canary-700 underline-offset-2 hover:underline"
        >
          Open incident
        </Link>
      ) : null}
    </li>
  );
}
