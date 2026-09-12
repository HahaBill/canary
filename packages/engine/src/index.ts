/**
 * @canary/engine — the reconciliation-correct financial core.
 *
 *   buildLedger              BuildLedger              raw rows + classifications → Ledger
 *   buildWeeklyBuckets                                ledger rows → calendar-week series
 *   computeBurn              ComputeBurn              Ledger → BurnSummary (+ runway)
 *   simulateCostChange       SimulateCostChange       BurnSummary → WhatIfResult
 *   pivotLedger              PivotLedger              Ledger → LedgerPivot (the sheet)
 *   pivotCell                PivotCellLookup          one row × period → its transactions
 *   projectRecurring         ProjectRecurring         Ledger → RecurringSeries[]
 *   buildCashCalendarEvents  BuildCashCalendarEvents  actual + expected + canary events
 *
 * See docs/WORKSTREAMS.md section B and docs/PRD.md §8/§14/§19/§25.
 */
export { buildWeeklyBuckets } from "./buckets.ts";
export { buildLedger, verifyClosingBalance, type ClosingBalanceCheck } from "./ledger.ts";
export { availableOperatingCashCents, computeBurn } from "./burn.ts";
export { noChangeClause, simulateCostChange, whatIfNoChangeReason, type WhatIfNoChangeReason } from "./whatif.ts";
export {
  buildCashCalendarEvents,
  categoryLabel,
  categoryRowId,
  entityDisplayName,
  pivotCell,
  pivotLedger,
  projectRecurring,
  sectionLabel,
  sectionRowId,
  vendorRowId,
} from "./views/index.ts";
