import { Link } from "react-router-dom";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Cents, ISODate, WeeklyBucket } from "@canary/shared";
import { CHART, TOOLTIP_STYLE } from "@/lib/chart.ts";
import { formatSignedUsd, formatUsdCompact, formatUsdWhole, formatWeekLabel } from "@/lib/format.ts";

/** Newest-first rows on the dashboard table. Chrome, not a financial window. */
export const RECENT_WEEK_LIMIT = 8;

export interface CashFlowRow {
  week_start: ISODate;
  label: string;
  outflow_cents: Cents;
  inflow_cents: Cents;
  net_burn_cents: Cents;
}

/**
 * Pass-through of engine week fields. No sign flip, no net recomputed here —
 * net burn is already outflow minus inflow on the bucket.
 */
export function toCashFlowRows(weeks: WeeklyBucket[]): CashFlowRow[] {
  return weeks.map((week) => ({
    week_start: week.week_start,
    label: formatWeekLabel(week.week_start),
    outflow_cents: week.total_operating_outflow_cents,
    inflow_cents: week.operating_inflow_cents,
    net_burn_cents: week.net_burn_cents,
  }));
}

/** Newest week first so the row the clock is filling sits at the top. */
export function recentWeeks(weeks: WeeklyBucket[]): WeeklyBucket[] {
  const slice = weeks.length > RECENT_WEEK_LIMIT ? weeks.slice(-RECENT_WEEK_LIMIT) : weeks;
  return slice.slice().reverse();
}

/** Same sign rule as the ledger's net-burn cells. */
export function formatNetBurn(cents: Cents): string {
  return cents < 0 ? formatSignedUsd(cents) : formatUsdWhole(cents);
}

/**
 * Weekly operating outflow vs inflow vs net burn, from `DerivedDemoObject.weeks`.
 * Wired to whatever `useDerived` last returned — a clock tick that replaces
 * that object updates the series in place (stale-while-revalidate).
 */
export function WeeklyCashPanel({ weeks }: { weeks: WeeklyBucket[] }) {
  if (weeks.length === 0) {
    return (
      <section
        aria-label="Weekly operating cash"
        className="rounded-2xl border border-neutral-200/80 bg-white p-5 shadow-sm sm:p-6"
      >
        <h2 className="text-sm font-medium text-neutral-900">Weekly operating cash</h2>
        <p className="mt-2 text-sm text-neutral-500">
          No weekly buckets in this derived object. Outflow, inflow and net burn appear here once
          the pipeline has a week of history.
        </p>
      </section>
    );
  }

  const rows = toCashFlowRows(weeks);
  const recent = recentWeeks(weeks);
  const first = weeks[0]!;
  const last = weeks[weeks.length - 1]!;

  return (
    <section
      aria-label="Weekly operating cash"
      className="rounded-2xl border border-neutral-200/80 bg-white p-5 shadow-sm sm:p-6"
    >
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-neutral-900">Weekly operating cash</h2>
          <p className="mt-1 text-xs text-neutral-500">
            {weeks.length} weeks · {formatWeekLabel(first.week_start)} – {formatWeekLabel(last.week_end)}
          </p>
        </div>
        <Link
          to="/ledger"
          className="text-xs font-medium text-neutral-900 underline-offset-4 hover:underline"
        >
          Full ledger →
        </Link>
      </header>

      <p className="sr-only">
        {weeks.length} weeks of operating outflow, operating inflow, and net burn from the week of{" "}
        {formatWeekLabel(first.week_start)} to the week of {formatWeekLabel(last.week_start)}. Net
        burn is the engine field, not a flipped profit figure.
      </p>

      {weeks.length >= 2 ? (
        <figure className="mt-4 m-0">
          <figcaption className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-500">
            <LegendSwatch color={CHART.outflow} label="Outflow" />
            <LegendSwatch color={CHART.inflow} label="Inflow" />
            <LegendSwatch color={CHART.accent} label="Net burn" />
          </figcaption>
          <div className="h-64 w-full sm:h-72">
            <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={200}>
              <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: CHART.axis, fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: CHART.grid }}
                  interval="preserveStartEnd"
                  minTickGap={16}
                />
                <YAxis
                  tickFormatter={(value: number) => formatUsdCompact(value)}
                  tick={{ fill: CHART.axis, fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={56}
                />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(value: unknown, name: unknown) => [
                    name === "net_burn_cents"
                      ? formatNetBurn(Number(value))
                      : formatUsdWhole(Number(value)),
                    name === "outflow_cents"
                      ? "Outflow"
                      : name === "inflow_cents"
                        ? "Inflow"
                        : "Net burn",
                  ]}
                  labelFormatter={(label: unknown) => `Week of ${String(label)}`}
                />
                <Area
                  type="monotone"
                  dataKey="outflow_cents"
                  stroke={CHART.outflow}
                  strokeWidth={1.5}
                  fill={CHART.outflowWash}
                  fillOpacity={0.9}
                  isAnimationActive={false}
                />
                <Area
                  type="monotone"
                  dataKey="inflow_cents"
                  stroke={CHART.inflow}
                  strokeWidth={1.5}
                  fill={CHART.inflowWash}
                  fillOpacity={0.55}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="net_burn_cents"
                  stroke={CHART.accent}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </figure>
      ) : (
        <p className="mt-3 text-sm text-neutral-500">
          One week on file — a chart needs two. The table below is the week the pipeline has.
        </p>
      )}

      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[28rem] text-left text-sm">
          <caption className="mb-2 text-left text-xs text-neutral-500">
            Newest {recent.length === 1 ? "week" : `${recent.length} weeks`} · newest first
          </caption>
          <thead>
            <tr className="border-b border-neutral-200 text-xs font-medium uppercase tracking-wide text-neutral-500">
              <th scope="col" className="pb-2 pr-3 font-medium">
                Week
              </th>
              <th scope="col" className="pb-2 pr-3 text-right font-medium">
                Outflow
              </th>
              <th scope="col" className="pb-2 pr-3 text-right font-medium">
                Inflow
              </th>
              <th scope="col" className="pb-2 text-right font-medium">
                Net burn
              </th>
            </tr>
          </thead>
          <tbody>
            {recent.map((week) => (
              <tr key={week.week_start} className="border-b border-neutral-100 last:border-0">
                <th scope="row" className="py-2 pr-3 font-medium text-neutral-900">
                  {formatWeekLabel(week.week_start)}
                </th>
                <td className="py-2 pr-3 text-right tabular-nums text-neutral-800">
                  {formatUsdWhole(week.total_operating_outflow_cents)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-neutral-800">
                  {formatUsdWhole(week.operating_inflow_cents)}
                </td>
                <td className="py-2 text-right tabular-nums text-neutral-800">
                  {formatNetBurn(week.net_burn_cents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
      {label}
    </span>
  );
}
