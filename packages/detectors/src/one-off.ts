/**
 * Vendor-relative one-off anomaly detector (PRD §12, contract §8–9).
 *
 * Walks every operating outflow in date order and compares it to the PRIOR
 * payments to the same `merchant_normalized` only — no look-ahead, so a replay
 * of the same ledger produces the same verdict for each transaction as the day
 * it landed.
 *
 * Fewer than `MIN_PRIOR_VENDOR_PAYMENTS` priors → the vendor-median rule does
 * not run at all and the payment is reported as `is_new_vendor` (contract §9).
 */
import {
  MIN_PRIOR_VENDOR_PAYMENTS,
  ONE_OFF_MEDIAN_MULTIPLE,
  ONE_OFF_MIN_ABS_DIFF_CENTS,
  mad,
  median,
  type BurnSummary,
  type Cents,
  type DetectOneOffs,
  type Ledger,
  type LedgerTransaction,
  type OneOffResult,
} from "@canary/shared";
import { evaluateOneOffMateriality } from "./materiality.ts";

export const detectOneOffs: DetectOneOffs = (ledger: Ledger, burn: BurnSummary): OneOffResult[] => {
  const outflows = ledger.transactions.filter(isEvaluatableOutflow).sort(byDateThenId);

  const byEntity = new Map<string, LedgerTransaction[]>();
  for (const tx of outflows) {
    const group = byEntity.get(tx.merchant_normalized);
    if (group) group.push(tx);
    else byEntity.set(tx.merchant_normalized, [tx]);
  }

  const results: OneOffResult[] = [];
  for (const group of byEntity.values()) {
    for (let i = 0; i < group.length; i++) {
      const tx = group[i]!;
      // The group is date-then-id ordered, so history is the prefix of rows
      // dated STRICTLY earlier: same-day payments are not history for each other.
      const history: Cents[] = [];
      for (let p = 0; p < i; p++) {
        const prior = group[p]!;
        if (prior.date < tx.date) history.push(Math.abs(prior.amount_cents));
      }

      const result = evaluatePayment(tx, history, burn);
      if (result) results.push(result);
    }
  }

  return results.sort(byResultDateThenId);
};

/**
 * Returns a result only when the payment is anomalous or from a new vendor —
 * callers filter further on `is_anomalous && materiality.material`.
 */
function evaluatePayment(tx: LedgerTransaction, history: Cents[], burn: BurnSummary): OneOffResult | null {
  const amount = Math.abs(tx.amount_cents);
  const priorCount = history.length;
  const base = {
    transaction_id: tx.id,
    entity: tx.merchant_normalized,
    date: tx.date,
    current_amount_cents: amount,
    prior_payment_count: priorCount,
    materiality: evaluateOneOffMateriality(amount, burn),
  };

  if (priorCount < MIN_PRIOR_VENDOR_PAYMENTS) {
    return {
      ...base,
      vendor_median_cents: null,
      vendor_mad_cents: null,
      multiple_of_median: null,
      is_new_vendor: true,
      is_anomalous: false,
    };
  }

  // Rounded to cents before the comparison so the reported median is the one the
  // rule actually used (an even-length history yields a half-cent median).
  const vendorMedian = Math.round(median(history));
  const isAnomalous =
    amount >= ONE_OFF_MEDIAN_MULTIPLE * vendorMedian && amount - vendorMedian >= ONE_OFF_MIN_ABS_DIFF_CENTS;
  if (!isAnomalous) return null;

  return {
    ...base,
    vendor_median_cents: vendorMedian,
    vendor_mad_cents: Math.round(mad(history)),
    multiple_of_median: vendorMedian > 0 ? Math.round((amount / vendorMedian) * 100) / 100 : null,
    is_new_vendor: false,
    is_anomalous: true,
  };
}

/**
 * Operating outflows only. Refunds also carry `counts_in_burn` but they are
 * inflows against a vendor, so including them would understate vendor medians.
 * Dropped (superseded pending) rows are invisible to the detector.
 */
function isEvaluatableOutflow(tx: LedgerTransaction): boolean {
  return !tx.dropped && tx.counts_in_burn && tx.flow_type === "OPERATING_OUTFLOW";
}

function byDateThenId(a: LedgerTransaction, b: LedgerTransaction): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function byResultDateThenId(a: OneOffResult, b: OneOffResult): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.transaction_id < b.transaction_id ? -1 : a.transaction_id > b.transaction_id ? 1 : 0;
}
