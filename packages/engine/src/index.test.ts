import { expect, it } from "vitest";
import {
  buildCashCalendarEvents,
  buildLedger,
  buildWeeklyBuckets,
  computeBurn,
  pivotCell,
  pivotLedger,
  projectRecurring,
  simulateCostChange,
  verifyClosingBalance,
} from "@canary/engine";
import type {
  BuildCashCalendarEvents,
  BuildLedger,
  ComputeBurn,
  PivotCellLookup,
  PivotLedger,
  ProjectRecurring,
  SimulateCostChange,
} from "@canary/shared";

it("exports the contract surface through the package entry point", () => {
  // Assignability to contracts.ts is the integration guarantee.
  const ledger: BuildLedger = buildLedger;
  const burn: ComputeBurn = computeBurn;
  const whatIf: SimulateCostChange = simulateCostChange;
  const pivot: PivotLedger = pivotLedger;
  const cell: PivotCellLookup = pivotCell;
  const recurring: ProjectRecurring = projectRecurring;
  const calendar: BuildCashCalendarEvents = buildCashCalendarEvents;
  for (const fn of [
    ledger,
    burn,
    whatIf,
    pivot,
    cell,
    recurring,
    calendar,
    buildWeeklyBuckets,
    verifyClosingBalance,
  ]) {
    expect(typeof fn).toBe("function");
  }
});
