/**
 * MOCK DerivedDemoObject — DEV ONLY.
 *
 * Lets apps/web and apps/api build before the real pipeline exists.
 * `provenance.history_source === "mock"` — the UI MUST render a visible
 * "MOCK DATA" banner when it sees this, and the API must never serve it in
 * production. Numbers are computed from a tiny synthetic series below so they
 * are internally consistent, but they are NOT the demo numbers.
 */
import { COMPANY, SANDBOX_ACCOUNTS, sandboxClosingCashCents } from "../company.ts";
import { CUSUM_DEFAULTS, DEMO, WEEKS_PER_MONTH } from "../config.ts";
import { addDays, historyStart, weekStartsEndingAt } from "../dates.ts";
import { runwayMonths, weeklyToAnnual, weeklyToMonthly } from "../money.ts";
import { SCENARIO_LABEL, type Contributor, type DerivedDemoObject, type Incident, type WeeklyBucket } from "../types.ts";

export function buildMockDerived(): DerivedDemoObject {
  const weeks = DEMO.WEEKS;
  const starts = weekStartsEndingAt(DEMO.END_DATE, weeks);
  const hs = historyStart(DEMO.END_DATE, weeks);
  const change = DEMO.CHANGE_START_INDEX;

  const buckets: WeeklyBucket[] = starts.map((ws, i) => {
    const ramp = Math.min(1, Math.max(0, (i - change + 1) / DEMO.CHANGE_RAMP_WEEKS));
    const aws = 420_000 + Math.round(ramp * 260_000) + ((i * 37) % 5) * 9_000;
    const datadog = 55_000 + Math.round(ramp * 30_000);
    const ashby = 40_000 + Math.round(ramp * 25_000);
    const figma = 12_000;
    const upwork = 250_000 - ((i * 13) % 4) * 15_000;
    const doordash = 20_000 + ((i * 7) % 3) * 4_000;
    const variable_by_entity = { aws, datadog, ashby, figma, upwork, doordash };
    const variable = Object.values(variable_by_entity).reduce((a, b) => a + b, 0);
    const fixed = i % 2 === 0 ? 3_000_000 : 200_000; // biweekly payroll, rent in odd weeks
    const inflow = i % 4 === 1 ? 4_500_000 : 0;
    const excluded = i === 14 ? 1_800_000 : 0; // planted one-off in mock
    const total = variable + fixed + excluded;
    return {
      week_start: ws,
      week_end: addDays(ws, 6),
      week_index: i,
      variable_spend_cents: variable,
      fixed_spend_cents: fixed,
      excluded_from_monitoring_cents: excluded,
      total_operating_outflow_cents: total,
      operating_inflow_cents: inflow,
      net_burn_cents: total - inflow,
      variable_by_entity,
      variable_by_category: { CLOUD_INFRASTRUCTURE: aws, SAAS_SOFTWARE: datadog + figma, RECRUITING: ashby, CONTRACTORS: upwork, MEALS: doordash },
      transaction_count: 12,
    };
  });

  const avg = (arr: number[]) => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
  const pre = buckets.slice(0, change);
  const post = buckets.slice(change);
  const preRate = avg(pre.map((w) => w.variable_spend_cents));
  const postRate = avg(post.map((w) => w.variable_spend_cents));

  const entities = Object.keys(buckets[0]!.variable_by_entity);
  const totalDelta = postRate - preRate;
  const contributors: Contributor[] = entities
    .map((e) => {
      const p = avg(pre.map((w) => w.variable_by_entity[e] ?? 0));
      const q = avg(post.map((w) => w.variable_by_entity[e] ?? 0));
      return {
        entity: e,
        category: null,
        pre_rate_weekly_cents: p,
        post_rate_weekly_cents: q,
        delta_weekly_cents: q - p,
        delta_monthly_cents: weeklyToMonthly(q - p),
        share_of_total_delta: totalDelta ? (q - p) / totalDelta : 0,
      };
    })
    .sort((a, b) => b.delta_weekly_cents - a.delta_weekly_cents);

  const cash = sandboxClosingCashCents();
  const window = post;
  const weeklyGross = avg(window.map((w) => w.total_operating_outflow_cents));
  const weeklyInflow = avg(window.map((w) => w.operating_inflow_cents));
  const weeklyNet = weeklyGross - weeklyInflow;
  const monthlyNet = weeklyToMonthly(weeklyNet);
  const preWeeklyNet = avg(pre.map((w) => w.net_burn_cents));
  const runwayBefore = runwayMonths(cash, weeklyToMonthly(preWeeklyNet));
  const runwayAfter = runwayMonths(cash, monthlyNet);

  const byEntity: Record<string, number> = {};
  for (const e of entities) byEntity[e] = avg(window.map((w) => w.variable_by_entity[e] ?? 0));

  const now = "2026-09-12T17:00:00.000Z";
  const stat: number[] = [];
  let s = 0;
  const sigma = 40_000;
  for (const w of buckets) {
    s = Math.max(0, s + (w.variable_spend_cents - preRate) - CUSUM_DEFAULTS.k_factor * sigma);
    stat.push(Math.round(s));
  }

  const primary: Incident = {
    id: "inc_mock_burn",
    type: "BURN_RATE_SHIFT",
    entity: contributors[0]!.entity,
    title: "Sustained increase in variable spending",
    summary: "MOCK — variable spend shifted upward; largest contributor is " + contributors[0]!.entity + ".",
    estimated_change_point: buckets[change]!.week_start,
    alarm_date: buckets[change + 3]!.week_start,
    severity: "HIGH",
    status: "OPEN",
    first_detected: now,
    last_updated: now,
    last_notified: null,
    financial_impact: {
      delta_weekly_cents: totalDelta,
      delta_monthly_cents: weeklyToMonthly(totalDelta),
      delta_annualized_cents: weeklyToAnnual(totalDelta),
      runway_before_months: runwayBefore,
      runway_after_months: runwayAfter,
      runway_impact_months: runwayBefore !== null && runwayAfter !== null ? Math.round((runwayBefore - runwayAfter) * 10) / 10 : null,
    },
    contributors,
    child_signals: [{ entity: "datadog", category: "SAAS_SOFTWARE", description: "MOCK recurring SaaS increase folded into this incident", delta_weekly_cents: contributors.find((c) => c.entity === "datadog")!.delta_weekly_cents }],
    detection: {},
    materiality: { material: true, rules_triggered: ["MIN_MONTHLY_DELTA"], values: { monthly_delta_cents: weeklyToMonthly(totalDelta) } },
    evidence: [
      { kind: "OBSERVED", text: "MOCK: aws spend increased in the post-change segment." },
      { kind: "DETECTED", text: "MOCK: CUSUM alarm on variable spend." },
      { kind: "EVIDENCE", text: "MOCK: cached vendor research placeholder.", source_url: "https://example.invalid", source_title: "placeholder", cached: true },
      { kind: "ESTIMATE", text: "MOCK: hypothetical 20% reduction changes modeled runway." },
      { kind: "SUGGESTION", text: "MOCK: review cloud cost allocation before acting." },
    ],
  };

  const oneOff: Incident = {
    id: "inc_mock_oneoff",
    type: "ONE_OFF_VENDOR_PAYMENT",
    entity: "figma",
    title: "Unusual one-off payment to figma",
    summary: "MOCK — payment is many times this vendor's median.",
    estimated_change_point: null,
    alarm_date: buckets[14]!.week_start,
    severity: "MEDIUM",
    status: "OPEN",
    first_detected: now,
    last_updated: now,
    last_notified: null,
    financial_impact: { delta_weekly_cents: null, delta_monthly_cents: null, delta_annualized_cents: null, runway_before_months: null, runway_after_months: null, runway_impact_months: null, one_off_amount_cents: 1_800_000 },
    contributors: [],
    child_signals: [],
    detection: {},
    materiality: { material: true, rules_triggered: ["MIN_ONE_OFF_AMOUNT"], values: { amount_cents: 1_800_000 } },
    evidence: [{ kind: "OBSERVED", text: "MOCK: figma payment far above vendor median." }],
  };

  return {
    provenance: {
      company_is_fictional: true,
      balance_source: "mock",
      history_source: "mock",
      seed: 0,
      weeks,
      start_date: hs,
      end_date: DEMO.END_DATE,
      generated_at: now,
    },
    company: COMPANY,
    accounts: SANDBOX_ACCOUNTS,
    cash_cents: cash,
    burn: {
      burn_window_start: window[0]!.week_start,
      burn_window_end: window[window.length - 1]!.week_end,
      burn_window_reason: "POST_CHANGE_SEGMENT",
      weeks_in_window: window.length,
      weekly_gross_burn_cents: weeklyGross,
      weekly_operating_inflow_cents: weeklyInflow,
      weekly_net_burn_cents: weeklyNet,
      weekly_variable_spend_cents: avg(window.map((w) => w.variable_spend_cents)),
      weekly_fixed_spend_cents: avg(window.map((w) => w.fixed_spend_cents)),
      monthly_gross_burn_cents: weeklyToMonthly(weeklyGross),
      monthly_net_burn_cents: monthlyNet,
      available_operating_cash_cents: cash,
      runway_months: runwayAfter,
      weekly_variable_by_entity: byEntity,
    },
    reconciliation: {
      as_of: DEMO.END_DATE,
      opening_balance_cents: cash + Math.round(weeklyNet * weeks),
      opening_balance_reported: true,
      reported_closing_balance_cents: cash,
      computed_closing_balance_cents: cash,
      discrepancy_cents: 0,
      matches: true,
      internal_transfer_pairs: 1,
      unpaired_transfer_legs: 0,
      card_settlements: 4,
      card_purchases_covered: 40,
      unpaired_settlements: 0,
      pending_rows_dropped: 2,
      financing_net_cents: 0,
      refunds_netted_cents: 50_000,
      needs_review_count: 1,
      needs_review_outflow_cents: 90_000,
      warnings: ["MOCK DATA — not generator output"],
    },
    needs_review: { count: 1, outflow_cents: 90_000, items: [{ transaction_id: "mock_nr_1", date: buckets[12]!.week_start, merchant_raw: "UNKNOWN MERCHANT 4471", merchant_normalized: "unknown_merchant_4471", amount_cents: -90_000, reason: "MOCK: no rule match and signals disagreed" }] },
    weeks: buckets,
    cusum_statistic_cents: stat,
    incidents: [primary, oneOff],
    primary_incident: primary,
    one_off_incident: oneOff,
    vendor_enrichments: [
      {
        vendor_name: DEMO.UNKNOWN_VENDOR.display_name,
        merchant_normalized: DEMO.UNKNOWN_VENDOR.merchant_normalized,
        business_type: "MOCK: recruiting software platform",
        mapped_category: DEMO.UNKNOWN_VENDOR.expected_category,
        source_url: "https://example.invalid/mock",
        source_title: "MOCK placeholder",
        retrieved_at: now,
        cached: true,
      },
    ],
    classifications: {},
  };
}

/** Handy for what-if mocks in the web app before the API exists. */
export function mockWhatIf(derived: DerivedDemoObject, entity: string, percentage: number) {
  const b = derived.burn;
  const isMonitored = Object.prototype.hasOwnProperty.call(b.weekly_variable_by_entity, entity);
  const cur = b.weekly_variable_by_entity[entity] ?? 0;
  // Match the engine: a zero/negative net vendor balance has no spend to cut,
  // so scaling it must not invert a reduction into higher modeled burn.
  const hyp = cur <= 0 ? cur : Math.round(cur * (1 + percentage / 100));
  const deltaWeekly = hyp - cur;
  const scenarioMonthly = b.monthly_net_burn_cents + weeklyToMonthly(deltaWeekly);
  const scenarioRunway = runwayMonths(b.available_operating_cash_cents, scenarioMonthly);
  const name = entity.charAt(0).toUpperCase() + entity.slice(1);
  const noChangeReason = !isMonitored
    ? `${name} is not part of the variable spend Canary monitors, so changing it does not move modeled burn`
    : cur <= 0
      ? `${name} has no net spend left to change over the current burn window`
      : percentage === 0
        ? `A zero percent change to ${entity} leaves everything where it is`
        : null;
  return {
    label: SCENARIO_LABEL,
    entity,
    percentage,
    current_weekly_cents: cur,
    current_monthly_cents: weeklyToMonthly(cur),
    hypothetical_weekly_cents: hyp,
    hypothetical_monthly_cents: weeklyToMonthly(hyp),
    delta_monthly_cents: weeklyToMonthly(deltaWeekly),
    delta_annualized_cents: weeklyToAnnual(deltaWeekly),
    current_burn_monthly_cents: b.monthly_net_burn_cents,
    scenario_burn_monthly_cents: scenarioMonthly,
    current_runway_months: b.runway_months,
    scenario_runway_months: scenarioRunway,
    runway_delta_months: b.runway_months !== null && scenarioRunway !== null ? Math.round((scenarioRunway - b.runway_months) * 10) / 10 : null,
    no_change_reason: noChangeReason,
    speech: { delta_monthly: "mock", scenario_runway: "mock", summary: "mock" },
  };
}

export const _mockWeeksPerMonth = WEEKS_PER_MONTH;
