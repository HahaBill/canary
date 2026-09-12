import { useDerived } from "@/api/useDerived.ts";
import { DataQualityStrip } from "@/components/DataQualityStrip.tsx";
import { IncidentCard } from "@/components/IncidentCard.tsx";
import { SignalCard } from "@/components/SignalCard.tsx";
import { StatCard } from "@/components/StatCard.tsx";
import { ErrorState, PanelSkeleton, StatRowSkeleton } from "@/components/States.tsx";
import { burnWindowCaption, formatDateMedium, formatMonths, formatUsdCompact, formatUsdWhole } from "@/lib/format.ts";

export function Dashboard() {
  const { data, loading, error, reload } = useDerived();

  if (error) return <ErrorState message={error} onRetry={reload} />;

  if (loading || !data) {
    return (
      <div className="space-y-6">
        <StatRowSkeleton />
        <PanelSkeleton className="h-52" />
        <PanelSkeleton className="h-28" />
      </div>
    );
  }

  const { burn, company, provenance, reconciliation, needs_review } = data;

  return (
    <div className="space-y-6 sm:space-y-8">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
          {company.name}
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          {company.stage} · {company.headcount} people · history through {formatDateMedium(provenance.end_date)}
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Cash"
          value={formatUsdCompact(data.cash_cents)}
          caption={`${company.bank_name} balance · ${formatDateMedium(company.as_of)}`}
          info="Checking plus savings as reported by the bank. Corporate card liability is excluded."
        />
        <StatCard
          label="Current burn"
          value={formatUsdWhole(burn.monthly_net_burn_cents)}
          caption={`monthly net · ${burnWindowCaption(burn)}`}
          info="Average weekly operating outflow minus operating inflow across the window, normalized to a month. Transfers, card settlements and financing are excluded."
        />
        <StatCard
          label="Runway"
          value={formatMonths(burn.runway_months)}
          caption="at current burn"
          info="Available operating cash divided by monthly net burn."
        />
      </div>

      {data.primary_incident || data.one_off_incident ? (
        <div className="grid gap-4 lg:grid-cols-3">
          {data.primary_incident ? (
            <div className="lg:col-span-2">
              <IncidentCard incident={data.primary_incident} />
            </div>
          ) : null}
          {data.one_off_incident ? <SignalCard incident={data.one_off_incident} /> : null}
        </div>
      ) : (
        <p className="rounded-2xl border border-neutral-200 bg-white p-6 text-sm text-neutral-500">
          No open incidents. Canary is watching variable spend week over week.
        </p>
      )}

      <DataQualityStrip reconciliation={reconciliation} needsReview={needs_review} />
    </div>
  );
}
