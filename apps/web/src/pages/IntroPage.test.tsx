import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMockDerived } from "@canary/shared/fixtures";
import { resetMockSnapshot } from "@/api/mock.ts";
import { clearApiCache } from "@/api/useDerived.ts";
import { INTRO_SAMPLE_BUBBLES, INTRO_STORAGE_KEY, markIntroSeen } from "@/lib/intro.ts";
import { installApiStub, renderApp, setViewport } from "@/test-utils.tsx";

describe("IntroPage", () => {
  beforeEach(() => {
    installApiStub();
    setViewport(1280);
    window.sessionStorage.clear();
    window.localStorage.clear();
    clearApiCache();
    resetMockSnapshot();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("presents Canary's product promise, iMessage alert, and demo entry points", () => {
    const { container } = renderApp("/");

    expect(
      screen.getByRole("heading", { name: /Your startup’s cash should never surprise you/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/reconciles financial activity/)).toBeInTheDocument();
    expect(screen.getByText("Deterministic money math")).toBeInTheDocument();
    expect(screen.getByText("Reports, never decides")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Explore the live demo/ })).toBeInTheDocument();
    expect(screen.getByText("Enter")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Reconcile first. Detect second/ })).toBeInTheDocument();

    const imessage = screen.getByLabelText("Sample iMessage conversation with Canary");
    for (const line of INTRO_SAMPLE_BUBBLES) {
      expect(imessage).toHaveTextContent(line);
    }
    expect(screen.getByLabelText("Sample Canary voice note")).toBeInTheDocument();
    expect(imessage).toHaveTextContent("WHY");
    expect(container.querySelectorAll(".canary-landing__bubble--incoming")).toHaveLength(4);

    expect(container.textContent).not.toMatch(/\$/);
    expect(container.textContent).not.toMatch(/Tavily/i);
    expect(container.textContent).not.toMatch(/CUSUM/i);
    expect(container.textContent).not.toMatch(/70%/);
    expect(screen.queryByRole("complementary", { name: "Main navigation" })).not.toBeInTheDocument();
  });

  it("enters the dashboard on Start and remembers it for this tab", async () => {
    renderApp("/");

    fireEvent.click(screen.getByRole("button", { name: /Explore the live demo/ }));

    expect(await screen.findByRole("heading", { name: "Home" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Main navigation" })).toBeInTheDocument();
    expect(window.sessionStorage.getItem(INTRO_STORAGE_KEY)).toBe("1");
    expect(screen.queryByRole("button", { name: /Explore the live demo/ })).not.toBeInTheDocument();
  });

  it("enters the dashboard when Enter is pressed", async () => {
    renderApp("/");

    fireEvent.keyDown(window, { key: "Enter" });

    expect(await screen.findByRole("heading", { name: "Home" })).toBeInTheDocument();
    expect(window.sessionStorage.getItem(INTRO_STORAGE_KEY)).toBe("1");
  });

  it("skips the intro on a later visit to / in the same session", async () => {
    markIntroSeen();
    renderApp("/");

    expect(await screen.findByRole("heading", { name: "Home" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Explore the live demo/ })).not.toBeInTheDocument();
  });

  it("opens /home without the intro", async () => {
    renderApp("/home");

    expect(await screen.findByRole("heading", { name: "Home" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Explore the live demo/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Your startup’s cash should never surprise you/)).not.toBeInTheDocument();
  });

  it.each([
    ["/incidents", "Incidents"],
    ["/ledger", "Ledger"],
    ["/scout", "Scout"],
  ] as const)("skips the intro on %s", async (path, heading) => {
    renderApp(path);

    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Explore the live demo/ })).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Main navigation" })).toBeInTheDocument();
  });

  it("opens an incident deep link without the intro", async () => {
    const incident = buildMockDerived().primary_incident!;
    renderApp(`/incidents/${incident.id}`);

    expect(await screen.findByRole("heading", { name: incident.title })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Explore the live demo/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "← Dashboard" })).toHaveAttribute("href", "/home");
  });
});
