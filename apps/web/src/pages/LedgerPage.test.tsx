import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMockDerived } from "@canary/shared/fixtures";
import { buildMockPivot } from "@/api/mock-views.ts";
import { resetMockSnapshot } from "@/api/mock.ts";
import { clearApiCache } from "@/api/useDerived.ts";
import { formatPivotAmount, formatUsdWhole } from "@/lib/format.ts";
import { installApiStub, renderApp, setViewport, type RecordedRequest } from "@/test-utils.tsx";

const derived = buildMockDerived();
const monthly = buildMockPivot(derived, "month");

function rowById(id: string) {
  const row = monthly.rows.find((r) => r.id === id);
  if (!row) throw new Error(`No pivot row "${id}" in the fixture`);
  return row;
}

describe("LedgerPage", () => {
  let requests: RecordedRequest[];

  beforeEach(() => {
    ({ requests } = installApiStub());
    setViewport(1280);
    window.localStorage.clear();
    clearApiCache();
    resetMockSnapshot();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the sections and period columns the engine returned", async () => {
    renderApp("/ledger");

    const table = await screen.findByRole("table", { name: /Ledger by month/ });

    for (const label of ["Revenue", "Variable spend", "Fixed spend", "Net burn", "Cash at period end"]) {
      expect(within(table).getByRole("rowheader", { name: new RegExp(label) })).toBeInTheDocument();
    }

    // Monthly is the default, so the columns are month labels plus run-rate.
    expect(within(table).getByRole("columnheader", { name: /Sep 2026/ })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: /run-rate/ })).toBeInTheDocument();

    const variable = rowById("section:VARIABLE_SPEND");
    const lastIndex = monthly.periods.length - 1;
    expect(table).toHaveTextContent(
      formatUsdWhole(variable.cells[lastIndex]!.amount_cents).replace(/\u00a0/g, " "),
    );
    // Cash is the bank-anchored balance, rendered compact.
    expect(table).toHaveTextContent(
      formatPivotAmount("CASH_END", rowById("section:CASH_END").cells[lastIndex]!.amount_cents),
    );
  });

  it("asks the API for weekly buckets when the granularity changes", async () => {
    renderApp("/ledger");
    await screen.findByRole("table", { name: /Ledger by month/ });
    expect(requests.find((r) => r.path === "/api/ledger")?.params.get("granularity")).toBe("month");

    fireEvent.click(screen.getByRole("radio", { name: "Weekly" }));

    await screen.findByRole("table", { name: /Ledger by week/ });
    const weekly = requests.filter(
      (r) => r.path === "/api/ledger" && r.params.get("granularity") === "week",
    );
    expect(weekly).toHaveLength(1);
    // Weeks are labelled by their Monday.
    expect(screen.getByRole("columnheader", { name: /Sep 7/ })).toBeInTheDocument();
  });

  it("keeps categories collapsed until asked, then shows their vendors", async () => {
    renderApp("/ledger");
    const table = await screen.findByRole("table", { name: /Ledger by month/ });

    expect(within(table).getByRole("rowheader", { name: /Cloud Infrastructure/ })).toBeInTheDocument();
    expect(within(table).queryByRole("rowheader", { name: /AWS/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expand Cloud Infrastructure" }));

    expect(within(table).getByRole("rowheader", { name: /AWS/ })).toBeInTheDocument();
    // Vendor rows link to the incident they drive.
    expect(
      within(table).getByRole("link", { name: /Open the incident driven by AWS/ }),
    ).toHaveAttribute("href", `/incidents/${derived.primary_incident!.id}`);
  });

  it("opens the transactions behind a vendor cell", async () => {
    renderApp("/ledger");
    await screen.findByRole("table", { name: /Ledger by month/ });
    fireEvent.click(screen.getByRole("button", { name: "Expand Cloud Infrastructure" }));

    const lastPeriod = monthly.periods[monthly.periods.length - 1]!;
    const amount = formatUsdWhole(rowById("vendor:aws").cells[monthly.periods.length - 1]!.amount_cents);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`AWS in Sep 2026`) }));

    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText(/AWS · Sep 2026/)).toBeInTheDocument();
    expect(sheet).toHaveTextContent(amount.replace(/\u00a0/g, " "));
    expect(within(sheet).getAllByText(/AWS MOCK DESCRIPTOR/).length).toBeGreaterThan(0);

    const cellRequest = requests.find((r) => r.path === "/api/ledger/cell");
    expect(cellRequest?.params.get("row_id")).toBe("vendor:aws");
    expect(cellRequest?.params.get("period_key")).toBe(lastPeriod.key);
  });

  it("marks the first period after the confirmed change point", async () => {
    renderApp("/ledger");
    await screen.findByRole("table", { name: /Ledger by month/ });

    const firstPost = monthly.periods.find((p) => p.post_change);
    expect(firstPost).toBeDefined();
    await waitFor(() => expect(screen.getByText("change point")).toBeInTheDocument());
  });

  it("filters the sheet from a natural-language query and opens the matching vendors", async () => {
    renderApp("/ledger");
    const table = await screen.findByRole("table", { name: /Ledger by month/ });
    expect(within(table).queryByRole("rowheader", { name: /AWS/ })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: /Filter the ledger/ }), { target: { value: "AWS" } });

    expect(within(table).getByRole("rowheader", { name: /AWS/ })).toBeInTheDocument();
    expect(within(table).queryByRole("rowheader", { name: /Revenue/ })).not.toBeInTheDocument();
    expect(within(table).queryByRole("rowheader", { name: /Datadog/ })).not.toBeInTheDocument();
    expect(screen.getByRole("search")).toHaveTextContent("AWS");
  });

  it("narrows period columns when the query is about the change point", async () => {
    renderApp("/ledger");
    const table = await screen.findByRole("table", { name: /Ledger by month/ });
    const before = within(table).getAllByRole("columnheader").length;

    fireEvent.change(screen.getByRole("searchbox", { name: /Filter the ledger/ }), {
      target: { value: "after the change" },
    });

    expect(within(table).getAllByRole("columnheader").length).toBeLessThan(before);
    expect(screen.getByText("after the change")).toBeInTheDocument();
  });

  it("clears the filter and restores the full sheet", async () => {
    renderApp("/ledger");
    const table = await screen.findByRole("table", { name: /Ledger by month/ });
    fireEvent.change(screen.getByRole("searchbox", { name: /Filter the ledger/ }), { target: { value: "AWS" } });
    expect(within(table).queryByRole("rowheader", { name: /Revenue/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear ledger filter" }));

    expect(within(table).getByRole("rowheader", { name: /Revenue/ })).toBeInTheDocument();
    expect(within(table).queryByRole("rowheader", { name: /AWS/ })).not.toBeInTheDocument();
  });

  it("surfaces an error with a retry when the ledger route rejects the request", async () => {
    // A 4xx is a real answer, so the app must show it rather than quietly
    // falling back to fixtures the way it does for an unreachable API.
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: false,
        status: 400,
        text: () => Promise.resolve(JSON.stringify({ error: "Unknown granularity" })),
      } as unknown as Response),
    );
    renderApp("/ledger");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load this view");
    expect(alert).toHaveTextContent("Unknown granularity");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
