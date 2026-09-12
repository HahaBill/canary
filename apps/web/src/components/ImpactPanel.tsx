import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import type { Incident } from "@canary/shared";
import { formatMonths, formatSignedUsd, formatUsdWhole } from "@/lib/format.ts";
import { variableRates } from "@/lib/incident.ts";

/** Rate before, rate after, and what that does to runway. */
export function ImpactPanel({ incident }: { incident: Incident }) {
  const impact = incident.financial_impact;
  const { pre, post } = variableRates(incident);

  return (
    <section aria-label="Financial impact" className="rounded-2xl border border-neutral-200 bg-white p-5">
      <h3 className="text-sm font-medium text-neutral-900">Financial impact</h3>

      <dl className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <Row
          label="Variable spend rate"
          value={
            pre !== null && post !== null ? (
              <span className="inline-flex items-center gap-1.5">
                {formatUsdWhole(pre)}
                <ArrowRight className="h-3.5 w-3.5 text-neutral-400" aria-hidden="true" />
                {formatUsdWhole(post)}
              </span>
            ) : (
              "—"
            )
          }
          caption="per week, pre → post change"
        />
        <Row
          label="Weekly change"
          value={impact.delta_weekly_cents !== null ? formatSignedUsd(impact.delta_weekly_cents, "/wk") : "—"}
          caption="post minus pre"
        />
        <Row
          label="Monthly change"
          value={impact.delta_monthly_cents !== null ? formatSignedUsd(impact.delta_monthly_cents, "/mo") : "—"}
          caption="normalized month"
        />
        <Row
          label="Runway"
          value={
            impact.runway_before_months !== null && impact.runway_after_months !== null ? (
              <span className="inline-flex items-center gap-1.5">
                {formatMonths(impact.runway_before_months)}
                <ArrowRight className="h-3.5 w-3.5 text-neutral-400" aria-hidden="true" />
                {formatMonths(impact.runway_after_months)}
              </span>
            ) : (
              "—"
            )
          }
          caption={
            impact.runway_before_months !== null && impact.runway_after_months !== null
              ? runwayImpactCaption(impact.runway_impact_months)
              : "one-off payments do not change the modeled burn rate"
          }
        />
      </dl>
    </section>
  );
}

/** A positive impact means runway got shorter, which is the usual direction. */
function runwayImpactCaption(impactMonths: number | null): string {
  if (impactMonths === null) return "at pre- and post-change burn";
  if (impactMonths === 0) return "unchanged";
  return `${formatMonths(Math.abs(impactMonths))} ${impactMonths > 0 ? "shorter" : "longer"}`;
}

function Row({
  label,
  value,
  caption,
}: {
  label: string;
  value: ReactNode;
  caption: string;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className="mt-1 text-base font-semibold tabular-nums text-neutral-900">{value}</dd>
      <dd className="mt-0.5 text-xs text-neutral-500">{caption}</dd>
    </div>
  );
}
