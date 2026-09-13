import { AGENT_TOOL_NAMES } from "@canary/shared";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockSnapshot } from "@/api/mock.ts";
import { clearApiCache } from "@/api/useDerived.ts";
import { installApiStub, renderApp, setViewport } from "@/test-utils.tsx";

const TICKET = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_test&conversation_signature=tok";

describe("AskCanaryOrb", () => {
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

  it("keeps a labeled Ask a question control on every page", async () => {
    renderApp("/");
    expect(await screen.findByRole("button", { name: "Ask Canary a question" })).toBeInTheDocument();
    expect(screen.getByText("Ask a question")).toBeInTheDocument();
    expect(document.querySelector("elevenlabs-convai")).not.toBeInTheDocument();
  });

  it("explains how to ask when voice is not connected", async () => {
    renderApp("/ledger");
    fireEvent.click(await screen.findByRole("button", { name: "Ask Canary a question" }));
    expect(screen.getByRole("dialog", { name: "Ask Canary" })).toBeInTheDocument();
    expect(screen.getByText(/What if AWS were 20% lower/)).toBeInTheDocument();
    expect(document.querySelector("elevenlabs-convai")).not.toBeInTheDocument();
  });

  it("starts the ElevenLabs widget from the same button once a ticket exists", async () => {
    installApiStub({ askCanary: { configured: true, signed_url: TICKET } });
    renderApp("/ledger");

    const launch = await screen.findByRole("button", { name: "Ask Canary a question" });
    await waitFor(() => {
      expect(launch).toHaveAttribute("data-ready", "voice");
    });
    fireEvent.click(launch);
    await waitFor(() => {
      expect(document.querySelector("elevenlabs-convai")).toHaveAttribute("signed-url", TICKET);
    });
    expect(document.querySelector("elevenlabs-convai")).toHaveAttribute("variant", "compact");
    expect(screen.queryByRole("dialog", { name: "Ask Canary" })).not.toBeInTheDocument();

    const config: { clientTools?: Record<string, unknown> } = {};
    document.querySelector("elevenlabs-convai")!.dispatchEvent(
      new CustomEvent("elevenlabs-convai:call", { detail: { config } }),
    );
    expect(Object.keys(config.clientTools ?? {}).sort()).toEqual([...AGENT_TOOL_NAMES].sort());
  });
});
