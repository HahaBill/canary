/**
 * Rho as a `BankProvider` — the real API, not a mock.
 *
 * The engine, detectors and UI read money through `BankProvider` (PRD §6). This
 * is that seam filled in with Rho: point it at a production token and Canary is
 * reading a real company's bank. Against the sandbox it needs no credentials at
 * all, which is what lets the integration be demonstrated live.
 *
 * WHAT THIS IS NOT. The demo does not run on Rho. Its sandbox holds 72
 * transactions spread over three years and ends 2026-06-27, so there is no
 * weekly spend series for CUSUM to watch, no planted regime change, no vendor
 * one-off and no unknown vendor for Tavily to corroborate. The detectors would
 * have nothing to find, which is a property of the fixture and not of them.
 * Canary's synthetic year stays the demo's source; this provider proves the
 * seam and reconciles whatever Rho actually returns.
 *
 * THE MAPPING IS THE POINT. Rho reports 22 transaction types. Deciding which of
 * them are operating spend, which are movements between the company's own
 * accounts, which are financing and which are refunds IS the reconciliation
 * judgement Canary exists to make — get it wrong and burn is wrong, however
 * good the detectors are. That table lives below, one line of reasoning each.
 */
import {
  type BankAccount,
  type Cents,
  type FlowType,
  type ISODate,
  type Transaction,
} from "@canary/shared";
import type { FetchLike } from "../sendblue/client.ts";

export const RHO_SANDBOX_BASE_URL = "https://rhoapi-sandbox.rho.co/api/v1";
export const RHO_PRODUCTION_BASE_URL = "https://rhoapi.rho.co/api/v1";

/** Rho pages everything; this is the per-request cap we ask for. */
const PAGE_SIZE = 100;
/** Hard stop on pagination so a malformed cursor can never spin forever. */
const MAX_PAGES = 50;

// ---------------------------------------------------------------------------
// Wire shapes (only the fields Canary reads)
// ---------------------------------------------------------------------------

interface RhoMoney {
  /** Signed minor units. Already integer cents for USD. */
  amount: number;
  currency: string;
}

export interface RhoAccount {
  id: string;
  account_name: string;
  account_type: string;
  balance: RhoMoney;
  account_number_last_4?: string;
}

export interface RhoTransaction {
  id: string;
  account_id: string;
  account_name?: string;
  account_type?: string;
  amount: RhoMoney;
  transaction_type: string;
  status: string;
  initiated_at?: string;
  posted_at?: string | null;
  counterparty_name?: string;
  memo?: string | null;
  note?: string | null;
  card_name?: string | null;
  user_full_name?: string | null;
}

// ---------------------------------------------------------------------------
// Flow-type mapping — the reconciliation judgement
// ---------------------------------------------------------------------------

/**
 * Rho transaction type → Canary flow type.
 *
 * The rule behind the table: money that left the company for a third party is
 * operating spend; money that moved between the company's own accounts is not
 * spend at all and must net to zero; money from investors or lenders changes
 * cash without touching burn; money coming back from a vendor nets against it.
 *
 * `null` means the row moves cash but is deliberately not classified here and
 * falls to NEEDS_REVIEW downstream — PRD §4, nothing falls through silently.
 */
export const RHO_FLOW_TYPES: Readonly<Record<string, FlowType | null>> = {
  // Third-party spend. The company is poorer and someone else has the money.
  card_debit: "OPERATING_OUTFLOW",
  ach_debit: "OPERATING_OUTFLOW",
  check_payment: "OPERATING_OUTFLOW",
  wire_out: "OPERATING_OUTFLOW",
  international_wire_out: "OPERATING_OUTFLOW",
  // Bank charges are real operating cost, not an accounting artefact.
  wire_fee: "OPERATING_OUTFLOW",
  international_wire_fee: "OPERATING_OUTFLOW",

  // Money back from a vendor. Nets against that vendor rather than counting as
  // revenue — a refunded charge should reduce spend, not inflate income.
  card_refund: "REFUND",
  ach_return: "REFUND",
  credit_repayment_refund: "REFUND",

  // Receipts from third parties. Customer payments look like this.
  ach_credit: "OPERATING_INFLOW",
  wire_in: "OPERATING_INFLOW",
  check_deposit: "OPERATING_INFLOW",

  // Between the company's own accounts. Never spend, never income: counting a
  // savings sweep as burn is the classic way to report a crisis that isn't one.
  internal_transfer: "INTERNAL_TRANSFER",
  savings_deposit: "INTERNAL_TRANSFER",
  savings_withdrawal: "INTERNAL_TRANSFER",

  // Paying down the card moves cash while the underlying purchases were already
  // counted as spend. Counting both double-counts every card transaction.
  credit_repayment: "CARD_SETTLEMENT",

  // Rewards are not operating income and not customer revenue. Accrual is a
  // liability Rho owes; redemption moves it into cash. Neither is burn.
  rewards_accrual: "INTERNAL_TRANSFER",
  rewards_cashback_redemption: "INTERNAL_TRANSFER",

  // Interest earned on the company's own balance. Cash, never revenue.
  savings_interest: "FINANCING",

  // A bank-side correction. It moves cash and its cause is unknown from the
  // feed alone, so it is surfaced for review rather than silently bucketed.
  adjustment_debit: null,
  adjustment_credit: null,
};

/**
 * Statuses that represent money that actually moved.
 *
 * `failed` and `awaiting_approval` rows appear in the feed but no cash left the
 * account. Including them would overstate burn and break reconciliation against
 * the reported balance. `pending` IS included: the money is gone as far as the
 * founder is concerned, and the engine already knows how to supersede a pending
 * row when its settled twin arrives.
 */
export const RHO_POSTED_STATUSES: readonly string[] = ["settled", "pending"];

export function isPosted(tx: RhoTransaction): boolean {
  return RHO_POSTED_STATUSES.includes(tx.status);
}

/** `2026-06-27T19:13:15Z` → `2026-06-27`. Posted date wins; initiated is the fallback. */
export function effectiveDate(tx: RhoTransaction): ISODate {
  return (tx.posted_at ?? tx.initiated_at ?? "").slice(0, 10);
}

/**
 * `merchant_normalized` is Canary's join key for vendor history, so it has to be
 * stable across a vendor's transactions: "Northstar Office Supply" and
 * "NORTHSTAR OFFICE SUPPLY, INC." must become one vendor or every payment looks
 * like a first payment and the one-off rule never has priors to compare against.
 */
export function normalizeCounterparty(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\b(inc|llc|ltd|co|corp|company|incorporated|plc|gmbh|sa|nv)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "unknown_counterparty";
}

/** Rho account type → Canary's three. Everything that is not credit holds cash. */
export function mapAccountType(rhoType: string): BankAccount["type"] {
  if (rhoType === "credit") return "card";
  if (rhoType === "savings") return "savings";
  return "checking";
}

export function mapAccount(account: RhoAccount): BankAccount {
  return {
    id: account.id,
    name: account.account_name,
    type: mapAccountType(account.account_type),
    currency: "USD",
    balance_cents: account.balance.amount as Cents,
    as_of: new Date().toISOString().slice(0, 10),
  };
}

/**
 * One Rho row → one Canary transaction, or `null` when no money moved.
 *
 * Sign convention is Canary's, not Rho's: inflow positive, outflow negative.
 * Rho already signs the same way for the rows we keep, so this asserts the
 * convention rather than reinterpreting it — silently flipping a sign here
 * would corrupt every downstream figure.
 */
export function mapTransaction(tx: RhoTransaction, asOf: ISODate): Transaction | null {
  if (!isPosted(tx)) return null;
  const date = effectiveDate(tx);
  if (!date || date > asOf) return null;

  const flowType = RHO_FLOW_TYPES[tx.transaction_type];
  const counterparty = tx.counterparty_name?.trim() || tx.transaction_type;
  const description = tx.memo?.trim() || tx.note?.trim() || tx.card_name?.trim() || "";

  const mapped: Transaction = {
    id: tx.id,
    account_id: tx.account_id,
    date,
    amount_cents: tx.amount.amount as Cents,
    currency: "USD",
    merchant_raw: counterparty,
    merchant_normalized: normalizeCounterparty(counterparty),
    description,
    // An unmapped type still moved cash; it is an outflow or inflow by its sign
    // and reaches Needs Review because nothing claimed it.
    flow_type: flowType ?? (tx.amount.amount < 0 ? "OPERATING_OUTFLOW" : "OPERATING_INFLOW"),
    status: tx.status === "pending" ? "pending" : "settled",
    source: "sandbox_bank",
    tags: [],
  };
  return mapped;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface RhoClientOptions {
  /** Omit for the sandbox, which accepts any non-empty bearer token. */
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface RhoLedger {
  accounts: BankAccount[];
  transactions: Transaction[];
  /** Rows that moved no money (failed, awaiting approval) — reported, not hidden. */
  skipped: number;
  /** Types with no entry in the mapping table, so a new Rho type is visible. */
  unmapped: string[];
  base_url: string;
}

export class RhoBankClient {
  private readonly baseUrl: string;

  constructor(private readonly options: RhoClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? (options.apiKey ? RHO_PRODUCTION_BASE_URL : RHO_SANDBOX_BASE_URL);
  }

  /** Sandbox takes any non-empty token; production needs a real `rhobat_` one. */
  private get token(): string {
    return this.options.apiKey?.trim() || "rhobat_sandbox";
  }

  private async page<T>(path: string, key: string, params: Record<string, string>): Promise<T[]> {
    const doFetch = this.options.fetchImpl ?? ((req: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => fetch(req, init));
    const out: T[] = [];
    let nextPageToken: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${this.baseUrl}${path}`);
      url.searchParams.set("page_size", String(PAGE_SIZE));
      for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
      if (nextPageToken) url.searchParams.set("next_page_token", nextPageToken);

      const res = await doFetch(url.toString(), {
        headers: { authorization: `Bearer ${this.token}`, accept: "application/json" },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      });
      if (!res.ok) throw new Error(`Rho ${path} responded ${res.status}`);

      const body = (await res.json()) as Record<string, unknown> & { page?: { next_page_token?: string } };
      const rows = body[key];
      if (Array.isArray(rows)) out.push(...(rows as T[]));
      nextPageToken = body.page?.next_page_token;
      if (!nextPageToken) break;
    }
    return out;
  }

  async getAccounts(): Promise<RhoAccount[]> {
    return this.page<RhoAccount>("/accounts", "accounts", {});
  }

  async getTransactions(range: { from?: ISODate; to?: ISODate } = {}): Promise<RhoTransaction[]> {
    return this.page<RhoTransaction>("/transactions", "transactions", {
      ...(range.from ? { posted_after: `${range.from}T00:00:00Z` } : {}),
      ...(range.to ? { posted_before: `${range.to}T23:59:59Z` } : {}),
    });
  }

  /** Everything Canary's engine needs, in Canary's own shapes. */
  async getLedger(asOf: ISODate): Promise<RhoLedger> {
    const [rhoAccounts, rhoTransactions] = await Promise.all([this.getAccounts(), this.getTransactions()]);

    const unmapped = new Set<string>();
    let skipped = 0;
    const transactions: Transaction[] = [];
    for (const row of rhoTransactions) {
      if (!(row.transaction_type in RHO_FLOW_TYPES)) unmapped.add(row.transaction_type);
      const mapped = mapTransaction(row, asOf);
      if (mapped) transactions.push(mapped);
      else skipped += 1;
    }
    transactions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));

    return {
      accounts: rhoAccounts.map(mapAccount),
      transactions,
      skipped,
      unmapped: [...unmapped].sort(),
      base_url: this.baseUrl,
    };
  }
}
