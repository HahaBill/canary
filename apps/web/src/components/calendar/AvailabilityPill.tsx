import type { AvailabilityResponse, CalendarConnectionResponse } from "@canary/shared";
import { CalendarClock, CalendarOff, MessageCircle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { formatTimeOfDay } from "@/lib/format.ts";
import { cn } from "@/lib/utils.ts";

/**
 * Whether Canary may interrupt right now (docs/AGENT_BEHAVIOR.md §1). The
 * alert policy reads the same endpoint, so this is the founder's view of it.
 */
export function AvailabilityPill({
  availability,
  connection,
  loading,
}: {
  availability: AvailabilityResponse | null;
  connection?: CalendarConnectionResponse | null;
  loading: boolean;
}) {
  if (loading && !availability) return <Skeleton className="h-7 w-44 rounded-full" />;
  if (!availability) return null;

  const { Icon, text, tone } = describe(availability, connection ?? null);

  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium", tone)}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {text}
    </span>
  );
}

function describe(availability: AvailabilityResponse, connection: CalendarConnectionResponse | null) {
  if (availability.source === "none") {
    const linked = Boolean(connection && (connection.provider !== "none" || connection.revoked_at));
    return {
      Icon: CalendarOff,
      text: linked ? "Calendar unread — texts immediately" : "No calendar — texts immediately",
      tone: "bg-neutral-100 text-neutral-500",
    };
  }
  if (availability.busy) {
    return {
      Icon: CalendarClock,
      text: availability.until ? `Holding until ${formatTimeOfDay(availability.until)}` : "Holding — in a meeting",
      tone: "bg-amber-50 text-amber-800",
    };
  }
  return { Icon: MessageCircle, text: "Canary can text", tone: "bg-emerald-50 text-emerald-800" };
}
