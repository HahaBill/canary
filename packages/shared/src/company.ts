/**
 * The fictional company and its sandbox bank closing balances.
 * These balances are the ANCHOR the generator closes on (contract §3).
 * They are inputs, not derived figures; everything else must be computed.
 */
import type { BankAccount, CompanyProfile } from "./types.ts";
import { DEMO } from "./config.ts";

export const ACCOUNT_IDS = {
  CHECKING: "acct_checking_7741",
  SAVINGS: "acct_savings_2210",
  CARD: "acct_card_9082",
} as const;

export const SANDBOX_ACCOUNTS: BankAccount[] = [
  {
    id: ACCOUNT_IDS.CHECKING,
    name: "Operating Checking",
    type: "checking",
    currency: "USD",
    balance_cents: 141_288_019, // $1,412,880.19
    as_of: DEMO.END_DATE,
  },
  {
    id: ACCOUNT_IDS.SAVINGS,
    name: "Reserve Savings",
    type: "savings",
    currency: "USD",
    balance_cents: 60_000_000, // $600,000.00
    as_of: DEMO.END_DATE,
  },
  {
    id: ACCOUNT_IDS.CARD,
    name: "Corporate Card",
    type: "card",
    currency: "USD",
    balance_cents: 0, // fully settled at as_of
    as_of: DEMO.END_DATE,
  },
];

export const COMPANY: CompanyProfile = {
  name: "Perch Analytics",
  legal_name: "Perch Analytics, Inc.",
  description: "Fictional seed-stage B2B analytics SaaS company used for the Canary demo.",
  stage: "Seed",
  headcount: 14,
  raised_cents: 300_000_000, // $3.0M (opening balance ~$2.66M must be ≤ raised)
  bank_name: "Canary Sandbox Bank",
  as_of: DEMO.END_DATE,
  accounts: SANDBOX_ACCOUNTS,
};

/** Checking + savings. Card liability excluded. */
export function sandboxClosingCashCents(accounts: BankAccount[] = SANDBOX_ACCOUNTS): number {
  return accounts.filter((a) => a.type !== "card").reduce((s, a) => s + a.balance_cents, 0);
}
