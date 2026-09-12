/**
 * One-sided upward CUSUM on calendar-week variable spend (PRD §13, contract §6).
 *
 * The series is `weeks[i].variable_spend_cents`, which the engine has already
 * stripped of fixed categories and of anything tagged `one_off` /
 * `annual_renewal` — so a single winsorized shock cannot produce an alarm here.
 *
 * CHANGE POINT CONVENTION (read this before touching anything downstream):
 *   `estimated_change_point_index` is the LAST index before the alarm at which
 *   the statistic was zero, i.e. the last week that still belongs to the OLD
 *   regime. The NEW regime therefore starts at `index + 1`, and
 *   `estimated_change_point_week_start` is the week_start of that first
 *   post-change week — the date a user sees and the value the engine wants as
 *   `regimeStartWeekIndex`. The index and the date are deliberately one week
 *   apart. When the statistic never returned to zero before the alarm the
 *   index is -1, meaning the elevated regime covers the whole series.
 */
import {
  CUSUM_DEFAULTS,
  MAD_TO_SIGMA,
  mad,
  median,
  type Cents,
  type CusumConfig,
  type CusumResult,
  type RunCusum,
  type WeeklyBucket,
} from "@canary/shared";

/** `estimated_change_point_index` when the statistic never hit zero before the alarm. */
export const NO_PRE_CHANGE_SEGMENT = -1;

export const runCusum: RunCusum = (weeks: WeeklyBucket[], configOverride?: Partial<CusumConfig>): CusumResult => {
  const config = resolveConfig(configOverride);
  const series = weeks.map((w) => w.variable_spend_cents);
  const n = series.length;
  const baselineWeeks = Math.max(1, Math.floor(config.min_baseline_weeks));

  // Not enough history to establish a baseline. The baseline is always the FIRST
  // `min_baseline_weeks` weeks, never a trailing window, so a shift that begins
  // mid-series can never contaminate it.
  if (n < baselineWeeks) return notFired(config, n, series.map(() => 0), 0, 0, 0, 0);

  const baseline = series.slice(0, baselineWeeks);
  const mu0 = median(baseline);
  const sigma = Math.max(MAD_TO_SIGMA * mad(baseline), config.sigma_floor_fraction * mu0);

  // A zero sigma means the baseline weeks carry no spend at all (median 0 and no
  // dispersion), so there is no rate to deviate from. Refuse rather than alarm
  // on the first dollar.
  if (sigma <= 0) return notFired(config, baselineWeeks, series.map(() => 0), mu0, 0, 0, 0);

  const k = config.k_factor * sigma;
  const h = config.h_multiplier * sigma;

  // S_0 = 0 before week 0; S_i = max(0, S_{i-1} + (x_i - mu0) - k). The statistic
  // keeps running after the alarm (no reset) so the chart stays continuous;
  // re-baselining is a decision for callers, not a second alarm.
  const statistic: number[] = [];
  let s = 0;
  let alarmIndex: number | null = null;
  for (let i = 0; i < n; i++) {
    s = Math.max(0, s + (series[i]! - mu0) - k);
    statistic.push(s);
    if (alarmIndex === null && s > h) alarmIndex = i;
  }
  const statisticCents = statistic.map((v) => Math.round(v));

  if (alarmIndex === null) {
    return notFired(config, baselineWeeks, statisticCents, mu0, sigma, k, h);
  }

  const changePointIndex = lastZeroBefore(statistic, alarmIndex);
  const regimeStart = changePointIndex + 1;
  const preSegment = series.slice(0, regimeStart);
  const postSegment = series.slice(regimeStart);

  // `regimeStart <= alarmIndex <= n - 1`, so the post segment always has at
  // least one week. The pre segment is empty only in the -1 case above, where a
  // pre-change rate (and therefore a delta) is genuinely unknown.
  const preRate = preSegment.length > 0 ? Math.round(mean(preSegment)) : null;
  const postRate = Math.round(mean(postSegment));

  return {
    fired: true,
    config,
    baseline_weeks: baselineWeeks,
    baseline_median_cents: Math.round(mu0),
    sigma_cents: Math.round(sigma),
    k_cents: Math.round(k),
    h_cents: Math.round(h),
    statistic_cents: statisticCents,
    alarm_week_index: alarmIndex,
    alarm_week_start: weeks[alarmIndex]!.week_start,
    estimated_change_point_index: changePointIndex,
    estimated_change_point_week_start: weeks[regimeStart]!.week_start,
    pre_change_rate_weekly_cents: preRate,
    post_change_rate_weekly_cents: postRate,
    delta_weekly_cents: preRate === null ? null : postRate - preRate,
    detection_lag_weeks: alarmIndex - regimeStart,
    post_change_weeks: n - regimeStart,
  };
};

/** Number of weeks in the pre-change segment implied by a fired result. */
export function regimeStartIndex(cusum: CusumResult): number | null {
  return cusum.estimated_change_point_index === null ? null : cusum.estimated_change_point_index + 1;
}

/**
 * Simple exponential smoothing. VISUALIZATION ONLY — never a detector (PRD §13).
 * `out[0] = values[0]`, `out[i] = alpha * values[i] + (1 - alpha) * out[i - 1]`.
 */
export function ewma(values: number[], alpha: number): number[] {
  if (!(alpha > 0 && alpha <= 1)) throw new Error(`ewma alpha must be in (0, 1], got ${alpha}`);
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < values.length; i++) {
    const x = values[i]!;
    prev = i === 0 ? x : alpha * x + (1 - alpha) * prev;
    out.push(Math.round(prev));
  }
  return out;
}

function resolveConfig(override?: Partial<CusumConfig>): CusumConfig {
  return {
    k_factor: override?.k_factor ?? CUSUM_DEFAULTS.k_factor,
    h_multiplier: override?.h_multiplier ?? CUSUM_DEFAULTS.h_multiplier,
    min_baseline_weeks: override?.min_baseline_weeks ?? CUSUM_DEFAULTS.min_baseline_weeks,
    sigma_floor_fraction: override?.sigma_floor_fraction ?? CUSUM_DEFAULTS.sigma_floor_fraction,
  };
}

function notFired(
  config: CusumConfig,
  baselineWeeks: number,
  statisticCents: Cents[],
  mu0: number,
  sigma: number,
  k: number,
  h: number,
): CusumResult {
  return {
    fired: false,
    config,
    baseline_weeks: baselineWeeks,
    baseline_median_cents: Math.round(mu0),
    sigma_cents: Math.round(sigma),
    k_cents: Math.round(k),
    h_cents: Math.round(h),
    statistic_cents: statisticCents,
    alarm_week_index: null,
    alarm_week_start: null,
    estimated_change_point_index: null,
    estimated_change_point_week_start: null,
    pre_change_rate_weekly_cents: null,
    post_change_rate_weekly_cents: null,
    delta_weekly_cents: null,
    detection_lag_weeks: null,
    post_change_weeks: null,
  };
}

/** Last index strictly before `alarmIndex` where the statistic was exactly zero, else -1. */
function lastZeroBefore(statistic: number[], alarmIndex: number): number {
  for (let i = alarmIndex - 1; i >= 0; i--) {
    if (statistic[i] === 0) return i;
  }
  return NO_PRE_CHANGE_SEGMENT;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}
