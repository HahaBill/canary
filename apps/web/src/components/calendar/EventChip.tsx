import type { CalendarEvent, CalendarEventKind } from "@canary/shared";
import { entityDisplayName, formatTimeOfDay, formatTimeRange, formatUsdCompact } from "@/lib/format.ts";
import { cn } from "@/lib/utils.ts";

export type CanaryMarker = "change_point" | "alarm" | "one_off";

export const CANARY_GLYPHS: Record<CanaryMarker, string> = {
  change_point: "▲",
  alarm: "●",
  one_off: "◆",
};

/**
 * `CalendarEvent` has no field that says which kind of Canary marker it is, so
 * the marker is inferred from the incident type and the title the API wrote.
 * See "Contract gaps" in the workstream report.
 */
export function canaryMarker(event: CalendarEvent): CanaryMarker {
  if (event.incident_type === "ONE_OFF_VENDOR_PAYMENT") return "one_off";
  return /change point/i.test(event.title) ? "change_point" : "alarm";
}

/** What the chip says, without the styling — reused by the day panel. */
export function eventLabel(event: CalendarEvent): string {
  if (event.kind === "busy") return event.start ? formatTimeRange(event.start, event.end) : "Busy";
  if (event.entity && event.kind !== "canary") return entityDisplayName(event.entity);
  return event.title;
}

const KIND_CLASSES: Record<CalendarEventKind, string> = {
  actual: "bg-neutral-100 text-neutral-700",
  expected: "border border-dashed border-neutral-300 bg-white text-neutral-500",
  canary: "bg-canary-100 text-canary-800",
  busy: "bg-neutral-100/70 text-neutral-400",
};

export function EventChip({ event, className }: { event: CalendarEvent; className?: string }) {
  const amount = event.amount_cents;

  return (
    <span
      className={cn(
        "flex w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-[10px] leading-tight",
        KIND_CLASSES[event.kind],
        className,
      )}
    >
      {event.kind === "canary" ? (
        <span aria-hidden="true" className="shrink-0 text-[8px]">
          {CANARY_GLYPHS[canaryMarker(event)]}
        </span>
      ) : null}
      {event.kind === "expected" ? <span className="shrink-0 opacity-70">expected</span> : null}
      <span className="truncate">{event.kind === "busy" ? "Busy" : eventLabel(event)}</span>
      {event.kind === "busy" && event.start ? (
        <span className="ml-auto shrink-0 tabular-nums">{formatTimeOfDay(event.start)}</span>
      ) : null}
      {amount !== undefined && event.kind !== "canary" ? (
        <span className="ml-auto shrink-0 tabular-nums">{formatUsdCompact(amount)}</span>
      ) : null}
    </span>
  );
}
