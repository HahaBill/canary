import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WeeklyBucket } from "@canary/shared";
import { buildMockDerived } from "@canary/shared/fixtures";
import { Sparkline, changePointIndex } from "@/components/Sparkline.tsx";

function week(start: string, variable: number): WeeklyBucket {
  return {
    week_start: start,
    week_end: start,
    week_index: 0,
    variable_spend_cents: variable,
    fixed_spend_cents: 0,
    excluded_from_monitoring_cents: 0,
    total_operating_outflow_cents: variable,
    operating_inflow_cents: 0,
    net_burn_cents: variable,
    variable_by_entity: {},
    variable_by_category: {},
    transaction_count: 0,
  };
}

describe("Sparkline", () => {
  afterEach(cleanup);

  it("draws the weekly series and marks the change point", () => {
    const derived = buildMockDerived();
    const incident = derived.primary_incident!;

    const { container } = render(
      <Sparkline
        weeks={derived.weeks}
        changePoint={incident.estimated_change_point}
        label="Weekly variable spend"
      />,
    );

    const path = container.querySelector("path");
    expect(path).not.toBeNull();
    // One move plus one line segment per remaining week.
    expect(path!.getAttribute("d")).toMatch(/^M[\d.]+,[\d.]+ (L[\d.]+,[\d.]+ ?)+$/);
    expect(path!.getAttribute("d")!.split("L")).toHaveLength(derived.weeks.length);

    expect(container.querySelector("circle")).not.toBeNull();
  });

  it("describes itself to screen readers with the caller's label", () => {
    const derived = buildMockDerived();
    render(<Sparkline weeks={derived.weeks} changePoint={null} label="$15,352 per week to $19,479 per week" />);

    expect(screen.getByRole("img", { name: "$15,352 per week to $19,479 per week" })).toBeInTheDocument();
  });

  it("leaves the marker off when there is no change point", () => {
    const derived = buildMockDerived();
    const { container } = render(<Sparkline weeks={derived.weeks} changePoint={null} label="no change point" />);

    expect(container.querySelector("path")).not.toBeNull();
    expect(container.querySelector("circle")).toBeNull();
  });

  it("renders nothing for a series too short to have a shape", () => {
    const { container } = render(<Sparkline weeks={[week("2026-01-05", 100)]} changePoint={null} label="one week" />);
    expect(container.querySelector("svg")).toBeNull();
  });

  describe("changePointIndex", () => {
    const weeks = [week("2026-01-05", 1), week("2026-01-12", 2), week("2026-01-19", 3)];

    it("matches a week_start exactly", () => {
      expect(changePointIndex(weeks, "2026-01-12")).toBe(1);
    });

    it("falls back to the first week at or after the change point", () => {
      expect(changePointIndex(weeks, "2026-01-14")).toBe(2);
    });

    it("has no index without a change point", () => {
      expect(changePointIndex(weeks, null)).toBe(-1);
    });
  });
});
