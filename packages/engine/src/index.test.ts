import { expect, it } from "vitest";
import {
  buildLedger,
  buildWeeklyBuckets,
  computeBurn,
  simulateCostChange,
  verifyClosingBalance,
} from "@canary/engine";
import type { BuildLedger, ComputeBurn, SimulateCostChange } from "@canary/shared";

it("exports the contract surface through the package entry point", () => {
  // Assignability to contracts.ts is the integration guarantee.
  const ledger: BuildLedger = buildLedger;
  const burn: ComputeBurn = computeBurn;
  const whatIf: SimulateCostChange = simulateCostChange;
  for (const fn of [ledger, burn, whatIf, buildWeeklyBuckets, verifyClosingBalance]) {
    expect(typeof fn).toBe("function");
  }
});
