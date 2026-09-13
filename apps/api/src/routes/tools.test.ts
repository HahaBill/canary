import { AGENT_TOOL_NAMES, formatUsd, type Classification, type DerivedDemoObject } from "@canary/shared";
import { buildMockDerived } from "@canary/shared/fixtures";
import { describe, expect, it } from "vitest";
import { MockDataProvider } from "../data/provider.ts";
import { createHarness } from "../test/harness.ts";

function withCloudClassification(base: DerivedDemoObject): DerivedDemoObject {
  const classifications: Record<string, Classification> = {
    txn_aws: {
      transaction_id: "txn_aws",
      merchant_normalized: "aws",
      category: "CLOUD_INFRASTRUCTURE",
      method: "RULE",
      reason: "test fixture",
      supporting_signals: [],
      confidence_level: "HIGH",
    },
  };
  return { ...base, classifications };
}

describe("agent tools (iMessage parity)", () => {
  it("serves every conversation tool over GET and POST", async () => {
    const h = createHarness();
    for (const name of AGENT_TOOL_NAMES) {
      const path = `/api/tools/${name}`;
      expect((await h.app.request(path)).status, `${name} GET`).toBe(200);
      expect((await h.post(path, {})).status, `${name} POST`).toBe(200);
    }
  });

  it("get_health_summary returns the formatted iMessage payload plus speech", async () => {
    const h = createHarness();
    const rest = await h.json<{ cash_cents: number; speech: { cash: string } }>("/api/health-summary");
    const tool = await h.json<{ cash: string; speech: { cash: string } }>("/api/tools/get_health_summary");
    expect(tool.status).toBe(200);
    expect(tool.body.cash).toBe(formatUsd(rest.body.cash_cents));
    expect(tool.body.speech.cash).toBe(rest.body.speech.cash);
  });

  it("get_incident defaults to the primary incident and never 404s a missing id", async () => {
    const h = createHarness();
    const { status, body } = await h.post<{ vendor: string; detector: string; speech: { summary: string } }>(
      "/api/tools/get_incident",
      {},
    );
    expect(status).toBe(200);
    expect(body.vendor).toBe("AWS");
    expect(body.detector).toMatch(/aws|AWS|variable spend/i);
    expect(body.speech.summary).toContain("AWS");
    expect(`${body.speech.summary}`).not.toMatch(/\$/);

    const missing = await h.post<{ flagged: boolean }>("/api/tools/get_incident", { id: "inc_nope" });
    expect(missing.status).toBe(200);
    expect(missing.body.flagged).toBe(false);
  });

  it("resolves spoken cloud cost the same way iMessage does", async () => {
    const derived = withCloudClassification(buildMockDerived());
    const h = createHarness({ provider: new MockDataProvider(derived) });
    const wrapped = await h.post<{ known: boolean; vendor: string; entity_key: string }>(
      "/api/tools/get_vendor_spend",
      { parameters: { vendor: "why cloud cost has risen" } },
    );
    expect(wrapped.body).toMatchObject({ known: true, vendor: "AWS", entity_key: "aws" });

    const viaGet = await h.json<{ known: boolean; vendor: string }>("/api/tools/get_vendor_spend?entity=cloud");
    expect(viaGet.body).toMatchObject({ known: true, vendor: "AWS" });
  });

  it("aliases get_runway and explain_incident onto the real tools", async () => {
    const h = createHarness();
    const runway = await h.json<{ cash: string }>("/api/tools/get_runway");
    const health = await h.json<{ cash: string }>("/api/tools/get_health_summary");
    expect(runway.body.cash).toBe(health.body.cash);

    const explained = await h.post<{ vendor: string }>("/api/tools/explain_incident", {});
    expect(explained.body.vendor).toBe("AWS");
  });

  it("returns structured errors as 200 so a voice host can speak them", async () => {
    const h = createHarness();
    const link = await h.post<{ error: string }>("/api/tools/create_app_link", { destination: "space" });
    expect(link.status).toBe(200);
    expect(link.body.error).toBe("invalid_destination");
  });
});
