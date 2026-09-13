/**
 * The live demo clock driving the REAL pipeline provider.
 *
 * Everything else in this suite runs against injected fakes. This one runs the
 * actual generator → engine → detectors path at several simulated instants,
 * because the promise the demo makes is that the numbers move on their own and
 * stay correct while they do.
 */
import { describe, expect, it } from "vitest";
import { demoAsOf, DEFAULT_MINUTES_PER_DAY } from "../clock.ts";
import { PipelineDataProvider } from "./pipeline-provider.ts";

const at = (minutes: number) => new Date(minutes * 60_000);

/** A provider whose clock the test moves by hand. */
function movingClock() {
  let minute = 0;
  const provider = new PipelineDataProvider({ asOf: () => demoAsOf(at(minute)) });
  return { provider, set: (m: number) => { minute = m; } };
}

describe("the dashboard as the clock advances", () => {
  it("moves the account forward and keeps cash reconciled at every step", async () => {
    const { provider, set } = movingClock();
    const minutes = [0, DEFAULT_MINUTES_PER_DAY * 3, DEFAULT_MINUTES_PER_DAY * 20, DEFAULT_MINUTES_PER_DAY * 60];

    const snapshots = [];
    for (const minute of minutes) {
      set(minute);
      snapshots.push(await provider.getDerived());
    }

    for (let i = 1; i < snapshots.length; i++) {
      const before = snapshots[i - 1]!;
      const after = snapshots[i]!;

      // Time moves forward, and so does the ledger.
      expect(after.provenance.end_date > before.provenance.end_date).toBe(true);
      expect(after.weeks.length).toBeGreaterThanOrEqual(before.weeks.length);
      // The company is burning, so cash falls as days post.
      expect(after.cash_cents).toBeLessThan(before.cash_cents);
    }

    // The whole point: none of that movement is allowed to break the books.
    for (const snapshot of snapshots) {
      expect(snapshot.reconciliation.matches).toBe(true);
      expect(snapshot.reconciliation.discrepancy_cents).toBe(0);
      expect(snapshot.burn.runway_months).not.toBeNull();
      expect(snapshot.cash_cents).toBe(snapshot.burn.available_operating_cash_cents);
    }
  });

  it("keeps finding the planted shift as the future posts", async () => {
    const { provider, set } = movingClock();

    for (const minute of [0, DEFAULT_MINUTES_PER_DAY * 30]) {
      set(minute);
      const derived = await provider.getDerived();
      const shift = derived.incidents.find((i) => i.type === "BURN_RATE_SHIFT");

      expect(shift).toBeDefined();
      expect(shift!.detection.cusum!.fired).toBe(true);
      // A detector that stopped working the moment new data arrived would be
      // worse than one that never ran.
      expect(derived.needs_review.count).toBeGreaterThan(0);
    }
  });

  it("serves the same snapshot twice inside one simulated day", async () => {
    const { provider, set } = movingClock();
    set(0);
    const first = await provider.getDerived();
    const second = await provider.getDerived();

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
