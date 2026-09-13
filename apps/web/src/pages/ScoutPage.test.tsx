import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assembleScoutPage,
  formatUsdWhole,
  scoutResearchQuery,
  type ScoutCacheFile,
  type ScoutFinding,
  type ScoutPage,
  type ScoutRefreshError,
} from "@canary/shared";
import { buildMockDerived } from "@canary/shared/fixtures";
import { resetMockSnapshot } from "@/api/mock.ts";
import { clearApiCache } from "@/api/useDerived.ts";
import { entityDisplayName, formatWeeklyLevel } from "@/lib/format.ts";
import { installApiStub, renderApp, setViewport, type RecordedRequest } from "@/test-utils.tsx";

const derived = buildMockDerived();
const NOW = derived.provenance.generated_at;

function pageFromCache(
  vendors: ScoutCacheFile["vendors"],
  extras: { tavilyCalls?: number; freshEntities?: string[]; refreshError?: ScoutRefreshError } = {},
): ScoutPage {
  return assembleScoutPage({
    weeklyVariableByEntity: derived.burn.weekly_variable_by_entity,
    windowStart: derived.burn.burn_window_start,
    windowEnd: derived.burn.burn_window_end,
    whatifIncidentId: derived.primary_incident!.id,
    cache: {
      kind: "scout",
      lookback_days: 90,
      retrieved_at: NOW,
      vendors,
    },
    now: NOW,
    displayName: entityDisplayName,
    tavilyCalls: extras.tavilyCalls,
    freshEntities: extras.freshEntities,
    refreshError: extras.refreshError,
  });
}

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
  return pageFromCache({ aws: { entity: "aws", findings: [finding], empty_window: false, retrieved_at: NOW } });
}

function pageSearchedEmpty(): ScoutPage {
  return pageFromCache({ aws: { entity: "aws", findings: [], empty_window: true, retrieved_at: NOW } });
}

function pageJustRetrieved(): ScoutPage {
  const finding: ScoutFinding = {
    kind: "EVIDENCE",
    claim: "AWS announced a new plan.",
    source_url: "https://aws.amazon.com/blogs/aws/new-plan",
    source_title: "AWS announced a new plan",
    published_at: "2026-08-01",
    retrieved_at: NOW,
    cached: false,
  };
  return pageFromCache(
    { aws: { entity: "aws", findings: [finding], empty_window: false, retrieved_at: NOW } },
    { tavilyCalls: 1, freshEntities: ["aws"] },
  );
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

  it("renders OBSERVED spend and a not-yet-searched empty state with the search query", async () => {
    renderApp("/scout");

    expect(await screen.findByRole("heading", { name: "Scout" })).toBeInTheDocument();
    expect(screen.getByText("Live search", { exact: true })).toBeInTheDocument();
    expect(screen.getByText(/Live search has not run yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Tavily/i);

    const card = within(await screen.findByRole("article", { name: entityDisplayName("aws") }));
    expect(card.queryByText("aws")).not.toBeInTheDocument();
    expect(card.getByText(formatWeeklyLevel(derived.burn.weekly_variable_by_entity.aws!), { exact: false })).toBeInTheDocument();
    expect(card.getByText("Observed")).toBeInTheDocument();
    expect(card.getByText("Evidence")).toBeInTheDocument();
    expect(card.getByText("Not yet searched.")).toBeInTheDocument();
    expect(card.getByText(scoutResearchQuery(entityDisplayName("aws")))).toBeInTheDocument();
    expect(card.queryByText("Nothing dated in the last 90 days.")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: `Open the what-if simulator for ${entityDisplayName("aws")}` })).toHaveAttribute(
      "href",
      `/incidents/${derived.primary_incident!.id}?tab=whatif&entity=aws`,
    );
    expect(document.body.textContent).not.toMatch(/cheaper alternative|you could save|switch to|cancel |downgrade/i);
    expect(formatUsdWhole(derived.burn.weekly_variable_by_entity.aws!)).not.toBe("");
  });

  it("distinguishes a searched empty window from not yet searched", async () => {
    ({ requests } = installApiStub({ scout: pageSearchedEmpty() }));
    renderApp("/scout");

    const card = within(await screen.findByRole("article", { name: entityDisplayName("aws") }));
    expect(card.getByText("Searched. Nothing dated in the last 90 days.")).toBeInTheDocument();
    expect(card.queryByText("Not yet searched.")).not.toBeInTheDocument();
    expect(screen.queryByText(/Live search has not run yet/)).not.toBeInTheDocument();
  });

  it("shows a dated EVIDENCE source when the cache has one", async () => {
    ({ requests } = installApiStub({ scout: pageWithFinding() }));
    renderApp("/scout");

    expect(await screen.findByText("AWS announced a new plan.")).toBeInTheDocument();
    const source = screen.getByRole("link", { name: /AWS announced a new plan/ });
    expect(source).toHaveAttribute("href", "https://aws.amazon.com/blogs/aws/new-plan");
    expect(screen.getByText(/published Aug 1, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/previously retrieved/)).toBeInTheDocument();
    expect(
      within(screen.getByRole("article", { name: entityDisplayName("aws") })).queryByText(
        "Searched. Nothing dated in the last 90 days.",
      ),
    ).not.toBeInTheDocument();
  });

  it("posts Refresh to the scout refresh route and shows a researching state", async () => {
    ({ requests } = installApiStub({ scoutRefresh: pageJustRetrieved(), refreshDelayMs: 80 }));
    renderApp("/scout");
    await screen.findByRole("heading", { name: "Scout" });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("button", { name: "Searching…" })).toBeDisabled();
    expect(screen.getByText(/Searching now/)).toBeInTheDocument();
    expect(screen.getAllByText("Asking live search for dated sources.").length).toBeGreaterThan(0);

    await waitFor(() => {
      expect(requests.some((r) => r.method === "POST" && r.path === "/api/scout/refresh")).toBe(true);
    });
    expect(await screen.findByText("AWS announced a new plan.")).toBeInTheDocument();
    expect(screen.getByText(/Live search checked 1 vendor just now/)).toBeInTheDocument();
    expect(screen.getByText("just retrieved")).toBeInTheDocument();
    expect(screen.queryByText("previously retrieved")).not.toBeInTheDocument();
  });

  it("explains a TTL no-op after Refresh", async () => {
    const searched = pageSearchedEmpty();
    ({ requests } = installApiStub({ scout: searched, scoutRefresh: { ...searched, tavily_calls: 0 } }));
    renderApp("/scout");
    await screen.findByRole("heading", { name: "Scout" });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/24-hour window/)).toBeInTheDocument();
  });

  it("names a missing key without claiming an outage or last sources", async () => {
    ({ requests } = installApiStub({ scoutRefresh: pageFromCache({}, { refreshError: "TAVILY_NOT_CONFIGURED" }) }));
    renderApp("/scout");
    await screen.findByRole("heading", { name: "Scout" });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/Live search is not configured on this Worker/)).toBeInTheDocument();
    expect(screen.queryByText(/Could not reach the research source/)).not.toBeInTheDocument();
    expect(screen.queryByText(/last retrieved/)).not.toBeInTheDocument();
  });

  it("does not claim last retrieved sources when Refresh fails on an empty cache", async () => {
    ({ requests } = installApiStub({ scoutRefresh: pageFromCache({}, { refreshError: "TAVILY_FAILED" }) }));
    renderApp("/scout");
    await screen.findByRole("heading", { name: "Scout" });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Live search returned an error.")).toBeInTheDocument();
    expect(screen.queryByText(/last retrieved/)).not.toBeInTheDocument();
  });

  it("keeps last-sources copy only when the cache actually has sources", async () => {
    const cached = pageWithFinding();
    ({ requests } = installApiStub({
      scout: cached,
      scoutRefresh: { ...cached, refresh_error: "TAVILY_UNREACHABLE" },
    }));
    renderApp("/scout");
    await screen.findByRole("heading", { name: "Scout" });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/Could not reach the research source\. Showing the last retrieved sources\./)).toBeInTheDocument();
    expect(screen.getByText("AWS announced a new plan.")).toBeInTheDocument();
  });

  it("names a quota failure instead of an outage", async () => {
    ({ requests } = installApiStub({ scoutRefresh: pageFromCache({}, { refreshError: "TAVILY_QUOTA" }) }));
    renderApp("/scout");
    await screen.findByRole("heading", { name: "Scout" });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/The research source rate-limited this Refresh \(quota\)/)).toBeInTheDocument();
    expect(screen.queryByText(/last retrieved/)).not.toBeInTheDocument();
  });
});
