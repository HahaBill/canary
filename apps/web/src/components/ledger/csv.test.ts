import { describe, expect, it } from "vitest";
import { buildMockDerived } from "@canary/shared/fixtures";
import { buildMockPivot } from "@/api/mock-views.ts";
import { buildLedgerCsv, ledgerCsvFilename } from "@/components/ledger/csv.ts";

const pivot = buildMockPivot(buildMockDerived(), "month");

describe("ledger CSV", () => {
  it("exports one column per period plus the total and run-rate", () => {
    const lines = buildLedgerCsv(pivot).trimEnd().split("\n");
    const header = lines[0]!.split(",");

    expect(header.slice(0, 5)).toEqual(["row_id", "level", "section", "label", "entity"]);
    for (const period of pivot.periods) expect(header).toContain(`${period.key}_cents`);
    expect(header.slice(-2)).toEqual(["total_cents", "annualized_run_rate_cents"]);
    expect(lines).toHaveLength(pivot.rows.length + 1);
  });

  it("writes the API's integer cents through untouched", () => {
    const lines = buildLedgerCsv(pivot).trimEnd().split("\n");
    const cash = pivot.rows.find((row) => row.id === "section:CASH_END")!;
    const line = lines.find((l) => l.startsWith("section:CASH_END"))!.split(",");

    expect(line.slice(5, 5 + pivot.periods.length)).toEqual(
      cash.cells.map((cell) => String(cell.amount_cents)),
    );
    // A run-rate the engine declined to compute stays blank rather than zero.
    expect(line[line.length - 1]).toBe("");
  });

  it("names the file after the granularity and the history window", () => {
    expect(ledgerCsvFilename(pivot)).toBe(
      `canary-ledger-month-${pivot.history_start}-to-${pivot.history_end}.csv`,
    );
  });
});
