import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCENARIO_LABEL, formatMonths, formatSignedUsd } from "@canary/shared";
import { buildMockDerived, mockWhatIf } from "@canary/shared/fixtures";
import { WhatIfPanel, runwayDeltaCaption } from "@/components/WhatIfPanel.tsx";
import { clearApiCache } from "@/api/useDerived.ts";
import { resetMockSnapshot } from "@/api/mock.ts";

const DEFAULT_PERCENT = -20;

describe("WhatIfPanel", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_USE_MOCK", "1");
    clearApiCache();
    resetMockSnapshot();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it("labels the result as a scenario estimate once simulate resolves", async () => {
    const derived = buildMockDerived();
    render(<WhatIfPanel burn={derived.burn} defaultEntity={derived.primary_incident!.entity} />);

    expect(await screen.findByText(SCENARIO_LABEL)).toBeInTheDocument();
  });

  it("shows the engine's monthly delta and scenario runway", async () => {
    const derived = buildMockDerived();
    const entity = derived.primary_incident!.entity;
    const expected = mockWhatIf(derived, entity, DEFAULT_PERCENT);

    render(<WhatIfPanel burn={derived.burn} defaultEntity={entity} />);
    await screen.findByText(SCENARIO_LABEL);

    const delta = screen.getByText("Monthly difference").parentElement;
    expect(delta).toHaveTextContent(formatSignedUsd(expected.delta_monthly_cents, "/mo"));

    const runway = screen.getByText("Runway").parentElement;
    expect(runway).toHaveTextContent(formatMonths(expected.scenario_runway_months));
  });

  it("defaults to the incident entity and a 20% reduction", async () => {
    const derived = buildMockDerived();
    const entity = derived.primary_incident!.entity;

    render(<WhatIfPanel burn={derived.burn} defaultEntity={entity} />);
    await screen.findByText(SCENARIO_LABEL);

    expect(screen.getByLabelText("Entity")).toHaveValue(entity);
    expect(screen.getByRole("slider")).toHaveValue(String(DEFAULT_PERCENT));
  });

  it("says how much longer a reduction buys, not just the magnitude", async () => {
    const derived = buildMockDerived();
    const entity = derived.primary_incident!.entity;
    const expected = mockWhatIf(derived, entity, DEFAULT_PERCENT);

    render(<WhatIfPanel burn={derived.burn} defaultEntity={entity} />);
    await screen.findByText(SCENARIO_LABEL);

    expect(expected.runway_delta_months).toBeGreaterThan(0);
    const runway = screen.getByText("Runway").parentElement;
    expect(runway).toHaveTextContent(`${formatMonths(expected.runway_delta_months!)} longer`);
  });

  it("says shorter when spend goes up", async () => {
    const derived = buildMockDerived();
    const entity = derived.primary_incident!.entity;

    render(<WhatIfPanel burn={derived.burn} defaultEntity={entity} />);
    await screen.findByText(SCENARIO_LABEL);

    fireEvent.change(screen.getByRole("slider"), { target: { value: "20" } });

    const expected = mockWhatIf(derived, entity, 20);
    expect(expected.runway_delta_months).toBeLessThan(0);
    await waitFor(() => {
      const runway = screen.getByText("Runway").parentElement;
      expect(runway).toHaveTextContent(`${formatMonths(Math.abs(expected.runway_delta_months!))} shorter`);
    });
  });

  it("sets the slider from a quick-pick chip", async () => {
    const derived = buildMockDerived();
    const entity = derived.primary_incident!.entity;

    render(<WhatIfPanel burn={derived.burn} defaultEntity={entity} />);
    await screen.findByText(SCENARIO_LABEL);

    for (const pick of ["-10%", "-20%", "-30%"]) {
      expect(screen.getByRole("button", { name: pick })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "-20%", pressed: true })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "-30%" }));

    expect(screen.getByRole("slider")).toHaveValue("-30");
    expect(screen.getByRole("button", { name: "-30%", pressed: true })).toBeInTheDocument();
  });

  it("marks the results grid busy while a new scenario is in flight", async () => {
    const derived = buildMockDerived();
    const entity = derived.primary_incident!.entity;

    render(<WhatIfPanel burn={derived.burn} defaultEntity={entity} />);
    await screen.findByText(SCENARIO_LABEL);

    const grid = () => screen.getByText("Monthly burn").closest("dl");
    expect(grid()).toHaveAttribute("aria-busy", "false");

    fireEvent.click(screen.getByRole("button", { name: "-30%" }));
    expect(grid()).toHaveAttribute("aria-busy", "true");

    await waitFor(() => expect(grid()).toHaveAttribute("aria-busy", "false"));
  });

  it("renders the backend reason when a scenario changes nothing", async () => {
    const derived = buildMockDerived();
    const entity = derived.primary_incident!.entity;

    render(<WhatIfPanel burn={derived.burn} defaultEntity={entity} />);
    await screen.findByText(SCENARIO_LABEL);
    fireEvent.change(screen.getByRole("slider"), { target: { value: "0" } });

    expect(await screen.findByText(/zero percent change/i)).toBeInTheDocument();
  });

  describe("runwayDeltaCaption", () => {
    const base = mockWhatIf(buildMockDerived(), "aws", -20);

    it("is directional, and says nothing changed when nothing did", () => {
      expect(runwayDeltaCaption({ ...base, runway_delta_months: 0.7 })).toBe("0.7 months longer");
      expect(runwayDeltaCaption({ ...base, runway_delta_months: -0.4 })).toBe("0.4 months shorter");
      expect(runwayDeltaCaption({ ...base, runway_delta_months: 0 })).toBe("no change");
    });

    it("does not claim no change when the scenario stops the burn", () => {
      expect(
        runwayDeltaCaption({ ...base, runway_delta_months: null, scenario_runway_months: null }),
      ).toBe("not burning cash in this scenario");
    });
  });
});
