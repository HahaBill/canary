import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assembleScoutPage, emptyScoutCache, formatUsdWhole, type ScoutFinding, type ScoutPage } from "@canary/shared";
import { buildMockDerived } from "@canary/shared/fixtures";
import { resetMockSnapshot } from "@/api/mock.ts";
import { clearApiCache } from "@/api/useDerived.ts";
import { entityDisplayName, formatWeeklyLevel } from "@/lib/format.ts";
import { installApiStub, renderApp, setViewport, type RecordedRequest } from "@/test-utils.tsx";

const derived = buildMockDerived();
const NOW = derived.provenance.generated_at;

function pageWithFinding(): ScoutPage {
  const finding: ScoutFinding = {
    kind: "EVIDENCE",
    claim: "AWS announced a new plan.",
    source_url: "https://aws.amazon.com/blogs/aws/new-plan",
    source_title: "AWS announced a new plan",
    published_at: "2026-08-01",
    retrieved_at: NOW,
    cached: true,
  };
  return assembleScoutPage({
    weeklyVariableByEntity: derived.burn.weekly_variable_by_entity,
    windowStart: derived.burn.burn_window_start,
    windowEnd: derived.burn.burn_window_end,
    whatifIncidentId: derived.primary_incident!.id,
    cache: {
      kind: "scout",
      lookback_days: 90,
      retrieved_at: NOW,
      vendors: { aws: { entity: "aws", findings: [finding], empty_window: false, retrieved_at: NOW } },
    },
    now: NOW,
    displayName: entityDisplayName,
  });
}

describe("ScoutPage", () => {
  let requests: RecordedRequest[];

  beforeEach(() => {
    ({ requests } = installApiStub());
    setViewport(1280);
    clearApiCache();
    resetMockSnapshot();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders OBSERVED spend from the ledger and an empty dated window", async () => {
    renderApp("/scout");

    expect(await screen.findByRole("heading", { name: "Scout" })).toBeInTheDocument();
    const card = within(await screen.findByRole("article", { name: entityDisplayName("aws") }));
    expect(card.queryByText("aws")).not.toBeInTheDocument();
    expect(card.getByText(formatWeeklyLevel(derived.burn.weekly_variable_by_entity.aws!), { exact: false })).toBeInTheDocument();
    expect(card.getByText("Observed")).toBeInTheDocument();
    expect(card.getByText("Evidence")).toBeInTheDocument();
    expect(card.getByText("Nothing dated in the last 90 days.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: `Open the what-if simulator for ${entityDisplayName("aws")}` })).toHaveAttribute(
      "href",
      `/incidents/${derived.primary_incident!.id}?tab=whatif&entity=aws`,
    );
    expect(document.body.textContent).not.toMatch(/cheaper alternative|you could save|switch to|cancel |downgrade/i);
    expect(formatUsdWhole(derived.burn.weekly_variable_by_entity.aws!)).not.toBe("");
  });

  it("shows a dated EVIDENCE source when the cache has one", async () => {
    ({ requests } = installApiStub({ scout: pageWithFinding() }));
    renderApp("/scout");

    expect(await screen.findByText("AWS announced a new plan.")).toBeInTheDocument();
    const source = screen.getByRole("link", { name: /AWS announced a new plan/ });
    expect(source).toHaveAttribute("href", "https://aws.amazon.com/blogs/aws/new-plan");
    expect(screen.getByText(/published Aug 1, 2026/)).toBeInTheDocument();
    expect(
      within(screen.getByRole("article", { name: entityDisplayName("aws") })).queryByText(
        "Nothing dated in the last 90 days.",
      ),
    ).not.toBeInTheDocument();
  });

  it("posts Refresh to the scout refresh route", async () => {
    renderApp("/scout");
    await screen.findByRole("heading", { name: "Scout" });

    fireEvent.click(screen.getByRole("button", { name: "Refresh sources" }));
    await waitFor(() => {
      expect(requests.some((r) => r.method === "POST" && r.path === "/api/scout/refresh")).toBe(true);
    });
  });
});
