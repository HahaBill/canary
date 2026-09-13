import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { WeeklyBucket } from "@canary/shared";
import { formatUsdWhole } from "@canary/shared";
import { buildMockDerived } from "@canary/shared/fixtures";
import {
  RECENT_WEEK_LIMIT,
  WeeklyCashPanel,
  formatNetBurn,
  recentWeeks,
  toCashFlowRows,
} from "@/components/WeeklyCashPanel.tsx";
import { formatWeekLabel } from "@/lib/format.ts";

function week(start: string, outflow: number, inflow: number, net: number): WeeklyBucket {
  return {
    week_start: start,
    week_end: start,
    week_index: 0,
    variable_spend_cents: outflow,
    fixed_spend_cents: 0,
    excluded_from_monitoring_cents: 0,
    total_operating_outflow_cents: outflow,
    operating_inflow_cents: inflow,
    net_burn_cents: net,
    variable_by_entity: {},
    variable_by_category: {},
    transaction_count: 0,
  };
}

function renderPanel(weeks: WeeklyBucket[]) {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <WeeklyCashPanel weeks={weeks} />
    </MemoryRouter>,
  );
}

describe("toCashFlowRows", () => {
  it("passes engine fields through without flipping net burn into profit", () => {
    // Inflow larger than outflow: the engine already stored a negative net.
    // Plotting `-(net)` or `inflow - outflow` here would be a second formula.
    const buckets = [week("2026-09-07", 10_000, 50_000, -40_000)];
    const [row] = toCashFlowRows(buckets);

    expect(row!.outflow_cents).toBe(10_000);
    expect(row!.inflow_cents).toBe(50_000);
    expect(row!.net_burn_cents).toBe(-40_000);
    expect(row!.label).toBe(formatWeekLabel("2026-09-07"));
  });
});

describe("recentWeeks", () => {
  it("returns newest first and caps at the display limit", () => {
    const derived = buildMockDerived();
    const recent = recentWeeks(derived.weeks);

    expect(recent).toHaveLength(RECENT_WEEK_LIMIT);
    expect(recent[0]!.week_start).toBe(derived.weeks[derived.weeks.length - 1]!.week_start);
    expect(recent[recent.length - 1]!.week_start).toBe(
      derived.weeks[derived.weeks.length - RECENT_WEEK_LIMIT]!.week_start,
    );
  });
});

describe("formatNetBurn", () => {
  it("keeps a burning week unsigned and a cash-positive week signed", () => {
    expect(formatNetBurn(16_300)).toBe(formatUsdWhole(16_300));
    expect(formatNetBurn(-40_000)).toBe("-$400");
  });
});

describe("WeeklyCashPanel", () => {
  afterEach(cleanup);

  it("says so honestly when there are no weeks", () => {
    renderPanel([]);

    const region = screen.getByRole("region", { name: "Weekly operating cash" });
    expect(region).toHaveTextContent("No weekly buckets in this derived object");
    expect(region.querySelector("svg")).toBeNull();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("draws the derived series and lists the newest weeks", () => {
    const derived = buildMockDerived();
    renderPanel(derived.weeks);

    const region = screen.getByRole("region", { name: "Weekly operating cash" });
    expect(region).toHaveTextContent(`${derived.weeks.length} weeks`);

    const table = screen.getByRole("table");
    const last = derived.weeks[derived.weeks.length - 1]!;
    const lastRow = within(table).getByRole("row", { name: new RegExp(formatWeekLabel(last.week_start)) });
    expect(lastRow).toHaveTextContent(formatUsdWhole(last.total_operating_outflow_cents));
    expect(lastRow).toHaveTextContent(formatUsdWhole(last.operating_inflow_cents));
    expect(lastRow).toHaveTextContent(formatNetBurn(last.net_burn_cents));

    const oldest = derived.weeks[0]!;
    expect(within(table).queryByRole("row", { name: new RegExp(formatWeekLabel(oldest.week_start)) })).toBeNull();

    const cashPositive = recentWeeks(derived.weeks).find((w) => w.net_burn_cents < 0);
    expect(cashPositive).toBeDefined();
    const inflowRow = within(table).getByRole("row", {
      name: new RegExp(formatWeekLabel(cashPositive!.week_start)),
    });
    expect(inflowRow).toHaveTextContent(formatUsdWhole(cashPositive!.operating_inflow_cents));
    expect(inflowRow).toHaveTextContent(formatNetBurn(cashPositive!.net_burn_cents));

    expect(screen.getByRole("link", { name: "Full ledger →" })).toHaveAttribute("href", "/ledger");
  });

  it("replaces table figures when the derived weeks change", () => {
    const first = [week("2026-09-07", 20_000, 5_000, 15_000)];
    const { rerender } = renderPanel(first);

    const table = screen.getByRole("table");
    expect(within(table).getByText(formatUsdWhole(20_000))).toBeInTheDocument();

    rerender(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <WeeklyCashPanel
          weeks={[
            week("2026-09-07", 20_000, 5_000, 15_000),
            week("2026-09-14", 27_500, 8_000, 19_500),
          ]}
        />
      </MemoryRouter>,
    );

    const next = screen.getByRole("table");
    const newRow = within(next).getByRole("row", { name: /Sep 14/ });
    expect(newRow).toHaveTextContent(formatUsdWhole(27_500));
    expect(newRow).toHaveTextContent(formatUsdWhole(8_000));
  });
});
