/** Keyword routing + the inbound Sendblue webhook (auth, ignores, replies). */
import { IMESSAGE_COMMANDS, type ErrorResponse } from "@canary/shared";
import { describe, expect, it } from "vitest";
import { formatDateShort } from "../format.ts";
import type { SendblueWebhookResponse } from "../routes/webhooks.ts";
import { createHarness, inbound, TEST_ENV } from "../test/harness.ts";
import { matchCommand, replyTarget, shouldIgnoreInbound } from "./router.ts";

const WEBHOOK = "/webhooks/sendblue";
const SENDER = TEST_ENV.FOUNDER_PHONE!;
const STRANGER = "+15559998888";

describe("matchCommand", () => {
  it("is case- and whitespace-insensitive", () => {
    expect(matchCommand("WHY")).toBe("WHY");
    expect(matchCommand("why")).toBe("WHY");
    expect(matchCommand("  Why?  ")).toBe("WHY");
    expect(matchCommand("SHOW ME")).toBe("SHOW ME");
    expect(matchCommand("show me")).toBe("SHOW ME");
    expect(matchCommand("  show    me!! ")).toBe("SHOW ME");
    expect(matchCommand("ShowMe")).toBe("SHOW ME");
    expect(matchCommand("sources")).toBe("SOURCES");
    expect(matchCommand("Help")).toBe("HELP");
  });

  it("recognises every documented command", () => {
    for (const command of IMESSAGE_COMMANDS) expect(matchCommand(command)).toBe(command);
  });

  it("returns null for anything else", () => {
    expect(matchCommand("what is going on with aws")).toBeNull();
    expect(matchCommand("")).toBeNull();
    expect(matchCommand(undefined)).toBeNull();
  });
});

describe("inbound filtering", () => {
  it("ignores outbound echoes and empty bodies", () => {
    expect(shouldIgnoreInbound({ content: "WHY", is_outbound: true })).toBe(true);
    expect(shouldIgnoreInbound({ content: "   ", is_outbound: false })).toBe(true);
    expect(shouldIgnoreInbound({ is_outbound: false })).toBe(true);
    expect(shouldIgnoreInbound({ content: "WHY", is_outbound: false })).toBe(false);
  });

  it("replies to the sender, falling back to the conversation number", () => {
    expect(replyTarget({ from_number: SENDER, number: "+15551112222" })).toBe(SENDER);
    expect(replyTarget({ number: "+15551112222" })).toBe("+15551112222");
    expect(replyTarget({})).toBeNull();
  });
});

describe("webhook auth", () => {
  it("503s when WEBHOOK_SECRET is unset — but only to a caller presenting a secret; anonymous callers see 401", async () => {
    const h = createHarness({ env: { WEBHOOK_SECRET: "" } });
    const { status, body } = await h.authed<ErrorResponse>(WEBHOOK, inbound("WHY"));
    expect(status).toBe(503);
    expect(body.error).toBe("webhook_not_configured");
    expect((await h.post<ErrorResponse>(WEBHOOK, inbound("WHY"))).status).toBe(401);
    expect(h.calls).toHaveLength(0);
  });

  it("401s without a secret, and with a wrong one", async () => {
    const h = createHarness();
    expect((await h.post<ErrorResponse>(WEBHOOK, inbound("WHY"))).status).toBe(401);
    expect((await h.post<ErrorResponse>(`${WEBHOOK}?secret=nope`, inbound("WHY"))).status).toBe(401);
    expect((await h.post<ErrorResponse>(WEBHOOK, inbound("WHY"), { headers: { "x-canary-secret": "nope" } })).status).toBe(401);
    expect(h.calls).toHaveLength(0);
  });

  it("accepts x-canary-secret or Sendblue's sb-signing-secret, but never the query string", async () => {
    const h = createHarness();
    expect(
      (await h.post<SendblueWebhookResponse>(WEBHOOK, inbound("HELP"), { headers: { "x-canary-secret": TEST_ENV.WEBHOOK_SECRET } })).status,
    ).toBe(200);
    expect(
      (await h.post<SendblueWebhookResponse>(WEBHOOK, inbound("HELP"), { headers: { "sb-signing-secret": TEST_ENV.WEBHOOK_SECRET } })).status,
    ).toBe(200);
    expect((await h.post<ErrorResponse>(WEBHOOK, inbound("HELP"), { headers: { "sb-signing-secret": "nope" } })).status).toBe(401);
    // Query-string secrets would end up in request logs — rejected.
    expect((await h.post<ErrorResponse>(`${WEBHOOK}?secret=${TEST_ENV.WEBHOOK_SECRET}`, inbound("HELP"))).status).toBe(401);
    expect(h.calls).toHaveLength(2);
  });

  it("ignores senders that are not the founder / allowed phones, without spending a reply", async () => {
    const h = createHarness();
    const { status, body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, inbound("WHY", { from_number: STRANGER }));
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, ignored: true, reason: "sender_not_allowed" });
    expect(h.calls).toHaveLength(0);

    const h2 = createHarness({ env: { ALLOWED_PHONES: ` ${STRANGER} , +15550002222` } });
    const ok = await h2.authed<SendblueWebhookResponse>(WEBHOOK, inbound("HELP", { from_number: STRANGER }));
    expect(ok.body.reply_sent).toBe(true);
    expect(h2.messages[0]!.number).toBe(STRANGER);
  });

  it("treats a string 'true' is_outbound and messages from its own line as outbound", async () => {
    const h = createHarness();
    expect((await h.authed<SendblueWebhookResponse>(WEBHOOK, inbound("WHY", { is_outbound: "true" }))).body.ignored).toBe(true);
    expect((await h.authed<SendblueWebhookResponse>(WEBHOOK, inbound("WHY", { from_number: TEST_ENV.SENDBLUE_FROM_NUMBER }))).body.ignored).toBe(true);
    expect(h.calls).toHaveLength(0);
  });

  it("400s on a malformed body", async () => {
    const h = createHarness();
    const res = await h.app.request(WEBHOOK, { method: "POST", body: "not json", headers: { "content-type": "application/json", "x-canary-secret": TEST_ENV.WEBHOOK_SECRET } });
    expect(res.status).toBe(400);
  });
});

describe("webhook ignores", () => {
  it("never replies to its own outbound messages", async () => {
    const h = createHarness();
    const { status, body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, inbound("WHY", { is_outbound: true }));
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, ignored: true, reason: "outbound" });
    expect(h.calls).toHaveLength(0);
    expect(h.db.rows("imessage_log")).toHaveLength(0);
  });

  it("ignores empty content", async () => {
    const h = createHarness();
    const { body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, inbound("   "));
    expect(body.ignored).toBe(true);
    expect(body.reason).toBe("empty_content");
    expect(h.calls).toHaveLength(0);
  });

  it("ignores a message with nobody to reply to", async () => {
    const h = createHarness();
    const { body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, { content: "WHY", is_outbound: false });
    expect(body.ignored).toBe(true);
    expect(body.reason).toBe("no_reply_target");
    expect(h.calls).toHaveLength(0);
  });
});

describe("webhook keyword replies", () => {
  it("WHY explains the change with dated, dollar-denominated lines", async () => {
    const h = createHarness();
    const { status, body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, inbound("why?", { from_number: SENDER }));
    expect(status).toBe(200);
    expect(body.command).toBe("WHY");
    expect(body.reply_sent).toBe(true);

    const reply = body.reply!;
    expect(reply).toContain("+$");
    expect(reply).toContain(formatDateShort(h.derived.primary_incident!.estimated_change_point));
    expect(reply).toMatch(/[A-Z][a-z]{2} \d{1,2}, \d{4}/);
    expect(reply).toContain("AWS");
    expect(reply).toContain("Reply SHOW ME for the incident page.");
    expect(reply.split("\n").length).toBeLessThanOrEqual(6);

    expect(h.messages[0]!.number).toBe(SENDER);
    expect(h.messages[0]!.from_number).toBe(TEST_ENV.SENDBLUE_FROM_NUMBER);
    expect(h.messages[0]!.content).toBe(reply);
  });

  it("SHOW ME returns the backend-built deep link", async () => {
    const h = createHarness();
    const { body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, inbound("show   me", { from_number: SENDER }));
    expect(body.command).toBe("SHOW ME");
    expect(body.reply).toContain(`${TEST_ENV.PUBLIC_BASE_URL}/incidents/`);
    expect(body.reply).toContain(`${TEST_ENV.PUBLIC_BASE_URL}/incidents/${h.derived.primary_incident!.id}`);
  });

  it("SOURCES cites the vendor research with a retrieval date", async () => {
    const h = createHarness();
    const { body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, inbound("SOURCES"));
    const enrichment = h.derived.vendor_enrichments[0]!;
    expect(body.command).toBe("SOURCES");
    expect(body.reply).toContain(enrichment.source_title);
    expect(body.reply).toContain(enrichment.source_url);
    expect(body.reply).toContain("(previously retrieved)");
  });

  it("SOURCES is honest when there is no research", async () => {
    const h = createHarness();
    h.derived.vendor_enrichments.length = 0;
    const { body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, inbound("SOURCES"));
    expect(body.reply).toBe("No external sources yet.");
  });

  it("falls back to HELP for anything unrecognised", async () => {
    const h = createHarness();
    const { body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, inbound("what should I do about aws"));
    expect(body.command).toBe("HELP");
    for (const command of IMESSAGE_COMMANDS) expect(body.reply).toContain(command);
  });

  it("logs both directions to imessage_log", async () => {
    const h = createHarness();
    await h.authed<SendblueWebhookResponse>(WEBHOOK, inbound("WHY", { from_number: SENDER }));
    const rows = h.db.rows("imessage_log");
    expect(rows.map((r) => r.direction)).toEqual(["inbound", "outbound"]);
    expect(rows.every((r) => r.phone === SENDER)).toBe(true);
    expect(rows[0]!.body).toBe("WHY");
    expect(rows[1]!.provider_message_id).toBe("msg_test_handle");
  });

  it("still answers 200 (with reply_sent false) when Sendblue is down", async () => {
    const h = createHarness({ sendblueResponse: () => new Response("upstream exploded", { status: 500 }) });
    const { status, body } = await h.authed<SendblueWebhookResponse>(WEBHOOK, inbound("HELP"));
    expect(status).toBe(200);
    expect(body.reply_sent).toBe(false);
    expect(body.error).toContain("upstream exploded");
    expect(h.db.rows("imessage_log").map((r) => r.direction)).toEqual(["inbound"]);
  });
});
