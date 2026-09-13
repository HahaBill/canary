/**
 * Does Canary's brain work on somebody else's bank?
 *
 * Every other test runs the detectors over our own generator, which plants the
 * things they are meant to find. That is circular on its own. This runs the
 * whole stack — reconcile, bucket, burn, CUSUM, one-off, drift — over Rho's
 * sandbox and records what each part does with data nobody tuned for it.
 *
 * The answer is not "it all works". Reconciliation and burn work. The detectors
 * stay silent, and the test asserts WHY: 72 transactions across three years
 * leave almost every week empty and no vendor with enough history to compare
 * against. Silence on data with nothing in it is correct behaviour, and pinning
 * the reason here is what stops anyone reading it as a failure.
 */
import { buildLedger, computeBurn } from "@canary/engine";
import { detectOneOffs, detectRecurringDrift, runCusum } from "@canary/detectors";
import { MIN_PRIOR_VENDOR_PAYMENTS } from "@canary/shared";
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/rho-sandbox.json" with { type: "json" };
import { RhoBankClient, type RhoAccount, type RhoTransaction } from "./rho.ts";
import type { FetchLike } from "../sendblue/client.ts";

const ASOF = "2026-09-13";

const fetchImpl = (async (input: Parameters<FetchLike>[0]) => {
  const body = String(input).includes("/accounts")
    ? { accounts: fixture.accounts as unknown as RhoAccount[], page: {} }
    : { transactions: fixture.transactions as unknown as RhoTransaction[], page: {} };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as unknown as FetchLike;

async function rhoStack() {
  const rho = await new RhoBankClient({ fetchImpl }).getLedger(ASOF);
  const dates = rho.transactions.map((t) => t.date);
  const ledger = buildLedger({
    company: {
      name: "Rho Sandbox Co", legal_name: "Rho Sandbox Co", description: "", stage: "sandbox",
      headcount: 0, raised_cents: 0, bank_name: "Rho", as_of: ASOF, accounts: rho.accounts,
    },
    accounts: rho.accounts,
    transactions: rho.transactions,
    classifications: {},
    historyStart: dates[0]!,
    historyEnd: ASOF,
  });
  const burn = computeBurn(ledger, { regimeStartWeekIndex: null });
  return { rho, ledger, burn };
}

describe("Canary's brain on Rho's bank", () => {
  it("reconciles to the balance Rho itself reports", async () => {
    const { rho, ledger } = await rhoStack();
    const cash = rho.accounts.filter((a) => a.type !== "card").reduce((s, a) => s + a.balance_cents, 0);

    // The part that has to be right before any detector matters, on data that
    // was not built for us.
    expect(ledger.reconciliation.discrepancy_cents).toBe(0);
    expect(ledger.reconciliation.computed_closing_balance_cents).toBe(cash);
  });

  it("keeps the company's own money out of burn", async () => {
    const { ledger } = await rhoStack();
    const internal = ledger.transactions.filter(
      (t) => t.flow_type === "INTERNAL_TRANSFER" || t.flow_type === "CARD_SETTLEMENT",
    );

    expect(internal.length).toBeGreaterThan(0);
    expect(internal.every((t) => !t.counts_in_burn)).toBe(true);
  });

  it("computes a burn and a runway without special-casing anything", async () => {
    const { burn } = await rhoStack();
    expect(Number.isInteger(burn.monthly_net_burn_cents)).toBe(true);
    expect(burn.weeks_in_window).toBeGreaterThan(0);
  });

  it("stays silent on the detectors, and the data says why", async () => {
    const { ledger, burn } = await rhoStack();
    const cusum = runCusum(ledger.weeks);
    const oneOffs = detectOneOffs(ledger, burn).filter((o) => o.is_anomalous);
    const drifts = detectRecurringDrift(ledger, burn);

    // 1. CUSUM watches a weekly series. Rho's sandbox spreads 72 transactions
    //    over three years, so nearly every week is empty — there is no series.
    const weeksWithSpend = ledger.weeks.filter((w) => w.variable_spend_cents !== 0).length;
    expect(weeksWithSpend / ledger.weeks.length).toBeLessThan(0.2);
    expect(cusum.fired).toBe(false);

    // 2. The one-off rule compares a payment to that vendor's own history.
    //    Exactly one counterparty in the sandbox is paid more than a handful of
    //    times — Rho itself, for wire fees — and its charges are consistent, so
    //    there is nothing anomalous to find. Every other vendor appears once or
    //    twice, which is "new vendor", never "anomalous" (contract §9).
    const payments = new Map<string, number>();
    for (const tx of ledger.transactions) {
      if (tx.counts_in_burn && tx.flow_type === "OPERATING_OUTFLOW") {
        payments.set(tx.merchant_normalized, (payments.get(tx.merchant_normalized) ?? 0) + 1);
      }
    }
    const withHistory = [...payments.entries()].filter(([, n]) => n > MIN_PRIOR_VENDOR_PAYMENTS);
    expect(withHistory).toEqual([["rho", 4]]);
    expect(oneOffs).toEqual([]);

    // 3. Drift compares a vendor's earlier charges to its later ones. Same reason.
    expect(drifts).toEqual([]);

    // Silence here is the detectors being right, not broken. Given a year of
    // weekly data they fire — that is what every other suite in this repo shows.
  });

  it("routes unknown vendors to Needs Review instead of inventing categories", async () => {
    const { ledger } = await rhoStack();
    // Canary has never seen these merchants and has no classifier wired here.
    // PRD §4: unknown category is not an ignored transaction.
    expect(ledger.reconciliation.needs_review_count).toBeGreaterThan(0);
    const review = ledger.transactions.filter((t) => t.category === "NEEDS_REVIEW" && t.amount_cents < 0);
    expect(review.every((t) => t.counts_in_burn)).toBe(true);
  });
});
