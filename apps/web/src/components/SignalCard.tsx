import { Link } from "react-router-dom";
import type { Incident } from "@canary/shared";
import { SeverityBadge } from "@/components/SeverityBadge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { entityDisplayName, formatDateMedium, formatMultiple, formatUsdWhole } from "@/lib/format.ts";

/**
 * A one-off vendor payment is its own signal, not a contributor to the burn
 * incident — it stays in cash and burn but out of the monitored series.
 */
export function SignalCard({ incident }: { incident: Incident }) {
  const amount = incident.financial_impact.one_off_amount_cents;
  const oneOff = incident.detection.one_off;
  const multiple = oneOff?.multiple_of_median ?? null;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Standalone signal
          </span>
          <SeverityBadge severity={incident.severity} />
        </div>
        <CardTitle>{incident.title}</CardTitle>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-sm text-neutral-600">{entityDisplayName(incident.entity)}</span>
          {amount !== undefined ? (
            <span className="text-xl font-semibold tabular-nums text-neutral-900">
              {formatUsdWhole(amount)}
            </span>
          ) : null}
          {multiple !== null ? (
            <span className="text-sm text-neutral-500">{formatMultiple(multiple)} vendor median</span>
          ) : null}
        </div>

        <p className="text-xs text-neutral-500">
          {oneOff ? `Payment dated ${formatDateMedium(oneOff.date)}. ` : ""}
          Counted in cash and burn, excluded from the monitored variable series.
        </p>

        <Link
          to={`/incidents/${incident.id}`}
          className="inline-block text-sm font-medium text-neutral-900 underline-offset-4 hover:underline"
        >
          View incident →
        </Link>
      </CardContent>
    </Card>
  );
}
