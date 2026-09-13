import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatMonths, formatUsdCompact, formatUsdWhole } from "@canary/shared";
import { buildMockDerived } from "@canary/shared/fixtures";
import App from "@/App.tsx";
import { buildMockPivot } from "@/api/mock-views.ts";
import { resetMockSnapshot } from "@/api/mock.ts";
import { clearApiCache } from "@/api/useDerived.ts";
import { formatNetBurn } from "@/components/WeeklyCashPanel.tsx";
import { formatDateMedium, formatPivotAmount, formatWeekLabel, formatWeeklyLevel } from "@/lib/format.ts";

function renderHome() {
  return render(
    <MemoryRouter initialEntries={["/home"]}>
      <App />
    </MemoryRouter>,
  );
}

describe("Dashboard", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_USE_MOCK", "1");
    clearApiCache();
    resetMockSnapshot();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it("renders cash, burn and runway through the shared formatters", async () => {
    const derived = buildMockDerived();
    renderHome();

    const cash = await screen.findByRole("region", { name: "Cash" });
    expect(cash).toHaveTextContent(formatUsdCompact(derived.cash_cents));
    expect(cash).toHaveTextContent(derived.company.bank_name);
    expect(cash).toHaveTextContent(formatDateMedium(derived.provenance.end_date));

    const burn = screen.getByRole("region", { name: "Current burn" });
    expect(burn).toHaveTextContent(formatUsdWhole(derived.burn.monthly_net_burn_cents));

    const runway = screen.getByRole("region", { name: "Runway" });
    expect(runway).toHaveTextContent(formatMonths(derived.burn.runway_months));
    expect(runway).toHaveTextContent("at current burn");

    const inflow = screen.getByRole("region", { name: "Operating inflow" });
    expect(inflow).toHaveTextContent(formatWeeklyLevel(derived.burn.weekly_operating_inflow_cents));
  });

  it("renders weekly outflow, inflow and net burn from the derived weeks", async () => {
    const derived = buildMockDerived();
    const last = derived.weeks[derived.weeks.length - 1]!;

    renderHome();

    const panel = await screen.findByRole("region", { name: "Weekly operating cash" });
    expect(panel).toHaveTextContent(`${derived.weeks.length} weeks`);

    const table = within(panel).getByRole("table");
    const lastRow = within(table).getByRole("row", { name: new RegExp(formatWeekLabel(last.week_start)) });
    expect(lastRow).toHaveTextContent(formatUsdWhole(last.total_operating_outflow_cents));
    expect(lastRow).toHaveTextContent(formatUsdWhole(last.operating_inflow_cents));
    expect(lastRow).toHaveTextContent(formatNetBurn(last.net_burn_cents));
  });

  it("shows the primary incident with a link to its page", async () => {
    const derived = buildMockDerived();
    const incident = derived.primary_incident!;

    renderHome();

    expect(await screen.findByText(incident.title)).toBeInTheDocument();
    const links = screen.getAllByRole("link", { name: "View incident →" });
    expect(links[0]).toHaveAttribute("href", `/incidents/${incident.id}`);
  });

  it("does not show Perch Analytics, Conversation, or Data quality", async () => {
    renderHome();

    expect(await screen.findByRole("heading", { name: "Home" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Live clock" })).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();

    expect(screen.queryByText(/Perch Analytics/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/fictional company/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Conversation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Data quality" })).not.toBeInTheDocument();
  });

  it("agrees with the ledger on cash, last-week net burn, and operating split", async () => {
    const derived = buildMockDerived();
    const last = derived.weeks[derived.weeks.length - 1]!;
    const weekly = buildMockPivot(derived, "week");
    const lastIndex = weekly.periods.length - 1;
    const cellOf = (id: string) => weekly.rows.find((row) => row.id === id)!.cells[lastIndex]!;

    expect(weekly.periods[lastIndex]!.start).toBe(last.week_start);
    expect(cellOf("section:CASH_END").amount_cents).toBe(derived.cash_cents);
    expect(cellOf("section:NET_BURN").amount_cents).toBe(last.net_burn_cents);
    expect(cellOf("section:REVENUE").amount_cents).toBe(last.operating_inflow_cents);
    expect(
      cellOf("section:VARIABLE_SPEND").amount_cents +
        cellOf("section:FIXED_SPEND").amount_cents +
        cellOf("section:ONE_OFF").amount_cents,
    ).toBe(last.total_operating_outflow_cents);

    renderHome();

    const cash = await screen.findByRole("region", { name: "Cash" });
    expect(cash).toHaveTextContent(formatUsdCompact(derived.cash_cents));

    const homeRow = within(screen.getByRole("region", { name: "Weekly operating cash" })).getByRole(
      "row",
      { name: new RegExp(formatWeekLabel(last.week_start)) },
    );
    expect(homeRow).toHaveTextContent(formatUsdWhole(last.total_operating_outflow_cents));
    expect(homeRow).toHaveTextContent(formatUsdWhole(last.operating_inflow_cents));
    expect(homeRow).toHaveTextContent(formatNetBurn(last.net_burn_cents));

    fireEvent.click(screen.getByRole("link", { name: "Full ledger →" }));

    await screen.findByRole("table", { name: /Ledger by month/ });
    fireEvent.click(screen.getByRole("radio", { name: "Weekly" }));

    const table = await screen.findByRole("table", { name: /Ledger by week/ });
    expect(table).toHaveTextContent(formatPivotAmount("CASH_END", derived.cash_cents));
    expect(table).toHaveTextContent(formatPivotAmount("NET_BURN", last.net_burn_cents));
  });
});
