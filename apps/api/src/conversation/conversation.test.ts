/**
 * Conversational iMessage end to end, through the real webhook route.
 *
 * OpenAI is scripted at the `fetch` boundary, so the client, the tool loop, the
 * guard, memory and compaction all run for real — only the network is faked.
 * Every expected figure is derived from the fixture with the shared formatters:
 * no financial number is hand-typed here either (AGENTS.md rule 1).
 */
import { formatMonths, formatUsd, formatUsdWhole } from "@canary/shared";
import { buildMockDerived, mockWhatIf } from "@canary/shared/fixtures";
import { describe, expect, it } from "vitest";
import { D1Store } from "../data/d1.ts";
import { MockDataProvider } from "../data/provider.ts";
import { healthLineMessage, helpMessage, refusalMessage, whyMessage } from "../messages.ts";
import type { SendblueWebhookResponse } from "../routes/webhooks.ts";
import { createHarness, inbound, TEST_ENV, type Harness, type HarnessOptions } from "../test/harness.ts";
import { fakeOpenAi, type FakeOpenAi, type ScriptedTurn } from "../test/fake-openai.ts";
import { CONVERSATION } from "./config.ts";
import { openAiClient } from "./openai.ts";
import { preFilterRefusal, UNCONFIGURED_PREFIX } from "./router.ts";

const WEBHOOK = "/webhooks/sendblue";
const SENDER = TEST_ENV.FOUNDER_PHONE!;
const NOW = "2026-09-14T12:00:00.000Z";

const derived = buildMockDerived();
/** Exactly what `simulate_cost_change` hands the model, per percentage. */
const at = (percentage: number) => {
  const s = mockWhatIf(derived, "aws", percentage);
  return {
    weekly: formatUsdWhole(s.current_weekly_cents),
    burnBefore: formatUsdWhole(s.current_burn_monthly_cents),
    burnAfter: formatUsdWhole(s.scenario_burn_monthly_cents),
    runwayBefore: formatMonths(s.current_runway_months),
    runwayAfter: formatMonths(s.scenario_runway_months),
  };
};
const FIG = { ...at(-30), cash: formatUsd(derived.cash_cents) };

/** `get_health_summary` returns `cash` with cents, so a reply may quote it exactly. */
const CASH_ANSWER: ScriptedTurn[] = [{ tool_calls: [{ name: "get_health_summary" }] }, { content: `You have ${FIG.cash} in the bank.` }];

function scripted(script: ScriptedTurn[], options: HarnessOptions = {}): Harness & { openai: FakeOpenAi } {
  const openai = fakeOpenAi(script);
  // `Object.assign`, not a spread: `Harness.messages` is a getter over the
  // captured fetches, and spreading would freeze it at "nothing sent yet".
  return Object.assign(createHarness({ ...options, llm: openAiClient({ apiKey: "test-openai-key", fetchImpl: openai.fetchImpl }) }), { openai });
}

const say = (text: string) => inbound(text, { from_number: SENDER, number: SENDER });

// ---------------------------------------------------------------------------

describe("the keyword path is untouched", () => {
  it("still answers WHY deterministically, with no model in the loop", async () => {
    const h = scripted([{ content: "the model should never be asked" }]);
    const { body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, say("why?"));
    expect(body).toMatchObject({ mode: "keyword", command: "WHY" });
    expect(body.reply).toBe(whyMessage(h.derived, h.derived.primary_incident!));
    expect(h.openai.requests).toHaveLength(0);
    expect(body.tool_calls).toBeUndefined();
  });

  it("logs a keyword turn with its command and no tool_calls", async () => {
    const h = scripted([]);
    await h.authed<SendblueWebhookResponse>(WEBHOOK, say("SHOW ME"));
    const rows = h.db.rows("imessage_log");
    expect(rows.map((r) => r.command)).toEqual(["SHOW ME", "SHOW ME"]);
    expect(rows.every((r) => r.tool_calls === null)).toBe(true);
  });
});

describe("what-if over tool calling", () => {
  const script: ScriptedTurn[] = [
    { tool_calls: [{ name: "simulate_cost_change", arguments: { entity: "AWS", percentage: -30 } }] },
    {
      content: [
        `AWS currently runs ${FIG.weekly}/wk.`,
        `At 30% lower, modeled monthly burn ${FIG.burnBefore} → ${FIG.burnAfter}, and modeled runway ${FIG.runwayBefore} → ${FIG.runwayAfter}.`,
        "Scenario estimate — not guaranteed savings.",
      ].join("\n"),
    },
  ];

  it("answers with figures that all come from the tool result", async () => {
    const h = scripted(script);
    const { status, body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, say("what if AWS were 30% lower?"));

    expect(status).toBe(200);
    expect(body).toMatchObject({ mode: "conversation", reply_sent: true, tool_calls: ["simulate_cost_change"] });
    expect(body.reason).toBeUndefined(); // the guard did not have to replace anything
    expect(body.reply).toContain(FIG.weekly);
    expect(body.reply).toContain(FIG.runwayAfter);
    expect(body.reply).toContain("Scenario estimate — not guaranteed savings.");
    expect(h.messages[0]!.content).toBe(body.reply);
  });

  it("persists the tools behind the reply on the outbound log row", async () => {
    const h = scripted(script);
    await h.authed<SendblueWebhookResponse>(WEBHOOK, say("what if AWS were 30% lower?"));
    const rows = h.db.rows("imessage_log");
    expect(rows[0]).toMatchObject({ direction: "inbound", command: null, tool_calls: null });
    expect(rows[1]).toMatchObject({ direction: "outbound", command: null, tool_calls: '["simulate_cost_change"]' });
  });

  it("resolves a natural vendor name to the ledger key", async () => {
    const h = scripted([
      { tool_calls: [{ name: "get_vendor_spend", arguments: { entity: "Amazon" } }] },
      { content: `Amazon (AWS) runs ${FIG.weekly}/wk in the current burn window.` },
    ]);
    const { body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, say("how much is Amazon costing us?"));
    expect(body.reply).toContain(FIG.weekly);
    expect(body.reason).toBeUndefined();
  });
});

describe("the number guard", () => {
  it("throws away the whole reply when a figure is not backed by a tool result", async () => {
    const h = scripted([
      { tool_calls: [{ name: "simulate_cost_change", arguments: { entity: "aws", percentage: -30 } }] },
      { content: `AWS runs about $99,999/wk, so you'd save a fortune.` },
    ]);
    const { body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, say("what if AWS were 30% lower?"));

    expect(body.reason).toBe("number_guard");
    expect(body.reply).not.toContain("$99,999");
    expect(body.reply).toBe(whyMessage(h.derived, h.derived.primary_incident!));
    expect(body.tool_calls).toEqual(["simulate_cost_change"]);
    expect(h.messages[0]!.content).toBe(body.reply); // the fabrication never left the Worker
  });

  it("strips a URL the model invented and keeps the one create_app_link returned", async () => {
    const link = `${TEST_ENV.PUBLIC_BASE_URL}/incidents/${derived.primary_incident!.id}`;
    const h = scripted([
      { tool_calls: [{ name: "create_app_link", arguments: { destination: "incident", id: derived.primary_incident!.id } }] },
      { content: `Here's the incident page: ${link}\nBackground: https://aws.amazon.com/blogs/whats-new` },
    ]);
    const { body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, say("send me the incident page"));

    expect(body.reply).toContain(link);
    expect(body.reply).not.toContain("aws.amazon.com");
  });

  it("falls back to the WHY message when the model returns nothing and something is flagged", async () => {
    const h = scripted([{ content: "   " }]);
    const { body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, say("hey"));
    expect(body.reason).toBe("no_content");
    expect(body.reply).toBe(whyMessage(h.derived, h.derived.primary_incident!));
    expect(body.reply_sent).toBe(true);
  });

  it("falls back to a health line when nothing is flagged at all", async () => {
    const quiet = { ...derived, incidents: [], primary_incident: null, one_off_incident: null };
    const h = scripted([{ content: `AWS is about $47,000/wk.` }], { provider: new MockDataProvider(quiet) });
    const { body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, say("how's AWS doing?"));

    expect(body.reason).toBe("number_guard");
    expect(body.reply).toBe(healthLineMessage(quiet));
    expect(body.reply).toContain(formatMonths(quiet.burn.runway_months));
  });

  it("keeps the reply to a chat-sized number of lines", async () => {
    const h = scripted([{ content: "one\ntwo\nthree\nfour\nfive\nsix" }]);
    const { body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, say("hey"));
    expect(body.reply!.split("\n")).toHaveLength(CONVERSATION.MAX_REPLY_LINES);
  });
});

describe("refusals", () => {
  it("refuses to move money without ever calling the model", async () => {
    const h = scripted([{ content: "the model should never be asked" }]);
    const { body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, say("pay the AWS bill"));

    expect(body).toMatchObject({ mode: "conversation", refused: true, tool_calls: [] });
    expect(body.reply).toBe(refusalMessage("MOVE_MONEY"));
    expect(h.openai.requests).toHaveLength(0);
  });

  it("routes an operational order through the model's explicit refuse tool", async () => {
    const h = scripted([{ tool_calls: [{ name: "refuse", arguments: { reason: "OPERATIONAL" } }] }]);
    const { body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, say("cancel Datadog"));

    expect(body).toMatchObject({ refused: true, tool_calls: ["refuse"] });
    expect(body.reply).toBe(refusalMessage("OPERATIONAL"));
    expect(h.openai.requests).toHaveLength(1);
  });

  it("says what it CAN answer in every refusal (AGENT_BEHAVIOR §4)", () => {
    for (const kind of ["MOVE_MONEY", "OPERATIONAL", "ADVICE", "PREDICTION"] as const) {
      expect(refusalMessage(kind)).toMatch(/I can (show|tell|give)/);
    }
  });

  it("pre-filters imperatives about cash, not questions about past payments", () => {
    for (const text of ["pay the AWS bill", "can you wire them $5,000", "please transfer 10k to payroll", "move the money to savings", "pay off the card"]) {
      expect(preFilterRefusal(text)).toBe("MOVE_MONEY");
    }
    for (const text of ["how much did we pay the contractors last month?", "what if AWS were 30% lower?", "cancel Datadog", "why did payroll go up", "send me the incident page"]) {
      expect(preFilterRefusal(text)).toBeNull();
    }
  });
});

describe("unknown vendors", () => {
  it("asks which vendor instead of answering with a number", async () => {
    const h = scripted([
      { tool_calls: [{ name: "get_vendor_spend", arguments: { entity: "Snowflake" } }] },
      { content: "I don't have any spend on record under Snowflake.\nDid you mean AWS, Datadog or Ashby?" },
    ]);
    const { body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, say("what about Snowflake?"));

    expect(body.reply).toMatch(/which|did you mean/i);
    expect(body.reply).not.toMatch(/\d/);
    expect(body.reason).toBeUndefined();
  });

  it("hands the model candidates rather than a zero", async () => {
    const h = scripted([{ tool_calls: [{ name: "get_vendor_spend", arguments: { entity: "Snowflake" } }] }, { content: "Which vendor did you mean?" }]);
    await h.authed<SendblueWebhookResponse>(WEBHOOK, say("what about Snowflake?"));

    const toolMessage = h.openai.requests[1]!.messages.find((m) => m.role === "tool");
    expect(toolMessage!.content).toContain('"known":false');
    expect(toolMessage!.content).toContain("AWS");
  });
});

describe("memory", () => {
  it("shows the model the previous exchange on the next turn", async () => {
    const twenty = at(-20);
    const forty = at(-40);
    const first = `At 20% lower, modeled runway ${twenty.runwayBefore} → ${twenty.runwayAfter}.`;
    const h = scripted([
      { tool_calls: [{ name: "simulate_cost_change", arguments: { entity: "aws", percentage: -20 } }] },
      { content: first },
      { tool_calls: [{ name: "simulate_cost_change", arguments: { entity: "aws", percentage: -40 } }] },
      { content: `At 40% lower, modeled runway ${forty.runwayBefore} → ${forty.runwayAfter}.` },
    ]);

    await h.authed<SendblueWebhookResponse>(WEBHOOK, say("what if aws were 20% lower"));
    await h.authed<SendblueWebhookResponse>(WEBHOOK, say("and 40%?"));

    // Third OpenAI call = first round of the second question.
    const second = h.openai.textOf(2);
    expect(second).toContain("what if aws were 20% lower");
    expect(second).toContain(first);
    expect(second).toContain("and 40%?");
  });

  it("does not leak one phone's thread into another's", async () => {
    const h = scripted([
      { content: "first answer" },
      { content: "second answer" },
    ], { env: { ALLOWED_PHONES: "+15559998888" } });

    await h.authed<SendblueWebhookResponse>(WEBHOOK, say("remember this"));
    await h.authed<SendblueWebhookResponse>(WEBHOOK, inbound("anything there?", { from_number: "+15559998888", number: "+15559998888" }));

    expect(h.openai.textOf(1)).not.toContain("remember this");
  });

  it("compacts the thread after the reply is sent, not before", async () => {
    const h = scripted([{ content: "a short answer" }, { content: JSON.stringify({ summary: "The founder asked about AWS several times." }) }]);
    const store = new D1Store(h.db);
    for (let i = 0; i < CONVERSATION.MAX_TURNS + 2; i++) {
      await store.logMessage({ direction: i % 2 === 0 ? "inbound" : "outbound", phone: SENDER, body: `older turn ${i}`, created_at: NOW, command: null });
    }

    const { body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, say("one more question"));
    expect(body.reply).toBe("a short answer");

    const summaries = h.db.rows("conversation_summaries");
    expect(summaries).toHaveLength(1);
    expect(String(summaries[0]!.summary)).not.toMatch(/\d/);
    // Two OpenAI calls: the reply, then the compaction that followed it.
    expect(h.openai.requests).toHaveLength(2);
    expect(h.openai.requests[1]!.response_format).toEqual({ type: "json_object" });
  });
});

describe("rate limiting", () => {
  async function seedReplies(h: ReturnType<typeof scripted>, count: number, createdAt: string): Promise<void> {
    const store = new D1Store(h.db);
    for (let i = 0; i < count; i++) {
      await store.logMessage({ direction: "outbound", phone: SENDER, body: `reply ${i}`, created_at: createdAt, command: null, tool_calls: ["get_health_summary"] });
    }
  }

  it("answers with HELP past the hourly cap, without calling the model", async () => {
    const h = scripted([{ content: "should not be reached" }]);
    await seedReplies(h, CONVERSATION.MAX_PER_HOUR, NOW);

    const { body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, say("what's our runway?"));
    expect(body).toMatchObject({ mode: "conversation", command: "HELP", reason: "rate_limited" });
    expect(body.reply).toBe(helpMessage());
    // Not even compaction: a turn that never reached OpenAI does not pay for one.
    expect(h.openai.requests).toHaveLength(0);
  });

  it("ignores replies older than the window", async () => {
    const h = scripted(CASH_ANSWER);
    await seedReplies(h, CONVERSATION.MAX_PER_HOUR, "2026-09-14T09:00:00.000Z");

    const { body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, say("what's our runway?"));
    expect(body.reason).toBeUndefined();
    expect(body.reply).toContain(FIG.cash);
  });

  it("does not count keyword replies against the conversational cap", async () => {
    const h = scripted(CASH_ANSWER);
    const store = new D1Store(h.db);
    for (let i = 0; i < CONVERSATION.MAX_PER_HOUR + 5; i++) {
      await store.logMessage({ direction: "outbound", phone: SENDER, body: "keyword reply", created_at: NOW, command: "WHY" });
    }

    const { body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, say("what's our runway?"));
    expect(body.reason).toBeUndefined();
  });
});

describe("degraded modes never 500", () => {
  it("sends HELP with an explanatory line when OpenAI is unconfigured", async () => {
    const h = createHarness(); // no llm injected, no OPENAI_API_KEY in TEST_ENV
    const { status, body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, say("what's our runway?"));

    expect(status).toBe(200);
    expect(body).toMatchObject({ mode: "conversation", command: "HELP", reason: "unconfigured", reply_sent: true });
    expect(body.reply).toContain(UNCONFIGURED_PREFIX);
    expect(body.reply).toContain(helpMessage());
  });

  it("sends plain HELP when OpenAI errors", async () => {
    const h = scripted([{ status: 500 }]);
    const { status, body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, say("what's our runway?"));

    expect(status).toBe(200);
    expect(body).toMatchObject({ command: "HELP", reason: "llm_error" });
    expect(body.reply).toBe(helpMessage());
    expect(body.reply).not.toContain(UNCONFIGURED_PREFIX);
  });

  it("sends HELP when OpenAI returns unparseable JSON", async () => {
    const h = scripted([{ raw: "<html>gateway</html>" }]);
    const { body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, say("what's our runway?"));
    expect(body.reason).toBe("llm_error");
  });

  it("still answers when Sendblue is down, and logs no outbound row", async () => {
    const h = scripted(CASH_ANSWER, { sendblueResponse: () => new Response("upstream exploded", { status: 500 }) });
    const { status, body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, say("how much cash?"));

    expect(status).toBe(200);
    expect(body.reply_sent).toBe(false);
    expect(body.error).toContain("upstream exploded");
    expect(h.db.rows("imessage_log").map((r) => r.direction)).toEqual(["inbound"]);
  });
});

describe("latency", () => {
  it("adds negligible time of its own around the OpenAI round-trips", async () => {
    // Four tool rounds is the worst case the router will run. With the network
    // scripted, whatever this measures is Canary's own overhead — the real
    // webhook latency is this plus 5 OpenAI calls.
    const h = scripted([
      { tool_calls: [{ name: "get_health_summary" }] },
      { tool_calls: [{ name: "get_incident" }] },
      { tool_calls: [{ name: "get_evidence" }] },
      { tool_calls: [{ name: "get_vendor_spend", arguments: { entity: "aws" } }] },
      { content: `Cash is ${FIG.cash}.` },
    ]);

    const started = Date.now();
    const { body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, say("give me the full picture"));
    const elapsed = Date.now() - started;

    expect(body.tool_calls).toEqual(["get_health_summary", "get_incident", "get_evidence", "get_vendor_spend"]);
    expect(h.openai.requests).toHaveLength(CONVERSATION.MAX_TOOL_ROUNDS + 1);
    expect(elapsed).toBeLessThan(1_000);
    console.log(JSON.stringify({ msg: "conversation_scripted_latency_ms", elapsed, openai_calls: h.openai.requests.length }));
  });
});
