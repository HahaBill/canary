/**
 * One-sided upward CUSUM on calendar-week variable spend (PRD §13, contract §6).
 *
 * The series is `weeks[i].variable_spend_cents`, which the engine has already
 * stripped of fixed categories and of anything tagged `one_off` /
 * `annual_renewal` — so a single winsorized shock cannot produce an alarm here.
 *
 * ── WHY THE BASELINE IS A TREND, NOT A MEDIAN ───────────────────────────────
 * A growing company outspends a flat baseline every week, forever. Measured
 * against a median, its statistic climbs from the first quarter onward and
 * alarms on the growth itself: Canary would tell a founder their spending
 * pattern had shifted when the company is simply getting bigger as planned. At
 * 3%/month on the demo's own numbers that false alarm lands around week 15 and
 * never goes away.
 *
 * So each week is compared against the trend the baseline established, not
 * against its median. Growth that was already there is expected and produces no
 * signal; a DEPARTURE from it still does. A flat company yields a zero slope and
 * behaves exactly as a level CUSUM, so nothing is lost on a business that is
 * not growing.
 *
 * The slope is estimated over a longer window than σ (`trend_window_fraction`),
 * because eight weeks cannot separate 0.7%/week growth from 7% weekly noise.
 * A slope too small to distinguish from noise is treated as flat rather than
 * extrapolated — projecting a noise-driven slope across a year is how a
 * detrending detector goes blind.
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
  if (n < baselineWeeks) return notFired(config, n, series.map(() => 0), 0, 0, 0, 0, 0);

  const baseline = series.slice(0, baselineWeeks);
  const mu0 = median(baseline);

  // The line the series is judged against. Estimated over a longer window than
  // sigma, because a slow trend cannot be separated from noise in eight weeks.
  const trendWeeks = Math.max(baselineWeeks, Math.floor(n * config.trend_window_fraction));
  const trend = estimateBaselineTrend(series, trendWeeks, config.trend_significance_z);

  // Residuals are RELATIVE to the expected level, then expressed back in
  // baseline-scale cents so every reported figure is still money. Relative is
  // what keeps a growing company's later, larger weeks from clearing a σ that
  // was measured when the company was smaller.
  const residuals = series.map((value, i) => {
    const expected = trend.at(i);
    return expected > 0 ? ((value - expected) / expected) * mu0 : value - mu0;
  });
  const sigma = Math.max(MAD_TO_SIGMA * mad(residuals.slice(0, baselineWeeks)), config.sigma_floor_fraction * mu0);

  // A zero sigma means the baseline weeks carry no spend at all (median 0 and no
  // dispersion), so there is no rate to deviate from. Refuse rather than alarm
  // on the first dollar.
  if (sigma <= 0) return notFired(config, baselineWeeks, series.map(() => 0), mu0, 0, 0, 0, 0);

  const k = config.k_factor * sigma;
  const h = config.h_multiplier * sigma;

  // S_0 = 0 before week 0; S_i = max(0, S_{i-1} + (x_i - mu0) - k). The statistic
  // keeps running after the alarm (no reset) so the chart stays continuous;
  // re-baselining is a decision for callers, not a second alarm.
  const statistic: number[] = [];
  let s = 0;
  let alarmIndex: number | null = null;
  for (let i = 0; i < n; i++) {
    s = Math.max(0, s + residuals[i]! - k);
    statistic.push(s);
    if (alarmIndex === null && s > h) alarmIndex = i;
  }
  const statisticCents = statistic.map((v) => Math.round(v));

  if (alarmIndex === null) {
    return notFired(config, baselineWeeks, statisticCents, mu0, sigma, k, h, mu0 * Math.expm1(trend.growth_per_week));
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
    baseline_slope_weekly_cents: Math.round(mu0 * Math.expm1(trend.growth_per_week)),
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
    trend_window_fraction: override?.trend_window_fraction ?? CUSUM_DEFAULTS.trend_window_fraction,
    trend_significance_z: override?.trend_significance_z ?? CUSUM_DEFAULTS.trend_significance_z,
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
  slope: number,
): CusumResult {
  return {
    fired: false,
    config,
    baseline_weeks: baselineWeeks,
    baseline_median_cents: Math.round(mu0),
    baseline_slope_weekly_cents: Math.round(slope),
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

/**
 * Theil–Sen slope: the median of the slopes between every pair of points.
 * Chosen over least squares because a single unusual week must not be able to
 * tilt the line the whole series is then judged against.
 */
export function theilSenSlope(values: number[]): number {
  if (values.length < 2) return 0;
  const slopes: number[] = [];
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) slopes.push((values[j]! - values[i]!) / (j - i));
  }
  return median(slopes);
}

export interface BaselineTrend {
  /** Growth per week in log units. 0 when flat, or too noisy to tell. */
  growth_per_week: number;
  /** Expected level at week index `i`. */
  at: (i: number) => number;
}

/**
 * The curve the rest of the series is measured against, fitted MULTIPLICATIVELY.
 *
 * Growth compounds, so a straight line is the wrong shape: fit one to a company
 * growing a steady few percent a month and it falls behind in the tail, leaving
 * a rising residual that a change detector is built to catch. Worse, absolute
 * week-to-week variation grows with the level, so a σ measured early is too
 * small later and ordinary noise starts clearing the threshold.
 *
 * Fitting in log space removes all three problems at once: constant percentage
 * growth is a straight line, residuals are relative, and their spread is stable
 * as the company grows.
 *
 * `trendWeeks` is longer than the σ window because the standard error of a slope
 * falls off as the window length to the power of one and a half. Eight weeks
 * cannot separate 0.7%/week growth from 7% weekly noise.
 */
export function estimateBaselineTrend(series: number[], trendWeeks: number, z: number): BaselineTrend {
  const window = series.slice(0, Math.max(2, Math.min(trendWeeks, series.length)));
  // Growth is a ratio, and a ratio needs something positive to grow from. A
  // baseline with an empty or credit week is treated as flat rather than
  // modelled — refusing is safer than inventing a growth rate.
  if (window.length < 2 || window.some((value) => value <= 0)) {
    const level = window.length > 0 ? median(window) : 0;
    return { growth_per_week: 0, at: () => level };
  }

  const logs = window.map((value) => Math.log(value));
  const rawGrowth = theilSenSlope(logs);
  const rawIntercept = median(logs.map((value, i) => value - rawGrowth * i));
  const spread = MAD_TO_SIGMA * mad(logs.map((value, i) => value - (rawIntercept + rawGrowth * i)));

  // Standard error of a slope over `m` evenly spaced points, which falls off as
  // m^1.5. A slope mistaken for real gets extrapolated across the whole series,
  // bending the curve every later week is judged against, so the bar is high.
  const m = window.length;
  const standardError = spread * Math.sqrt(12 / (m * (m * m - 1)));
  const believable = standardError === 0 ? rawGrowth !== 0 : Math.abs(rawGrowth) >= z * standardError;

  const growth = believable ? rawGrowth : 0;
  const intercept = believable ? rawIntercept : median(logs);
  return { growth_per_week: growth, at: (i: number) => Math.exp(intercept + growth * i) };
}

