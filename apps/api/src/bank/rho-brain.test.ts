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

/**
 * Schema fit: can Canary's ledger actually carry a real customer's Rho data?
 *
 * Not "does it run" but "does Rho send the fields reconciliation depends on".
 * Two of them it does. Two it does not, and knowing which is the difference
 * between an integration that works and one that quietly mis-states burn.
 */
describe("Rho's schema against Canary's ledger", () => {
  it("pairs transfers natively: money_movement_id IS transfer_pair_id", async () => {
    const { ledger } = await rhoStack();

    // Two legs, one movement id, summing to zero — exactly what the engine means
    // by a paired internal transfer. No invention required.
    expect(ledger.reconciliation.internal_transfer_pairs).toBeGreaterThan(0);
    const paired = ledger.transactions.filter((t) => t.transfer_pair_id);
    const byPair = new Map<string, number>();
    for (const t of paired) byPair.set(t.transfer_pair_id!, (byPair.get(t.transfer_pair_id!) ?? 0) + t.amount_cents);
    for (const [, sum] of [...byPair].filter(([id]) => paired.filter((t) => t.transfer_pair_id === id).length === 2)) {
      expect(sum).toBe(0);
    }
  });

  it("reports one-sided transfers instead of trusting them", async () => {
    const { ledger } = await rhoStack();
    // Rho's sandbox sweeps savings against accounts it does not also report, so
    // some movements arrive with a single leg. That is a real condition a real
    // customer will hit, and the engine counts and warns rather than assuming
    // the money is accounted for.
    expect(ledger.reconciliation.unpaired_transfer_legs).toBeGreaterThan(0);
    expect(ledger.reconciliation.warnings.length).toBeGreaterThan(0);
    // Cash still reconciles exactly despite them.
    expect(ledger.reconciliation.discrepancy_cents).toBe(0);
  });

  it("has no link from a card purchase to the repayment that covers it", async () => {
    const { rho } = await rhoStack();
    // Canary's own generator links them with settlement_pair_id, which lets the
    // engine VERIFY a settlement covers exactly the purchases it claims. Rho
    // sends no such link, so that verification is unavailable on Rho data.
    //
    // Correctness does not depend on it: a card purchase counts in burn and a
    // repayment does not, by flow type alone, so nothing is double counted.
    // What is lost is the cross-check, not the arithmetic.
    expect(rho.transactions.some((t) => t.settlement_pair_id)).toBe(false);
    const { ledger } = await rhoStack();
    const repayments = ledger.transactions.filter((t) => t.flow_type === "CARD_SETTLEMENT");
    const purchases = ledger.transactions.filter((t) => t.flow_type === "OPERATING_OUTFLOW");
    expect(repayments.every((t) => !t.counts_in_burn)).toBe(true);
    expect(purchases.every((t) => t.counts_in_burn)).toBe(true);
  });

  it("has no link from a settled row back to the pending row it replaces", async () => {
    const { rho } = await rhoStack();
    // Canary models this with pending_of so a settled twin supersedes its
    // pending row. Rho sends no such field, and its pending rows share no
    // movement id with any settled row.
    //
    // THE OPEN QUESTION FOR REAL DATA: when a Rho authorisation settles, does
    // the same transaction `id` change status, or does a second row appear? If
    // the id is stable, Canary is simpler than it needs to be and cannot double
    // count. If a new row appears, the mapper must set pending_of or burn is
    // overstated by every pending charge. A static sandbox cannot answer it.
    expect(rho.transactions.some((t) => t.pending_of)).toBe(false);
    const pending = rho.transactions.filter((t) => t.status === "pending");
    expect(pending.length).toBeGreaterThan(0);
    // Ids are unique today, so nothing is double counted in what we can see.
    expect(new Set(rho.transactions.map((t) => t.id)).size).toBe(rho.transactions.length);
  });

  it("carries every field the ledger requires, and Canary supplies the rest", async () => {
    const { rho } = await rhoStack();
    const sample = rho.transactions[0]!;

    // Required by Canary's Transaction and present from Rho, directly or derived.
    for (const field of ["id", "account_id", "date", "amount_cents", "currency", "merchant_raw", "merchant_normalized", "flow_type", "status", "source"] as const) {
      expect(sample[field]).toBeDefined();
    }
    // `category` is the one thing a bank never sends. It is Canary's job, not
    // Rho's — rules, then OpenAI, then Tavily corroboration — which is why the
    // classification package exists at all.
    expect("category" in sample).toBe(false);
  });
});

describe("reconciliation coverage — saying what was checked", () => {
  it("reports transfers as partially verified, because some arrive one-sided", async () => {
    const { rho } = await rhoStack();
    expect(rho.coverage.transfers_paired).toBe("partial");
    expect(rho.coverage.notes.some((n) => n.includes("one leg"))).toBe(true);
  });

  it("reports settlement coverage as unavailable rather than guessing it", async () => {
    const { rho } = await rhoStack();
    // Reconstruction was tested against this data and does not hold: a day's
    // repayment is not the sum of that day's purchases. A cross-check that is
    // wrong is worse than one that is absent, because it raises false alarms on
    // a real customer's books.
    expect(rho.coverage.settlement_coverage).toBe("unavailable");
  });

  it("says pending supersession is unknown instead of assuming the safe case", async () => {
    const { rho } = await rhoStack();
    expect(rho.coverage.pending_supersession).toBe("unknown");
  });

  it("claims categories as Canary's own contribution", async () => {
    const { rho } = await rhoStack();
    // The one thing no bank sends, and the reason the classification package
    // exists: rules, then OpenAI, then Tavily corroboration.
    expect(rho.coverage.categories).toBe("canary_supplied");
  });
});
