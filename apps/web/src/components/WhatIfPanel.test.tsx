import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCENARIO_LABEL, formatMonths, formatSignedUsd } from "@canary/shared";
import { buildMockDerived, mockWhatIf } from "@canary/shared/fixtures";
import { WhatIfPanel } from "@/components/WhatIfPanel.tsx";
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
});
