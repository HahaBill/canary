/**
 * Reference one-sided upward CUSUM — GENERATOR SELF-VERIFICATION ONLY.
 *
 * @canary/detectors owns the real implementation. This is a small independent copy of the
 * contract in docs/PRD.md §13 / docs/DATA_AND_DETECTOR_CONTRACT.md §6 so the generator can
 * prove, offline and with no cross-package dependency, that its planted shift is detectable
 * with the configured parameters. Not exported from the package entry point.
 */
import { CUSUM_DEFAULTS, MAD_TO_SIGMA, mad, median, type Cents, type CusumConfig } from "@canary/shared";

export interface ReferenceCusum {
  fired: boolean;
  baseline_median_cents: Cents;
  sigma_cents: number;
  k_cents: number;
  h_cents: number;
  statistic_cents: number[];
  alarm_week_index: number | null;
  /** Last index before the alarm where the statistic was 0. The new regime starts at +1. */
  estimated_change_point_index: number | null;
  regime_start_index: number | null;
  detection_lag_weeks: number | null;
}

export function referenceCusum(series: Cents[], config: Partial<CusumConfig> = {}): ReferenceCusum {
  const cfg: CusumConfig = { ...CUSUM_DEFAULTS, ...config };
  const baseline = series.slice(0, Math.min(cfg.min_baseline_weeks, series.length));
  const mu0 = median(baseline);
  const sigma = Math.max(MAD_TO_SIGMA * mad(baseline), cfg.sigma_floor_fraction * mu0);
  const k = cfg.k_factor * sigma;
  const h = cfg.h_multiplier * sigma;

  const statistic: number[] = [];
  let s = 0;
  let alarm: number | null = null;
  for (const [i, x] of series.entries()) {
    s = Math.max(0, s + (x - mu0) - k);
    statistic.push(s);
    if (alarm === null && s > h) alarm = i;
  }

  let changePoint: number | null = null;
  if (alarm !== null) {
    for (let j = alarm - 1; j >= 0; j--) {
      if (statistic[j] === 0) {
        changePoint = j;
        break;
      }
    }
    // A statistic that never returned to zero means the regime started at the series start.
    if (changePoint === null) changePoint = -1;
  }

  return {
    fired: alarm !== null,
    baseline_median_cents: mu0,
    sigma_cents: sigma,
    k_cents: k,
    h_cents: h,
    statistic_cents: statistic,
    alarm_week_index: alarm,
    estimated_change_point_index: changePoint,
    regime_start_index: changePoint === null ? null : changePoint + 1,
    detection_lag_weeks: alarm === null || changePoint === null ? null : alarm - (changePoint + 1),
  };
}
