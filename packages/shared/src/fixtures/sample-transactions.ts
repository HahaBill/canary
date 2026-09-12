/**
 * Small hand-built transaction set FOR UNIT TESTS ONLY (engine / classification / detectors).
 * Never displayed in the UI. Covers every reconciliation edge case:
 *   - internal transfer pair (checking → savings)
 *   - card purchases + one bank-side card settlement
 *   - pending row superseded by a settled row
 *   - financing inflow
 *   - refund netted against a vendor
 *   - unknown vendor (no deterministic rule)
 *   - 4 weeks so weekly bucketing is exercised
 *
 * History: 4 complete weeks, Mon 2026-08-17 → Sun 2026-09-13.
 * Closing cash (checking+savings) is defined below so tests can assert reconciliation.
 */
import type { BankAccount, Transaction } from "../types.ts";

export const SAMPLE_ACCOUNTS: BankAccount[] = [
  { id: "chk", name: "Operating Checking", type: "checking", currency: "USD", balance_cents: 50_000_000, as_of: "2026-09-13" },
  { id: "sav", name: "Reserve Savings", type: "savings", currency: "USD", balance_cents: 10_000_000, as_of: "2026-09-13" },
  { id: "card", name: "Corporate Card", type: "card", currency: "USD", balance_cents: 0, as_of: "2026-09-13" },
];

export const SAMPLE_HISTORY_START = "2026-08-17";
export const SAMPLE_HISTORY_END = "2026-09-13";
/** checking + savings */
export const SAMPLE_CLOSING_CASH_CENTS = 60_000_000;

const t = (p: Omit<Transaction, "currency" | "source" | "tags" | "status"> & Partial<Pick<Transaction, "status" | "tags">>): Transaction => ({
  currency: "USD",
  source: "synthetic",
  status: "settled",
  tags: [],
  ...p,
});

export const SAMPLE_TRANSACTIONS: Transaction[] = [
  // ---- Week 0: 2026-08-17..23 ----
  t({ id: "t001", account_id: "chk", date: "2026-08-17", amount_cents: -1_200_000, merchant_raw: "AMAZON WEB SERVICES AWS.AMAZON.CO", merchant_normalized: "aws", description: "AWS monthly", flow_type: "OPERATING_OUTFLOW", category_hint: "CLOUD_INFRASTRUCTURE" }),
  t({ id: "t002", account_id: "chk", date: "2026-08-18", amount_cents: -450_000, merchant_raw: "GUSTO PAYROLL", merchant_normalized: "gusto_payroll", description: "Payroll", flow_type: "OPERATING_OUTFLOW", category_hint: "PAYROLL" }),
  t({ id: "t003", account_id: "chk", date: "2026-08-19", amount_cents: 2_500_000, merchant_raw: "STRIPE PAYOUT", merchant_normalized: "stripe_payouts", description: "Customer payments", flow_type: "OPERATING_INFLOW", category_hint: "CUSTOMER_REVENUE" }),
  t({ id: "t004", account_id: "card", date: "2026-08-20", amount_cents: -45_000, merchant_raw: "FIGMA INC", merchant_normalized: "figma", description: "Figma seats", flow_type: "OPERATING_OUTFLOW", settlement_pair_id: "t010", category_hint: "SAAS_SOFTWARE" }),
  t({ id: "t005", account_id: "card", date: "2026-08-21", amount_cents: -18_000, merchant_raw: "DOORDASH*TEAM LUNCH", merchant_normalized: "doordash", description: "Team lunch", flow_type: "OPERATING_OUTFLOW", settlement_pair_id: "t010", category_hint: "MEALS" }),
  // internal transfer pair (net 0)
  t({ id: "t006", account_id: "chk", date: "2026-08-21", amount_cents: -5_000_000, merchant_raw: "TRANSFER TO SAVINGS", merchant_normalized: "internal_transfer", description: "Reserve top-up", flow_type: "INTERNAL_TRANSFER", transfer_pair_id: "xfer_1", category_hint: "INTERNAL_TRANSFER" }),
  t({ id: "t007", account_id: "sav", date: "2026-08-21", amount_cents: 5_000_000, merchant_raw: "TRANSFER FROM CHECKING", merchant_normalized: "internal_transfer", description: "Reserve top-up", flow_type: "INTERNAL_TRANSFER", transfer_pair_id: "xfer_1", category_hint: "INTERNAL_TRANSFER" }),

  // ---- Week 1: 2026-08-24..30 ----
  t({ id: "t008", account_id: "chk", date: "2026-08-24", amount_cents: -800_000, merchant_raw: "WEWORK RENT", merchant_normalized: "wework", description: "Office rent", flow_type: "OPERATING_OUTFLOW", category_hint: "RENT" }),
  t({ id: "t009", account_id: "chk", date: "2026-08-25", amount_cents: -300_000, merchant_raw: "UPWORK CONTRACTOR", merchant_normalized: "upwork", description: "Contractor", flow_type: "OPERATING_OUTFLOW", category_hint: "CONTRACTORS" }),
  // card settlement covering t004 + t005 (63_000). Cash leaves checking; card liability cleared.
  t({ id: "t010", account_id: "chk", date: "2026-08-26", amount_cents: -63_000, merchant_raw: "CARD PAYMENT", merchant_normalized: "card_settlement", description: "Corporate card settlement", flow_type: "CARD_SETTLEMENT", settlement_pair_id: "t010", category_hint: "CARD_SETTLEMENT" }),
  t({ id: "t011", account_id: "card", date: "2026-08-26", amount_cents: 63_000, merchant_raw: "PAYMENT RECEIVED", merchant_normalized: "card_settlement", description: "Card balance paid", flow_type: "CARD_SETTLEMENT", settlement_pair_id: "t010", category_hint: "CARD_SETTLEMENT" }),
  // unknown vendor (no rule)
  t({ id: "t012", account_id: "chk", date: "2026-08-27", amount_cents: -150_000, merchant_raw: "ASHBYHQ INC SAN FRANCISCO CA", merchant_normalized: "ashby", description: "", flow_type: "OPERATING_OUTFLOW", category_hint: "RECRUITING" }),

  // ---- Week 2: 2026-08-31..09-06 ----
  t({ id: "t013", account_id: "chk", date: "2026-08-31", amount_cents: -450_000, merchant_raw: "GUSTO PAYROLL", merchant_normalized: "gusto_payroll", description: "Payroll", flow_type: "OPERATING_OUTFLOW", category_hint: "PAYROLL" }),
  // pending row superseded by settled row t015 (engine must drop t014)
  t({ id: "t014", account_id: "chk", date: "2026-09-01", amount_cents: -220_000, merchant_raw: "DATADOG", merchant_normalized: "datadog", description: "Monitoring (pending)", flow_type: "OPERATING_OUTFLOW", status: "pending", category_hint: "SAAS_SOFTWARE" }),
  t({ id: "t015", account_id: "chk", date: "2026-09-02", amount_cents: -220_000, merchant_raw: "DATADOG", merchant_normalized: "datadog", description: "Monitoring", flow_type: "OPERATING_OUTFLOW", pending_of: "t014", category_hint: "SAAS_SOFTWARE" }),
  // refund from upwork (netted against contractors)
  t({ id: "t016", account_id: "chk", date: "2026-09-03", amount_cents: 50_000, merchant_raw: "UPWORK REFUND", merchant_normalized: "upwork", description: "Refund", flow_type: "REFUND", category_hint: "REFUND" }),
  // financing (changes cash, never revenue, never in burn)
  t({ id: "t017", account_id: "chk", date: "2026-09-04", amount_cents: 20_000_000, merchant_raw: "WIRE IN - SAFE PROCEEDS", merchant_normalized: "safe_financing", description: "SAFE", flow_type: "FINANCING", category_hint: "FINANCING" }),

  // ---- Week 3: 2026-09-07..13 ----
  t({ id: "t018", account_id: "chk", date: "2026-09-08", amount_cents: -1_600_000, merchant_raw: "AMAZON WEB SERVICES AWS.AMAZON.CO", merchant_normalized: "aws", description: "AWS monthly", flow_type: "OPERATING_OUTFLOW", category_hint: "CLOUD_INFRASTRUCTURE" }),
  t({ id: "t019", account_id: "chk", date: "2026-09-10", amount_cents: 2_500_000, merchant_raw: "STRIPE PAYOUT", merchant_normalized: "stripe_payouts", description: "Customer payments", flow_type: "OPERATING_INFLOW", category_hint: "CUSTOMER_REVENUE" }),
];

/**
 * Expected engine results for SAMPLE_TRANSACTIONS (hand-verified):
 *   cash-moving sum (chk + sav, excluding dropped pending t014 and card-account rows):
 *     -1_200_000 -450_000 +2_500_000 -5_000_000 +5_000_000 -800_000 -300_000 -63_000 -150_000
 *     -450_000 -220_000 +50_000 +20_000_000 -1_600_000 +2_500_000 = 19_817_000
 *   → opening balance = 60_000_000 - 19_817_000 = 40_183_000
 *   gross operating burn (OPERATING_OUTFLOW incl. card purchases, minus refunds):
 *     1_200_000+450_000+45_000+18_000+800_000+300_000+150_000+450_000+220_000+1_600_000 - 50_000 = 5_183_000
 *   operating inflow = 5_000_000 ; net burn = 183_000
 *   internal transfer contributes 0 ; settlement contributes 0 ; financing contributes 0 to burn
 */
export const SAMPLE_EXPECTED = {
  opening_balance_cents: 40_183_000,
  gross_operating_burn_cents: 5_183_000,
  operating_inflow_cents: 5_000_000,
  net_burn_cents: 183_000,
  pending_rows_dropped: 1,
  internal_transfer_pairs: 1,
  card_settlements: 1,
  card_purchases_covered: 2,
  financing_net_cents: 20_000_000,
  refunds_netted_cents: 50_000,
} as const;
