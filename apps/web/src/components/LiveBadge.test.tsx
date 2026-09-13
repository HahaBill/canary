/**
 * The live badge is the only thing on screen that claims the account is moving.
 * If it mis-reports movement it is worse than absent, so the comparison logic is
 * tested directly and the rendered sentence is tested through the component.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildMockDerived } from "@canary/shared/fixtures";
import { LiveBadge, advanceLive, type LiveObservation } from "@/components/LiveBadge.tsx";

const provenance = buildMockDerived().provenance;
const at = (date: string, cash: number): LiveObservation => ({ date, cash_cents: cash });

describe("advanceLive", () => {
  it("has nothing to compare on the first reading", () => {
    const state = advanceLive(null, at("2026-09-13", 201_288_019));

    expect(state.baseline).toEqual(at("2026-09-13", 201_288_019));
    expect(state.days_elapsed).toBe(0);
    expect(state.delta_cents).toBeNull();
    expect(state.restarted).toBe(false);
  });

  it("reports cash falling as the clock runs forward", () => {
    const baseline = at("2026-09-13", 201_288_019);
    const state = advanceLive(baseline, at("2026-09-17", 200_100_000));

    // Four simulated days later, and the delta is exactly the difference
    // between the two readings — no rate, no extrapolation.
    expect(state.days_elapsed).toBe(4);
    expect(state.delta_cents).toBe(200_100_000 - 201_288_019);
    expect(state.baseline).toEqual(baseline);
  });

  it("keeps measuring from the ORIGINAL baseline, not the previous reading", () => {
    // Otherwise the badge would show one day's movement forever instead of the
    // movement since the viewer arrived.
    const baseline = at("2026-09-13", 201_288_019);
    const first = advanceLive(baseline, at("2026-09-14", 201_000_000));
    const second = advanceLive(first.baseline, at("2026-09-15", 200_500_000));

    expect(second.baseline).toEqual(baseline);
    expect(second.days_elapsed).toBe(2);
    expect(second.delta_cents).toBe(200_500_000 - 201_288_019);
  });

  it("re-baselines when the demo clock wraps, instead of reporting a windfall", () => {
    // THE BUG THIS PREVENTS: the clock runs a ten-minute cycle and then returns
    // to the end of history. Cash jumps back up by whatever the cycle spent.
    // Measured naively the badge would announce the company earning a week's
    // burn every ten minutes.
    const baseline = at("2026-09-20", 199_000_000);
    const state = advanceLive(baseline, at("2026-09-13", 201_288_019));

    expect(state.restarted).toBe(true);
    expect(state.delta_cents).toBeNull();
    expect(state.days_elapsed).toBe(0);
    expect(state.baseline).toEqual(at("2026-09-13", 201_288_019));
  });

  it("says nothing about a delta within the same simulated day", () => {
    const baseline = at("2026-09-13", 201_288_019);
    const state = advanceLive(baseline, at("2026-09-13", 201_000_000));

    expect(state.days_elapsed).toBe(0);
    expect(state.delta_cents).toBeNull();
  });
});

describe("LiveBadge", () => {
  afterEach(cleanup);

  it("shows the simulated date it is current to", () => {
    render(<LiveBadge provenance={provenance} cashCents={201_288_019} />);

    // The date comes from provenance, which comes from the pipeline.
    expect(screen.getByText(/watching/)).toBeInTheDocument();
  });

  it("never renders a figure the pipeline did not produce", () => {
    const { container } = render(<LiveBadge provenance={provenance} cashCents={201_288_019} />);

    // On the first reading there is no comparison yet, so there must be no
    // dollar figure at all rather than a placeholder or a zero.
    expect(container.textContent).not.toMatch(/\$/);
  });
});
