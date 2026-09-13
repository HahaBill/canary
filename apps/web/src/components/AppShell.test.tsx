import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMockDerived } from "@canary/shared/fixtures";
import { resetMockSnapshot } from "@/api/mock.ts";
import { clearApiCache } from "@/api/useDerived.ts";
import { SIDEBAR_STORAGE_KEY } from "@/components/AppShell.tsx";
import { formatDateMedium } from "@/lib/format.ts";
import { installApiStub, renderApp, setViewport } from "@/test-utils.tsx";

describe("AppShell", () => {
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

  it("links to every section and marks the current one active", async () => {
    renderApp("/ledger");

    const sidebar = await screen.findByRole("complementary", { name: "Main navigation" });
    for (const label of ["Home", "Incidents", "Ledger", "Needs Review", "Scout", "Ask Canary"]) {
      expect(within(sidebar).getByRole("link", { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(within(sidebar).getByRole("link", { name: /Home/ })).toHaveAttribute("href", "/home");
    expect(within(sidebar).queryByRole("link", { name: /Calendar/ })).not.toBeInTheDocument();
    expect(within(sidebar).getByRole("link", { name: /Ledger/ })).toHaveAttribute("aria-current", "page");
  });

  it("keeps /calendar reachable without a Calendar tab", async () => {
    renderApp("/calendar");

    expect(await screen.findByRole("heading", { name: "When Canary can text" })).toBeInTheDocument();
    const sidebar = screen.getByRole("complementary", { name: "Main navigation" });
    expect(within(sidebar).queryByRole("link", { name: /Calendar/ })).not.toBeInTheDocument();
  });

  it("links Ask Canary to the voice page", async () => {
    renderApp("/home");

    const sidebar = await screen.findByRole("complementary", { name: "Main navigation" });
    expect(within(sidebar).getByRole("link", { name: /Ask Canary/ })).toHaveAttribute("href", "/ask");
    expect(within(sidebar).queryByText("soon")).not.toBeInTheDocument();
  });

  it("keeps the live clock and does not name the fictional company", async () => {
    const derived = buildMockDerived();
    renderApp("/home");

    const clock = await screen.findByRole("region", { name: "Live clock" });
    expect(clock).toHaveTextContent("Live");
    expect(clock).toHaveTextContent(formatDateMedium(derived.provenance.end_date));
    expect(screen.queryByText(/Perch Analytics/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/fictional company/i)).not.toBeInTheDocument();
  });

  it("collapses the sidebar and remembers it across mounts", async () => {
    renderApp("/home");

    const collapse = await screen.findByRole("button", { name: "Collapse sidebar" });
    expect(screen.getByRole("complementary", { name: "Main navigation" })).toHaveAttribute(
      "data-collapsed",
      "false",
    );

    fireEvent.click(collapse);

    expect(screen.getByRole("complementary", { name: "Main navigation" })).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("collapsed");

    cleanup();
    clearApiCache();
    renderApp("/home");

    expect(await screen.findByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Main navigation" })).toHaveAttribute(
      "data-collapsed",
      "true",
    );
  });

  it("shows the Needs Review queue size on its nav entry", async () => {
    const derived = buildMockDerived();
    renderApp("/home");

    const sidebar = await screen.findByRole("complementary", { name: "Main navigation" });
    const link = within(sidebar).getByRole("link", { name: /Needs Review/ });
    expect(link).toHaveTextContent(String(derived.needs_review.count));
  });

  it("swaps the sidebar for a bottom tab bar on a narrow viewport", async () => {
    setViewport(375);
    renderApp("/home");

    const tabBar = await screen.findByRole("navigation", { name: "Main navigation" });
    expect(screen.queryByRole("complementary", { name: "Main navigation" })).not.toBeInTheDocument();
    expect(within(tabBar).getAllByRole("link")).toHaveLength(5);
    expect(within(tabBar).queryByRole("link", { name: /Calendar/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ask Canary" })).toHaveAttribute("href", "/ask");
    expect(screen.queryByRole("button", { name: /sidebar/ })).not.toBeInTheDocument();
  });
});
