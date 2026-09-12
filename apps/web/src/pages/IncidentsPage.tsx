import type { Incident, IncidentType } from "@canary/shared";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { useDerived } from "@/api/useDerived.ts";
import { SeverityBadge, StatusBadge } from "@/components/SeverityBadge.tsx";
import { ErrorState, PanelSkeleton } from "@/components/States.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { entityDisplayName, formatDateMedium } from "@/lib/format.ts";

const TYPE_LABELS: Record<IncidentType, string> = {
  BURN_RATE_SHIFT: "Burn rate shift",
  ONE_OFF_VENDOR_PAYMENT: "One-off payment",
};

/** OPEN first, then most recently updated — the order a founder would trust. */
function byUrgency(a: Incident, b: Incident): number {
  if (a.status !== b.status) {
    if (a.status === "OPEN") return -1;
    if (b.status === "OPEN") return 1;
  }
  return b.last_updated.localeCompare(a.last_updated);
}

export function IncidentsPage() {
  const { data, loading, error, reload } = useDerived();

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || !data) return <PanelSkeleton className="h-72" />;

  const incidents = [...data.incidents].sort(byUrgency);
  const openCount = incidents.filter((i) => i.status === "OPEN").length;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">Incidents</h1>
        <p className="mt-1 text-sm text-neutral-500">
          {incidents.length === 1 ? "1 incident" : `${incidents.length} incidents`} ·{" "}
          {openCount === 0 ? "none open" : `${openCount} open`} · history through{" "}
          {formatDateMedium(data.provenance.end_date)}
        </p>
      </header>

      {incidents.length === 0 ? (
        <p className="rounded-2xl border border-neutral-200 bg-white p-6 text-sm text-neutral-500">
          No incidents. Canary is watching variable spend week over week.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white">
          <table className="w-full text-left text-[13px]">
            <caption className="sr-only">All incidents Canary has raised</caption>
            <thead className="border-b border-neutral-200 bg-neutral-50 text-[11px] uppercase tracking-wide text-neutral-500">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Incident
                </th>
                <th scope="col" className="hidden px-4 py-2.5 font-medium sm:table-cell">
                  Entity
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Severity
                </th>
                <th scope="col" className="hidden px-4 py-2.5 font-medium md:table-cell">
                  Status
                </th>
                <th scope="col" className="hidden px-4 py-2.5 font-medium lg:table-cell">
                  Detected
                </th>
                <th scope="col" className="px-4 py-2.5">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {incidents.map((incident) => (
                <tr key={incident.id} className="align-top hover:bg-neutral-50/70">
                  <td className="px-4 py-3">
                    <Link
                      to={`/incidents/${incident.id}`}
                      className="font-medium text-neutral-900 underline-offset-4 hover:underline"
                    >
                      {incident.title}
                    </Link>
                    <p className="mt-0.5 text-xs text-neutral-500">
                      <Badge variant="quiet">{TYPE_LABELS[incident.type]}</Badge>
                    </p>
                  </td>
                  <td className="hidden px-4 py-3 text-neutral-600 sm:table-cell">
                    {entityDisplayName(incident.entity)}
                  </td>
                  <td className="px-4 py-3">
                    <SeverityBadge severity={incident.severity} />
                  </td>
                  <td className="hidden px-4 py-3 md:table-cell">
                    <StatusBadge status={incident.status} />
                  </td>
                  <td className="hidden px-4 py-3 text-neutral-600 lg:table-cell">
                    <DetectionDates incident={incident} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      to={`/incidents/${incident.id}`}
                      aria-label={`Open ${incident.title}`}
                      className="inline-flex text-neutral-400 hover:text-neutral-900"
                    >
                      <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DetectionDates({ incident }: { incident: Incident }) {
  if (!incident.alarm_date && !incident.estimated_change_point) {
    return <span className="text-neutral-400">–</span>;
  }
  return (
    <span className="whitespace-nowrap">
      {incident.alarm_date ? formatDateMedium(incident.alarm_date) : "–"}
      {incident.estimated_change_point ? (
        <span className="block text-xs text-neutral-400">
          change point {formatDateMedium(incident.estimated_change_point)}
        </span>
      ) : null}
    </span>
  );
}
