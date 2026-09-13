import { describe, expect, it } from "vitest";
import { getConversationSignedUrl } from "./signed-url.ts";

const TICKET = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_test&conversation_signature=tok";

describe("getConversationSignedUrl", () => {
  it("asks ElevenLabs with the API key and returns the ticket", async () => {
    const result = await getConversationSignedUrl({
      apiKey: "xi-test",
      agentId: "agent_test",
      fetchImpl: async (input, init) => {
        expect(String(input)).toContain("agent_id=agent_test");
        expect(String(input)).toContain("/v1/convai/conversation/get-signed-url");
        expect((init?.headers as Record<string, string>)["xi-api-key"]).toBe("xi-test");
        return new Response(JSON.stringify({ signed_url: TICKET }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    expect(result).toEqual({ ok: true, signed_url: TICKET, status: 200 });
  });

  it("rejects a body that is not a websocket or https ticket", async () => {
    const result = await getConversationSignedUrl({
      apiKey: "xi-test",
      agentId: "agent_test",
      fetchImpl: async () =>
        new Response(JSON.stringify({ signed_url: "javascript:alert(1)" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("missing_signed_url");
  });

  it("surfaces an ElevenLabs HTTP error without throwing", async () => {
    const result = await getConversationSignedUrl({
      apiKey: "xi-test",
      agentId: "agent_test",
      fetchImpl: async () => new Response("no requested permission", { status: 401 }),
    });
    expect(result).toMatchObject({ ok: false, status: 401, error: "no requested permission" });
  });
});
