import { MIN_PRIOR_VENDOR_PAYMENTS, ONE_OFF_MEDIAN_MULTIPLE, ONE_OFF_MIN_ABS_DIFF_CENTS } from "@canary/shared";
import { describe, expect, it } from "vitest";
import { detectOneOffs } from "./one-off.ts";
import { makeBurn, makeLedger, makeTx, priorPayments } from "./test-helpers.ts";

const BURN = makeBurn();
const PRIOR_AMOUNTS = [4_200_00, 4_500_00, 4_800_00]; // $4,200 / $4,500 / $4,800
const SPIKE = makeTx({ id: "figma_spike", date: "2026-09-05", amount_cents: -1_800_000, merchant_normalized: "figma" });

describe("detectOneOffs", () => {
  it("flags a payment that clears both the median multiple and the absolute floor", () => {
    const ledger = makeLedger([...priorPayments("figma", PRIOR_AMOUNTS, "2026-08-01"), SPIKE]);
    const anomalies = detectOneOffs(ledger, BURN).filter((r) => r.is_anomalous);
    const [result, ...rest] = anomalies;

    expect(rest).toEqual([]);
    expect(result!.transaction_id).toBe("figma_spike");
    expect(result!.entity).toBe("figma");
    expect(result!.date).toBe("2026-09-05");
    expect(result!.current_amount_cents).toBe(1_800_000);
    expect(result!.prior_payment_count).toBe(3);
    expect(result!.vendor_median_cents).toBe(4_500_00);
    expect(result!.vendor_mad_cents).toBe(300_00);
    expect(result!.multiple_of_median).toBe(4);
    expect(result!.is_new_vendor).toBe(false);
    expect(result!.is_anomalous).toBe(true);
    expect(result!.materiality.material).toBe(true);
  });

  it("treats a vendor with too little history as new instead of anomalous", () => {
    const priors = priorPayments("figma", PRIOR_AMOUNTS.slice(0, MIN_PRIOR_VENDOR_PAYMENTS - 1), "2026-08-01");
    const results = detectOneOffs(makeLedger([...priors, SPIKE]), BURN);
    const spike = results.find((r) => r.transaction_id === "figma_spike")!;

    expect(spike.is_new_vendor).toBe(true);
    expect(spike.is_anomalous).toBe(false);
    expect(spike.prior_payment_count).toBe(MIN_PRIOR_VENDOR_PAYMENTS - 1);
    expect(spike.vendor_median_cents).toBeNull();
    expect(spike.vendor_mad_cents).toBeNull();
    expect(spike.multiple_of_median).toBeNull();
    // Materiality is still evaluated so callers can act on a large first payment.
    expect(spike.materiality.material).toBe(true);
  });

  it("reports the first payments to a vendor as new-vendor results", () => {
    const results = detectOneOffs(makeLedger(priorPayments("figma", PRIOR_AMOUNTS, "2026-08-01")), BURN);

    expect(results.map((r) => r.prior_payment_count)).toEqual([0, 1, 2]);
    expect(results.every((r) => r.is_new_vendor && !r.is_anomalous)).toBe(true);
  });

  it("ignores a payment that is a large multiple but a small absolute difference", () => {
    const small = 500_00; // $500 median, so 3× it is still a rounding error in burn terms
    const priors = priorPayments("notion", [small, small, small], "2026-08-01");
    const justUnder = small + ONE_OFF_MIN_ABS_DIFF_CENTS - 1;
    const payment = makeTx({ id: "notion_x", date: "2026-09-05", amount_cents: -justUnder, merchant_normalized: "notion" });
    const results = detectOneOffs(makeLedger([...priors, payment]), BURN);

    expect(justUnder).toBeGreaterThanOrEqual(ONE_OFF_MEDIAN_MULTIPLE * small);
    expect(justUnder - small).toBeLessThan(ONE_OFF_MIN_ABS_DIFF_CENTS);
    expect(results.filter((r) => r.transaction_id === "notion_x")).toEqual([]);
  });

  it("ignores a payment that is a large difference but a small multiple", () => {
    const priors = priorPayments("aws", [30_000_00, 30_000_00, 30_000_00], "2026-08-01");
    const payment = makeTx({ id: "aws_x", date: "2026-09-05", amount_cents: -60_000_00, merchant_normalized: "aws" });
    const results = detectOneOffs(makeLedger([...priors, payment]), BURN);

    expect(60_000_00 - 30_000_00).toBeGreaterThanOrEqual(ONE_OFF_MIN_ABS_DIFF_CENTS);
    expect(results.filter((r) => r.is_anomalous)).toEqual([]);
  });

  it("counts only strictly earlier payments as history", () => {
    const priors = priorPayments("figma", PRIOR_AMOUNTS, "2026-08-01");
    const sameDay = makeTx({ id: "figma_same_day", date: priors[2]!.date, amount_cents: -1_800_000, merchant_normalized: "figma" });
    const result = detectOneOffs(makeLedger([...priors, sameDay]), BURN).find((r) => r.transaction_id === "figma_same_day")!;

    // Two strictly-earlier priors, not three: the same-day sibling does not count.
    expect(result.prior_payment_count).toBe(2);
    expect(result.is_new_vendor).toBe(true);
  });

  it("ignores dropped rows, non-burn rows and refunds", () => {
    const priors = priorPayments("figma", PRIOR_AMOUNTS, "2026-08-01");
    const noise = [
      makeTx({ id: "figma_pending", date: "2026-09-04", amount_cents: -1_800_000, merchant_normalized: "figma", dropped: true, excluded_reason: "superseded by settled row" }),
      makeTx({ id: "figma_refund", date: "2026-09-04", amount_cents: 1_800_000, merchant_normalized: "figma", flow_type: "REFUND" }),
      makeTx({ id: "xfer", date: "2026-09-04", amount_cents: -9_000_000, merchant_normalized: "internal_transfer", flow_type: "INTERNAL_TRANSFER", counts_in_burn: false }),
      makeTx({ id: "settle", date: "2026-09-04", amount_cents: -9_000_000, merchant_normalized: "card_settlement", flow_type: "CARD_SETTLEMENT", counts_in_burn: false }),
    ];
    const results = detectOneOffs(makeLedger([...priors, ...noise, SPIKE]), BURN);
    const anomalies = results.filter((r) => r.is_anomalous);

    expect(results.map((r) => r.transaction_id)).not.toContain("figma_refund");
    expect(results.map((r) => r.transaction_id)).not.toContain("xfer");
    expect(anomalies.map((r) => r.transaction_id)).toEqual(["figma_spike"]);
    // The dropped duplicate did not become history either.
    expect(anomalies[0]!.prior_payment_count).toBe(3);
  });

  it("returns results in date then id order across vendors", () => {
    const ledger = makeLedger([
      ...priorPayments("figma", PRIOR_AMOUNTS, "2026-08-01"),
      ...priorPayments("datadog", PRIOR_AMOUNTS, "2026-08-01"),
      makeTx({ id: "b_late", date: "2026-09-12", amount_cents: -1_800_000, merchant_normalized: "figma" }),
      makeTx({ id: "a_late", date: "2026-09-12", amount_cents: -1_800_000, merchant_normalized: "datadog" }),
      SPIKE,
    ]);
    const anomalies = detectOneOffs(ledger, BURN).filter((r) => r.is_anomalous);

    expect(anomalies.map((r) => r.transaction_id)).toEqual(["figma_spike", "a_late", "b_late"]);
  });

  it("is deterministic", () => {
    const ledger = makeLedger([...priorPayments("figma", PRIOR_AMOUNTS, "2026-08-01"), SPIKE]);
    expect(detectOneOffs(ledger, BURN)).toEqual(detectOneOffs(ledger, BURN));
  });
});
