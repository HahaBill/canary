/** `GET /api/ask-canary` — signed conversation URL for the Ask Canary widget. */
import type { AskCanaryResponse } from "@canary/shared";
import { jsonError, type CanaryApp } from "../context.ts";
import { getConversationSignedUrl } from "../voice/signed-url.ts";

export function registerAskCanaryRoutes(app: CanaryApp): void {
  app.get("/api/ask-canary", async (c) => {
    const env = c.get("appEnv");
    const agentId = env.ELEVENLABS_AGENT_ID?.trim() ?? "";
    const apiKey = env.ELEVENLABS_API_KEY?.trim() ?? "";
    if (!agentId || !apiKey) {
      const body: AskCanaryResponse = { configured: false };
      return c.json(body);
    }

    const result = await getConversationSignedUrl({
      apiKey,
      agentId,
      fetchImpl: c.get("fetchImpl"),
    });
    if (!result.ok || !result.signed_url) {
      return jsonError(c, 502, "elevenlabs_unavailable", result.error ?? "signed_url_failed");
    }
    const body: AskCanaryResponse = { configured: true, signed_url: result.signed_url };
    return c.json(body);
  });
}
