/**
 * TEST ONLY. The 20-week demo ledger, built the way the pipeline builds it:
 * generator rows → classifications → `buildLedger` with the planted one-off
 * tagged (the detector's job in production, `category_hint` here).
 *
 * The view tests assert against this rather than hand-written numbers, so every
 * figure they check traces back to the generator.
 */
import { DEFAULT_DEMO_OPTIONS, generateDemoCompany } from "@canary/generator";
import { DEMO, type GeneratedCompany, type Ledger } from "@canary/shared";
import { buildLedger } from "../ledger.ts";
import { classificationsFromHints } from "../test-support.ts";

export interface DemoLedger {
  demo: GeneratedCompany;
  ledger: Ledger;
}

export interface DemoLedgerOptions {
  /** `false` leaves the planted Figma true-up in variable spend. */
  tagOneOff?: boolean;
  /** `test` adds financing, an annual renewal and the messy statement shapes. */
  profile?: "demo" | "test";
}

export function buildDemoLedger({ tagOneOff = true, profile = "demo" }: DemoLedgerOptions = {}): DemoLedger {
  const demo = generateDemoCompany({
    ...DEFAULT_DEMO_OPTIONS,
    profile,
    seed: profile === "test" ? DEMO.TEST_SEED : DEFAULT_DEMO_OPTIONS.seed,
  });
  const ledger = buildLedger({
    company: demo.company,
    accounts: demo.accounts,
    transactions: demo.transactions,
    classifications: classificationsFromHints(demo.transactions),
    oneOffTransactionIds: tagOneOff ? [demo.fixture.one_off.transaction_id] : [],
    historyStart: demo.fixture.start_date,
    historyEnd: demo.fixture.end_date,
    expectedOpeningBalanceCents: demo.fixture.opening_balance_cents,
  });
  return { demo, ledger };
}
