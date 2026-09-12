import { describe, expect, it } from "vitest";
import {
  SAMPLE_ACCOUNTS,
  SAMPLE_CLOSING_CASH_CENTS,
  SAMPLE_EXPECTED,
  SAMPLE_HISTORY_END,
  SAMPLE_HISTORY_START,
  SAMPLE_TRANSACTIONS,
} from "@canary/shared/fixtures";
import { sumCents } from "@canary/shared";
import { buildLedger, verifyClosingBalance } from "./ledger.ts";
import { buildSampleLedger, classificationsFromHints, SAMPLE_COMPANY, tx } from "./test-support.ts";

const byId = (ledger: ReturnType<typeof buildSampleLedger>, id: string) => {
  const row = ledger.transactions.find((t) => t.id === id);
  if (!row) throw new Error(`missing ${id}`);
  return row;
};

describe("buildLedger — reconciliation against the bank anchor", () => {
  const ledger = buildSampleLedger();
  const r = ledger.reconciliation;

  it("derives the hand-verified opening balance", () => {
    expect(r.opening_balance_cents).toBe(SAMPLE_EXPECTED.opening_balance_cents);
    expect(r.opening_balance_cents).toBe(40_183_000);
  });

  it("closes exactly on the reported balance", () => {
    expect(r.reported_closing_balance_cents).toBe(SAMPLE_CLOSING_CASH_CENTS);
    expect(r.computed_closing_balance_cents).toBe(SAMPLE_CLOSING_CASH_CENTS);
    expect(r.matches).toBe(true);
    const netCash = sumCents(
      ledger.transactions.filter((t) => t.counts_in_cash).map((t) => t.amount_cents),
    );
    expect(netCash).toBe(19_817_000);
    expect(r.opening_balance_cents + netCash).toBe(r.reported_closing_balance_cents);
  });

  it("reports no warnings for a clean fixture", () => {
    expect(r.warnings).toEqual([]);
  });

  it("counts every reconciliation event from the fixture", () => {
    expect(r.pending_rows_dropped).toBe(SAMPLE_EXPECTED.pending_rows_dropped);
    expect(r.internal_transfer_pairs).toBe(SAMPLE_EXPECTED.internal_transfer_pairs);
    expect(r.unpaired_transfer_legs).toBe(0);
    expect(r.card_settlements).toBe(SAMPLE_EXPECTED.card_settlements);
    expect(r.card_purchases_covered).toBe(SAMPLE_EXPECTED.card_purchases_covered);
    expect(r.unpaired_settlements).toBe(0);
    expect(r.financing_net_cents).toBe(SAMPLE_EXPECTED.financing_net_cents);
    expect(r.refunds_netted_cents).toBe(SAMPLE_EXPECTED.refunds_netted_cents);
    expect(r.needs_review_count).toBe(0);
    expect(r.needs_review_outflow_cents).toBe(0);
  });

  it("reconstructs gross burn, inflow and net burn from the weekly series", () => {
    const gross = sumCents(ledger.weeks.map((w) => w.total_operating_outflow_cents));
    const inflow = sumCents(ledger.weeks.map((w) => w.operating_inflow_cents));
    expect(gross).toBe(SAMPLE_EXPECTED.gross_operating_burn_cents);
    expect(inflow).toBe(SAMPLE_EXPECTED.operating_inflow_cents);
    expect(gross - inflow).toBe(SAMPLE_EXPECTED.net_burn_cents);
  });

  it("stores integer cents everywhere", () => {
    const values = [
      ...Object.values(r).filter((v): v is number => typeof v === "number"),
      ...ledger.weeks.flatMap((w) => [
        w.variable_spend_cents,
        w.fixed_spend_cents,
        w.excluded_from_monitoring_cents,
        w.total_operating_outflow_cents,
        w.operating_inflow_cents,
        w.net_burn_cents,
        ...Object.values(w.variable_by_entity),
        ...Object.values(w.variable_by_category),
      ]),
    ];
    for (const v of values) expect(Number.isInteger(v)).toBe(true);
  });
});

describe("verifyClosingBalance", () => {
  const ledger = buildSampleLedger();

  it("confirms the identity from a known opening balance", () => {
    const check = verifyClosingBalance(ledger, SAMPLE_EXPECTED.opening_balance_cents);
    expect(check.matches).toBe(true);
    expect(check.difference_cents).toBe(0);
    expect(check.net_cash_movement_cents).toBe(19_817_000);
    expect(check.derived_opening_balance_cents).toBe(check.expected_opening_balance_cents);
  });

  it("reports the signed difference when the opening balance is wrong", () => {
    const check = verifyClosingBalance(ledger, SAMPLE_EXPECTED.opening_balance_cents + 1_000);
    expect(check.matches).toBe(false);
    expect(check.difference_cents).toBe(1_000);
  });
});

describe("buildLedger — pending/settled dedup", () => {
  it("drops a pending row that a settled row supersedes", () => {
    const ledger = buildSampleLedger();
    const pending = byId(ledger, "t014");
    const settled = byId(ledger, "t015");
    expect(pending.dropped).toBe(true);
    expect(pending.excluded_reason).toContain("t015");
    expect(pending.counts_in_burn).toBe(false);
    expect(pending.counts_in_cash).toBe(false);
    expect(settled.dropped).toBe(false);
    expect(settled.counts_in_burn).toBe(true);
    expect(settled.counts_in_cash).toBe(true);
    // The 220_000 datadog charge is counted once.
    expect(ledger.weeks[2]!.variable_by_entity["datadog"]).toBe(220_000);
  });

  it("keeps an unreferenced pending row in cash and burn", () => {
    const transactions = [
      tx({
        id: "p1",
        account_id: "chk",
        date: "2026-08-18",
        amount_cents: -100_000,
        merchant_raw: "VERCEL",
        merchant_normalized: "vercel",
        description: "Hosting (pending)",
        flow_type: "OPERATING_OUTFLOW",
        status: "pending",
        category_hint: "SAAS_SOFTWARE",
      }),
    ];
    const ledger = buildSampleLedger({ transactions });
    const row = byId(ledger, "p1");
    expect(row.dropped).toBe(false);
    expect(row.counts_in_burn).toBe(true);
    expect(row.counts_in_cash).toBe(true);
    expect(ledger.reconciliation.pending_rows_dropped).toBe(0);
    expect(ledger.weeks[0]!.variable_spend_cents).toBe(100_000);
  });

  it("warns instead of dropping when pending_of points at a settled row", () => {
    const transactions = [
      tx({
        id: "a",
        account_id: "chk",
        date: "2026-08-18",
        amount_cents: -100_000,
        merchant_raw: "VERCEL",
        merchant_normalized: "vercel",
        description: "one",
        flow_type: "OPERATING_OUTFLOW",
        category_hint: "SAAS_SOFTWARE",
      }),
      tx({
        id: "b",
        account_id: "chk",
        date: "2026-08-19",
        amount_cents: -100_000,
        merchant_raw: "VERCEL",
        merchant_normalized: "vercel",
        description: "two",
        flow_type: "OPERATING_OUTFLOW",
        pending_of: "a",
        category_hint: "SAAS_SOFTWARE",
      }),
    ];
    const ledger = buildSampleLedger({ transactions });
    expect(ledger.reconciliation.pending_rows_dropped).toBe(0);
    expect(ledger.reconciliation.warnings.join(" ")).toContain("pending_of");
  });
});

describe("buildLedger — internal transfers", () => {
  const ledger = buildSampleLedger();

  it("contributes $0 to burn and nets to zero in cash", () => {
    const out = byId(ledger, "t006");
    const inn = byId(ledger, "t007");
    expect(out.counts_in_burn).toBe(false);
    expect(inn.counts_in_burn).toBe(false);
    expect(out.counts_in_cash).toBe(true);
    expect(inn.counts_in_cash).toBe(true);
    expect(out.amount_cents + inn.amount_cents).toBe(0);
    expect(out.category).toBe("INTERNAL_TRANSFER");
    expect(inn.category).toBe("INTERNAL_TRANSFER");
    // Week 0 holds both legs but neither shows up as spend.
    expect(ledger.weeks[0]!.variable_by_entity["internal_transfer"]).toBeUndefined();
    expect(ledger.weeks[0]!.total_operating_outflow_cents).toBe(1_713_000);
  });

  it("flags legs that do not net to zero", () => {
    const transactions = SAMPLE_TRANSACTIONS.map((t) =>
      t.id === "t007" ? { ...t, amount_cents: 4_000_000 } : t,
    );
    const ledger2 = buildSampleLedger({ transactions });
    expect(ledger2.reconciliation.internal_transfer_pairs).toBe(0);
    expect(ledger2.reconciliation.unpaired_transfer_legs).toBe(2);
    expect(ledger2.reconciliation.warnings.join(" ")).toContain("sum to");
  });

  it("flags a leg with no pair id", () => {
    const transactions = SAMPLE_TRANSACTIONS.map((t) =>
      t.id === "t007" ? { ...t, transfer_pair_id: undefined } : t,
    );
    const ledger2 = buildSampleLedger({ transactions });
    expect(ledger2.reconciliation.unpaired_transfer_legs).toBe(2);
  });
});

describe("buildLedger — card settlements", () => {
  const ledger = buildSampleLedger();

  it("keeps settlement legs out of burn and the card leg out of cash", () => {
    const checkingLeg = byId(ledger, "t010");
    const cardLeg = byId(ledger, "t011");
    expect(checkingLeg.counts_in_burn).toBe(false);
    expect(cardLeg.counts_in_burn).toBe(false);
    expect(checkingLeg.counts_in_cash).toBe(true);
    expect(cardLeg.counts_in_cash).toBe(false);
    expect(checkingLeg.category).toBe("CARD_SETTLEMENT");
  });

  it("counts card purchases once, in their own week", () => {
    const figma = byId(ledger, "t004");
    const doordash = byId(ledger, "t005");
    for (const purchase of [figma, doordash]) {
      expect(purchase.counts_in_burn).toBe(true);
      expect(purchase.counts_in_cash).toBe(false);
    }
    // Purchases are dated in week 0; the settlement that covers them is week 1.
    expect(ledger.weeks[0]!.variable_by_entity["figma"]).toBe(45_000);
    expect(ledger.weeks[0]!.variable_by_entity["doordash"]).toBe(18_000);
    expect(ledger.weeks[1]!.variable_by_entity["figma"]).toBeUndefined();
    expect(ledger.weeks[1]!.variable_by_entity["doordash"]).toBeUndefined();
    // Gross burn holds 63_000 of card spend, never 126_000.
    expect(sumCents(ledger.weeks.map((w) => w.total_operating_outflow_cents))).toBe(
      SAMPLE_EXPECTED.gross_operating_burn_cents,
    );
  });

  it("verifies covered purchases equal the checking leg", () => {
    const covered = sumCents(
      ledger.transactions
        .filter((t) => t.settlement_pair_id === "t010" && t.flow_type !== "CARD_SETTLEMENT")
        .map((t) => Math.abs(t.amount_cents)),
    );
    expect(covered).toBe(Math.abs(byId(ledger, "t010").amount_cents));
    expect(ledger.reconciliation.unpaired_settlements).toBe(0);
  });

  it("warns when the settlement does not cover its purchases", () => {
    const transactions = SAMPLE_TRANSACTIONS.map((t) =>
      t.id === "t004" ? { ...t, amount_cents: -40_000 } : t,
    );
    const ledger2 = buildSampleLedger({ transactions });
    expect(ledger2.reconciliation.warnings.join(" ")).toContain("covers 58000 cents");
  });

  it("flags purchases pointing at a settlement that does not exist", () => {
    const transactions = SAMPLE_TRANSACTIONS.filter((t) => t.id !== "t010" && t.id !== "t011");
    const ledger2 = buildSampleLedger({ transactions });
    expect(ledger2.reconciliation.card_settlements).toBe(0);
    expect(ledger2.reconciliation.unpaired_settlements).toBe(1);
  });
});

describe("buildLedger — financing", () => {
  const ledger = buildSampleLedger();

  it("changes cash without touching burn or revenue", () => {
    const financing = byId(ledger, "t017");
    expect(financing.counts_in_burn).toBe(false);
    expect(financing.counts_in_cash).toBe(true);
    expect(financing.category).toBe("FINANCING");
    expect(ledger.reconciliation.financing_net_cents).toBe(20_000_000);
    // Week 2 received the SAFE wire but records no operating inflow.
    expect(ledger.weeks[2]!.operating_inflow_cents).toBe(0);
    expect(sumCents(ledger.weeks.map((w) => w.operating_inflow_cents))).toBe(5_000_000);
    // …and it is inside the cash movement that closes on the anchor.
    expect(ledger.reconciliation.opening_balance_cents).toBe(40_183_000);
  });
});

describe("buildLedger — refunds", () => {
  const ledger = buildSampleLedger();

  it("inherits the vendor's category and subtracts in its own week", () => {
    const refund = byId(ledger, "t016");
    expect(refund.category).toBe("CONTRACTORS");
    expect(refund.counts_in_burn).toBe(true);
    expect(refund.counts_in_cash).toBe(true);
    expect(ledger.weeks[1]!.variable_by_entity["upwork"]).toBe(300_000);
    expect(ledger.weeks[2]!.variable_by_entity["upwork"]).toBe(-50_000);
    expect(ledger.weeks[2]!.variable_by_category["CONTRACTORS"]).toBe(-50_000);
    expect(ledger.weeks[2]!.variable_spend_cents).toBe(170_000);
    expect(ledger.reconciliation.refunds_netted_cents).toBe(50_000);
  });

  it("falls back to REFUND when the vendor has no other classified row", () => {
    const transactions = [
      tx({
        id: "r1",
        account_id: "chk",
        date: "2026-08-18",
        amount_cents: 25_000,
        merchant_raw: "MYSTERY REFUND",
        merchant_normalized: "mystery",
        description: "Refund",
        flow_type: "REFUND",
        category_hint: "REFUND",
      }),
    ];
    const ledger2 = buildSampleLedger({ transactions });
    const refund = byId(ledger2, "r1");
    expect(refund.category).toBe("REFUND");
    expect(refund.counts_in_burn).toBe(true);
    expect(ledger2.weeks[0]!.variable_spend_cents).toBe(-25_000);
  });
});

describe("buildLedger — needs review", () => {
  const ledger = buildSampleLedger({ omitClassificationIds: ["t012"] });

  it("keeps an unclassified outflow in burn and cash", () => {
    const row = byId(ledger, "t012");
    expect(row.category).toBe("NEEDS_REVIEW");
    expect(row.classification_method).toBe("NEEDS_REVIEW");
    expect(row.tags).toContain("needs_review");
    expect(row.counts_in_burn).toBe(true);
    expect(row.counts_in_cash).toBe(true);
    expect(ledger.reconciliation.needs_review_count).toBe(1);
    expect(ledger.reconciliation.needs_review_outflow_cents).toBe(150_000);
  });

  it("does not change gross burn, inflow or the reconciliation identity", () => {
    expect(sumCents(ledger.weeks.map((w) => w.total_operating_outflow_cents))).toBe(
      SAMPLE_EXPECTED.gross_operating_burn_cents,
    );
    expect(ledger.reconciliation.opening_balance_cents).toBe(
      SAMPLE_EXPECTED.opening_balance_cents,
    );
    expect(ledger.weeks[1]!.variable_by_category["NEEDS_REVIEW"]).toBe(150_000);
    expect(ledger.weeks[1]!.variable_spend_cents).toBe(450_000);
  });

  it("does not tag flow-type-driven rows as needs review", () => {
    const all = buildSampleLedger({ omitClassificationIds: SAMPLE_TRANSACTIONS.map((t) => t.id) });
    // Transfers, settlements, financing and inflows are decided by flow type.
    for (const id of ["t003", "t006", "t007", "t010", "t011", "t017"]) {
      const row = byId(all, id);
      expect(row.tags).not.toContain("needs_review");
      expect(row.classification_method).toBe("RULE");
    }
    // The 10 live operating outflows, plus the refund that inherits their
    // unresolved category so it still nets against the same vendor.
    expect(byId(all, "t016").category).toBe("NEEDS_REVIEW");
    expect(all.reconciliation.needs_review_count).toBe(11);
    expect(all.reconciliation.needs_review_outflow_cents).toBe(5_233_000);
    expect(all.reconciliation.opening_balance_cents).toBe(SAMPLE_EXPECTED.opening_balance_cents);
    expect(sumCents(all.weeks.map((w) => w.total_operating_outflow_cents))).toBe(
      SAMPLE_EXPECTED.gross_operating_burn_cents,
    );
  });
});

describe("buildLedger — determinism and normalization", () => {
  it("produces identical output for identical input", () => {
    expect(buildSampleLedger()).toEqual(buildSampleLedger());
  });

  it("is insensitive to input ordering", () => {
    const shuffled = [...SAMPLE_TRANSACTIONS].reverse();
    expect(JSON.stringify(buildSampleLedger({ transactions: shuffled }))).toBe(
      JSON.stringify(buildSampleLedger()),
    );
  });

  it("never mutates the input transactions", () => {
    const snapshot = JSON.stringify(SAMPLE_TRANSACTIONS);
    buildSampleLedger({ oneOffTransactionIds: ["t018"] });
    expect(JSON.stringify(SAMPLE_TRANSACTIONS)).toBe(snapshot);
  });

  it("normalizes the history span to whole weeks", () => {
    const ledger = buildLedger({
      company: SAMPLE_COMPANY,
      accounts: SAMPLE_ACCOUNTS,
      transactions: SAMPLE_TRANSACTIONS,
      classifications: classificationsFromHints(SAMPLE_TRANSACTIONS),
      historyStart: "2026-08-19",
      historyEnd: "2026-09-10",
    });
    expect(ledger.history_start).toBe(SAMPLE_HISTORY_START);
    expect(ledger.history_end).toBe(SAMPLE_HISTORY_END);
    expect(ledger.weeks).toHaveLength(4);
  });

  it("warns about unknown accounts", () => {
    const transactions = SAMPLE_TRANSACTIONS.map((t) =>
      t.id === "t001" ? { ...t, account_id: "ghost" } : t,
    );
    const ledger = buildSampleLedger({ transactions });
    expect(ledger.reconciliation.warnings.join(" ")).toContain("unknown account ghost");
  });
});
