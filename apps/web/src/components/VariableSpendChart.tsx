import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Cents, ISODate, WeeklyBucket } from "@canary/shared";
import { CHART, TOOLTIP_STYLE } from "@/lib/chart.ts";
import { formatUsdCompact, formatUsdWhole, formatWeekLabel } from "@/lib/format.ts";
import { cn } from "@/lib/utils.ts";

/**
 * Weekly variable spend with the estimated change point marked and every week
 * from it onward shaded — the "what changed, and when" picture.
 */
export function VariableSpendChart({
  weeks,
  changePoint,
  ewma,
}: {
  weeks: WeeklyBucket[];
  changePoint: ISODate | null;
  ewma?: Cents[];
}) {
  const hasEwma = Array.isArray(ewma) && ewma.length === weeks.length && weeks.length > 0;
  const [showEwma, setShowEwma] = useState(false);

  const data = weeks.map((w, i) => ({
    label: formatWeekLabel(w.week_start),
    variable: w.variable_spend_cents,
    ewma: hasEwma ? ewma[i] : undefined,
  }));

  const changeLabel = changePoint ? formatWeekLabel(changePoint) : null;
  const lastLabel = data[data.length - 1]?.label ?? null;
  const shadePostChange = changeLabel !== null && lastLabel !== null && changeLabel !== lastLabel;

  return (
    <figure className="m-0">
      <figcaption className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-neutral-900">Weekly variable spend</span>
        {hasEwma ? (
          <button
            type="button"
            aria-pressed={showEwma}
            onClick={() => setShowEwma((v) => !v)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
              showEwma
                ? "border-neutral-300 bg-neutral-100 text-neutral-900"
                : "border-neutral-200 text-neutral-500 hover:text-neutral-800",
            )}
          >
            EWMA overlay
          </button>
        ) : null}
      </figcaption>

      <p className="sr-only">
        {weeks.length} weeks of variable spend
        {changePoint ? `, with the estimated change point at the week of ${formatWeekLabel(changePoint)}` : ""}.
      </p>

      <div className="h-64 w-full sm:h-72">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
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
                formatUsdWhole(Number(value)),
                name === "ewma" ? "EWMA" : "Variable spend",
              ]}
              labelFormatter={(label: unknown) => `Week of ${String(label)}`}
            />

            {shadePostChange ? (
              <ReferenceArea x1={changeLabel} x2={lastLabel} fill={CHART.accentWash} fillOpacity={0.7} />
            ) : null}
            {changeLabel ? (
              <ReferenceLine
                x={changeLabel}
                stroke={CHART.muted}
                strokeDasharray="4 4"
                label={{ value: "change point", position: "insideTopLeft", fill: CHART.axis, fontSize: 11 }}
              />
            ) : null}

            <Line
              type="monotone"
              dataKey="variable"
              stroke={CHART.accent}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
            {hasEwma && showEwma ? (
              <Line
                type="monotone"
                dataKey="ewma"
                stroke={CHART.muted}
                strokeWidth={1.5}
                strokeDasharray="5 4"
                dot={false}
                isAnimationActive={false}
              />
            ) : null}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
