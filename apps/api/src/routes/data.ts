/** `/api/simulate`, `/api/vendors/:entity/enrichment`, `/api/bank/*`. */
import type {
  BankAccountsResponse,
  BankTransactionsResponse,
  SimulateResponse,
  VendorEnrichmentResponse,
} from "@canary/shared";
import { jsonError, readJson, type CanaryApp } from "../context.ts";
import { parseWhatIfRequest, simulateCostChange } from "../tools.ts";

export function registerDataRoutes(app: CanaryApp): void {
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
