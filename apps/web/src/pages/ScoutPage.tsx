import { useState } from "react";
import { Link } from "react-router-dom";
import { SCOUT, type ScoutPage, type ScoutRefreshError, type ScoutVendorCard } from "@canary/shared";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { ApiError } from "@/api/client.ts";
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
  const [refreshError, setRefreshError] = useState<ScoutRefreshError | null>(null);

  const shown = page ?? data;

  async function refresh() {
    setRefreshing(true);
    setRefreshError(null);
    try {
      setPage(await refreshScoutSources());
    } catch (err) {
      setRefreshError(err instanceof ApiError && err.kind === "network" ? "TAVILY_UNREACHABLE" : "TAVILY_FAILED");
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

  const neverSearched = shown.never_searched;
  const status = scoutStatus({
    refreshing,
    vendorCount: shown.vendors.length,
    neverSearched,
    didRefresh: page !== null,
    tavilyCalls: shown.tavily_calls,
    refreshError: refreshError ?? shown.refresh_error ?? null,
    hasLastSources: shown.vendors.some((card) => card.findings.length > 0),
  });

  return (
    <div className="space-y-5" aria-busy={refreshing}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">Scout</h1>
            <Badge variant="accent">Live search</Badge>
          </div>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-neutral-500">
            Dated pricing, plan, and credit announcements at vendors you already pay. Canary
            reports what live search found. It does not rank vendors or recommend a change.
            Sources without a published date are omitted.
          </p>
        </div>
        <Button type="button" variant="accent" size="lg" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
          {refreshing ? "Searching…" : "Refresh"}
        </Button>
      </header>

      {status ? (
        <p role="status" className="rounded-2xl border border-canary-200 bg-canary-50 px-4 py-3 text-sm leading-relaxed text-neutral-800">
          {status}
        </p>
      ) : null}

      {shown.vendors.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-neutral-200 bg-neutral-50 px-4 py-6 text-sm text-neutral-600">
          No monitored variable-spend vendor is above the Scout floor in the current burn window.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {shown.vendors.map((card) => (
            <VendorCard
              key={card.entity}
              card={card}
              incidentId={shown.whatif_incident_id}
              lookbackDays={shown.lookback_days}
              researching={refreshing}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function lastRetrievedSuffix(hasLastSources: boolean): string {
  return hasLastSources ? " Showing the last retrieved sources." : "";
}

function scoutStatus(input: {
  refreshing: boolean;
  vendorCount: number;
  neverSearched: boolean;
  didRefresh: boolean;
  tavilyCalls: number;
  refreshError: ScoutRefreshError | null;
  hasLastSources: boolean;
}): string | null {
  if (input.refreshing) {
    return `Searching now — one dated news search per vendor, capped at ${SCOUT.MAX_TAVILY_CALLS_PER_RUN} calls. This can take a few seconds.`;
  }
  if (input.refreshError === "TAVILY_NOT_CONFIGURED") {
    return "Live search is not configured on this Worker, so Refresh cannot run.";
  }
  if (input.refreshError === "TAVILY_UNAUTHORIZED") {
    return "The research source rejected the API key. Refresh cannot search until the Worker secret is updated.";
  }
  if (input.refreshError === "TAVILY_QUOTA") {
    return `The research source rate-limited this Refresh (quota). Try again later.${lastRetrievedSuffix(input.hasLastSources)}`;
  }
  if (input.refreshError === "TAVILY_UNREACHABLE") {
    return `Could not reach the research source.${lastRetrievedSuffix(input.hasLastSources)}`;
  }
  if (input.refreshError) {
    return `Live search returned an error.${lastRetrievedSuffix(input.hasLastSources)}`;
  }
  if (input.didRefresh && input.tavilyCalls > 0) {
    const n = input.tavilyCalls;
    return `Live search checked ${n} vendor${n === 1 ? "" : "s"} just now. Dated sources are listed below; nothing dated is a complete answer.`;
  }
  if (input.didRefresh && input.tavilyCalls === 0 && !input.neverSearched) {
    return `Still inside the ${SCOUT.TTL_HOURS}-hour window. Showing the last retrieval — Refresh will search again after that.`;
  }
  if (input.neverSearched && input.vendorCount > 0) {
    return "Live search has not run yet. Refresh runs one dated news search per vendor for pricing, plan, credit, and announcement sources.";
  }
  return null;
}

function VendorCard({
  card,
  incidentId,
  lookbackDays,
  researching,
}: {
  card: ScoutVendorCard;
  incidentId: string | null;
  lookbackDays: number;
  researching: boolean;
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

        <p className="text-xs leading-relaxed text-neutral-500">
          <span className="font-medium text-neutral-700">Search query. </span>
          <span className="break-words font-mono text-[11px] text-neutral-600">{card.query}</span>
        </p>

        {researching && !card.searched ? (
          <p className="flex items-center gap-2 text-sm text-neutral-600">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Asking live search for dated sources.
          </p>
        ) : !card.searched ? (
          <p className="text-sm text-neutral-600">Not yet searched.</p>
        ) : card.empty_window ? (
          <p className="text-sm text-neutral-600">
            Searched. Nothing dated in the last {lookbackDays} days.
          </p>
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
                  {finding.cached ? <Badge variant="quiet">previously retrieved</Badge> : <Badge variant="accent">just retrieved</Badge>}
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
