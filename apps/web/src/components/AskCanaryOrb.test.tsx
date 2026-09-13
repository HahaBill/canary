import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockSnapshot } from "@/api/mock.ts";
import { clearApiCache } from "@/api/useDerived.ts";
import { installApiStub, renderApp, setViewport, type RecordedRequest } from "@/test-utils.tsx";

const TICKET = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_test&conversation_signature=tok";

describe("AskCanaryOrb", () => {
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

  it("stays off the page when the agent is not configured", async () => {
    renderApp("/");
    await waitFor(() => {
      expect(requests.some((r) => r.path === "/api/ask-canary")).toBe(true);
    });
    expect(document.querySelector("elevenlabs-convai")).not.toBeInTheDocument();
  });

  it("mounts the compact ElevenLabs orb on every page once a ticket exists", async () => {
    ({ requests } = installApiStub({ askCanary: { configured: true, signed_url: TICKET } }));
    renderApp("/ledger");

    await waitFor(() => {
      expect(document.querySelector("elevenlabs-convai")).toHaveAttribute("signed-url", TICKET);
    });
    const orb = document.querySelector("elevenlabs-convai");
    expect(orb).toHaveAttribute("variant", "compact");
    expect(orb).toHaveAttribute("action-text", "Ask Canary");
  });
});
