import { Link } from "react-router-dom";
import type { Incident } from "@canary/shared";
import { SeverityBadge } from "@/components/SeverityBadge.tsx";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import {
  entityDisplayName,
  formatMonths,
  formatSignedUsd,
  formatWeekLabel,
  formatDateMedium,
} from "@/lib/format.ts";
import { topPositiveContributor } from "@/lib/incident.ts";

/**
 * The one-sentence "what changed" line. Built entirely from engine figures —
 * no prose is stored for it, so it can never drift from the numbers.
 */
export function incidentSummarySentence(incident: Incident): string {
  const clauses: string[] = [];
  const delta = incident.financial_impact.delta_weekly_cents;
  const changePoint = incident.estimated_change_point;

  if (delta !== null) {
    clauses.push(
      changePoint
        ? `Variable spend up ${formatSignedUsd(delta, "/wk")} since the week of ${formatWeekLabel(changePoint)}`
        : `Variable spend up ${formatSignedUsd(delta, "/wk")}`,
    );
  }

  const driver = topPositiveContributor(incident);
  if (driver) {
    clauses.push(
      `${entityDisplayName(driver.entity)} is the largest contributor at ${formatSignedUsd(driver.delta_weekly_cents, "/wk")}`,
    );
  }

  return clauses.length > 0 ? `${clauses.join("; ")}.` : incident.summary;
}

export function IncidentCard({ incident }: { incident: Incident }) {
  const impact = incident.financial_impact;

  return (
    <Card className="border-canary-300 ring-1 ring-canary-200">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-canary-100 px-2.5 py-0.5 text-xs font-medium text-canary-800">
            Open incident
          </span>
          <SeverityBadge severity={incident.severity} />
        </div>
        <CardTitle>{incident.title}</CardTitle>
        <p className="text-sm leading-relaxed text-neutral-600">{incidentSummarySentence(incident)}</p>
      </CardHeader>

      <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {impact.delta_monthly_cents !== null ? (
          <Figure label="Monthly impact" value={formatSignedUsd(impact.delta_monthly_cents, "/mo")} />
        ) : null}
        {impact.runway_before_months !== null && impact.runway_after_months !== null ? (
          <Figure
            label="Runway"
            value={`${formatMonths(impact.runway_before_months)} → ${formatMonths(impact.runway_after_months)}`}
          />
        ) : null}
        {incident.alarm_date ? (
          <Figure label="Detected" value={formatDateMedium(incident.alarm_date)} />
        ) : null}
      </CardContent>

      <CardFooter>
        <Link
          to={`/incidents/${incident.id}`}
          className="text-sm font-medium text-neutral-900 underline-offset-4 hover:underline"
        >
          View incident →
        </Link>
      </CardFooter>
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</p>
      <p className="mt-1 text-sm font-semibold tabular-nums text-neutral-900">{value}</p>
    </div>
  );
}
