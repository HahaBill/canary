import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMockDerived } from "@canary/shared/fixtures";
import App from "@/App.tsx";
import { KIND_META } from "@/components/EvidenceList.tsx";
import { clearApiCache } from "@/api/useDerived.ts";
import { resetMockSnapshot } from "@/api/mock.ts";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]} future={{ v7_relativeSplatPath: true }}>
      <App />
    </MemoryRouter>,
  );
}

describe("IncidentPage", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_USE_MOCK", "1");
    clearApiCache();
    resetMockSnapshot();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it("opens the tab named in ?tab=", async () => {
    const incident = buildMockDerived().primary_incident!;
    renderAt(`/incidents/${incident.id}?tab=evidence`);

    expect(await screen.findByRole("tab", { name: "Evidence", selected: true })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview", selected: false })).toBeInTheDocument();
    // Evidence-only content, so the right panel really is mounted.
    expect(screen.getByRole("heading", { level: 3, name: KIND_META.OBSERVED.label })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Why Canary flagged this/i })).toBeInTheDocument();
  });

  it("defaults to the overview tab", async () => {
    const incident = buildMockDerived().primary_incident!;
    renderAt(`/incidents/${incident.id}`);

    expect(await screen.findByRole("tab", { name: "Overview", selected: true })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Financial impact" })).toBeInTheDocument();
  });

  it("falls back to overview for an unknown tab value", async () => {
    const incident = buildMockDerived().primary_incident!;
    renderAt(`/incidents/${incident.id}?tab=not-a-tab`);

    expect(await screen.findByRole("tab", { name: "Overview", selected: true })).toBeInTheDocument();
  });

  it("shows the incident header with severity, change point and detection date", async () => {
    const incident = buildMockDerived().primary_incident!;
    renderAt(`/incidents/${incident.id}?tab=drivers`);

    expect(await screen.findByRole("heading", { level: 1, name: incident.title })).toBeInTheDocument();
    expect(screen.getByText(/severity/i)).toBeInTheDocument();
    expect(screen.getByText(/Detected/)).toBeInTheDocument();
  });

  it("renders a 404 for an unknown incident id", async () => {
    renderAt("/incidents/inc_does_not_exist");

    expect(await screen.findByText(/Incident not found/i)).toBeInTheDocument();
  });
});
