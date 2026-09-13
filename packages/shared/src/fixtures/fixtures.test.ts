import { describe, expect, it } from "vitest";
import { buildMockDerived, mockWhatIf } from "./mock-derived.ts";
import { SAMPLE_EXPECTED, SAMPLE_TRANSACTIONS } from "./sample-transactions.ts";
import { DEMO } from "../config.ts";

describe("fixtures", () => {
  it("sample transactions cash sum matches hand-verified expectation", () => {
    const cash = SAMPLE_TRANSACTIONS.filter((t) => t.account_id !== "card" && t.status !== "pending").reduce((s, t) => s + t.amount_cents, 0);
    expect(60_000_000 - cash).toBe(SAMPLE_EXPECTED.opening_balance_cents);
  });

  it("mock derived is well-formed and flagged as mock", () => {
    const d = buildMockDerived();
    expect(d.provenance.history_source).toBe("mock");
    expect(d.weeks).toHaveLength(DEMO.WEEKS);
    expect(d.cusum_statistic_cents).toHaveLength(DEMO.WEEKS);
    expect(d.primary_incident?.contributors[0]?.entity).toBe("aws");
    expect(d.burn.runway_months).not.toBeNull();
    const w = mockWhatIf(d, "aws", -20);
    expect(w.delta_monthly_cents).toBeLessThan(0);
    expect((w.scenario_runway_months ?? 0) > (w.current_runway_months ?? 0)).toBe(true);
  });

  it("mock what-if explains no-change cases without scaling a credit balance", () => {
    const d = buildMockDerived();
    const credited = {
      ...d,
      burn: {
        ...d.burn,
        weekly_variable_by_entity: { ...d.burn.weekly_variable_by_entity, linear: -50_000 },
      },
    };
    const result = mockWhatIf(credited, "linear", -20);

    expect(result.hypothetical_weekly_cents).toBe(result.current_weekly_cents);
    expect(result.delta_monthly_cents).toBe(0);
    expect(result.no_change_reason).toContain("no net spend left to change");
  });
});
