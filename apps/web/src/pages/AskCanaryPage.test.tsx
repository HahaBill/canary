import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockSnapshot } from "@/api/mock.ts";
import { clearApiCache } from "@/api/useDerived.ts";
import { installApiStub, renderApp, setViewport } from "@/test-utils.tsx";

describe("AskCanaryPage", () => {
  beforeEach(() => {
    installApiStub();
    setViewport(1280);
    clearApiCache();
    resetMockSnapshot();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("points at the floating orb and does not embed a page widget", async () => {
    renderApp("/ask");

    expect(await screen.findByRole("heading", { name: "Ask Canary" })).toBeInTheDocument();
    expect(screen.getByText(/Press the orb in the corner/i)).toBeInTheDocument();
    expect(screen.getByText(/What if AWS were 20% lower/)).toBeInTheDocument();
    expect(screen.getByText(/offline fixtures stay silent/i)).toBeInTheDocument();
    expect(document.querySelector("elevenlabs-convai")).not.toBeInTheDocument();
  });
});
