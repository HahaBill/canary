/** Sandbox BankProvider — the swappable seam for a real bank API. */
import { COMPANY, sandboxClosingCashCents } from "@canary/shared";
import { buildMockDerived, SAMPLE_ACCOUNTS, SAMPLE_TRANSACTIONS } from "@canary/shared/fixtures";
import { describe, expect, it } from "vitest";
import { MockDataProvider } from "../data/provider.ts";
import { sandboxBankFor, SandboxBankProvider } from "./sandbox.ts";

const bank = new SandboxBankProvider({
  getAccounts: async () => SAMPLE_ACCOUNTS,
  getTransactions: async () => SAMPLE_TRANSACTIONS,
});

describe("SandboxBankProvider", () => {
  it("identifies itself as the fictional bank", () => {
    expect(bank.name).toBe(COMPANY.bank_name);
  });

  it("returns accounts from its injected source", async () => {
    expect(await bank.getAccounts()).toEqual(SAMPLE_ACCOUNTS);
  });

  it("sums cash accounts only and excludes the card liability", async () => {
    const closing = await bank.getClosingBalance();
    expect(closing.total_cents).toBe(sandboxClosingCashCents(SAMPLE_ACCOUNTS));
    expect(Object.keys(closing.by_account)).toEqual(["chk", "sav"]);
    expect(closing.as_of).toBe("2026-09-13");
  });

  it("filters by account and date range, and orders deterministically", async () => {
    const all = await bank.getTransactions();
    expect(all.map((t) => t.id)).toEqual([...SAMPLE_TRANSACTIONS].map((t) => t.id).sort((a, b) => (a < b ? -1 : 1)));

    const chk = await bank.getTransactions({ account_id: "chk" });
    expect(chk.every((t) => t.account_id === "chk")).toBe(true);

    const window = await bank.getTransactions({ from: "2026-08-24", to: "2026-08-27" });
    expect(window.map((t) => t.date)).toEqual(["2026-08-24", "2026-08-25", "2026-08-26", "2026-08-26", "2026-08-27"]);
  });
});

describe("sandboxBankFor", () => {
  it("reads accounts from the data provider and defaults to an empty ledger", async () => {
    const derived = buildMockDerived();
    const bankFromProvider = sandboxBankFor(new MockDataProvider(derived));
    expect(await bankFromProvider.getAccounts()).toEqual(derived.accounts);
    expect(await bankFromProvider.getTransactions()).toEqual([]);
    expect((await bankFromProvider.getClosingBalance()).total_cents).toBe(derived.cash_cents);
  });
});
