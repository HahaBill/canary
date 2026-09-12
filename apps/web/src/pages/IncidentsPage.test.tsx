import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMockDerived } from "@canary/shared/fixtures";
import { resetMockSnapshot } from "@/api/mock.ts";
import { clearApiCache } from "@/api/useDerived.ts";
import { entityDisplayName, formatDateMedium } from "@/lib/format.ts";
import { installApiStub, renderApp, setViewport } from "@/test-utils.tsx";

const derived = buildMockDerived();

describe("IncidentsPage", () => {
  beforeEach(() => {
    installApiStub();
    setViewport(1280);
    window.localStorage.clear();
    clearApiCache();
    resetMockSnapshot();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists every incident with its type, entity, severity, status and dates", async () => {
    renderApp("/incidents");

    const table = await screen.findByRole("table", { name: /All incidents/ });
    const rows = within(table).getAllByRole("row");
    // One header row plus one per incident.
    expect(rows).toHaveLength(derived.incidents.length + 1);

    const primary = derived.primary_incident!;
    const row = within(table).getByRole("link", { name: primary.title }).closest("tr")!;
    expect(row).toHaveTextContent("Burn rate shift");
    expect(row).toHaveTextContent(entityDisplayName(primary.entity));
    expect(row).toHaveTextContent("High severity");
    expect(row).toHaveTextContent("Open");
    expect(row).toHaveTextContent(formatDateMedium(primary.alarm_date!));
    expect(row).toHaveTextContent(formatDateMedium(primary.estimated_change_point!));
  });

  it("links each incident to its page", async () => {
    renderApp("/incidents");
    const table = await screen.findByRole("table", { name: /All incidents/ });

    for (const incident of derived.incidents) {
      expect(within(table).getByRole("link", { name: incident.title })).toHaveAttribute(
        "href",
        `/incidents/${incident.id}`,
      );
    }
  });

  it("counts open incidents in the header", async () => {
    renderApp("/incidents");
    const heading = await screen.findByRole("heading", { name: "Incidents" });

    const open = derived.incidents.filter((i) => i.status === "OPEN").length;
    expect(heading.parentElement).toHaveTextContent(`${open} open`);
  });
});
