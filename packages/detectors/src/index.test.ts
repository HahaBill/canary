/**
 * Package surface: the exports must be assignable to the shared contracts, and
 * the documented call order must work end to end.
 */
import type { BuildIncidents, DecomposeContributors, DetectOneOffs, RunCusum } from "@canary/shared";
import { describe, expect, it } from "vitest";
import {
  buildIncidents,
  decomposeContributors,
  detectOneOffs,
  evaluateOneOffMateriality,
  evaluateRateMateriality,
  ewma,
  regimeStartIndex,
  runCusum,
} from "./index.ts";
import { buildWeeks, makeBurn, makeLedger, makeTx, priorPayments } from "./test-helpers.ts";

// Compile-time conformance: these fail `npm run typecheck`, not at runtime.
const _detectOneOffs: DetectOneOffs = detectOneOffs;
const _runCusum: RunCusum = runCusum;
const _decompose: DecomposeContributors = decomposeContributors;
const _buildIncidents: BuildIncidents = buildIncidents;
void [_detectOneOffs, _runCusum, _decompose, _buildIncidents];

describe("@canary/detectors", () => {
  it("exports the functions the pipeline wires together", () => {
    for (const fn of [detectOneOffs, runCusum, decomposeContributors, buildIncidents, evaluateRateMateriality, evaluateOneOffMateriality, ewma]) {
      expect(typeof fn).toBe("function");
    }
  });

  it("runs the documented detector order end to end", () => {
    const weeks = buildWeeks();
    const ledger = makeLedger(
      [
        makeTx({ id: "aws_1", date: "2026-09-07", amount_cents: -420_000, merchant_normalized: "aws" }),
        ...priorPayments("figma", [4_200_00, 4_500_00, 4_800_00], "2026-08-01"),
        makeTx({ id: "figma_spike", date: "2026-09-05", amount_cents: -1_800_000, merchant_normalized: "figma" }),
      ],
      weeks,
    );
    const burnBefore = makeBurn({ monthly_gross_burn_cents: 10_000_000, runway_months: 25 });
    const burnAfter = makeBurn({ monthly_gross_burn_cents: 10_000_000, runway_months: 22 });

    const oneOffs = detectOneOffs(ledger, burnAfter);
    const cusum = runCusum(weeks);
    const contributors = decomposeContributors(weeks, cusum);
    const incidents = buildIncidents({
      ledger,
      cusum,
      contributors,
      oneOffs,
      burnBefore,
      burnAfter,
      existing: [],
      now: "2026-09-12T17:00:00.000Z",
    });

    // The engine's `regimeStartWeekIndex` is the change point index + 1.
    expect(regimeStartIndex(cusum)).toBe(cusum.estimated_change_point_index! + 1);
    expect(weeks[regimeStartIndex(cusum)!]!.week_start).toBe(cusum.estimated_change_point_week_start);

    expect(incidents.map((i) => i.type)).toEqual(["BURN_RATE_SHIFT", "ONE_OFF_VENDOR_PAYMENT"]);
    expect(ewma(weeks.map((w) => w.variable_spend_cents), 0.3)).toHaveLength(weeks.length);
    expect(evaluateRateMateriality(cusum.delta_weekly_cents, burnBefore, burnAfter).material).toBe(true);
    expect(evaluateOneOffMateriality(oneOffs.find((o) => o.is_anomalous)!.current_amount_cents, burnAfter).material).toBe(true);
  });
});
