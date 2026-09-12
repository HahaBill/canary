/**
 * Canary pipeline: generator → classification → engine → detectors → DerivedDemoObject.
 * Lead-owned integration glue. Deterministic given (seed, profile, now, classification inputs).
 */
import {
  DEMO,
  type ClassificationMap,
  type ClassifyOptions,
  type DerivedDemoObject,
  type GeneratedCompany,
  type Incident,
  type Ledger,
  type NeedsReviewItem,
  type VendorEnrichment,
} from "@canary/shared";
import { DEFAULT_DEMO_OPTIONS, generateDemoCompany } from "@canary/generator";
import { buildLedger, computeBurn } from "@canary/engine";
import { attachDriftSignals, buildIncidents, decomposeContributors, detectOneOffs, detectRecurringDrift, ewma, runCusum } from "@canary/detectors";
// Import the node-free core so the Worker bundle never pulls in node:fs.
import { classifyTransactions } from "@canary/classification/core";

export interface PipelineOptions {
  seed?: number;
  profile?: "demo" | "test";
  /** ISO timestamp used for incident timestamps and provenance. Defaults to a fixed value for determinism. */
  now?: string;
  /** Providers/cache for classification. Omit for rules-only (unknown vendors → NEEDS_REVIEW). */
  classify?: ClassifyOptions;
  /**
   * Pre-computed per-merchant classifications (from a previous live run), applied before
   * calling classifyTransactions so the Worker can be deterministic and offline.
   * Keyed by merchant_normalized. Values are Classification minus transaction_id.
   */
  merchantClassificationCache?: Record<string, Omit<import("@canary/shared").Classification, "transaction_id">>;
  cachedEnrichments?: VendorEnrichment[];
  existingIncidents?: Incident[];
  /** Include fixture metadata in the output (verification only). */
  includeFixture?: boolean;
  /** Reuse an already generated company (tests). */
  generated?: GeneratedCompany;
}

export const FIXED_NOW = "2026-09-13T23:59:00.000Z";

export interface PipelineResult {
  derived: DerivedDemoObject;
  ledger: Ledger;
  generated: GeneratedCompany;
}

export async function runPipeline(opts: PipelineOptions = {}): Promise<PipelineResult> {
  const seed = opts.seed ?? DEMO.SEED;
  const profile = opts.profile ?? "demo";
  const now = opts.now ?? FIXED_NOW;

  // 1. Generate
  const generated = opts.generated ?? generateDemoCompany({ ...DEFAULT_DEMO_OPTIONS, seed, profile });
  const { company, accounts, transactions, fixture } = generated;

  // 2. Classify (cache first, then providers/rules)
  let classifications: ClassificationMap = {};
  let enrichments: VendorEnrichment[] = [...(opts.cachedEnrichments ?? [])];
  const cache = opts.merchantClassificationCache ?? {};
  const uncached = transactions.filter((t) => {
    const c = cache[t.merchant_normalized];
    if (c && t.flow_type === "OPERATING_OUTFLOW") {
      classifications[t.id] = { ...c, transaction_id: t.id };
      return false;
    }
    return true;
  });
  if (uncached.length > 0) {
    const res = await classifyTransactions(uncached, opts.classify);
    classifications = { ...classifications, ...res.classifications };
    for (const e of res.enrichments) if (!enrichments.some((x) => x.merchant_normalized === e.merchant_normalized)) enrichments.push(e);
  }

  // 3. Ledger pass 1 (no one-off tags) → baseline burn → one-off detection
  // The sandbox bank reports the period's opening balance (fixture.opening_balance_cents), making reconciliation a real check.
  const ledgerBase = { company, accounts, transactions, classifications, historyStart: fixture.start_date, historyEnd: fixture.end_date, expectedOpeningBalanceCents: fixture.opening_balance_cents };
  const ledger0 = buildLedger(ledgerBase);
  const burn0 = computeBurn(ledger0, { regimeStartWeekIndex: null });
  const oneOffs = detectOneOffs(ledger0, burn0);
  const oneOffIds = oneOffs.filter((o) => o.is_anomalous && o.materiality.material).map((o) => o.transaction_id);

  // 4. Ledger pass 2 with one-offs winsorized out of the monitoring series
  const ledger = buildLedger({ ...ledgerBase, oneOffTransactionIds: oneOffIds });

  // 5. CUSUM → regime → burn windows
  const cusum = runCusum(ledger.weeks);
  const regimeStart = cusum.fired && cusum.estimated_change_point_index !== null ? cusum.estimated_change_point_index + 1 : null;
  const burnAfter = computeBurn(ledger, { regimeStartWeekIndex: regimeStart });
  // "Before" = the entire pre-change segment (all weeks before the regime start), so runway_before
  // describes the same weeks the incident's OBSERVED evidence cites.
  const burnBefore =
    regimeStart !== null
      ? computeBurn({ ...ledger, weeks: ledger.weeks.slice(0, regimeStart) }, { regimeStartWeekIndex: null, trailingWindowWeeks: regimeStart })
      : burnAfter;

  // 6. Decomposition + incidents
  const contributors = cusum.fired ? decomposeContributors(ledger.weeks, cusum) : [];
  // Recurring-charge drift runs on the SECOND-pass ledger, where one-offs are
  // already tagged, so a planted spike can never read as a billing trend. A
  // drifting vendor that already contributes to the rate shift is folded into
  // that incident rather than raising a second alert (contract §10).
  const drifts = detectRecurringDrift(ledger, burnAfter);
  const incidents = attachDriftSignals(
    buildIncidents({ ledger, cusum, contributors, oneOffs, burnBefore, burnAfter, existing: opts.existingIncidents ?? [], now }),
    drifts,
  );
  // Only incidents (re)detected THIS run (last_updated === now) can drive the dashboard;
  // a stored incident that no current detection claimed is stale and must not become primary.
  const fresh = incidents.filter((i) => i.last_updated === now);
  const pick = (type: Incident["type"]) =>
    fresh.find((i) => i.type === type && i.status !== "RESOLVED") ?? fresh.find((i) => i.type === type) ?? null;
  const primary = pick("BURN_RATE_SHIFT");
  const oneOff = pick("ONE_OFF_VENDOR_PAYMENT");

  // 7. Needs review items
  const needsReviewItems: NeedsReviewItem[] = ledger.transactions
    .filter((t) => !t.dropped && t.category === "NEEDS_REVIEW" && t.amount_cents < 0)
    .map((t) => ({
      transaction_id: t.id,
      date: t.date,
      merchant_raw: t.merchant_raw,
      merchant_normalized: t.merchant_normalized,
      amount_cents: t.amount_cents,
      reason: classifications[t.id]?.reason ?? "No classification available",
    }));

  const derived: DerivedDemoObject = {
    provenance: {
      company_is_fictional: true,
      balance_source: "sandbox_bank",
      history_source: "synthetic",
      seed,
      weeks: fixture.weeks,
      start_date: fixture.start_date,
      end_date: fixture.end_date,
      generated_at: now,
    },
    company,
    accounts,
    cash_cents: burnAfter.available_operating_cash_cents,
    burn: burnAfter,
    reconciliation: ledger.reconciliation,
    needs_review: {
      count: needsReviewItems.length,
      outflow_cents: needsReviewItems.reduce((s, i) => s + Math.abs(i.amount_cents), 0),
      items: needsReviewItems,
    },
    weeks: ledger.weeks,
    cusum_statistic_cents: cusum.statistic_cents,
    ewma_variable_spend_cents: ewma(ledger.weeks.map((w) => w.variable_spend_cents), 0.3).map((v) => Math.round(v)),
    incidents,
    primary_incident: primary,
    one_off_incident: oneOff,
    vendor_enrichments: enrichments,
    classifications,
    ...(opts.includeFixture ? { fixture } : {}),
  };

  return { derived, ledger, generated };
}
