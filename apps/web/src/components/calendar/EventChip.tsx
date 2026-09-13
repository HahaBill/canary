import type { CalendarEvent } from "@canary/shared";
import { formatTimeOfDay, formatTimeRange } from "@/lib/format.ts";
import { cn } from "@/lib/utils.ts";

/** What the chip says, without the styling — reused by the day panel. */
export function eventLabel(event: CalendarEvent): string {
  if (event.kind === "busy") return event.start ? formatTimeRange(event.start, event.end) : "Busy";
  if (event.kind === "canary") return event.title;
  return event.title;
}

export function EventChip({ event, className }: { event: CalendarEvent; className?: string }) {
  const review = event.kind === "canary";
  return (
    <span
      className={cn(
        "flex w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-[10px] leading-tight",
        review ? "bg-canary-100 text-canary-800" : "bg-amber-50 text-amber-800",
        className,
      )}
    >
      <span className="truncate">{review ? event.title : "Busy"}</span>
      {event.start ? <span className="ml-auto shrink-0 tabular-nums">{formatTimeOfDay(event.start)}</span> : null}
    </span>
  );
}
