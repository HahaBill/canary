/**
 * Client-side CSV of the pivot exactly as the engine served it.
 *
 * Amounts are exported as the integer cents that came back from the API — no
 * rounding, no currency strings, no arithmetic. The column headers carry the
 * unit so a spreadsheet does not have to guess.
 */
import type { LedgerPivot } from "@canary/shared";

function escapeField(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildLedgerCsv(pivot: LedgerPivot): string {
  const header = [
    "row_id",
    "level",
    "section",
    "label",
    "entity",
    ...pivot.periods.map((period) => `${period.key}_cents`),
    "total_cents",
    "annualized_run_rate_cents",
  ];

  const lines = [header.map(escapeField).join(",")];

  for (const row of pivot.rows) {
    lines.push(
      [
        row.id,
        row.level,
        row.section,
        row.label,
        row.entity ?? "",
        ...row.cells.map((cell) => cell.amount_cents),
        row.total_cents,
        row.annualized_cents ?? "",
      ]
        .map(escapeField)
        .join(","),
    );
  }

  return `${lines.join("\n")}\n`;
}

export function ledgerCsvFilename(pivot: LedgerPivot): string {
  return `canary-ledger-${pivot.granularity}-${pivot.history_start}-to-${pivot.history_end}.csv`;
}

/** Triggers a download without leaving the SPA. */
export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
