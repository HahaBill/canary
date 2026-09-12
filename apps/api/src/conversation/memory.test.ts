/** Thread loading out of `imessage_log`, and the hourly conversational counter. */
import { describe, expect, it } from "vitest";
import { D1Store, VOICE_LOG_PREFIX } from "../data/d1.ts";
import { FakeD1 } from "../test/fake-d1.ts";
import { countRecentConversationalReplies, EMPTY_THREAD, estimatedTokens, loadThread } from "./memory.ts";

const PHONE = "+15550001111";
const OTHER = "+15559998888";
const NOW = "2026-09-14T12:00:00.000Z";

function storeWith(db = new FakeD1()): { db: FakeD1; store: D1Store } {
  return { db, store: new D1Store(db) };
}

describe("loadThread", () => {
  it("degrades to an empty thread without a D1 binding", async () => {
    expect(await loadThread(null, PHONE)).toEqual(EMPTY_THREAD);
    expect(await countRecentConversationalReplies(null, PHONE, NOW)).toBe(0);
  });

  it("reads inbound as the founder and outbound as Canary, oldest first", async () => {
    const { store } = storeWith();
    await store.logMessage({ direction: "inbound", phone: PHONE, body: "what's our runway?", created_at: NOW, command: null });
    await store.logMessage({ direction: "outbound", phone: PHONE, body: "Modeled runway is …", created_at: NOW, command: null, tool_calls: ["get_health_summary"] });

    const thread = await loadThread(store, PHONE);
    expect(thread.summary).toBeNull();
    expect(thread.turns.map((t) => t.role)).toEqual(["founder", "canary"]);
    expect(thread.turns[1]!.tool_calls).toEqual(["get_health_summary"]);
  });

  it("keeps one phone's thread out of another's", async () => {
    const { store } = storeWith();
    await store.logMessage({ direction: "inbound", phone: PHONE, body: "mine", created_at: NOW, command: null });
    await store.logMessage({ direction: "inbound", phone: OTHER, body: "theirs", created_at: NOW, command: null });

    expect((await loadThread(store, PHONE)).turns.map((t) => t.text)).toEqual(["mine"]);
    expect((await loadThread(store, OTHER)).turns.map((t) => t.text)).toEqual(["theirs"]);
  });

  it("skips transport rows nobody said", async () => {
    const { store } = storeWith();
    await store.logMessage({ direction: "outbound", phone: PHONE, body: `${VOICE_LOG_PREFIX} 14s]`, created_at: NOW, command: null });
    await store.logMessage({ direction: "inbound", phone: PHONE, body: "[ignored: not an allowed sender] hello", created_at: NOW, command: null });
    await store.logMessage({ direction: "inbound", phone: PHONE, body: "a real question", created_at: NOW, command: null });

    expect((await loadThread(store, PHONE)).turns.map((t) => t.text)).toEqual(["a real question"]);
  });

  it("replays only the turns the summary does not cover", async () => {
    const { store } = storeWith();
    for (const body of ["one", "two", "three"]) {
      await store.logMessage({ direction: "inbound", phone: PHONE, body, created_at: NOW, command: null });
    }
    await store.saveConversationSummary({ phone: PHONE, summary: "earlier: the founder asked about AWS", covers_through_id: 2, turns_compacted: 2, updated_at: NOW });

    const thread = await loadThread(store, PHONE);
    expect(thread.summary).toBe("earlier: the founder asked about AWS");
    expect(thread.covers_through_id).toBe(2);
    expect(thread.turns.map((t) => t.text)).toEqual(["three"]);
  });
});

describe("countRecentConversationalReplies", () => {
  it("counts outbound rows with tool_calls inside the window, and nothing else", async () => {
    const { store } = storeWith();
    await store.logMessage({ direction: "outbound", phone: PHONE, body: "recent", created_at: NOW, command: null, tool_calls: [] });
    await store.logMessage({ direction: "outbound", phone: PHONE, body: "old", created_at: "2026-09-14T09:00:00.000Z", command: null, tool_calls: [] });
    await store.logMessage({ direction: "outbound", phone: PHONE, body: "keyword", created_at: NOW, command: "WHY" });
    await store.logMessage({ direction: "inbound", phone: PHONE, body: "question", created_at: NOW, command: null, tool_calls: [] });
    await store.logMessage({ direction: "outbound", phone: OTHER, body: "other phone", created_at: NOW, command: null, tool_calls: [] });

    expect(await countRecentConversationalReplies(store, PHONE, "2026-09-14T11:00:00.000Z")).toBe(1);
  });
});

describe("estimatedTokens", () => {
  it("is a chars/4 proxy over the turn bodies", () => {
    expect(estimatedTokens([{ id: 1, role: "founder", text: "x".repeat(400), created_at: NOW }])).toBe(100);
  });
});
