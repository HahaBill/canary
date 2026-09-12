import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatMonths, formatUsdCompact, formatUsdWhole } from "@canary/shared";
import { buildMockDerived } from "@canary/shared/fixtures";
import App from "@/App.tsx";
import { clearApiCache } from "@/api/useDerived.ts";
import { resetMockSnapshot } from "@/api/mock.ts";

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
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );

    const cash = await screen.findByRole("region", { name: "Cash" });
    expect(cash).toHaveTextContent(formatUsdCompact(derived.cash_cents));
    expect(cash).toHaveTextContent(derived.company.bank_name);

    const burn = screen.getByRole("region", { name: "Current burn" });
    expect(burn).toHaveTextContent(formatUsdWhole(derived.burn.monthly_net_burn_cents));

    const runway = screen.getByRole("region", { name: "Runway" });
    expect(runway).toHaveTextContent(formatMonths(derived.burn.runway_months));
    expect(runway).toHaveTextContent("at current burn");
  });

  it("shows the primary incident with a link to its page", async () => {
    const derived = buildMockDerived();
    const incident = derived.primary_incident!;

    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText(incident.title)).toBeInTheDocument();
    const links = screen.getAllByRole("link", { name: "View incident →" });
    expect(links[0]).toHaveAttribute("href", `/incidents/${incident.id}`);
  });

  it("surfaces reconciliation and needs-review counts", async () => {
    const derived = buildMockDerived();
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );

    const strip = await screen.findByRole("region", { name: "Data quality" });
    expect(strip).toHaveTextContent("Reconciled");
    expect(strip).toHaveTextContent(`${derived.reconciliation.pending_rows_dropped} pending dropped`);
    expect(strip).toHaveTextContent(formatUsdWhole(derived.needs_review.outflow_cents));
  });
});
