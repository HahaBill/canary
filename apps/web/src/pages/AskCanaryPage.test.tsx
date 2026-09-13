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

  it("points at the corner Start a call control", async () => {
    renderApp("/ask");

    expect(await screen.findByRole("heading", { name: "Ask Canary" })).toBeInTheDocument();
    expect(screen.getByText(/Start a call/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ask Canary a question" })).not.toBeInTheDocument();
    expect(screen.getAllByText(/What if AWS were 20% lower/).length).toBeGreaterThan(0);
  });
});
