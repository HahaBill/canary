import type { AskCanaryResponse, ErrorResponse } from "@canary/shared";
import { describe, expect, it } from "vitest";
import { createHarness } from "../test/harness.ts";

const TICKET = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_test&conversation_signature=tok";

describe("GET /api/ask-canary", () => {
  it("reports unconfigured when the conversational agent is not set", async () => {
    const h = createHarness();
    const { status, body } = await h.json<AskCanaryResponse>("/api/ask-canary");
    expect(status).toBe(200);
    expect(body).toEqual({ configured: false });
    expect(h.calls.some((call) => call.url.includes("elevenlabs"))).toBe(false);
  });

  it("keeps the API key on the Worker and returns only the signed ticket", async () => {
    const h = createHarness({
      env: { ELEVENLABS_API_KEY: "xi-test", ELEVENLABS_AGENT_ID: "agent_test" },
      fetchHandler: (input) => {
        if (String(input).includes("/v1/convai/conversation/get-signed-url")) {
          return new Response(JSON.stringify({ signed_url: TICKET }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return null;
      },
    });
    const { status, body } = await h.json<AskCanaryResponse>("/api/ask-canary");
    expect(status).toBe(200);
    expect(body).toEqual({ configured: true, signed_url: TICKET });
    expect(JSON.stringify(body)).not.toContain("xi-test");

    const eleven = h.calls.find((call) => call.url.includes("get-signed-url"));
    expect(eleven?.headers["xi-api-key"]).toBe("xi-test");
    expect(eleven?.url).toContain("agent_id=agent_test");
  });

  it("returns 502 when ElevenLabs will not issue a ticket", async () => {
    const h = createHarness({
      env: { ELEVENLABS_API_KEY: "xi-test", ELEVENLABS_AGENT_ID: "agent_test" },
      fetchHandler: (input) => {
        if (String(input).includes("get-signed-url")) {
          return new Response("no requested permission", { status: 401 });
        }
        return null;
      },
    });
    const { status, body } = await h.json<ErrorResponse>("/api/ask-canary");
    expect(status).toBe(502);
    expect(body.error).toBe("elevenlabs_unavailable");
  });
});
