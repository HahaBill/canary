/**
 * Rolling compaction, and the rule that makes it safe: a summary carries
 * intents, never figures (docs/AGENT_BEHAVIOR.md §3).
 */
import { describe, expect, it } from "vitest";
import { D1Store } from "../data/d1.ts";
import { FakeD1 } from "../test/fake-d1.ts";
import { fakeOpenAi, type ScriptedTurn } from "../test/fake-openai.ts";
import { CONVERSATION } from "./config.ts";
import { compactIfNeeded, needsCompaction, stripFigures } from "./compaction.ts";
import { loadThread, type ThreadTurn } from "./memory.ts";
import { openAiClient } from "./openai.ts";

const PHONE = "+15550001111";
const NOW = "2026-09-14T12:00:00.000Z";

function llm(script: ScriptedTurn[]) {
  const openai = fakeOpenAi(script);
  return { client: openAiClient({ apiKey: "test-openai-key", fetchImpl: openai.fetchImpl }), openai };
}

function summaryTurn(summary: string): ScriptedTurn {
  return { content: JSON.stringify({ summary }) };
}

/** Seeds `count` alternating founder/Canary turns through the real store. */
async function seedThread(store: D1Store, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const inbound = i % 2 === 0;
    await store.logMessage({
      direction: inbound ? "inbound" : "outbound",
      phone: PHONE,
      body: inbound ? `question number ${i} about aws` : `answer number ${i} about aws`,
      created_at: NOW,
      command: null,
      ...(inbound ? {} : { tool_calls: ["get_vendor_spend"] }),
    });
  }
}

describe("stripFigures", () => {
  it("removes dollar amounts, percentages and month counts", () => {
    const stripped = stripFigures("The founder asked what happens if AWS drops 30%, which saves $8,736/mo and extends runway to 26.5 months.");
    expect(stripped).not.toMatch(/\d/);
    expect(stripped).not.toContain("$");
    expect(stripped).not.toContain("%");
    expect(stripped).toContain("AWS");
    expect(stripped).toContain("founder asked");
  });

  it("removes spelled-out figures too", () => {
    const stripped = stripFigures("Canary said about nineteen thousand dollars a week and about twelve months of runway.");
    expect(stripped).not.toMatch(/thousand dollars|twelve months/);
    expect(stripped).toContain("Canary said");
  });

  it("removes dates, which are figures a later turn must not reuse", () => {
    expect(stripFigures("The change point was 2026-07-06.")).not.toMatch(/\d/);
  });

  it("leaves a figure-free note alone", () => {
    const note = "The founder asked about AWS and Datadog, acknowledged the variable-spend incident, and still wants to know about Snowflake.";
    expect(stripFigures(note)).toBe(note);
  });
});

describe("needsCompaction", () => {
  const turn = (i: number, text: string): ThreadTurn => ({ id: i, role: "founder", text, created_at: NOW });

  it("trips on turn count", () => {
    expect(needsCompaction(Array.from({ length: CONVERSATION.MAX_TURNS }, (_, i) => turn(i, "hi")))).toBe(false);
    expect(needsCompaction(Array.from({ length: CONVERSATION.MAX_TURNS + 1 }, (_, i) => turn(i, "hi")))).toBe(true);
  });

  it("trips on the token budget even with few turns", () => {
    const long = "x".repeat(CONVERSATION.TOKEN_BUDGET * CONVERSATION.CHARS_PER_TOKEN + 1);
    expect(needsCompaction([turn(1, long)])).toBe(true);
  });
});

describe("compactIfNeeded", () => {
  it("does nothing while the thread is under budget", async () => {
    const db = new FakeD1();
    const store = new D1Store(db);
    await seedThread(store, 4);
    const { client, openai } = llm([summaryTurn("should not be called")]);

    expect(await compactIfNeeded({ store, llm: client, now: () => NOW }, PHONE)).toEqual({ compacted: false, reason: "under_budget" });
    expect(openai.requests).toHaveLength(0);
    expect(db.rows("conversation_summaries")).toHaveLength(0);
  });

  it("folds everything but the most recent turns into a figure-free summary", async () => {
    const db = new FakeD1();
    const store = new D1Store(db);
    await seedThread(store, 15);
    const { client, openai } = llm([summaryTurn("The founder asked repeatedly about AWS spend; Canary answered with the weekly rate each time. $8,736/mo and 26.5 months came up.")]);

    const outcome = await compactIfNeeded({ store, llm: client, now: () => NOW }, PHONE);
    expect(outcome.compacted).toBe(true);

    const rows = db.rows("conversation_summaries");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phone: PHONE, covers_through_id: 9, turns_compacted: 9, updated_at: NOW });
    expect(String(rows[0]!.summary)).not.toMatch(/\d/);
    expect(String(rows[0]!.summary)).toContain("AWS");

    // Compaction is asked for JSON, at temperature 0, with no tools to choose from.
    expect(openai.requests[0]).toMatchObject({ temperature: 0, response_format: { type: "json_object" } });
    expect(openai.requests[0]!.tools).toBeUndefined();
  });

  it("makes the next load read as summary + the most recent turns only", async () => {
    const db = new FakeD1();
    const store = new D1Store(db);
    await seedThread(store, 15);
    const { client } = llm([summaryTurn("The founder kept asking about AWS.")]);
    await compactIfNeeded({ store, llm: client, now: () => NOW }, PHONE);

    const thread = await loadThread(store, PHONE);
    expect(thread.summary).toBe("The founder kept asking about AWS.");
    expect(thread.covers_through_id).toBe(9);
    expect(thread.turns).toHaveLength(CONVERSATION.KEEP_RECENT);
    expect(thread.turns.map((t) => t.id)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(thread.turns[0]!.text).toContain("number 9");
  });

  it("keeps the raw turns when OpenAI fails", async () => {
    const db = new FakeD1();
    const store = new D1Store(db);
    await seedThread(store, 15);
    const { client } = llm([{ status: 500 }]);

    expect(await compactIfNeeded({ store, llm: client, now: () => NOW }, PHONE)).toEqual({ compacted: false, reason: "llm_failed" });
    expect(db.rows("conversation_summaries")).toHaveLength(0);
    expect((await loadThread(store, PHONE)).turns).toHaveLength(15);
  });

  it("keeps the raw turns when OpenAI is not configured", async () => {
    const db = new FakeD1();
    const store = new D1Store(db);
    await seedThread(store, 15);
    const unconfigured = openAiClient({});

    expect(await compactIfNeeded({ store, llm: unconfigured, now: () => NOW }, PHONE)).toEqual({ compacted: false, reason: "llm_unconfigured" });
    expect((await loadThread(store, PHONE)).turns).toHaveLength(15);
  });

  it("compacts again later, carrying the previous note forward", async () => {
    const db = new FakeD1();
    const store = new D1Store(db);
    await seedThread(store, 15);
    const { client, openai } = llm([summaryTurn("First note about AWS."), summaryTurn("Second note about AWS and Datadog.")]);
    await compactIfNeeded({ store, llm: client, now: () => NOW }, PHONE);

    await seedThread(store, 13);
    const second = await compactIfNeeded({ store, llm: client, now: () => NOW }, PHONE);
    expect(second).toMatchObject({ compacted: true, turns_compacted: 22 });
    expect(db.rows("conversation_summaries")).toHaveLength(1);
    expect(openai.textOf(1)).toContain("First note about AWS.");
  });

  it("is a no-op without a D1 binding", async () => {
    const { client } = llm([]);
    expect(await compactIfNeeded({ store: null, llm: client, now: () => NOW }, PHONE)).toEqual({ compacted: false, reason: "no_store" });
  });
});
