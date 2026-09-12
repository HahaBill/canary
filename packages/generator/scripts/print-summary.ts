/**
 * Prints the demo fixture the way the integrator needs to see it.
 *
 *   node --experimental-strip-types packages/generator/scripts/print-summary.ts
 *   node --experimental-strip-types packages/generator/scripts/print-summary.ts --profile test
 *
 * Everything here is read out of generator output; nothing is hand-typed.
 */
import {
  DEMO,
  FIXED_CATEGORIES,
  VARIABLE_CATEGORIES,
  WEEKS_PER_MONTH,
  formatUsd,
  formatUsdWhole,
  runwayMonths,
  weekStartsEndingAt,
  weeklyToMonthly,
  type Category,
  type Transaction,
} from "@canary/shared";
import { referenceCusum } from "../src/cusum.testkit.ts";
import { DEFAULT_DEMO_OPTIONS, generateDemoCompany, summarizeWeeklyVariableSpend } from "../src/index.ts";

const profile = process.argv.includes("--profile") ? process.argv[process.argv.indexOf("--profile") + 1] : "demo";
const seed = profile === "test" ? DEMO.TEST_SEED : DEMO.SEED;
const gen = generateDemoCompany({ ...DEFAULT_DEMO_OPTIONS, seed, profile: profile === "test" ? "test" : "demo" });
const { transactions, fixture } = gen;
const starts = weekStartsEndingAt(fixture.end_date, fixture.weeks);
const change = fixture.burn_shift.true_change_start_index;

const series = summarizeWeeklyVariableSpend(transactions, {
  historyStart: fixture.start_date,
  weeks: fixture.weeks,
  excludeIds: [fixture.one_off.transaction_id],
});

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const superseded = new Set(transactions.filter((t) => t.pending_of).map((t) => t.pending_of!));
const live = transactions.filter((t) => !superseded.has(t.id));
const cardIds = new Set(gen.accounts.filter((a) => a.type === "card").map((a) => a.id));
const weekOf = (t: Transaction): number => starts.findIndex((s, i) => t.date >= s && (i === starts.length - 1 || t.date < starts[i + 1]!));

const bucket = (predicate: (t: Transaction) => boolean): number[] => {
  const out = new Array<number>(fixture.weeks).fill(0);
  for (const t of live.filter(predicate)) {
    const i = weekOf(t);
    if (i >= 0) out[i] = out[i]! - t.amount_cents;
  }
  return out;
};
const isFixed = (t: Transaction): boolean =>
  t.flow_type === "OPERATING_OUTFLOW" && FIXED_CATEGORIES.includes(t.category_hint as Category);
const isVariableOrExcluded = (t: Transaction): boolean =>
  (t.flow_type === "OPERATING_OUTFLOW" || t.flow_type === "REFUND") && !isFixed(t);

const fixedSeries = bucket(isFixed);
const grossSeries = bucket((t) => isFixed(t) || isVariableOrExcluded(t));
const inflowSeries = bucket((t) => t.flow_type === "OPERATING_INFLOW").map((v) => -v);
const awsSeries = bucket((t) => t.merchant_normalized === "aws");

// ── weekly variable spend ────────────────────────────────────────────────────
console.log(`\nCanary generator — profile=${fixture.profile} seed=${fixture.seed}`);
console.log(`history ${fixture.start_date} → ${fixture.end_date} (${fixture.weeks} complete Mon–Sun weeks)`);
console.log(`\nweek  start        variable      aws        fixed      inflow   marker`);
for (let i = 0; i < fixture.weeks; i++) {
  const marker = i === change ? "◀ change starts" : i === fixture.weeks - 1 ? "◀ last week" : "";
  const oneOffHere = weekOf(transactions.find((t) => t.id === fixture.one_off.transaction_id)!) === i ? " + one-off" : "";
  console.log(
    `${String(i).padStart(3)}   ${starts[i]}  ${formatUsdWhole(series[i]!).padStart(10)} ` +
      `${formatUsdWhole(awsSeries[i]!).padStart(10)} ${formatUsdWhole(fixedSeries[i]!).padStart(10)} ` +
      `${formatUsdWhole(inflowSeries[i]!).padStart(10)}   ${marker}${oneOffHere}`,
  );
}

// ── CUSUM on the generator's own series ─────────────────────────────────────
const cusum = referenceCusum(series);
const preMean = mean(series.slice(0, change));
const postMean = mean(series.slice(change));
const rampedMean = mean(series.slice(change + DEMO.CHANGE_RAMP_WEEKS - 1));
console.log(`\nCUSUM (k=0.5σ, h=4σ, baseline = first 8 weeks)`);
console.log(`  baseline median      ${formatUsd(cusum.baseline_median_cents)}`);
console.log(`  sigma                ${formatUsd(Math.round(cusum.sigma_cents))}`);
console.log(`  k / h                ${formatUsd(Math.round(cusum.k_cents))} / ${formatUsd(Math.round(cusum.h_cents))}`);
console.log(`  planted delta        ${formatUsd(fixture.burn_shift.planted_delta_weekly_cents)}/wk` +
  `  (= ${(fixture.burn_shift.planted_delta_weekly_cents / cusum.sigma_cents).toFixed(2)}σ)`);
console.log(`  alarm week           ${cusum.alarm_week_index}  (${cusum.alarm_week_index === null ? "-" : starts[cusum.alarm_week_index]})`);
console.log(`  change point (last 0) ${cusum.estimated_change_point_index} → regime starts week ${cusum.regime_start_index}` +
  ` (true ${change})`);
console.log(`  detection lag        ${cusum.detection_lag_weeks} weeks`);
console.log(`  pre-change mean      ${formatUsd(Math.round(preMean))}/wk`);
console.log(`  post-change mean     ${formatUsd(Math.round(postMean))}/wk  (delta ${formatUsd(Math.round(postMean - preMean))})`);
console.log(`  fully-ramped mean    ${formatUsd(Math.round(rampedMean))}/wk  (delta ${formatUsd(Math.round(rampedMean - preMean))})`);
console.log(`  statistic            [${cusum.statistic_cents.map((s) => Math.round(s / 1000)).join(", ")}] (thousands of cents)`);

const preOnly = referenceCusum(series.slice(0, change));
console.log(`  pre-change weeks alone fired? ${preOnly.fired}`);

// ── contributors ────────────────────────────────────────────────────────────
const entities = [...new Set(live.filter((t) => VARIABLE_CATEGORIES.includes(t.category_hint as Category)).map((t) => t.merchant_normalized))];
const deltas = entities
  .map((e) => {
    const s = bucket((t) => t.merchant_normalized === e && t.id !== fixture.one_off.transaction_id);
    return { entity: e, delta: mean(s.slice(change)) - mean(s.slice(0, change)) };
  })
  .sort((a, b) => b.delta - a.delta);
console.log(`\ncontributors (weekly delta, post-change window vs pre-change)`);
for (const d of deltas) console.log(`  ${d.entity.padEnd(22)} ${formatUsdWhole(Math.round(d.delta)).padStart(10)}/wk`);

// ── balances and burn ───────────────────────────────────────────────────────
const preGross = mean(grossSeries.slice(0, change));
const preInflow = mean(inflowSeries.slice(0, change));
const postGross = mean(grossSeries.slice(change));
const postInflow = mean(inflowSeries.slice(change));
const cash = fixture.closing_balance_cents;
console.log(`\nbalances`);
console.log(`  opening (derived)    ${formatUsd(fixture.opening_balance_cents)}`);
console.log(`  closing (anchor)     ${formatUsd(fixture.closing_balance_cents)}`);
console.log(`  net cash movement    ${formatUsd(fixture.closing_balance_cents - fixture.opening_balance_cents)}`);
console.log(`  card balance at end  ${formatUsd(live.filter((t) => cardIds.has(t.account_id)).reduce((s, t) => s + t.amount_cents, 0))}`);
console.log(`\nburn (weeks/month = ${WEEKS_PER_MONTH.toFixed(4)})`);
console.log(`  pre-change  gross ${formatUsdWhole(weeklyToMonthly(Math.round(preGross)))}/mo  revenue ${formatUsdWhole(weeklyToMonthly(Math.round(preInflow)))}/mo` +
  `  net ${formatUsdWhole(weeklyToMonthly(Math.round(preGross - preInflow)))}/mo  runway ${runwayMonths(cash, weeklyToMonthly(Math.round(preGross - preInflow)))} mo`);
console.log(`  post-change gross ${formatUsdWhole(weeklyToMonthly(Math.round(postGross)))}/mo  revenue ${formatUsdWhole(weeklyToMonthly(Math.round(postInflow)))}/mo` +
  `  net ${formatUsdWhole(weeklyToMonthly(Math.round(postGross - postInflow)))}/mo  runway ${runwayMonths(cash, weeklyToMonthly(Math.round(postGross - postInflow)))} mo`);

// ── fixture metadata ────────────────────────────────────────────────────────
console.log(`\nfixture metadata`);
console.log(JSON.stringify(fixture, null, 2));
console.log(`\ntransactions: ${transactions.length}`);
