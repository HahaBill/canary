/**
 * @canary/engine — the reconciliation-correct financial core.
 *
 *   buildLedger         BuildLedger         raw rows + classifications → Ledger
 *   buildWeeklyBuckets                      ledger rows → calendar-week series
 *   computeBurn         ComputeBurn         Ledger → BurnSummary (+ runway)
 *   simulateCostChange  SimulateCostChange  BurnSummary → WhatIfResult
 *
 * See docs/WORKSTREAMS.md section B and docs/PRD.md §8/§14/§19/§25.
 */
export { buildWeeklyBuckets } from "./buckets.ts";
export { buildLedger, verifyClosingBalance, type ClosingBalanceCheck } from "./ledger.ts";
export { availableOperatingCashCents, computeBurn } from "./burn.ts";
export { simulateCostChange } from "./whatif.ts";
