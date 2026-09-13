/**
 * The Rho provider, against a fixture recorded from the live sandbox.
 *
 * Offline by construction (AGENTS.md: CI runs with no network and no secrets).
 * The live test at the bottom skips unless RHO_LIVE=1, so the same file proves
 * the mapping and, on demand, that the real endpoint still answers.
 */
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../sendblue/client.ts";
import fixture from "./fixtures/rho-sandbox.json" with { type: "json" };
import {
  RHO_FLOW_TYPES,
  RHO_SANDBOX_BASE_URL,
  RhoBankClient,
  effectiveDate,
  isPosted,
  mapAccount,
  mapTransaction,
  normalizeCounterparty,
  type RhoAccount,
  type RhoTransaction,
} from "./rho.ts";

const ACCOUNTS = fixture.accounts as unknown as RhoAccount[];
const TRANSACTIONS = fixture.transactions as unknown as RhoTransaction[];
const ASOF = "2026-09-13";

/** Serves the recorded fixture, one page, and records the requests made. */
function stubFetch(): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    const url = String(input);
    urls.push(url);
    const body = url.includes("/accounts") ? { accounts: ACCOUNTS, page: {} } : { transactions: TRANSACTIONS, page: {} };
    void init;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as FetchLike;
  return { fetchImpl, urls };
}

describe("mapping Rho's transaction types onto reconciliation", () => {
  it("keeps money that moved and drops money that did not", () => {
    // `failed` and `awaiting_approval` rows are in the feed but no cash left the
    // account. Counting them would overstate burn and break reconciliation.
    const failed = TRANSACTIONS.find((t) => t.status === "failed")!;
    expect(failed).toBeDefined();
    expect(isPosted(failed)).toBe(false);
    expect(mapTransaction(failed, ASOF)).toBeNull();

    const settled = TRANSACTIONS.find((t) => t.status === "settled")!;
    expect(mapTransaction(settled, ASOF)).not.toBeNull();
  });

  it("keeps pending rows, because the money is gone to the founder", () => {
    const pending = TRANSACTIONS.find((t) => t.status === "pending");
    if (!pending) return;
    const mapped = mapTransaction(pending, ASOF)!;
    expect(mapped.status).toBe("pending");
  });

  it("never counts the company's own money as spend", () => {
    // A savings sweep or a card repayment is not burn. Treating either as spend
    // is the classic way to report a cash crisis that is not happening.
    for (const type of ["internal_transfer", "savings_deposit", "savings_withdrawal"]) {
      expect(RHO_FLOW_TYPES[type]).toBe("INTERNAL_TRANSFER");
    }
    expect(RHO_FLOW_TYPES["credit_repayment"]).toBe("CARD_SETTLEMENT");
  });

  it("treats vendor money coming back as a refund, never as revenue", () => {
    for (const type of ["card_refund", "ach_return", "credit_repayment_refund"]) {
      expect(RHO_FLOW_TYPES[type]).toBe("REFUND");
    }
  });

  it("counts bank fees as real operating cost", () => {
    expect(RHO_FLOW_TYPES["wire_fee"]).toBe("OPERATING_OUTFLOW");
    expect(RHO_FLOW_TYPES["international_wire_fee"]).toBe("OPERATING_OUTFLOW");
  });

  it("sends an unclassifiable adjustment to Needs Review rather than guessing", () => {
    // PRD §4: unknown category is not an ignored transaction.
    expect(RHO_FLOW_TYPES["adjustment_debit"]).toBeNull();
    const adjustment = TRANSACTIONS.find((t) => t.transaction_type === "adjustment_debit" && isPosted(t));
    if (adjustment) {
      const mapped = mapTransaction(adjustment, ASOF)!;
      // It still moves cash, by its sign, and nothing claimed it.
      expect(mapped.amount_cents).toBe(adjustment.amount.amount);
    }
  });

  it("preserves Canary's sign convention exactly as Rho reports it", () => {
    for (const row of TRANSACTIONS.filter(isPosted)) {
      const mapped = mapTransaction(row, ASOF);
      if (mapped) expect(mapped.amount_cents).toBe(row.amount.amount);
    }
  });

  it("hides nothing after the as-of date", () => {
    const early = "2024-01-01";
    const mapped = TRANSACTIONS.map((t) => mapTransaction(t, early)).filter(Boolean);
    expect(mapped.every((t) => t!.date <= early)).toBe(true);
  });
});

describe("vendor identity", () => {
  it("collapses legal suffixes so a vendor has one history, not many", () => {
    // The one-off rule needs priors. If "Acme Inc." and "ACME, INC" are two
    // vendors, every payment looks like a first payment and it never fires.
    expect(normalizeCounterparty("Northstar Office Supply")).toBe("northstar_office_supply");
    expect(normalizeCounterparty("Foundry Works Inc.")).toBe(normalizeCounterparty("FOUNDRY WORKS, INC"));
    expect(normalizeCounterparty("Guangzhou Harbor Apparel Co., Ltd.")).toBe("guangzhou_harbor_apparel");
    expect(normalizeCounterparty("   ")).toBe("unknown_counterparty");
  });

  it("uses the posted date, falling back to initiated", () => {
    expect(effectiveDate({ posted_at: "2026-06-27T19:13:15Z", initiated_at: "2026-06-26T00:00:00Z" } as RhoTransaction)).toBe("2026-06-27");
    expect(effectiveDate({ posted_at: null, initiated_at: "2026-06-26T00:00:00Z" } as RhoTransaction)).toBe("2026-06-26");
  });
});

describe("accounts", () => {
  it("maps credit to card and everything else to a cash account", () => {
    const byType = new Map(ACCOUNTS.map((a) => [a.account_type, a]));
    expect(mapAccount(byType.get("credit")!).type).toBe("card");
    expect(mapAccount(byType.get("savings")!).type).toBe("savings");
    expect(mapAccount(byType.get("checking")!).type).toBe("checking");
  });

  it("carries balances through as integer cents", () => {
    for (const account of ACCOUNTS.map(mapAccount)) {
      expect(Number.isInteger(account.balance_cents)).toBe(true);
      expect(account.currency).toBe("USD");
    }
  });
});

describe("RhoBankClient.getLedger", () => {
  it("returns Canary shapes, in date order, and says what it skipped", async () => {
    const { fetchImpl, urls } = stubFetch();
    const ledger = await new RhoBankClient({ fetchImpl }).getLedger(ASOF);

    expect(ledger.base_url).toBe(RHO_SANDBOX_BASE_URL);
    expect(urls.some((u) => u.includes("page_size=100"))).toBe(true);
    expect(ledger.accounts.length).toBe(ACCOUNTS.length);
    expect(ledger.transactions.length).toBeGreaterThan(0);
    expect(ledger.transactions.length + ledger.skipped).toBe(TRANSACTIONS.length);

    const dates = ledger.transactions.map((t) => t.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it("reports transaction types it has no rule for, instead of silently bucketing them", async () => {
    // The day Rho adds a type, this is how we find out — not by a wrong burn figure.
    const { fetchImpl } = stubFetch();
    const ledger = await new RhoBankClient({ fetchImpl }).getLedger(ASOF);
    expect(ledger.unmapped).toEqual([]);
  });

  it("sends a bearer token and targets production only when given a key", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
      seen.push(String((init?.headers as Record<string, string>)?.authorization ?? ""));
      return new Response(JSON.stringify({ accounts: [], transactions: [], page: {} }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as FetchLike;

    await new RhoBankClient({ fetchImpl }).getLedger(ASOF);
    expect(seen.every((h) => h.startsWith("Bearer "))).toBe(true);
    expect(new RhoBankClient({ apiKey: "rhobat_real" }).getLedger).toBeDefined();
  });

  it("fails loudly on a non-OK response rather than reporting an empty bank", async () => {
    // An empty ledger and a broken API must never look the same: one says the
    // company spent nothing, the other says we do not know.
    const fetchImpl = (async () => new Response("nope", { status: 503 })) as unknown as FetchLike;
    await expect(new RhoBankClient({ fetchImpl }).getLedger(ASOF)).rejects.toThrow(/503/);
  });
});

describe("Canary's engine over real Rho data", () => {
  it("reconciles the sandbox ledger without any synthetic help", async () => {
    const { buildLedger } = await import("@canary/engine");
    const { fetchImpl } = stubFetch();
    const rho = await new RhoBankClient({ fetchImpl }).getLedger(ASOF);

    const cash = rho.accounts.filter((a) => a.type !== "card").reduce((s, a) => s + a.balance_cents, 0);
    const dates = rho.transactions.map((t) => t.date);
    const ledger = buildLedger({
      company: {
        name: "Rho Sandbox",
        legal_name: "Rho Sandbox",
        description: "Rho's own sandbox company, read live through the Rho API.",
        stage: "sandbox",
        headcount: 0,
        raised_cents: 0,
        bank_name: "Rho",
        as_of: ASOF,
        accounts: rho.accounts,
      },
      accounts: rho.accounts,
      transactions: rho.transactions,
      classifications: {},
      historyStart: dates[0]!,
      historyEnd: ASOF,
    });

    // The reconciliation identity holds on somebody else's data, which is the
    // whole claim: the engine is not tuned to our generator.
    expect(ledger.reconciliation.computed_closing_balance_cents).toBe(cash);
    expect(ledger.reconciliation.discrepancy_cents).toBe(0);
    expect(ledger.weeks.length).toBeGreaterThan(0);

    // Transfers and card repayments are out of burn; nothing is dropped.
    const internal = ledger.transactions.filter((t) => t.flow_type === "INTERNAL_TRANSFER" || t.flow_type === "CARD_SETTLEMENT");
    expect(internal.length).toBeGreaterThan(0);
    expect(internal.every((t) => !t.counts_in_burn)).toBe(true);
  });
});

/** Opt-in: proves the real endpoint still answers. `RHO_LIVE=1 npm test -w @canary/api` */
describe.skipIf(process.env.RHO_LIVE !== "1")("live Rho sandbox", () => {
  it("answers without credentials and maps cleanly", async () => {
    const ledger = await new RhoBankClient({ timeoutMs: 30_000 }).getLedger(ASOF);
    expect(ledger.accounts.length).toBeGreaterThan(0);
    expect(ledger.transactions.length).toBeGreaterThan(0);
    expect(ledger.unmapped).toEqual([]);
  }, 60_000);
});
