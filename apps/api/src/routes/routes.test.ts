/** Status + body shape for every route in `API_ROUTES`. */
import {
  API_ROUTES,
  EVIDENCE_KINDS,
  SCENARIO_LABEL,
  type BankAccountsResponse,
  type BankTransactionsResponse,
  type DemoResponse,
  type ErrorResponse,
  type HealthResponse,
  type HealthSummaryResponse,
  type IncidentDetailResponse,
  type IncidentEvidenceResponse,
  type IncidentsResponse,
  type SendAlertResponse,
  type SimulateResponse,
  type VendorEnrichmentResponse,
} from "@canary/shared";
import { SAMPLE_TRANSACTIONS } from "@canary/shared/fixtures";
import { describe, expect, it } from "vitest";
import { API_VERSION } from "../env.ts";
import { createHarness, fakeTts, FIXED_NOW, TEST_ENV } from "../test/harness.ts";
import type { IncidentStatusResponse } from "./incidents.ts";

describe("route surface", () => {
  it("declares a handler for every route in API_ROUTES", async () => {
    const h = createHarness();
    for (const route of Object.values(API_ROUTES)) {
      const [method, template] = route.split(" ") as [string, string];
      const path = template.replace(":id", "inc_mock_burn").replace(":entity", "ashby");
      const res = await h.app.request(path, {
        method,
        headers: { "content-type": "application/json", "x-canary-secret": TEST_ENV.WEBHOOK_SECRET },
        ...(method === "POST" ? { body: JSON.stringify({ status: "OPEN", entity: "aws", percentage: -20, destination: "dashboard", content: "HELP" }) } : {}),
      });
      expect(res.status, `${route} should be routed`).not.toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
    }
  });

  it("answers unknown API paths with the ErrorResponse shape", async () => {
    const h = createHarness();
    const { status, body } = await h.json<ErrorResponse>("/api/nope");
    expect(status).toBe(404);
    expect(body.error).toBe("not_found");
  });

  it("sets permissive CORS on /api/*", async () => {
    const h = createHarness();
    const res = await h.app.request("/api/health", { headers: { origin: "https://canary.test" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("GET /api/health", () => {
  it("returns the service banner with the injected clock", async () => {
    const h = createHarness();
    const { status, body } = await h.json<HealthResponse>("/api/health");
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, service: "canary-api", version: API_VERSION, time: FIXED_NOW });
  });
});

describe("GET /api/health-summary", () => {
  it("mirrors the derived object and renders speech from shared helpers", async () => {
    const h = createHarness();
    const { status, body } = await h.json<HealthSummaryResponse>("/api/health-summary");
    expect(status).toBe(200);
    expect(body.cash_cents).toBe(h.derived.cash_cents);
    expect(body.burn).toEqual(h.derived.burn);
    expect(body.company_name).toBe(h.derived.company.name);
    expect(body.bank_name).toBe(h.derived.company.bank_name);
    expect(body.reconciliation_status).toBe("OK");
    expect(body.needs_review_count).toBe(h.derived.needs_review.count);
    expect(body.open_incident_count).toBe(h.derived.incidents.filter((i) => i.status === "OPEN").length);
    expect(body.primary_incident?.id).toBe(h.derived.primary_incident?.id);
    expect(body.one_off_incident?.id).toBe(h.derived.one_off_incident?.id);

    // Speech is words, never digits, and mentions the driver.
    expect(body.speech.cash).toMatch(/dollars/);
    expect(body.speech.runway).toMatch(/months|not currently burning/);
    expect(body.speech.headline).toContain("AWS");
    expect(body.speech.headline).not.toMatch(/\d/);
  });
});

describe("GET /api/demo", () => {
  it("returns the derived object without fixture metadata", async () => {
    const h = createHarness();
    const response = await h.app.request("/api/demo");
    const status = response.status;
    const body = (await response.json()) as DemoResponse & { fixture?: unknown };
    expect(status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.fixture).toBeUndefined();
    expect(body.weeks).toHaveLength(h.derived.weeks.length);
    expect(body.incidents).toHaveLength(h.derived.incidents.length);
    // mock provenance passes straight through so the UI can shout about it
    expect(body.provenance.history_source).toBe("mock");
    expect(body.provenance.balance_source).toBe("mock");
    expect(body.provenance.company_is_fictional).toBe(true);
  });
});

describe("incidents", () => {
  it("lists incidents", async () => {
    const h = createHarness();
    const { status, body } = await h.json<IncidentsResponse>("/api/incidents");
    expect(status).toBe(200);
    expect(body.incidents.map((i) => i.id)).toEqual(h.derived.incidents.map((i) => i.id));
  });

  it("assembles the incident detail payload", async () => {
    const h = createHarness();
    const id = h.derived.primary_incident!.id;
    const { status, body } = await h.json<IncidentDetailResponse>(`/api/incidents/${id}`);
    expect(status).toBe(200);
    expect(body.incident.id).toBe(id);
    expect(body.weeks).toHaveLength(h.derived.weeks.length);
    expect(body.cusum_statistic_cents).toHaveLength(h.derived.weeks.length);
    expect(body.burn).toEqual(h.derived.burn);
    expect(body.cash_cents).toBe(h.derived.cash_cents);
    expect(body.provenance).toEqual(h.derived.provenance);
    expect(body.vendor_enrichments.every((e) => e.merchant_normalized === "ashby")).toBe(true);
    expect(body.evidence.some((e) => e.kind === "ESTIMATE")).toBe(true);
  });

  it("404s an unknown incident", async () => {
    const h = createHarness();
    const { status, body } = await h.json<ErrorResponse>("/api/incidents/inc_nope");
    expect(status).toBe(404);
    expect(body.error).toBe("incident_not_found");
  });

  it("serves the same evidence from the evidence route", async () => {
    const h = createHarness();
    const id = h.derived.primary_incident!.id;
    const detail = await h.json<IncidentDetailResponse>(`/api/incidents/${id}`);
    const evidence = await h.json<IncidentEvidenceResponse>(`/api/incidents/${id}/evidence`);
    expect(evidence.status).toBe(200);
    expect(evidence.body.evidence).toEqual(detail.body.evidence);
  });

  it("updates incident status and persists it to D1", async () => {
    const h = createHarness();
    const id = h.derived.primary_incident!.id;
    const { status, body } = await h.post<IncidentStatusResponse>(`/api/incidents/${id}/status`, { status: "ACKNOWLEDGED" });
    expect(status).toBe(200);
    expect(body.incident.status).toBe("ACKNOWLEDGED");
    expect(body.incident.last_updated).toBe(FIXED_NOW);

    const stored = h.db.rows("incidents").find((r) => r.id === id);
    expect(stored?.status).toBe("ACKNOWLEDGED");

    const after = await h.json<IncidentsResponse>("/api/incidents");
    expect(after.body.incidents.find((i) => i.id === id)?.status).toBe("ACKNOWLEDGED");
  });

  it("rejects an unknown status", async () => {
    const h = createHarness();
    const { status, body } = await h.post<ErrorResponse>(`/api/incidents/${h.derived.primary_incident!.id}/status`, { status: "SNOOZED" });
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_status");
  });

  it("404s a status update for an unknown incident", async () => {
    const h = createHarness();
    const { status } = await h.post<ErrorResponse>("/api/incidents/inc_nope/status", { status: "RESOLVED" });
    expect(status).toBe(404);
  });
});

describe("POST /api/simulate", () => {
  it("returns a labelled scenario with speech", async () => {
    const h = createHarness();
    const { status, body } = await h.post<SimulateResponse>("/api/simulate", { entity: "aws", percentage: -20 });
    expect(status).toBe(200);
    expect(body.label).toBe(SCENARIO_LABEL);
    expect(body.entity).toBe("aws");
    expect(body.percentage).toBe(-20);
    expect(body.current_weekly_cents).toBe(h.derived.burn.weekly_variable_by_entity.aws);
    expect(body.delta_monthly_cents).toBeLessThan(0);
    expect(body.speech.summary).toContain("twenty percent lower");
    expect(body.speech.summary).toContain(SCENARIO_LABEL);
    expect(body.speech.summary).not.toMatch(/\$/);
  });

  it("treats an unknown entity as zero spend rather than an error", async () => {
    const h = createHarness();
    const { status, body } = await h.post<SimulateResponse>("/api/simulate", { entity: "not_a_vendor", percentage: -20 });
    expect(status).toBe(200);
    expect(body.current_weekly_cents).toBe(0);
    expect(body.delta_monthly_cents).toBe(0);
    expect(body.no_change_reason).toContain("no spending on record");
  });

  const invalidBodies: Array<{ label: string; payload: Record<string, unknown>; error: string }> = [
    { label: "a non-numeric percentage", payload: { entity: "aws", percentage: "twenty" }, error: "invalid_percentage" },
    { label: "a null percentage", payload: { entity: "aws", percentage: null }, error: "invalid_percentage" },
    { label: "a missing percentage", payload: { entity: "aws" }, error: "invalid_percentage" },
    { label: "a percentage below -100", payload: { entity: "aws", percentage: -101 }, error: "percentage_out_of_range" },
    { label: "a percentage above 100", payload: { entity: "aws", percentage: 100.5 }, error: "percentage_out_of_range" },
    { label: "a missing entity", payload: { percentage: -20 }, error: "invalid_entity" },
    { label: "a blank entity", payload: { entity: "   ", percentage: -20 }, error: "invalid_entity" },
  ];

  for (const testCase of invalidBodies) {
    it(`400s on ${testCase.label}`, async () => {
      const h = createHarness();
      const { status, body } = await h.post<ErrorResponse>("/api/simulate", testCase.payload);
      expect(status).toBe(400);
      expect(body.error).toBe(testCase.error);
    });
  }

  it("400s on malformed JSON", async () => {
    const h = createHarness();
    const res = await h.app.request("/api/simulate", { method: "POST", body: "{oops", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
  });

  it("accepts a numeric string percentage from voice agents", async () => {
    const h = createHarness();
    const { status, body } = await h.post<SimulateResponse>("/api/simulate", { entity: "aws", percentage: "-20" });
    expect(status).toBe(200);
    expect(body.percentage).toBe(-20);
  });
});

describe("GET /api/vendors/:entity/enrichment", () => {
  it("returns the enrichment for a known vendor", async () => {
    const h = createHarness();
    const { status, body } = await h.json<VendorEnrichmentResponse>("/api/vendors/ashby/enrichment");
    expect(status).toBe(200);
    expect(body.enrichment?.merchant_normalized).toBe("ashby");
    expect(body.enrichment?.source_url).toBeTruthy();
  });

  it("returns null for an unknown vendor", async () => {
    const h = createHarness();
    const { status, body } = await h.json<VendorEnrichmentResponse>("/api/vendors/nobody/enrichment");
    expect(status).toBe(200);
    expect(body.enrichment).toBeNull();
  });
});

describe("bank routes", () => {
  it("serves sandbox accounts and closing cash", async () => {
    const h = createHarness();
    const { status, body } = await h.json<BankAccountsResponse>("/api/bank/accounts");
    expect(status).toBe(200);
    expect(body.bank_name).toBe(h.derived.company.bank_name);
    expect(body.accounts).toHaveLength(h.derived.accounts.length);
    expect(body.closing_cash_cents).toBe(h.derived.cash_cents);
    expect(body.as_of).toBe(h.derived.provenance.end_date);
  });

  it("serves an empty ledger until the generator is wired in", async () => {
    const h = createHarness();
    const { status, body } = await h.json<BankTransactionsResponse>("/api/bank/transactions");
    expect(status).toBe(200);
    expect(body.transactions).toEqual([]);
  });

  it("filters an injected ledger by date and account", async () => {
    const h = createHarness({ bankTransactions: async () => SAMPLE_TRANSACTIONS });
    const all = await h.json<BankTransactionsResponse>("/api/bank/transactions");
    expect(all.body.transactions.length).toBe(SAMPLE_TRANSACTIONS.length);

    const filtered = await h.json<BankTransactionsResponse>("/api/bank/transactions?from=2026-09-01&to=2026-09-13&account_id=chk");
    expect(filtered.status).toBe(200);
    expect(filtered.body.transactions.length).toBeGreaterThan(0);
    expect(filtered.body.transactions.every((t) => t.account_id === "chk" && t.date >= "2026-09-01" && t.date <= "2026-09-13")).toBe(true);
  });
});

describe("POST /api/alerts/send", () => {
  it("requires the shared secret (it texts a real phone and spends credit)", async () => {
    const h = createHarness();
    const { status, body } = await h.post<ErrorResponse>("/api/alerts/send", {});
    expect(status).toBe(401);
    expect(body.error).toBe("unauthorized");
    expect(h.calls).toHaveLength(0);
  });

  it("sends the alert, logs it, and marks the incident notified", async () => {
    const h = createHarness();
    const { status, body } = await h.authed<SendAlertResponse>(API_ROUTES.sendAlert.split(" ")[1]!, {});
    expect(status).toBe(200);
    expect(body.sent).toBe(true);
    expect(body.to).toBe(TEST_ENV.FOUNDER_PHONE);
    expect(body.provider_message_id).toBe("msg_test_handle");
    expect(body.message).toContain("🐤 Canary");
    expect(body.message).toContain("Reply WHY or SHOW ME.");

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toBe("https://api.sendblue.co/api/send-message");
    expect(h.calls[0]!.headers["sb-api-key-id"]).toBe(TEST_ENV.SENDBLUE_API_KEY);
    expect(h.calls[0]!.headers["sb-api-secret-key"]).toBe(TEST_ENV.SENDBLUE_API_SECRET);
    expect(h.messages[0]).toEqual({ number: TEST_ENV.FOUNDER_PHONE, content: body.message, from_number: TEST_ENV.SENDBLUE_FROM_NUMBER });

    const logged = h.db.rows("imessage_log");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ direction: "outbound", phone: TEST_ENV.FOUNDER_PHONE, created_at: "2026-09-14T12:00:00.000Z" });

    const detail = await h.json<IncidentDetailResponse>(`/api/incidents/${h.derived.primary_incident!.id}`);
    expect(detail.body.incident.last_notified).toBe(FIXED_NOW);
  });

  it("honours an explicit recipient and incident id", async () => {
    const h = createHarness();
    const { body } = await h.authed<SendAlertResponse>("/api/alerts/send", { to: "+15557654321", incident_id: h.derived.one_off_incident!.id });
    expect(body.to).toBe("+15557654321");
    expect(h.messages[0]!.number).toBe("+15557654321");
  });

  it("400s with no recipient anywhere", async () => {
    const h = createHarness({ env: { FOUNDER_PHONE: "" } });
    const { status, body } = await h.authed<ErrorResponse>("/api/alerts/send", {});
    expect(status).toBe(400);
    expect(body.error).toBe("missing_recipient");
  });

  it("404s for an unknown incident id", async () => {
    const h = createHarness();
    const { status } = await h.authed<ErrorResponse>("/api/alerts/send", { incident_id: "inc_nope" });
    expect(status).toBe(404);
  });

  it("503s when Sendblue credentials are absent", async () => {
    const h = createHarness({ env: { SENDBLUE_API_KEY: "", SENDBLUE_API_SECRET: "", SENDBLUE_FROM_NUMBER: "" } });
    const { status, body } = await h.authed<SendAlertResponse>("/api/alerts/send", {});
    expect(status).toBe(503);
    expect(body.sent).toBe(false);
    expect(body.error).toBe("SENDBLUE_NOT_CONFIGURED");
    expect(h.calls).toHaveLength(0);
  });

  it("reports the voice note as skipped when ElevenLabs is not configured", async () => {
    const h = createHarness();
    const { body } = await h.authed<SendAlertResponse>("/api/alerts/send", {});
    expect(body.sent).toBe(true);
    expect(body.voice?.sent).toBe(false);
    expect(body.voice?.error).toBe("ELEVENLABS_NOT_CONFIGURED");
    expect(body.voice?.transcript).toContain("Canary");
    expect(h.calls).toHaveLength(1);
  });

  it("sends text, then uploads a CAF voice note and sends it as media (same incident, no exact figures spoken)", async () => {
    const tts = fakeTts(); // 1s of silence at 24kHz S16LE
    const h = createHarness({ tts });
    const { body } = await h.authed<SendAlertResponse>("/api/alerts/send", {});
    expect(body.sent).toBe(true);
    expect(body.voice).toMatchObject({ sent: true, seconds: 1, media_url: "https://storage.test/inbound-file-store/abc_CanaryAlert.caf" });
    expect(tts.spoken).toEqual([body.voice!.transcript]);
    expect(body.voice!.transcript).not.toMatch(/\$|\d/);
    // text → upload → media send
    expect(h.calls.map((c) => c.url)).toEqual([
      "https://api.sendblue.co/api/send-message",
      "https://api.sendblue.com/api/upload-file",
      "https://api.sendblue.co/api/send-message",
    ]);
    expect(h.calls[2]!.body).toMatchObject({ media_url: body.voice!.media_url, number: TEST_ENV.FOUNDER_PHONE });
    expect(h.calls[2]!.body).not.toHaveProperty("content");
  });

  it("skips the voice note when voice=false", async () => {
    const h = createHarness({ tts: fakeTts() });
    const { body } = await h.authed<SendAlertResponse>("/api/alerts/send", { voice: false });
    expect(body.voice).toBeUndefined();
    expect(h.calls).toHaveLength(1);
  });

  it("keeps the text alert delivered when TTS fails", async () => {
    const h = createHarness({ tts: fakeTts({ pcm: () => ({ ok: false, sampleRate: 24_000, status: 500, error: "boom" }) }) });
    const { status, body } = await h.authed<SendAlertResponse>("/api/alerts/send", {});
    expect(status).toBe(200);
    expect(body.sent).toBe(true);
    expect(body.voice?.sent).toBe(false);
    expect(body.voice?.error).toBe("tts: boom");
    expect(h.calls).toHaveLength(1);
  });

  it("502s when Sendblue rejects the message", async () => {
    const h = createHarness({ sendblueResponse: () => new Response(JSON.stringify({ error: "bad number" }), { status: 422 }) });
    const { status, body } = await h.authed<SendAlertResponse>("/api/alerts/send", {});
    expect(status).toBe(502);
    expect(body.sent).toBe(false);
    expect(body.error).toBe("bad number");
  });
});

describe("agent tools", () => {
  it("get_health_summary matches the REST figures in iMessage format", async () => {
    const h = createHarness();
    const rest = await h.json<HealthSummaryResponse>("/api/health-summary");
    const tool = await h.post<{ cash: string; speech: { cash: string } }>("/api/tools/get_health_summary");
    expect(tool.status).toBe(200);
    expect(tool.body.cash).toMatch(/^\$/);
    expect(tool.body.speech.cash).toBe(rest.body.speech.cash);
  });

  it("get_incident defaults to the primary incident and adds speech", async () => {
    const h = createHarness();
    const { status, body } = await h.post<{ vendor: string; speech: Record<string, string> }>("/api/tools/get_incident", {});
    expect(status).toBe(200);
    expect(body.vendor).toBe("AWS");
    expect(body.speech.summary).toContain("AWS");
    expect(body.speech.drivers).toMatch(/dollars a week/);
    expect(body.speech.impact).toMatch(/runway/);
    expect(`${body.speech.summary}${body.speech.drivers}${body.speech.impact}`).not.toMatch(/\$/);
  });

  it("get_incident accepts an explicit id and reports unknown ones as not flagged", async () => {
    const h = createHarness();
    const ok = await h.post<{ type: string }>("/api/tools/get_incident", { id: h.derived.one_off_incident!.id });
    expect(ok.body.type).toBe("ONE_OFF_VENDOR_PAYMENT");
    const missing = await h.post<{ flagged: boolean }>("/api/tools/get_incident", { id: "inc_nope" });
    expect(missing.status).toBe(200);
    expect(missing.body.flagged).toBe(false);
  });

  it("simulate_cost_change returns the same scenario iMessage would speak", async () => {
    const h = createHarness();
    const rest = await h.post<SimulateResponse>("/api/simulate", { entity: "datadog", percentage: 10 });
    const tool = await h.post<{ vendor: string; percentage: number; label: string; speech: { summary: string } }>(
      "/api/tools/simulate_cost_change",
      { entity: "datadog", percentage: 10 },
    );
    expect(tool.body.vendor).toBe("Datadog");
    expect(tool.body.percentage).toBe(rest.body.percentage);
    expect(tool.body.label).toBe(rest.body.label);
    expect(tool.body.speech.summary).toMatch(/Datadog/);
  });

  it("create_app_link builds absolute URLs for every tab", async () => {
    const h = createHarness();
    const dashboard = await h.post<{ url: string; path: string }>("/api/tools/create_app_link", { destination: "dashboard" });
    expect(dashboard.body).toEqual({ url: `${TEST_ENV.PUBLIC_BASE_URL}/home`, path: "/home" });

    const overview = await h.post<{ url: string; path: string }>("/api/tools/create_app_link", { destination: "incident", id: "inc_1" });
    expect(overview.body.path).toBe("/incidents/inc_1");

    const evidence = await h.post<{ url: string; path: string }>("/api/tools/create_app_link", { destination: "incident", id: "inc_1", tab: "evidence" });
    expect(evidence.body).toEqual({ url: `${TEST_ENV.PUBLIC_BASE_URL}/incidents/inc_1?tab=evidence`, path: "/incidents/inc_1?tab=evidence" });
  });

  it("create_app_link returns structured errors instead of 400", async () => {
    const h = createHarness();
    expect((await h.post<ErrorResponse>("/api/tools/create_app_link", { destination: "space" })).body.error).toBe("invalid_destination");
    expect((await h.post<ErrorResponse>("/api/tools/create_app_link", { destination: "incident" })).body.error).toBe("missing_id");
  });
});

describe("evidence taxonomy", () => {
  it("orders items OBSERVED → DETECTED → EVIDENCE → ESTIMATE → SUGGESTION", async () => {
    const h = createHarness();
    const { body } = await h.json<IncidentDetailResponse>(`/api/incidents/${h.derived.primary_incident!.id}`);
    const ranks = body.evidence.map((e) => EVIDENCE_KINDS.indexOf(e.kind));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(body.evidence.map((e) => e.kind))).toEqual(new Set(EVIDENCE_KINDS));
  });

  it("cites external sources with a retrieval date and cached flag", async () => {
    const h = createHarness();
    const { body } = await h.json<IncidentDetailResponse>(`/api/incidents/${h.derived.primary_incident!.id}`);
    const cited = body.evidence.find((e) => e.kind === "EVIDENCE" && e.source_url === h.derived.vendor_enrichments[0]!.source_url);
    expect(cited).toBeDefined();
    expect(cited!.retrieved_at).toBe(h.derived.vendor_enrichments[0]!.retrieved_at);
    expect(cited!.cached).toBe(true);
    expect(cited!.text).toContain(h.derived.vendor_enrichments[0]!.business_type);
  });
});
