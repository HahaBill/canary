import type { AvailabilityResponse } from "@canary/shared";
import { CalendarClock, CalendarOff, UserCheck } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { formatTimeOfDay } from "@/lib/format.ts";
import { cn } from "@/lib/utils.ts";

/**
 * Whether Canary may interrupt right now (docs/AGENT_BEHAVIOR.md §1). The
 * alert policy reads the same endpoint, so this is the founder's view of it.
 */
export function AvailabilityPill({
  availability,
  loading,
}: {
  availability: AvailabilityResponse | null;
  loading: boolean;
}) {
  if (loading && !availability) return <Skeleton className="h-7 w-40 rounded-full" />;
  if (!availability) return null;

  const { Icon, text, tone } = describe(availability);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        tone,
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {text}
    </span>
  );
}

function describe(availability: AvailabilityResponse) {
  if (availability.source === "none") {
    return {
      Icon: CalendarOff,
      text: "No calendar connected",
      tone: "bg-neutral-100 text-neutral-500",
    };
  }
  if (availability.busy) {
    return {
      Icon: CalendarClock,
      text: availability.until
        ? `In a meeting until ${formatTimeOfDay(availability.until)}`
        : "In a meeting",
      tone: "bg-amber-50 text-amber-700",
    };
  }
  return { Icon: UserCheck, text: "Founder free", tone: "bg-emerald-50 text-emerald-700" };
}
