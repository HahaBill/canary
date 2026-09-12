/**
 * Canary Sandbox Bank — the fictional bank behind the shared `BankProvider`
 * seam (docs/BUILD.md Rule 0.5). A real bank API drops in here without the
 * engine, detectors, or UI noticing.
 */
import { COMPANY, sandboxClosingCashCents, type BankAccount, type BankProvider, type Cents, type ISODate, type Transaction } from "@canary/shared";
import type { DataProvider } from "../data/provider.ts";

export interface SandboxBankSource {
  getAccounts(): Promise<BankAccount[]>;
  getTransactions(): Promise<Transaction[]>;
}

export class SandboxBankProvider implements BankProvider {
  readonly name: string;

  constructor(
    private readonly source: SandboxBankSource,
    name: string = COMPANY.bank_name,
  ) {
    this.name = name;
  }

  async getAccounts(): Promise<BankAccount[]> {
    return this.source.getAccounts();
  }

  async getTransactions(params: { from?: ISODate; to?: ISODate; account_id?: string } = {}): Promise<Transaction[]> {
    const all = await this.source.getTransactions();
    return all
      .filter((t) => {
        if (params.account_id && t.account_id !== params.account_id) return false;
        if (params.from && t.date < params.from) return false;
        if (params.to && t.date > params.to) return false;
        return true;
      })
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async getClosingBalance(): Promise<{ total_cents: Cents; as_of: ISODate; by_account: Record<string, Cents> }> {
    const accounts = await this.getAccounts();
    const cash = accounts.filter((a) => a.type !== "card");
    const by_account: Record<string, Cents> = {};
    for (const a of cash) by_account[a.id] = a.balance_cents;
    const as_of = cash.reduce<ISODate>((latest, a) => (a.as_of > latest ? a.as_of : latest), cash[0]?.as_of ?? COMPANY.as_of);
    return { total_cents: sandboxClosingCashCents(accounts), as_of, by_account };
  }
}

/**
 * Sandbox bank backed by the derived object's accounts. Transactions default to
 * empty until the lead wires the generator's ledger through `getTransactions`.
 */
export function sandboxBankFor(provider: DataProvider, getTransactions?: () => Promise<Transaction[]>): SandboxBankProvider {
  return new SandboxBankProvider({
    async getAccounts() {
      return (await provider.getDerived()).accounts;
    },
    async getTransactions() {
      return getTransactions ? getTransactions() : [];
    },
  });
}
