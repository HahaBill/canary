/**
 * The one test that talks to the real model. Skipped without `OPENAI_API_KEY`,
 * so `npm test` stays offline and needs no secrets.
 *
 * What it proves is the thing no scripted test can: that a real gpt-4o-mini,
 * given this system prompt and these tool schemas, answers a what-if question
 * with figures the number guard accepts. If the model drifts and starts
 * rounding, this fails — and in production the founder would have received the
 * guard's deterministic fallback rather than a fabricated number.
 *
 * Run with: OPENAI_API_KEY=sk-... npm test -w @canary/api
 */
import { describe, expect, it } from "vitest";
import { whyMessage } from "../messages.ts";
import type { SendblueWebhookResponse } from "../routes/webhooks.ts";
import { createHarness, inbound, TEST_ENV } from "../test/harness.ts";
import { extractFigures } from "./guard.ts";
import { openAiClient } from "./openai.ts";

const apiKey = process.env.OPENAI_API_KEY;
const maybe = apiKey ? it : it.skip;

describe("live OpenAI", () => {
  maybe(
    "answers a real what-if with figures the guard accepts",
    async () => {
      const h = createHarness({ llm: openAiClient({ apiKey: apiKey!, ...(process.env.OPENAI_MODEL ? { model: process.env.OPENAI_MODEL } : {}) }) });
      const { status, body } = await h.authed<SendblueWebhookResponse>(
        "/webhooks/sendblue",
        inbound("what if AWS were 20% lower?", { from_number: TEST_ENV.FOUNDER_PHONE, number: TEST_ENV.FOUNDER_PHONE }),
      );
      console.log(JSON.stringify({ msg: "live_conversation_reply", tool_calls: body.tool_calls, reason: body.reason, reply: body.reply }));

      expect(status).toBe(200);
      expect(body.mode).toBe("conversation");
      expect(body.tool_calls).toContain("simulate_cost_change");

      // The guard neither replaced the reply nor fell back to a canned one.
      expect(body.reason).toBeUndefined();
      expect(body.reply).not.toBe(whyMessage(h.derived, h.derived.primary_incident!));

      // It actually quoted figures — a guard that passes on a reply with no
      // numbers in it would prove nothing.
      expect(extractFigures(body.reply!).length).toBeGreaterThan(0);
    },
    60_000,
  );
});
