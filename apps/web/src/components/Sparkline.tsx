import type { ISODate, WeeklyBucket } from "@canary/shared";
import { CHART } from "@/lib/chart.ts";

const PAD_X = 3;
const PAD_Y = 5;

/**
 * Index of the week the change point falls in. Exact `week_start` match first,
 * then the first week at or after it — a change point mid-week still belongs to
 * the bucket that contains it. ISO dates compare correctly as strings.
 */
export function changePointIndex(weeks: WeeklyBucket[], changePoint: ISODate | null): number {
  if (!changePoint) return -1;
  const exact = weeks.findIndex((w) => w.week_start === changePoint);
  if (exact !== -1) return exact;
  return weeks.findIndex((w) => w.week_start >= changePoint);
}

/**
 * Thumbnail of weekly variable spend for the incident card: the full series,
 * the post-change weeks tinted, and a marker where the change point landed.
 * Pure SVG scaling of engine figures — no aggregation, no money arithmetic.
 * `label` is supplied by the caller so the description is built from the same
 * formatted rates the card already shows.
 */
export function Sparkline({
  weeks,
  changePoint,
  label,
  width = 220,
  height = 48,
  className,
}: {
  weeks: WeeklyBucket[];
  changePoint: ISODate | null;
  label: string;
  width?: number;
  height?: number;
  className?: string;
}) {
  if (weeks.length < 2) return null;

  const values = weeks.map((w) => w.variable_spend_cents);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat series would divide by zero; draw it down the middle instead.
  const span = max - min || 1;
  const stepX = (width - PAD_X * 2) / (weeks.length - 1);
  const plotHeight = height - PAD_Y * 2;

  const x = (index: number) => PAD_X + index * stepX;
  const y = (value: number) => PAD_Y + (1 - (value - min) / span) * plotHeight;

  const path = values.map((value, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(value).toFixed(2)}`).join(" ");

  const changeIndex = changePointIndex(weeks, changePoint);
  const marked = changeIndex > 0 && changeIndex < weeks.length;
  const changeX = marked ? x(changeIndex) : 0;

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      className={className}
    >
      {marked ? (
        <>
          <rect x={changeX} y={0} width={width - changeX} height={height} fill={CHART.accentWash} />
          <line
            x1={changeX}
            y1={0}
            x2={changeX}
            y2={height}
            stroke={CHART.muted}
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        </>
      ) : null}

      <path d={path} fill="none" stroke={CHART.accent} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />

      {marked ? <circle cx={changeX} cy={y(values[changeIndex]!)} r={2.75} fill={CHART.accent} /> : null}
    </svg>
  );
}
