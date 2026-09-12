import type { ChildSignal, Contributor } from "@canary/shared";
import { Badge } from "@/components/ui/badge.tsx";
import {
  categoryLabel,
  entityDisplayName,
  formatMonthlyRate,
  formatShare,
  formatWeeklyRate,
} from "@/lib/format.ts";
import { cn } from "@/lib/utils.ts";

/**
 * Which entities moved, and by how much. Bars are sized by the magnitude of
 * the weekly delta so a negative contributor reads as an offset, not a driver.
 */
export function ContributorBars({
  contributors,
  childSignals,
}: {
  contributors: Contributor[];
  childSignals: ChildSignal[];
}) {
  const widest = contributors.reduce((max, c) => Math.max(max, Math.abs(c.delta_weekly_cents)), 0);

  return (
    <div className="space-y-6">
      <ul className="space-y-4">
        {contributors.map((c) => {
          const increased = c.delta_weekly_cents >= 0;
          const width = widest > 0 ? (Math.abs(c.delta_weekly_cents) / widest) * 100 : 0;
          const category = categoryLabel(c.category);

          return (
            <li key={c.entity}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-neutral-900">
                    {entityDisplayName(c.entity)}
                  </span>
                  {category ? <Badge variant="quiet">{category}</Badge> : null}
                </div>
                <div className="flex items-baseline gap-2 text-sm tabular-nums">
                  <span className={cn("font-semibold", increased ? "text-neutral-900" : "text-emerald-700")}>
                    {formatWeeklyRate(c.delta_weekly_cents)}
                  </span>
                  <span className="text-neutral-500">{formatMonthlyRate(c.delta_monthly_cents)}</span>
                  <span className="text-xs text-neutral-400">{formatShare(c.share_of_total_delta)}</span>
                </div>
              </div>
              <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-neutral-100">
                <div
                  className={cn("h-full rounded-full", increased ? "bg-canary-400" : "bg-emerald-200")}
                  style={{ width: `${width}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>

      {childSignals.length > 0 ? (
        <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-4">
          <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Folded into this incident
          </h3>
          <p className="mt-1 text-xs text-neutral-500">
            Related movements that would otherwise have become their own alerts.
          </p>
          <ul className="mt-3 space-y-2">
            {childSignals.map((signal) => (
              <li key={signal.entity} className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-sm text-neutral-800">
                  {entityDisplayName(signal.entity)}
                  <span className="text-neutral-500"> — {signal.description}</span>
                </span>
                <span className="text-sm font-medium tabular-nums text-neutral-700">
                  {formatWeeklyRate(signal.delta_weekly_cents)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
