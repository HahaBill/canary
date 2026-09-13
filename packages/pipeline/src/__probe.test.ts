import { describe, it } from "vitest";
import { DEMO, addDays } from "@canary/shared";
import { runPipeline } from "./run.ts";
describe("probe", () => {
  it("walking the last 10 days of history up to END_DATE", async () => {
    for (let d = -9; d <= 0; d++) {
      const asOf = addDays(DEMO.END_DATE, d);
      const r = await runPipeline({ asOf, horizonWeeks: DEMO.HORIZON_WEEKS });
      const inc = r.derived.primary_incident;
      console.log("ROW", asOf,
        "cash=$"+(r.derived.cash_cents/100).toFixed(2),
        "burn=$"+(r.derived.burn.monthly_net_burn_cents/100).toFixed(2),
        "runway="+r.derived.burn.runway_months,
        "win="+r.derived.burn.weeks_in_window,
        "headline=+$"+((inc?.financial_impact.delta_weekly_cents ?? 0)/100).toFixed(0),
        "id="+(inc?.id ?? "-"),
        "disc="+r.derived.reconciliation.discrepancy_cents);
    }
  }, 300_000);
});
