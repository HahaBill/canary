import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { formatSignedUsd, formatUsdWhole, type ReconciliationReport } from "@canary/shared";
import { buildMockDerived } from "@canary/shared/fixtures";
import { DataQualityStrip } from "@/components/DataQualityStrip.tsx";

function renderStrip(overrides: Partial<ReconciliationReport> = {}) {
  const derived = buildMockDerived();
  const reconciliation = { ...derived.reconciliation, ...overrides };
  return {
    reconciliation,
    ...render(<DataQualityStrip reconciliation={reconciliation} needsReview={derived.needs_review} />),
  };
}

describe("DataQualityStrip", () => {
  afterEach(cleanup);

  it("reports a clean reconciliation and where the opening balance came from", () => {
    const { reconciliation } = renderStrip({ matches: true, opening_balance_reported: true, warnings: [] });

    const strip = screen.getByRole("region", { name: "Data quality" });
    expect(strip).toHaveTextContent("Reconciled");
    expect(strip).toHaveTextContent("opening balance from bank statement");
    expect(strip).toHaveTextContent(`${formatUsdWhole(reconciliation.refunds_netted_cents)} refunds netted`);
    expect(screen.queryByText(/^Notes/)).not.toBeInTheDocument();
  });

  it("names the discrepancy when the closing balance does not tie out", () => {
    renderStrip({ matches: false, discrepancy_cents: -12_345, opening_balance_reported: false });

    const strip = screen.getByRole("region", { name: "Data quality" });
    expect(strip).toHaveTextContent("Reconciliation mismatch");
    expect(strip).toHaveTextContent(`${formatSignedUsd(-12_345)} reported minus computed`);
    expect(strip).toHaveTextContent("opening balance derived");
  });

  it("lists the reconciliation warnings in a collapsed Notes section", () => {
    const warnings = [
      "2 transactions had no merchant on the statement",
      "1 pending row had no settled counterpart",
    ];
    renderStrip({ matches: false, discrepancy_cents: 500, warnings });

    const notes = screen.getByText(`Notes (${warnings.length})`);
    expect(notes.closest("details")).not.toHaveAttribute("open");

    fireEvent.click(notes);
    for (const warning of warnings) {
      expect(screen.getByText(warning)).toBeInTheDocument();
    }
  });
});
