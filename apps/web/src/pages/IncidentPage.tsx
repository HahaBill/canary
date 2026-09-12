import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { CreateAppLinkRequest, IncidentStatus } from "@canary/shared";
import { clearApiCache, updateIncidentStatus, useIncidentDetail } from "@/api/useDerived.ts";
import { ContributorBars } from "@/components/ContributorBars.tsx";
import { CusumChart } from "@/components/CusumChart.tsx";
import { EvidenceList } from "@/components/EvidenceList.tsx";
import { ImpactPanel } from "@/components/ImpactPanel.tsx";
import { SeverityBadge, StatusBadge } from "@/components/SeverityBadge.tsx";
import { ErrorState, PanelSkeleton } from "@/components/States.tsx";
import { VariableSpendChart } from "@/components/VariableSpendChart.tsx";
import { WhatIfPanel } from "@/components/WhatIfPanel.tsx";
import { WhyFlagged } from "@/components/WhyFlagged.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { NotFound } from "@/pages/NotFound.tsx";
import { formatDateMedium } from "@/lib/format.ts";

/** Same tab vocabulary the deep-link builder uses (`buildAppPath`). */
type IncidentTab = NonNullable<CreateAppLinkRequest["tab"]>;
const TABS: readonly IncidentTab[] = ["overview", "drivers", "evidence", "whatif"];
const TAB_LABELS: Record<IncidentTab, string> = {
  overview: "Overview",
  drivers: "Drivers",
  evidence: "Evidence",
  whatif: "What-if",
};

export function IncidentPage() {
  const { id = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data, loading, error, reload } = useIncidentDetail(id);
  // Scoped to an incident id so it cannot leak when navigating between incidents.
  const [statusOverride, setStatusOverride] = useState<{ id: string; status: IncidentStatus } | null>(null);
  const [statusPending, setStatusPending] = useState(false);

  const requested = searchParams.get("tab");
  const tab: IncidentTab = TABS.includes(requested as IncidentTab)
    ? (requested as IncidentTab)
    : "overview";

  function selectTab(next: string) {
    const params = new URLSearchParams(searchParams);
    // `buildAppPath` omits the param for the default tab; stay consistent.
    if (next === "overview") params.delete("tab");
    else params.set("tab", next);
    setSearchParams(params, { replace: true });
  }

  if (error) return <ErrorState message={error} onRetry={reload} />;

  if (loading) {
    return (
      <div className="space-y-6">
        <PanelSkeleton className="h-24" />
        <PanelSkeleton className="h-72" />
      </div>
    );
  }

  if (!data) {
    return (
      <NotFound
        title="Incident not found"
        message={`No incident with id "${id}". It may have been resolved or the link may be stale.`}
      />
    );
  }

  const { incident, weeks, burn } = data;
  const cusum = incident.detection.cusum;
  const shownStatus =
    statusOverride && statusOverride.id === incident.id ? statusOverride.status : incident.status;

  async function acknowledge() {
    setStatusPending(true);
    try {
      const updated = await updateIncidentStatus(incident.id, "ACKNOWLEDGED");
      setStatusOverride({ id: incident.id, status: updated?.status ?? "ACKNOWLEDGED" });
      clearApiCache(); // so the dashboard / a revisit reflect the new status
    } catch {
      // Status is a convenience here; the incident itself is unchanged.
    } finally {
      setStatusPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/"
          className="text-sm text-neutral-500 underline-offset-4 hover:text-neutral-900 hover:underline"
        >
          ← Dashboard
        </Link>
      </div>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={shownStatus} />
          <SeverityBadge severity={incident.severity} />
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
          {incident.title}
        </h1>
        <p className="text-sm leading-relaxed text-neutral-600">
          {incident.estimated_change_point
            ? `Change point: week of ${formatDateMedium(incident.estimated_change_point)}. `
            : ""}
          {incident.alarm_date ? `Detected ${formatDateMedium(incident.alarm_date)}.` : ""}
        </p>
        {shownStatus === "OPEN" ? (
          <Button variant="outline" size="sm" onClick={acknowledge} disabled={statusPending}>
            {statusPending ? "Saving…" : "Acknowledge"}
          </Button>
        ) : null}
      </header>

      <Tabs value={tab} onValueChange={selectTab}>
        <TabsList>
          {TABS.map((name) => (
            <TabsTrigger key={name} value={name}>
              {TAB_LABELS[name]}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <div className="rounded-2xl border border-neutral-200 bg-white p-5">
            <VariableSpendChart
              weeks={weeks}
              changePoint={incident.estimated_change_point}
              {...(data.ewma_variable_spend_cents ? { ewma: data.ewma_variable_spend_cents } : {})}
            />
          </div>
          {cusum ? (
            <div className="rounded-2xl border border-neutral-200 bg-white p-5">
              <CusumChart weeks={weeks} statistic={cusum.statistic_cents} thresholdCents={cusum.h_cents} />
            </div>
          ) : null}
          <ImpactPanel incident={incident} />
        </TabsContent>

        <TabsContent value="drivers">
          <div className="rounded-2xl border border-neutral-200 bg-white p-5 sm:p-6">
            {incident.contributors.length > 0 ? (
              <ContributorBars
                contributors={incident.contributors}
                childSignals={incident.child_signals}
              />
            ) : (
              <p className="text-sm text-neutral-500">
                This signal has no contributor decomposition — it is a single vendor payment.
              </p>
            )}
          </div>
        </TabsContent>

        <TabsContent value="evidence" className="space-y-6">
          <EvidenceList items={data.evidence} />
          <WhyFlagged
            {...(cusum ? { cusum } : {})}
            {...(incident.detection.one_off ? { oneOff: incident.detection.one_off } : {})}
            materiality={incident.materiality}
          />
        </TabsContent>

        <TabsContent value="whatif">
          <div className="rounded-2xl border border-neutral-200 bg-white p-5 sm:p-6">
            <h2 className="text-sm font-medium text-neutral-900">What if spend changed?</h2>
            <p className="mt-1 text-xs text-neutral-500">
              The financial engine computes every figure below.
            </p>
            <div className="mt-5">
              {/* Remount per incident so the entity picker resets to the new driver. */}
              <WhatIfPanel key={incident.id} burn={burn} defaultEntity={incident.entity} />
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
