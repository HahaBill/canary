import { AGENT_TOOL_NAMES } from "@canary/shared";
import { cleanup, screen, waitFor } from "@testing-library/react";
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

  it("does not render the custom Ask a question bird launcher", async () => {
    renderApp("/home");
    await screen.findByRole("status", { name: "Ask Canary" });
    expect(screen.queryByRole("button", { name: "Ask Canary a question" })).not.toBeInTheDocument();
    expect(screen.queryByText("Ask a question")).not.toBeInTheDocument();
    expect(document.querySelector("elevenlabs-convai")).not.toBeInTheDocument();
  });

  it("explains how to ask when voice is not connected", async () => {
    renderApp("/ledger");
    const panel = await screen.findByRole("status", { name: "Ask Canary" });
    expect(panel).toHaveTextContent(/What if AWS were 20% lower/);
    expect(screen.getByRole("link", { name: "How Ask Canary works" })).toHaveAttribute("href", "/ask");
    expect(document.querySelector("elevenlabs-convai")).not.toBeInTheDocument();
  });

  it("auto-mounts the ElevenLabs widget once a ticket exists", async () => {
    installApiStub({ askCanary: { configured: true, signed_url: TICKET } });
    renderApp("/ledger");

    await waitFor(() => {
      expect(document.querySelector("elevenlabs-convai")).toHaveAttribute("signed-url", TICKET);
    });
    expect(document.querySelector(".ask-canary-dock")).toHaveAttribute("data-ready", "voice");
    expect(document.querySelector("elevenlabs-convai")).toHaveAttribute("variant", "compact");
    expect(document.querySelector("elevenlabs-convai")).toHaveAttribute("start-call-text", "Start a call");
    expect(screen.queryByRole("button", { name: "Ask Canary a question" })).not.toBeInTheDocument();
    expect(screen.queryByText("Ask a question")).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Ask Canary" })).not.toBeInTheDocument();

    const config: { clientTools?: Record<string, unknown> } = {};
    document.querySelector("elevenlabs-convai")!.dispatchEvent(
      new CustomEvent("elevenlabs-convai:call", { detail: { config } }),
    );
    expect(Object.keys(config.clientTools ?? {}).sort()).toEqual([...AGENT_TOOL_NAMES].sort());
  });
});
