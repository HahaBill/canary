import type { CusumResult, MaterialityVerdict, OneOffResult } from "@canary/shared";
import { Badge } from "@/components/ui/badge.tsx";
import { formatDateMedium, formatUsdWhole, ruleLabel } from "@/lib/format.ts";

/**
 * The audit trail for the alarm: the baseline it was measured against, the
 * CUSUM parameters, and which materiality rules made it worth an alert.
 */
export function WhyFlagged({
  cusum,
  oneOff,
  materiality,
}: {
  cusum?: CusumResult;
  oneOff?: OneOffResult;
  materiality: MaterialityVerdict;
}) {
  return (
    <section
      aria-label="Why Canary flagged this"
      className="rounded-2xl border border-neutral-200 bg-neutral-50/60 p-5"
    >
      <h3 className="text-sm font-medium text-neutral-900">Why Canary flagged this</h3>

      {cusum ? (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Param
              label="Baseline"
              value={`${cusum.baseline_weeks} weeks`}
              caption={`median ${formatUsdWhole(cusum.baseline_median_cents)}/wk`}
            />
            <Param label="σ (weekly)" value={formatUsdWhole(cusum.sigma_cents)} caption="from baseline MAD" />
            <Param
              label="k (slack)"
              value={formatUsdWhole(cusum.k_cents)}
              caption={`${cusum.config.k_factor}× σ`}
            />
            <Param
              label="h (threshold)"
              value={formatUsdWhole(cusum.h_cents)}
              caption={`${cusum.config.h_multiplier}× σ`}
            />
          </dl>

          <p className="mt-4 text-xs leading-relaxed text-neutral-600">
            {cusum.estimated_change_point_week_start
              ? `The statistic last sat at zero before the week of ${formatDateMedium(cusum.estimated_change_point_week_start)}, so that week starts the new regime. `
              : ""}
            {cusum.alarm_week_start
              ? `It crossed h during the week of ${formatDateMedium(cusum.alarm_week_start)}`
              : "It has not crossed h"}
            {cusum.detection_lag_weeks !== null
              ? ` — a detection lag of ${cusum.detection_lag_weeks} ${cusum.detection_lag_weeks === 1 ? "week" : "weeks"}.`
              : "."}
          </p>
        </>
      ) : oneOff ? (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Param label="This payment" value={formatUsdWhole(oneOff.current_amount_cents)} caption={formatDateMedium(oneOff.date)} />
            <Param
              label="Vendor median"
              value={oneOff.vendor_median_cents !== null ? formatUsdWhole(oneOff.vendor_median_cents) : "—"}
              caption={`${oneOff.prior_payment_count} prior ${oneOff.prior_payment_count === 1 ? "payment" : "payments"}`}
            />
            <Param
              label="Multiple of median"
              value={oneOff.multiple_of_median !== null ? `${oneOff.multiple_of_median.toFixed(1)}×` : "—"}
              caption="vendor-relative rule"
            />
            <Param
              label="Vendor MAD"
              value={oneOff.vendor_mad_cents !== null ? formatUsdWhole(oneOff.vendor_mad_cents) : "—"}
              caption="typical deviation"
            />
          </dl>
          <p className="mt-4 text-xs leading-relaxed text-neutral-600">
            Flagged by the vendor-relative one-off rule: the payment is far above this vendor&apos;s own history. It still counts in cash
            and burn, but is excluded from the CUSUM monitoring series so it cannot masquerade as a sustained shift.
          </p>
        </>
      ) : (
        <p className="mt-3 text-xs leading-relaxed text-neutral-600">
          Detector parameters were not attached to this incident.
        </p>
      )}

      <div className="mt-5">
        <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Materiality rules triggered
        </h4>
        {materiality.rules_triggered.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-2">
            {materiality.rules_triggered.map((rule) => (
              <li key={rule}>
                <Badge variant={materiality.material ? "accent" : "quiet"} title={rule}>
                  {ruleLabel(rule)}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-neutral-600">
            No materiality rule fired; this incident is informational.
          </p>
        )}
      </div>
    </section>
  );
}

function Param({ label, value, caption }: { label: string; value: string; caption: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className="mt-1 text-sm font-semibold tabular-nums text-neutral-900">{value}</dd>
      <dd className="text-xs text-neutral-500">{caption}</dd>
    </div>
  );
}
