/** `/api/simulate`, `/api/vendors/:entity/enrichment`, `/api/bank/*`. */
import type {
  BankAccountsResponse,
  BankTransactionsResponse,
  SimulateResponse,
  VendorEnrichmentResponse,
} from "@canary/shared";
import { buildLedger } from "@canary/engine";
import { jsonError, readJson, type CanaryApp } from "../context.ts";
import { RhoBankClient } from "../bank/rho.ts";
import { parseWhatIfRequest, simulateCostChange } from "../tools.ts";

export function registerDataRoutes(app: CanaryApp): void {
  /**
   * `GET /api/bank/rho` — Canary's reconciliation engine run over the REAL Rho
   * API, live, through the same `BankProvider` seam the demo uses.
   *
   * This is the integration proof, not the demo. Rho's sandbox holds 72
   * transactions across three years, so there is no weekly series for the
   * detectors to watch — that is a property of the fixture, not of them. What it
   * does prove is the part that has to be right before any detector matters:
   * the engine pairs Rho's internal transfers, keeps card repayments out of
   * burn, drops rows that never moved money, and reconciles to the balance Rho
   * itself reports. On somebody else's data, so nothing is tuned to ours.
   *
   * No credentials needed against the sandbox. Set RHO_API_KEY and it reads a
   * real company's bank instead, with no other change.
   */
  app.get("/api/bank/rho", async (c) => {
    const apiKey = c.get("appEnv").RHO_API_KEY?.trim();
    const asOf = c.get("now")().slice(0, 10);
    try {
      const rho = await new RhoBankClient({ ...(apiKey ? { apiKey } : {}), timeoutMs: 25_000 }).getLedger(asOf);
      if (rho.transactions.length === 0) {
        return c.json({ source: "rho", live: true, base_url: rho.base_url, accounts: rho.accounts, transactions: [], note: "Rho returned no posted transactions." });
      }

      const dates = rho.transactions.map((t) => t.date);
      const ledger = buildLedger({
        company: {
          name: "Rho Sandbox Co", legal_name: "Rho Sandbox Co", description: "Rho's sandbox company, read live through the Rho API.",
          stage: "sandbox", headcount: 0, raised_cents: 0, bank_name: "Rho", as_of: asOf, accounts: rho.accounts,
        },
        accounts: rho.accounts,
        transactions: rho.transactions,
        // No classifier: unknown vendors land in Needs Review, which is the
        // honest state for a bank Canary has never seen before.
        classifications: {},
        historyStart: dates[0]!,
        historyEnd: asOf,
      });

      return c.json({
        source: "rho",
        live: true,
        base_url: rho.base_url,
        authenticated: Boolean(apiKey),
        as_of: asOf,
        counts: {
          accounts: rho.accounts.length,
          transactions: rho.transactions.length,
          skipped_not_posted: rho.skipped,
          unmapped_types: rho.unmapped,
        },
        // What Canary could VERIFY here, versus what it can only assume. A feed
        // is rows; a ledger is rows plus relationships, and where the feed
        // cannot support one, saying so is the product rather than a gap.
        coverage: rho.coverage,
        reconciliation: ledger.reconciliation,
        weeks: ledger.weeks.length,
        transactions: ledger.transactions.slice(-25).map((t) => ({
          id: t.id, date: t.date, merchant: t.merchant_raw, amount_cents: t.amount_cents,
          flow_type: t.flow_type, category: t.category, counts_in_burn: t.counts_in_burn,
        })),
      });
    } catch (err) {
      // An unreachable bank must never look like a bank with no money in it.
      return jsonError(c, 502, "rho_unavailable", err instanceof Error ? err.message : String(err));
    }
  });

  app.post("/api/simulate", async (c) => {
    const parsed = parseWhatIfRequest(await readJson(c));
    if (!parsed.ok) return jsonError(c, 400, parsed.error, parsed.detail);
    const body: SimulateResponse = await simulateCostChange(c.get("provider"), parsed.value);
    return c.json(body);
  });

  app.get("/api/vendors/:entity/enrichment", async (c) => {
    const enrichment = await c.get("provider").getEnrichment(c.req.param("entity"));
    const body: VendorEnrichmentResponse = { enrichment };
    return c.json(body);
  });

  app.get("/api/bank/accounts", async (c) => {
    const bank = c.get("bank");
    const [accounts, closing] = await Promise.all([bank.getAccounts(), bank.getClosingBalance()]);
    const body: BankAccountsResponse = {
      bank_name: bank.name,
      accounts,
      closing_cash_cents: closing.total_cents,
      as_of: closing.as_of,
    };
    return c.json(body);
  });

  app.get("/api/bank/transactions", async (c) => {
    const { from, to, account_id } = c.req.query();
    const body: BankTransactionsResponse = {
      transactions: await c.get("bank").getTransactions({
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(account_id ? { account_id } : {}),
      }),
    };
    return c.json(body);
  });
}
