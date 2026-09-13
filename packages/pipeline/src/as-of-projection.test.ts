/**
 * Projecting the company to an arbitrary `asOf`.
 *
 * The demo clock only ever moves forward from the end of history, so most of
 * this is exercised in one direction. But `asOf` is a parameter, the operator
 * override accepts any day inside the generated span, and the numbers have to be
 * right on every one of them — a product that is only correct on the dates the
 * demo happens to visit is not correct.
 *
 * The hard case is the gap between a card authorisation and its settlement.
 */
import { DEMO, historyStart } from "@canary/shared";
import { describe, expect, it } from "vitest";
import { runPipeline } from "./run.ts";

const full = await runPipeline({ includeFixture: true });

/** The planted pending/settled pair, found in the data rather than hard-coded. */
const settledTwin = full.generated.transactions.find((t) => t.pending_of)!;
const pendingRow = full.generated.transactions.find((t) => t.id === settledTwin.pending_of)!;

describe("the pending/settled gap", () => {
  it("plants a pair that straddles at least one day", () => {
    // Without this the test below proves nothing.
    expect(pendingRow.status).toBe("pending");
    expect(pendingRow.date < settledTwin.date).toBe(true);
  });

  it("reconciles exactly on the day the charge is pending and not yet settled", async () => {
    // THE BUG THIS CATCHES. The account balance shift used to decide which
    // pending rows were superseded by looking at every transaction the generator
    // produced, including rows dated after `asOf`. On this day the settlement
    // has not happened yet, so the pending row IS the record of the money — but
    // its future twin already existed, so the shift dropped it and reported cash
    // higher than the ledger, which counts only rows up to `asOf`.
    const run = await runPipeline({ asOf: pendingRow.date, includeFixture: true });

    expect(run.derived.reconciliation.discrepancy_cents).toBe(0);
    expect(run.derived.reconciliation.matches).toBe(true);
  });

  it("still reconciles on the day the settlement posts", async () => {
    const run = await runPipeline({ asOf: settledTwin.date, includeFixture: true });

    expect(run.derived.reconciliation.discrepancy_cents).toBe(0);
    expect(run.derived.reconciliation.matches).toBe(true);
  });

  it("counts the charge once on each side of the settlement, never twice", async () => {
    const before = await runPipeline({ asOf: pendingRow.date, includeFixture: true });
    const after = await runPipeline({ asOf: settledTwin.date, includeFixture: true });

    // Settling replaces the pending row; it does not spend the money again. So
    // the cash move between the two days is exactly the OTHER rows that posted
    // in between — the pair itself contributes nothing.
    //
    // Card rows are excluded because `cash_cents` is available operating cash,
    // which does not include the card liability.
    const cashAccounts = new Set(
      full.generated.accounts.filter((a) => a.type !== "card").map((a) => a.id),
    );
    const inWindow = full.generated.transactions.filter(
      (t) => t.date > pendingRow.date && t.date <= settledTwin.date && cashAccounts.has(t.account_id),
    );
    const posted = inWindow.reduce((sum, t) => sum + t.amount_cents, 0);
    // `before` already counted the pending row; settling removes it.
    const expected = posted - (cashAccounts.has(pendingRow.account_id) ? pendingRow.amount_cents : 0);

    expect(after.derived.cash_cents - before.derived.cash_cents).toBe(expected);

    // And the pair's own net effect across the boundary is zero.
    expect(settledTwin.amount_cents - pendingRow.amount_cents).toBe(0);
  });
});

describe("projection across the whole generated span", () => {
  it("reconciles on every week boundary from the start of history to the horizon", async () => {
    // Sampled weekly rather than daily to keep the suite fast, and anchored to
    // the generator's real first day, not to arithmetic on the end date.
    const start = historyStart(DEMO.END_DATE, DEMO.WEEKS);
    const dates: string[] = [];
    for (const tx of full.generated.transactions) {
      if (tx.date >= start && !dates.includes(tx.date)) dates.push(tx.date);
    }
    const sample = dates.filter((_, i) => i % 37 === 0);
    expect(sample.length).toBeGreaterThan(5);

    for (const asOf of sample) {
      const run = await runPipeline({ asOf, includeFixture: true });
      expect(run.derived.reconciliation.discrepancy_cents, `discrepancy at ${asOf}`).toBe(0);
    }
  }, 120_000);
});
