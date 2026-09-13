/**
 * The live demo clock driving the REAL pipeline provider.
 *
 * Everything else in this suite runs against injected fakes. This one runs the
 * actual generator → engine → detectors path at several simulated instants,
 * because the promise the demo makes is that the numbers move on their own and
 * stay correct while they do.
 */
import { describe, expect, it } from "vitest";
import { CYCLE_MINUTES, demoAsOf, DEFAULT_MINUTES_PER_DAY } from "../clock.ts";
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
    // Inside ONE cycle: the clock returns to the end of history at the top of
    // each, so a range that wraps would not be moving forward at all.
    const step = Math.max(1, Math.floor(CYCLE_MINUTES / 4));
    const minutes = [0, step, step * 2, step * 3].map((m) => m * DEFAULT_MINUTES_PER_DAY);
    expect(minutes[minutes.length - 1]!).toBeLessThan(CYCLE_MINUTES);

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
    }

    // Cash trends DOWN across the window, but not necessarily on every step: a
    // revenue payout lands weekly, so an individual day can end richer than it
    // started. Asserting a fall per step would be asserting that customers never
    // pay, which is a worse bug than the one it would catch.
    expect(snapshots[snapshots.length - 1]!.cash_cents).toBeLessThan(snapshots[0]!.cash_cents);

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

    for (const minute of [0, Math.floor(CYCLE_MINUTES / 2) * DEFAULT_MINUTES_PER_DAY]) {
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

describe("the horizon is fuel, never history", () => {
  it("lists no transaction dated after the clock, on any surface", async () => {
    // The generator's future rows exist so the demo can reveal them a day at a
    // time. Until the clock reaches a row it has not happened, and a founder
    // asking "show me my transactions" must never see it — the future is only
    // ever a labelled projection.
    const { provider, set } = movingClock();
    set(DEFAULT_MINUTES_PER_DAY * 5);
    const derived = await provider.getDerived();
    const today = derived.provenance.end_date;

    const bank = await provider.getTransactions();
    expect(bank.length).toBeGreaterThan(600);
    expect(bank.filter((t) => t.date > today)).toEqual([]);

    // Newest-first is exactly where a leak would surface in a text reply.
    const listed = await provider.listTransactions({ limit: 10 });
    expect(listed.items.length).toBeGreaterThan(0);
    for (const row of listed.items) {
      expect(row.date <= today).toBe(true);
    }
  });

  it("still moves: a later clock reveals rows the earlier one hid", async () => {
    const { provider, set } = movingClock();
    set(0);
    const before = (await provider.getTransactions()).length;
    set(DEFAULT_MINUTES_PER_DAY * 8);
    const after = (await provider.getTransactions()).length;

    expect(after).toBeGreaterThan(before);
  });
});
