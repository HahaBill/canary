/**
 * The notification policy as the routes apply it, the deferred-alert queue, the
 * cron job, the alert log and the incident voice note.
 */
import type {
  AlertHistoryResponse,
  AlertsPendingResponse,
  DerivedDemoObject,
  ErrorResponse,
  IncidentDetailResponse,
  SendAlertResponse,
} from "@canary/shared";
import { buildMockDerived } from "@canary/shared/fixtures";
import { beforeEach, describe, expect, it } from "vitest";
import { MockDataProvider } from "../data/provider.ts";
import { createHarness, fakeTts, FIXED_NOW, TEST_ENV, type Harness } from "../test/harness.ts";
import { clearVoiceCache } from "./incidents.ts";
import type { DeliverPendingResponse } from "./alerts.ts";

const BUSY_UNTIL = "2026-09-14T13:30:00.000Z";
const AFTER_MEETING = "2026-09-14T13:31:00.000Z";
const SEND = "/api/alerts/send";
const DELIVER = "/api/alerts/deliver-pending";

/** A harness whose clock the test can move forward. */
function withClock(initial = FIXED_NOW): { h: Harness; setNow: (iso: string) => void } {
  let now = initial;
  const h = createHarness({ now: () => now, tts: fakeTts() });
  return { h, setNow: (iso) => (now = iso) };
}

/** A provider over a patched derived object, for cases the mock fixture does not contain. */
function providerWith(patch: (derived: DerivedDemoObject) => DerivedDemoObject): MockDataProvider {
  return new MockDataProvider(patch(buildMockDerived()));
}

describe("POST /api/alerts/send — notification policy", () => {
  it("sends a material, open, un-notified incident when the founder is free", async () => {
    const h = createHarness();
    const { status, body } = await h.authed<SendAlertResponse>(SEND, {});
    expect(status).toBe(200);
    expect(body.sent).toBe(true);
    expect(body.decision).toBeUndefined();
    expect(h.messages).toHaveLength(1);
  });

  it("does not text twice about the same incident (already_notified)", async () => {
    const h = createHarness();
    await h.authed<SendAlertResponse>(SEND, {});
    const second = await h.authed<SendAlertResponse>(SEND, {});
    expect(second.status).toBe(200);
    expect(second.body.sent).toBe(false);
    expect(second.body.decision).toEqual({ send: false, reason: "already_notified" });
    // Still exactly one Sendblue call, from the first send.
    expect(h.calls).toHaveLength(1);
    // The withheld text is reported so an operator can see what was suppressed.
    expect(second.body.message).toContain("🐤 Canary");
  });

  it("stays quiet about an acknowledged incident", async () => {
    const h = createHarness();
    const id = h.derived.primary_incident!.id;
    await h.post(`/api/incidents/${id}/status`, { status: "ACKNOWLEDGED" });
    const { status, body } = await h.authed<SendAlertResponse>(SEND, { incident_id: id });
    expect(status).toBe(200);
    expect(body).toMatchObject({ sent: false, to: TEST_ENV.FOUNDER_PHONE, decision: { send: false, reason: "not_open" } });
    expect(h.calls).toHaveLength(0);
  });

  it("stays quiet about an immaterial incident", async () => {
    const provider = providerWith((derived) => {
      const quiet = { ...derived.primary_incident!, materiality: { material: false, rules_triggered: [], values: {} } };
      return { ...derived, incidents: [quiet, derived.one_off_incident!], primary_incident: quiet };
    });
    const h = createHarness({ provider });
    const { body } = await h.authed<SendAlertResponse>(SEND, {});
    expect(body.decision).toEqual({ send: false, reason: "not_material" });
    expect(h.calls).toHaveLength(0);
  });

  it("force sends into a meeting, and again after the incident was notified", async () => {
    const h = createHarness();
    h.calendar.busy = { until: BUSY_UNTIL };

    const forced = await h.authed<SendAlertResponse>(SEND, { force: true });
    expect(forced.status).toBe(200);
    expect(forced.body.sent).toBe(true);
    expect(h.db.rows("pending_alerts")).toHaveLength(0);

    const again = await h.authed<SendAlertResponse>(SEND, { force: true });
    expect(again.body.sent).toBe(true);
    expect(h.messages).toHaveLength(2);
  });
});

describe("POST /api/alerts/send — deferral", () => {
  it("202s and queues the alert when the founder is in a meeting", async () => {
    const h = createHarness();
    h.calendar.busy = { until: BUSY_UNTIL };
    const { status, body } = await h.authed<SendAlertResponse>(SEND, {});
    expect(status).toBe(202);
    expect(body.sent).toBe(false);
    expect(body.decision).toEqual({ send: false, reason: "calendar_busy", until: BUSY_UNTIL });
    expect(body.pending).toEqual({
      incident_id: h.derived.primary_incident!.id,
      to: TEST_ENV.FOUNDER_PHONE,
      voice: true,
      created_at: FIXED_NOW,
      deliver_after: BUSY_UNTIL,
      attempts: 0,
    });

    // Nothing sent, nothing spent, and the incident is NOT marked notified.
    expect(h.calls).toHaveLength(0);
    const detail = await h.json<IncidentDetailResponse>(`/api/incidents/${h.derived.primary_incident!.id}`);
    expect(detail.body.incident.last_notified).toBeNull();

    const pending = await h.json<AlertsPendingResponse>("/api/alerts/pending");
    expect(pending.body.pending).toEqual([body.pending]);
    expect(h.db.rows("pending_alerts")[0]).toMatchObject({ voice: 1, delivered_at: null, attempts: 0 });
  });

  it("carries voice=false through to the queued alert", async () => {
    const h = createHarness();
    h.calendar.busy = { until: BUSY_UNTIL };
    const { body } = await h.authed<SendAlertResponse>(SEND, { voice: false });
    expect(body.pending?.voice).toBe(false);
  });

  it("re-queueing the same alert upserts rather than duplicating the text", async () => {
    const h = createHarness();
    h.calendar.busy = { until: BUSY_UNTIL };
    await h.authed<SendAlertResponse>(SEND, {});
    await h.authed<SendAlertResponse>(SEND, {});
    expect(h.db.rows("pending_alerts")).toHaveLength(1);
  });

  it("reports an empty queue when nothing was deferred", async () => {
    const h = createHarness();
    const { status, body } = await h.json<AlertsPendingResponse>("/api/alerts/pending");
    expect(status).toBe(200);
    expect(body.pending).toEqual([]);
  });
});

describe("draining the queue", () => {
  it("delivers text and voice once the founder is free", async () => {
    const { h, setNow } = withClock();
    h.calendar.busy = { until: BUSY_UNTIL };
    await h.authed<SendAlertResponse>(SEND, {});

    setNow(AFTER_MEETING);
    h.calendar.busy = null;
    const { status, body } = await h.authed<DeliverPendingResponse>(DELIVER);
    expect(status).toBe(200);
    expect(body.result).toMatchObject({ due: 1, delivered: [h.derived.primary_incident!.id], deferred: [], dropped: [], failed: [] });

    // text → voice upload → voice send, exactly as a live alert.
    expect(h.calls.map((c) => c.url)).toEqual([
      "https://api.sendblue.co/api/send-message",
      "https://api.sendblue.com/api/upload-file",
      "https://api.sendblue.co/api/send-message",
    ]);
    expect(h.messages[0]!.content).toContain("🐤 Canary");

    expect(h.db.rows("pending_alerts")[0]).toMatchObject({ delivered_at: AFTER_MEETING, attempts: 1 });
    expect((await h.json<AlertsPendingResponse>("/api/alerts/pending")).body.pending).toEqual([]);
    const detail = await h.json<IncidentDetailResponse>(`/api/incidents/${h.derived.primary_incident!.id}`);
    expect(detail.body.incident.last_notified).toBe(AFTER_MEETING);
  });

  it("pushes the alert out again when the meeting ran long", async () => {
    const { h, setNow } = withClock();
    h.calendar.busy = { until: BUSY_UNTIL };
    await h.authed<SendAlertResponse>(SEND, {});

    setNow(AFTER_MEETING);
    h.calendar.busy = { until: "2026-09-14T14:15:00.000Z" };
    const { body } = await h.authed<DeliverPendingResponse>(DELIVER);
    expect(body.result).toMatchObject({ due: 1, delivered: [], deferred: [h.derived.primary_incident!.id] });
    expect(h.calls).toHaveLength(0);
    expect(h.db.rows("pending_alerts")[0]).toMatchObject({ deliver_after: "2026-09-14T14:15:00.000Z", attempts: 1, delivered_at: null });

    // …and delivers on the pass after that.
    setNow("2026-09-14T14:16:00.000Z");
    h.calendar.busy = null;
    const second = await h.authed<DeliverPendingResponse>(DELIVER);
    expect(second.body.result.delivered).toEqual([h.derived.primary_incident!.id]);
    expect(h.db.rows("pending_alerts")[0]).toMatchObject({ attempts: 2 });
  });

  it("leaves an alert alone until its deliver_after has passed", async () => {
    const h = createHarness();
    h.calendar.busy = { until: BUSY_UNTIL };
    await h.authed<SendAlertResponse>(SEND, {});
    h.calendar.busy = null;
    const { body } = await h.authed<DeliverPendingResponse>(DELIVER);
    expect(body.result).toMatchObject({ due: 0, delivered: [], deferred: [] });
    expect(h.calls).toHaveLength(0);
  });

  it("drops a queued alert the founder answered during the meeting", async () => {
    const { h, setNow } = withClock();
    const id = h.derived.primary_incident!.id;
    h.calendar.busy = { until: BUSY_UNTIL };
    await h.authed<SendAlertResponse>(SEND, {});

    await h.post(`/api/incidents/${id}/status`, { status: "ACKNOWLEDGED" });
    setNow(AFTER_MEETING);
    h.calendar.busy = null;
    const { body } = await h.authed<DeliverPendingResponse>(DELIVER);
    expect(body.result.dropped).toEqual([{ incident_id: id, reason: "not_open" }]);
    expect(h.calls).toHaveLength(0);
    expect(h.db.rows("pending_alerts")[0]).toMatchObject({ delivered_at: AFTER_MEETING });
  });

  it("retries a queued alert Sendblue rejected, without marking it delivered", async () => {
    let now = FIXED_NOW;
    const h = createHarness({ now: () => now, sendblueResponse: () => new Response(JSON.stringify({ error: "bad number" }), { status: 422 }) });
    h.calendar.busy = { until: BUSY_UNTIL };
    await h.authed<SendAlertResponse>(SEND, {});
    now = AFTER_MEETING;
    h.calendar.busy = null;
    const { body } = await h.authed<DeliverPendingResponse>(DELIVER);
    expect(body.result.failed).toEqual([{ incident_id: h.derived.primary_incident!.id, error: "bad number" }]);
    expect(h.db.rows("pending_alerts")[0]).toMatchObject({ delivered_at: null, deliver_after: BUSY_UNTIL, attempts: 1 });
  });

  it("runs the same job from the cron handler", async () => {
    const { h, setNow } = withClock();
    h.calendar.busy = { until: BUSY_UNTIL };
    await h.authed<SendAlertResponse>(SEND, {});

    setNow(AFTER_MEETING);
    h.calendar.busy = null;
    const result = await h.runScheduled();
    expect(result).toMatchObject({ due: 1, delivered: [h.derived.primary_incident!.id] });
    expect(h.messages[0]!.content).toContain("🐤 Canary");
  });

  it("does nothing on a cron pass with an empty queue", async () => {
    const h = createHarness();
    expect(await h.runScheduled()).toEqual({ due: 0, delivered: [], deferred: [], dropped: [], failed: [] });
    expect(h.calls).toHaveLength(0);
  });

  it("requires the shared secret to drain the queue on demand", async () => {
    const h = createHarness();
    const { status, body } = await h.post<ErrorResponse>(DELIVER);
    expect(status).toBe(401);
    expect(body.error).toBe("unauthorized");
  });
});

describe("GET /api/alerts/history", () => {
  it("returns the log newest first and flags the voice note", async () => {
    const h = createHarness({ tts: fakeTts() });
    await h.authed<SendAlertResponse>(SEND, {});
    const { status, body } = await h.json<AlertHistoryResponse>("/api/alerts/history");
    expect(status).toBe(200);
    expect(body.items).toHaveLength(2);
    expect(body.items.map((i) => i.id)).toEqual([2, 1]);
    expect(body.items[0]).toMatchObject({ direction: "outbound", phone: TEST_ENV.FOUNDER_PHONE, voice: true, created_at: FIXED_NOW });
    expect(body.items[0]!.body).toContain("[voice note");
    expect(body.items[1]).toMatchObject({ voice: false, command: null });
  });

  it("records inbound replies alongside outbound alerts", async () => {
    const h = createHarness();
    await h.authed("/webhooks/sendblue", { content: "WHY", from_number: TEST_ENV.FOUNDER_PHONE, number: TEST_ENV.FOUNDER_PHONE, is_outbound: false });
    const { body } = await h.json<AlertHistoryResponse>("/api/alerts/history");
    expect(body.items.map((i) => i.direction)).toEqual(["outbound", "inbound"]);
    expect(body.items.find((i) => i.direction === "inbound")).toMatchObject({ body: "WHY", command: "WHY" });
  });

  it("honours limit, and clamps a silly one", async () => {
    const h = createHarness({ tts: fakeTts() });
    await h.authed<SendAlertResponse>(SEND, {});
    expect((await h.json<AlertHistoryResponse>("/api/alerts/history?limit=1")).body.items).toHaveLength(1);
    expect((await h.json<AlertHistoryResponse>("/api/alerts/history?limit=0")).body.items).toHaveLength(2);
    expect((await h.json<AlertHistoryResponse>("/api/alerts/history?limit=nope")).body.items).toHaveLength(2);
    expect((await h.json<AlertHistoryResponse>("/api/alerts/history?limit=9999")).body.items).toHaveLength(2);
  });

  it("returns an empty log when there is no D1", async () => {
    const h = createHarness({ db: undefined, env: { DB: undefined } });
    const { body } = await h.json<AlertHistoryResponse>("/api/alerts/history");
    expect(Array.isArray(body.items)).toBe(true);
  });
});

describe("GET /api/incidents/:id/voice", () => {
  beforeEach(clearVoiceCache);

  it("streams the same script the iMessage voice note speaks", async () => {
    const tts = fakeTts();
    const h = createHarness({ tts });
    const id = h.derived.primary_incident!.id;
    const res = await h.app.request(`/api/incidents/${id}/voice`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect((await res.arrayBuffer()).byteLength).toBe(4);
    expect(tts.spokenMp3).toHaveLength(1);
    // Voice never speaks exact figures (docs/AGENT_BEHAVIOR.md §3).
    expect(tts.spokenMp3[0]).not.toMatch(/\$|\d/);
  });

  it("synthesises once per incident and serves the cached bytes after that", async () => {
    const tts = fakeTts();
    const h = createHarness({ tts });
    const path = `/api/incidents/${h.derived.primary_incident!.id}/voice`;
    await h.app.request(path);
    await h.app.request(path);
    expect(tts.spokenMp3).toHaveLength(1);
  });

  it("503s when ElevenLabs is not configured", async () => {
    const h = createHarness();
    const res = await h.app.request(`/api/incidents/${h.derived.primary_incident!.id}/voice`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as ErrorResponse).error).toBe("tts_not_configured");
  });

  it("502s when synthesis fails", async () => {
    const h = createHarness({ tts: fakeTts({ mp3: () => ({ ok: false, status: 500, error: "boom" }) }) });
    const res = await h.app.request(`/api/incidents/${h.derived.primary_incident!.id}/voice`);
    expect(res.status).toBe(502);
    expect(((await res.json()) as ErrorResponse).detail).toBe("boom");
  });

  it("404s an unknown incident", async () => {
    const h = createHarness({ tts: fakeTts() });
    const res = await h.app.request("/api/incidents/inc_nope/voice");
    expect(res.status).toBe(404);
  });
});
