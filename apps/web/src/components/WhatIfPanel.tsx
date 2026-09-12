import { ArrowRight } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { BurnSummary } from "@canary/shared";
import { useSimulate } from "@/api/useDerived.ts";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Slider } from "@/components/ui/slider.tsx";
import {
  entityDisplayName,
  formatMonths,
  formatSignedPercent,
  formatSignedUsd,
  formatUsdWhole,
  formatWeeklyLevel,
} from "@/lib/format.ts";
import { whatIfEntities } from "@/lib/incident.ts";

const MIN_PERCENT = -50;
const MAX_PERCENT = 50;
const STEP_PERCENT = 5;
const DEFAULT_PERCENT = -20;

/**
 * Asks the backend what a spend change would do. All arithmetic happens in the
 * engine; this panel only picks an entity and a percentage.
 */
export function WhatIfPanel({ burn, defaultEntity }: { burn: BurnSummary; defaultEntity: string }) {
  const entities = useMemo(
    () => whatIfEntities(burn.weekly_variable_by_entity, defaultEntity),
    [burn.weekly_variable_by_entity, defaultEntity],
  );

  const [entity, setEntity] = useState(() => entities[0] ?? defaultEntity);
  const [percentage, setPercentage] = useState(DEFAULT_PERCENT);

  const request = useMemo(() => (entity ? { entity, percentage } : null), [entity, percentage]);
  const { data: result, loading, error } = useSimulate(request);

  if (entities.length === 0) {
    return (
      <p className="text-sm text-neutral-500">
        No monitored entities in the current burn window, so there is nothing to simulate.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="whatif-entity" className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Entity
          </label>
          <select
            id="whatif-entity"
            value={entity}
            onChange={(e) => setEntity(e.target.value)}
            className="mt-1.5 h-10 w-full rounded-lg border border-neutral-200 bg-white px-3 text-sm text-neutral-900"
          >
            {entities.map((option) => (
              <option key={option} value={option}>
                {entityDisplayName(option)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <div className="flex items-baseline justify-between">
            <label htmlFor="whatif-percentage" className="text-xs font-medium uppercase tracking-wide text-neutral-500">
              Spend change
            </label>
            <output htmlFor="whatif-percentage" className="text-sm font-semibold tabular-nums text-neutral-900">
              {formatSignedPercent(percentage)}
            </output>
          </div>
          <Slider
            id="whatif-percentage"
            min={MIN_PERCENT}
            max={MAX_PERCENT}
            step={STEP_PERCENT}
            value={percentage}
            onChange={(e) => setPercentage(Number(e.target.value))}
            aria-label={`Change ${entityDisplayName(entity)} spend by percentage`}
            className="mt-2"
          />
          <div className="flex justify-between text-xs text-neutral-400">
            <span>{formatSignedPercent(MIN_PERCENT)}</span>
            <span>{formatSignedPercent(MAX_PERCENT)}</span>
          </div>
        </div>
      </div>

      {error ? (
        <p className="text-sm text-rose-700">Could not run the scenario: {error}</p>
      ) : loading && !result ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : result ? (
        <>
          <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <Result
              label={`${entityDisplayName(result.entity)} spend`}
              value={
                <span className="inline-flex items-center gap-1.5">
                  {formatWeeklyLevel(result.current_weekly_cents)}
                  <ArrowRight className="h-3.5 w-3.5 text-neutral-400" aria-hidden="true" />
                  {formatWeeklyLevel(result.hypothetical_weekly_cents)}
                </span>
              }
              caption="weekly, current → scenario"
            />
            <Result
              label="Monthly burn"
              value={
                <span className="inline-flex items-center gap-1.5">
                  {formatUsdWhole(result.current_burn_monthly_cents)}
                  <ArrowRight className="h-3.5 w-3.5 text-neutral-400" aria-hidden="true" />
                  {formatUsdWhole(result.scenario_burn_monthly_cents)}
                </span>
              }
              caption="net, current → scenario"
            />
            <Result
              label="Monthly difference"
              value={formatSignedUsd(result.delta_monthly_cents, "/mo")}
              caption={`${formatSignedUsd(result.delta_annualized_cents)} annualized`}
            />
            <Result
              label="Runway"
              value={
                <span className="inline-flex items-center gap-1.5">
                  {formatMonths(result.current_runway_months)}
                  <ArrowRight className="h-3.5 w-3.5 text-neutral-400" aria-hidden="true" />
                  {formatMonths(result.scenario_runway_months)}
                </span>
              }
              caption={
                result.runway_delta_months !== null
                  ? `${formatMonths(result.runway_delta_months)} difference`
                  : "current → scenario"
              }
            />
          </dl>

          <p className="text-xs font-medium text-neutral-500">{result.label}</p>
        </>
      ) : null}
    </div>
  );
}

function Result({
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
