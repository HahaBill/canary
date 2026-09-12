import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Cents, WeeklyBucket } from "@canary/shared";
import { CHART, TOOLTIP_STYLE } from "@/lib/chart.ts";
import { formatUsdCompact, formatUsdWhole, formatWeekLabel } from "@/lib/format.ts";

/**
 * The CUSUM statistic that raised the alarm. It keeps accumulating after the
 * alarm (no reset), so the curve shows how far past the threshold it ran.
 */
export function CusumChart({
  weeks,
  statistic,
  thresholdCents,
}: {
  weeks: WeeklyBucket[];
  statistic: Cents[];
  thresholdCents?: Cents | null;
}) {
  const data = weeks.map((w, i) => ({
    label: formatWeekLabel(w.week_start),
    statistic: statistic[i] ?? 0,
  }));

  return (
    <figure className="m-0">
      <figcaption className="mb-3 text-sm font-medium text-neutral-900">CUSUM statistic</figcaption>

      <div className="h-40 w-full sm:h-44">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: CHART.axis, fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: CHART.grid }}
              interval="preserveStartEnd"
              minTickGap={24}
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
              formatter={(value: unknown) => [formatUsdWhole(Number(value)), "Statistic"]}
              labelFormatter={(label: unknown) => `Week of ${String(label)}`}
            />
            {thresholdCents != null ? (
              <ReferenceLine
                y={thresholdCents}
                stroke={CHART.threshold}
                strokeDasharray="4 4"
                label={{
                  value: `alarm threshold ${formatUsdCompact(thresholdCents)}`,
                  position: "insideTopRight",
                  fill: CHART.axis,
                  fontSize: 11,
                }}
              />
            ) : null}
            <Area
              type="monotone"
              dataKey="statistic"
              stroke={CHART.accent}
              strokeWidth={1.5}
              fill={CHART.accentWash}
              fillOpacity={0.9}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
