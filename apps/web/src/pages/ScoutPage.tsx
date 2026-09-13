import { useState } from "react";
import { Link } from "react-router-dom";
import type { ScoutPage, ScoutVendorCard } from "@canary/shared";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { refreshScoutSources, useScout } from "@/api/useDerived.ts";
import { KIND_META } from "@/components/EvidenceList.tsx";
import { ErrorState, PanelSkeleton } from "@/components/States.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { formatDateMedium, formatTimestampMedium, formatWeeklyLevel } from "@/lib/format.ts";

export function ScoutPage() {
  const { data, loading, error, reload } = useScout();
  const [page, setPage] = useState<ScoutPage | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const shown = page ?? data;

  async function refresh() {
    setRefreshing(true);
    setRefreshError(null);
    try {
      setPage(await refreshScoutSources());
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : "Could not refresh sources.");
    } finally {
      setRefreshing(false);
    }
  }

  if (error && !shown) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !shown) {
    return (
      <div className="space-y-5">
        <PanelSkeleton className="h-16" />
        <PanelSkeleton className="h-48" />
      </div>
    );
  }
  if (!shown) return null;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">Scout</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-neutral-500">
            Dated changes at vendors you already pay. Not a comparison, and not a recommendation.
            Sources without a published date are omitted.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
          Refresh sources
        </Button>
      </header>

      {shown.refresh_error || refreshError ? (
        <p role="status" className="text-sm text-neutral-500">
          {refreshError ?? "Could not reach Tavily — showing the last retrieved sources."}
        </p>
      ) : null}

      {shown.vendors.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-neutral-200 bg-neutral-50 px-4 py-6 text-sm text-neutral-600">
          No monitored variable-spend vendor is above the Scout floor in the current burn window.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {shown.vendors.map((card) => (
            <VendorCard key={card.entity} card={card} incidentId={shown.whatif_incident_id} lookbackDays={shown.lookback_days} />
          ))}
        </div>
      )}
    </div>
  );
}

function VendorCard({
  card,
  incidentId,
  lookbackDays,
}: {
  card: ScoutVendorCard;
  incidentId: string | null;
  lookbackDays: number;
}) {
  const observed = KIND_META.OBSERVED;
  const evidence = KIND_META.EVIDENCE;
  const whatIfTo = incidentId ? `/incidents/${encodeURIComponent(incidentId)}?tab=whatif&entity=${encodeURIComponent(card.entity)}` : null;

  return (
    <Card role="article" aria-labelledby={`scout-${card.entity}`}>
      <CardHeader>
        <CardTitle id={`scout-${card.entity}`}>{card.display_name}</CardTitle>
        <CardDescription>
          <span className="sr-only">{observed.label}. </span>
          <Badge variant={observed.variant}>{observed.label}</Badge>
          <span className="ml-2">
            {formatWeeklyLevel(card.trailing_weekly_cents)} in the burn window {formatDateMedium(card.window_start)}–
            {formatDateMedium(card.window_end)}.
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-900">{evidence.label}</h3>
          <Badge variant={evidence.variant}>{evidence.blurb}</Badge>
        </div>

        {card.empty_window ? (
          <p className="text-sm text-neutral-600">Nothing dated in the last {lookbackDays} days.</p>
        ) : (
          <ul className="space-y-3">
            {card.findings.map((finding) => (
              <li key={finding.source_url} className="rounded-xl border border-neutral-200 bg-neutral-50/80 p-3">
                <p className="text-sm leading-relaxed text-neutral-800">{finding.claim}</p>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
                  <a
                    href={finding.source_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-neutral-900 underline-offset-4 hover:underline"
                  >
                    {finding.source_title}
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                  <span>published {formatDateMedium(finding.published_at)}</span>
                  {finding.retrieved_at ? <span>retrieved {formatTimestampMedium(finding.retrieved_at)}</span> : null}
                  {finding.cached ? <Badge variant="quiet">previously retrieved</Badge> : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        {whatIfTo ? (
          <p className="pt-1">
            <Link to={whatIfTo} className="text-sm font-medium text-neutral-900 underline-offset-4 hover:underline">
              Open the what-if simulator for {card.display_name}
            </Link>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
