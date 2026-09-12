/**
 * Contract §15 assertions. Run: `npm run verify` from the repo root.
 * Exits non-zero if any assertion fails. Prints the derived demo numbers.
 */
import {
  CHANGE_POINT_TOLERANCE_WEEKS,
  CONTRIBUTOR_SUM_TOLERANCE,
  DEMO,
  MIN_PRIOR_VENDOR_PAYMENTS,
  formatMonths,
  formatSignedUsd,
  formatUsd,
  sandboxClosingCashCents,
  weekIndexOf,
} from "@canary/shared";
import { runPipeline } from "./run.ts";
import { loadDemoCaches } from "./caches.ts";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export async function verifyDemo(): Promise<{ checks: Check[]; ok: boolean }> {
  const caches = await loadDemoCaches();
  const { derived, ledger, generated } = await runPipeline({ includeFixture: true, ...caches });
  const fx = generated.fixture;
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

  // Closing balance
  add(
    "closing balance matches sandbox bank balance exactly",
    derived.reconciliation.matches && derived.reconciliation.reported_closing_balance_cents === sandboxClosingCashCents() && derived.reconciliation.opening_balance_cents === fx.opening_balance_cents,
    `reported=${formatUsd(derived.reconciliation.reported_closing_balance_cents)} computed=${formatUsd(derived.reconciliation.computed_closing_balance_cents)} opening(engine)=${formatUsd(derived.reconciliation.opening_balance_cents)} opening(fixture)=${formatUsd(fx.opening_balance_cents)}`,
  );

  // Internal transfer net spend = 0
  const transferLegs = ledger.transactions.filter((t) => t.flow_type === "INTERNAL_TRANSFER");
  add("internal transfer net spend = 0", transferLegs.length >= 2 && transferLegs.every((t) => !t.counts_in_burn) && derived.reconciliation.unpaired_transfer_legs === 0, `${transferLegs.length} legs, pairs=${derived.reconciliation.internal_transfer_pairs}`);

  // Card settlement not double counted
  add("card settlement not double counted", derived.reconciliation.card_settlements > 0 && derived.reconciliation.unpaired_settlements === 0 && ledger.transactions.filter((t) => t.flow_type === "CARD_SETTLEMENT").every((t) => !t.counts_in_burn), `settlements=${derived.reconciliation.card_settlements} covered=${derived.reconciliation.card_purchases_covered}`);

  // Pending dropped
  add("pending superseded rows dropped", derived.reconciliation.pending_rows_dropped === fx.pending_settled_pairs.length, `dropped=${derived.reconciliation.pending_rows_dropped} expected=${fx.pending_settled_pairs.length}`);

  // Financing excluded from burn (test profile has financing; demo may not)
  const financing = ledger.transactions.filter((t) => t.flow_type === "FINANCING");
  add("financing excluded from operating burn", financing.every((t) => !t.counts_in_burn && t.counts_in_cash), `${financing.length} financing rows`);

  // Needs review outflow included in burn
  const nr = ledger.transactions.filter((t) => !t.dropped && t.category === "NEEDS_REVIEW" && t.amount_cents < 0);
  add("Needs Review outflow included in burn", nr.every((t) => t.counts_in_burn), `${nr.length} rows, ${formatUsd(derived.needs_review.outflow_cents)}`);

  // One-off
  const oneOffInc = derived.one_off_incident;
  const oneOffDet = oneOffInc?.detection.one_off;
  add("one-off has ≥3 prior vendor payments", fx.one_off.prior_payment_count >= MIN_PRIOR_VENDOR_PAYMENTS && (oneOffDet?.prior_payment_count ?? 0) >= MIN_PRIOR_VENDOR_PAYMENTS, `fixture priors=${fx.one_off.prior_payment_count} detector priors=${oneOffDet?.prior_payment_count}`);
  add("one-off detector fires on planted payment", oneOffDet?.transaction_id === fx.one_off.transaction_id && oneOffDet.is_anomalous && oneOffInc?.materiality.material === true, `planted=${fx.one_off.transaction_id} detected=${oneOffDet?.transaction_id} ×median=${oneOffDet?.multiple_of_median?.toFixed(1)}`);

  // One-off excluded from CUSUM series
  const oneOffWeek = ledger.weeks[weekIndexOf(fx.one_off.transaction_id ? ledger.transactions.find((t) => t.id === fx.one_off.transaction_id)!.date : fx.end_date, fx.start_date)];
  add("one-off winsorized out of CUSUM series", (oneOffWeek?.excluded_from_monitoring_cents ?? 0) >= fx.one_off.amount_cents, `excluded in week ${oneOffWeek?.week_start}: ${formatUsd(oneOffWeek?.excluded_from_monitoring_cents ?? 0)}`);

  // CUSUM
  const cusum = derived.primary_incident?.detection.cusum;
  add("CUSUM fires before final week", !!cusum?.fired && (cusum.alarm_week_index ?? 99) < ledger.weeks.length - 1, `alarm_week=${cusum?.alarm_week_index} of ${ledger.weeks.length}`);
  const regimeStart = cusum?.estimated_change_point_index !== null && cusum?.estimated_change_point_index !== undefined ? cusum.estimated_change_point_index + 1 : null;
  add("estimated change point within tolerance of planted start", regimeStart !== null && Math.abs(regimeStart - fx.burn_shift.true_change_start_index) <= CHANGE_POINT_TOLERANCE_WEEKS, `estimated regime start=${regimeStart} true=${fx.burn_shift.true_change_start_index} tol=±${CHANGE_POINT_TOLERANCE_WEEKS}`);
  add("CUSUM does not fire on pre-change weeks alone", (() => {
    if (!cusum) return false;
    // statistic must stay ≤ h through the week before the true change start
    return cusum.statistic_cents.slice(0, fx.burn_shift.true_change_start_index).every((s) => s <= cusum.h_cents);
  })());

  // Burn window
  add("post-change burn window is representative", derived.burn.burn_window_reason === "POST_CHANGE_SEGMENT" && regimeStart !== null && derived.burn.burn_window_start === ledger.weeks[regimeStart]?.week_start, `reason=${derived.burn.burn_window_reason} window=${derived.burn.burn_window_start}..${derived.burn.burn_window_end}`);

  // Contributors
  const contribs = derived.primary_incident?.contributors ?? [];
  const sum = contribs.reduce((s, c) => s + c.delta_weekly_cents, 0);
  const total = cusum?.delta_weekly_cents ?? 0;
  add("contributor deltas sum to total delta within tolerance", total !== 0 && Math.abs(sum - total) <= Math.max(Math.abs(total) * CONTRIBUTOR_SUM_TOLERANCE, contribs.length), `Σ=${formatSignedUsd(sum)} total=${formatSignedUsd(total)}`);
  add("primary driver is the planted driver", derived.primary_incident?.entity === DEMO.PRIMARY_DRIVER_ENTITY && fx.burn_shift.expected_driver_entities[0] === DEMO.PRIMARY_DRIVER_ENTITY, `entity=${derived.primary_incident?.entity}`);

  // Dedup
  const rerun = await runPipeline({ includeFixture: true, ...caches, existingIncidents: derived.incidents, now: "2026-09-14T12:00:00.000Z" });
  add("incident dedup prevents duplicates", rerun.derived.incidents.length === derived.incidents.length && rerun.derived.incidents.every((i) => derived.incidents.some((j) => j.id === i.id)), `before=${derived.incidents.length} after=${rerun.derived.incidents.length}`);

  // Tavily
  const enr = derived.vendor_enrichments.find((e) => e.merchant_normalized === DEMO.UNKNOWN_VENDOR.merchant_normalized);
  add("Tavily vendor result is cached and cited", !!enr && /^https?:\/\//.test(enr.source_url) && !/PLACEHOLDER|example\.invalid/i.test(enr.source_url + enr.source_title), enr ? `${enr.source_title} — ${enr.source_url}` : "missing");
  const ashbyTx = ledger.transactions.find((t) => t.merchant_normalized === DEMO.UNKNOWN_VENDOR.merchant_normalized);
  add("unknown vendor corroborated (OpenAI == Tavily)", ashbyTx?.classification_method === "LLM_CORROBORATED" && ashbyTx.category === DEMO.UNKNOWN_VENDOR.expected_category, `method=${ashbyTx?.classification_method} category=${ashbyTx?.category}`);

  // Provenance
  add("all dashboard figures derived (provenance synthetic/sandbox)", derived.provenance.history_source === "synthetic" && derived.provenance.balance_source === "sandbox_bank");

  const ok = checks.every((c) => c.ok);

  // Print summary
  console.log("\n=== Canary demo verification ===\n");
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `\n        ${c.detail}` : ""}`);
  console.log("\n=== Derived demo numbers ===");
  console.log(`cash                 ${formatUsd(derived.cash_cents)}`);
  console.log(`monthly net burn     ${formatUsd(derived.burn.monthly_net_burn_cents)}  (window ${derived.burn.burn_window_start}..${derived.burn.burn_window_end}, ${derived.burn.burn_window_reason})`);
  console.log(`runway               ${formatMonths(derived.burn.runway_months)}`);
  if (cusum) {
    console.log(`cusum σ=${formatUsd(cusum.sigma_cents)} k=${formatUsd(cusum.k_cents)} h=${formatUsd(cusum.h_cents)} alarm=${cusum.alarm_week_start} change=${cusum.estimated_change_point_week_start} lag=${cusum.detection_lag_weeks}w`);
    console.log(`variable spend pre→post  ${formatUsd(cusum.pre_change_rate_weekly_cents ?? 0)} → ${formatUsd(cusum.post_change_rate_weekly_cents ?? 0)} /wk (${formatSignedUsd(cusum.delta_weekly_cents ?? 0)}/wk)`);
  }
  for (const c of contribs.slice(0, 5)) console.log(`  ${c.entity.padEnd(14)} ${formatSignedUsd(c.delta_weekly_cents)}/wk  ${formatSignedUsd(c.delta_monthly_cents)}/mo`);
  if (oneOffDet) console.log(`one-off              ${oneOffDet.entity} ${formatUsd(oneOffDet.current_amount_cents)} = ${oneOffDet.multiple_of_median?.toFixed(1)}× median ${formatUsd(oneOffDet.vendor_median_cents ?? 0)}`);
  console.log(`weekly variable      ${ledger.weeks.map((w) => Math.round(w.variable_spend_cents / 100)).join(" ")}`);
  console.log(`incidents            ${derived.incidents.map((i) => `${i.id}:${i.type}:${i.entity}:${i.severity}`).join(", ")}`);
  console.log(`\n${ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}\n`);
  return { checks, ok };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  verifyDemo().then((r) => process.exit(r.ok ? 0 : 1));
}
