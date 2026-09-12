import { Link } from "react-router-dom";
import type { ISODate, Incident, WeeklyBucket } from "@canary/shared";
import { SeverityBadge } from "@/components/SeverityBadge.tsx";
import { Sparkline } from "@/components/Sparkline.tsx";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import {
  entityDisplayName,
  formatMonths,
  formatSignedUsd,
  formatUsdWhole,
  formatWeekLabel,
  formatDateMedium,
} from "@/lib/format.ts";
import { topPositiveContributor, variableRates } from "@/lib/incident.ts";

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

/**
 * Describes the thumbnail for screen readers using the same engine rates the
 * incident quotes, so the alt text can never disagree with the picture.
 */
export function sparklineLabel(incident: Incident, weeks: WeeklyBucket[]): string {
  const { pre, post } = variableRates(incident);
  const shape =
    pre !== null && post !== null
      ? `, from ${formatUsdWhole(pre)} per week before the change point to ${formatUsdWhole(post)} per week after`
      : "";
  return `Weekly variable spend across ${weeks.length} weeks${shape}.`;
}

export function IncidentCard({
  incident,
  weeks,
  changePoint,
}: {
  incident: Incident;
  /** Omitted on surfaces that have no weekly series; the card renders without the thumbnail. */
  weeks?: WeeklyBucket[];
  /** Defaults to the incident's own change point. */
  changePoint?: ISODate | null;
}) {
  const impact = incident.financial_impact;
  const series = weeks ?? [];
  const marker = changePoint === undefined ? incident.estimated_change_point : changePoint;

  return (
    <Card className="border-canary-300 ring-1 ring-canary-200">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-canary-100 px-2.5 py-0.5 text-xs font-medium text-canary-800">
            {incident.status.charAt(0) + incident.status.slice(1).toLowerCase()} incident
          </span>
          <SeverityBadge severity={incident.severity} />
        </div>
        <CardTitle>{incident.title}</CardTitle>
        <p className="text-sm leading-relaxed text-neutral-600">{incidentSummarySentence(incident)}</p>
        {series.length > 1 ? (
          <Sparkline
            weeks={series}
            changePoint={marker}
            label={sparklineLabel(incident, series)}
            className="mt-1.5 h-12 w-full max-w-[220px]"
          />
        ) : null}
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
