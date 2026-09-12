import { AudioLines, Bird, Smartphone } from "lucide-react";
import type { AlertHistoryItem, ISODateTime } from "@canary/shared";
import { useAlertHistory } from "@/api/useDerived.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { cn } from "@/lib/utils.ts";

const DEFAULT_LIMIT = 8;

/**
 * What Canary actually said, and what the founder said back. Optional chrome:
 * if the route is missing or fails the strip renders nothing, because a failed
 * transcript log must never look like a failed detector.
 *
 * `now` is injected so the relative timestamps are testable. Elapsed time is
 * interface chrome, not a derived figure — no money is computed here.
 */
export function AlertsStrip({
  limit = DEFAULT_LIMIT,
  now = new Date(),
}: {
  limit?: number;
  now?: Date;
}) {
  const { data, loading, error } = useAlertHistory(limit);

  if (error) return null;

  return (
    <section aria-label="Conversation" className="rounded-2xl border border-neutral-200/80 bg-white p-4 sm:p-5">
      <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">Conversation</h2>

      {loading && !data ? (
        <div className="mt-3 space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-11 rounded-xl" />
          ))}
        </div>
      ) : !data || data.length === 0 ? (
        <p className="mt-3 text-sm text-neutral-500">No alerts sent yet.</p>
      ) : (
        <ol className="mt-3 flex flex-col gap-2 lg:flex-row lg:flex-wrap">
          {data.map((item) => (
            <Entry key={item.id} item={item} now={now} />
          ))}
        </ol>
      )}
    </section>
  );
}

function Entry({ item, now }: { item: AlertHistoryItem; now: Date }) {
  const outbound = item.direction === "outbound";
  const Icon = outbound ? Bird : Smartphone;

  return (
    <li
      className={cn(
        "flex min-w-0 items-start gap-2.5 rounded-xl border p-2.5 lg:max-w-xs lg:flex-1",
        outbound ? "border-canary-200 bg-canary-50/60" : "border-neutral-200",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg",
          outbound ? "bg-canary-200 text-canary-900" : "bg-neutral-100 text-neutral-600",
        )}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </span>

      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
          <span className="font-medium text-neutral-700">{outbound ? "Canary" : "Founder"}</span>
          <span>{relativeTime(item.created_at, now)}</span>
          {item.voice ? (
            <Badge variant="accent" className="px-1.5 py-0 text-[10px]">
              <AudioLines className="h-2.5 w-2.5" aria-hidden="true" />
              voice note
            </Badge>
          ) : null}
          {item.command ? (
            <Badge variant="outline" className="px-1.5 py-0 text-[10px] uppercase">
              {item.command}
            </Badge>
          ) : null}
        </p>
        <p className="mt-0.5 truncate text-sm text-neutral-800">{previewLine(item.body)}</p>
      </div>
    </li>
  );
}

/** First line only — the rest of the alert body lives on the incident page. */
export function previewLine(body: string): string {
  const first = body.split("\n").find((line) => line.trim().length > 0);
  return first ? first.trim() : "";
}

/** `2h ago`. Coarse on purpose: a log entry does not need seconds. */
export function relativeTime(timestamp: ISODateTime, now: Date): string {
  const then = new Date(timestamp).getTime();
  if (Number.isNaN(then)) return timestamp;

  const minutes = Math.round((now.getTime() - then) / 60_000);
  if (minutes < 0) return "just now";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
