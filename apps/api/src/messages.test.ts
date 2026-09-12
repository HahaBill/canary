/** iMessage templates. Every figure must come from the shared money helpers. */
import { formatMonths, formatSignedUsd, formatUsdWhole, IMESSAGE_COMMANDS } from "@canary/shared";
import { buildMockDerived } from "@canary/shared/fixtures";
import { describe, expect, it } from "vitest";
import { positiveContributors, variableSpendRates } from "./derive.ts";
import { displayName, formatDateShort } from "./format.ts";
import { alertMessage, alertVoiceScript, renderAlert, dashboardMessage, helpMessage, showMeMessage, sourcesMessage, whyMessage } from "./messages.ts";

const derived = buildMockDerived();
const incident = derived.primary_incident!;
const oneOff = derived.one_off_incident!;
const BASE = "https://canary.test";

describe("displayName", () => {
  it("uses the known map, then title-cases", () => {
    expect(displayName("aws")).toBe("AWS");
    expect(displayName("datadog")).toBe("Datadog");
    expect(displayName("github")).toBe("GitHub");
    expect(displayName("gusto_payroll")).toBe("Gusto payroll");
    expect(displayName("acme_cloud_co")).toBe("Acme Cloud Co");
  });
});

describe("formatDateShort", () => {
  it("renders an ISO date without timezone drift", () => {
    expect(formatDateShort("2026-07-06")).toBe("Jul 6, 2026");
    expect(formatDateShort("2026-01-01")).toBe("Jan 1, 2026");
    expect(formatDateShort(null)).toBe("");
  });
});

describe("alertMessage", () => {
  it("matches the DEMO.md wording, plus the runway impact line", () => {
    const { runway_before_months: before, runway_after_months: after } = incident.financial_impact;
    expect(alertMessage(incident)).toBe(
      [
        "🐤 Canary",
        "I detected a sustained increase in variable spending.",
        "AWS is currently the largest contributor.",
        `Impact: modeled runway ${formatMonths(before)} → ${formatMonths(after)} versus the previous spending regime.`,
        "Reply WHY or SHOW ME.",
      ].join("\n"),
    );
  });

  it("renders a short, rounded voice script from the same incident (no exact figures, no URLs)", () => {
    const script = alertVoiceScript(incident);
    expect(script).toContain("AWS is the largest contributor");
    expect(script).toMatch(/Reply why for the breakdown, or show me/);
    expect(script).not.toMatch(/\$|https?:\/\/|\d/); // exact numbers stay in the text
    const words = script.split(/\s+/).length;
    expect(words).toBeGreaterThan(25);
    expect(words).toBeLessThan(80); // ~10–20 seconds spoken
    const rendering = renderAlert(incident, "https://canary.test");
    expect(rendering.text_summary).toBe(alertMessage(incident));
    expect(rendering.voice_summary).toBe(script);
    expect(rendering.app_path).toBe(`/incidents/${incident.id}`);
  });
});

describe("whyMessage", () => {
  const message = whyMessage(derived, incident);
  const lines = message.split("\n");

  it("opens with the change period and closes with the next step", () => {
    expect(lines[0]).toBe(`Since the week of ${formatDateShort(incident.estimated_change_point)}, variable spending has stayed elevated.`);
    expect(lines.at(-1)).toBe("Reply SHOW ME for the incident page.");
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.length).toBeLessThanOrEqual(6);
  });

  it("quotes pre/post weekly variable spend from the engine", () => {
    const rates = variableSpendRates(derived, incident)!;
    expect(message).toContain(`${formatUsdWhole(rates.pre_weekly_cents)} → ${formatUsdWhole(rates.post_weekly_cents)}`);
  });

  it("names the top two contributors as +$/wk", () => {
    const [first, second] = positiveContributors(incident, 2);
    expect(message).toContain(`${displayName(first!.entity)} ${formatSignedUsd(first!.delta_weekly_cents, "/wk")}`);
    expect(message).toContain(`${displayName(second!.entity)} ${formatSignedUsd(second!.delta_weekly_cents, "/wk")}`);
    expect(message).toContain("+$");
  });

  it("shows runway before → after", () => {
    const { runway_before_months, runway_after_months } = incident.financial_impact;
    expect(message).toContain(`Runway: ${formatMonths(runway_before_months)} → ${formatMonths(runway_after_months)}.`);
  });

  it("describes a one-off incident differently", () => {
    const text = whyMessage(derived, oneOff);
    expect(text).toContain("one-off payment to Figma");
    expect(text).toContain(formatUsdWhole(oneOff.financial_impact.one_off_amount_cents!));
    expect(text).toContain("Reply SHOW ME for the incident page.");
  });
});

describe("showMeMessage", () => {
  it("is one line plus the deep link", () => {
    const lines = showMeMessage(incident, BASE).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("Here's the full AWS incident:");
    expect(lines[1]).toBe(`${BASE}/incidents/${incident.id}`);
  });
});

describe("sourcesMessage", () => {
  it("cites title, url, retrieval date and cache state", () => {
    const enrichment = derived.vendor_enrichments[0]!;
    const text = sourcesMessage(derived, incident);
    expect(text).toContain(`${enrichment.vendor_name}: ${enrichment.source_title} — ${enrichment.source_url}`);
    expect(text).toContain(`Retrieved ${formatDateShort(enrichment.retrieved_at.slice(0, 10))} (previously retrieved)`);
  });

  it("drops the cache marker for live results", () => {
    const live = buildMockDerived();
    live.vendor_enrichments[0]!.cached = false;
    expect(sourcesMessage(live, live.primary_incident)).not.toContain("(previously retrieved)");
  });

  it("says so when nothing has been researched", () => {
    const empty = buildMockDerived();
    empty.vendor_enrichments = [];
    expect(sourcesMessage(empty, empty.primary_incident)).toBe("No external sources yet.");
  });
});

describe("helpMessage / dashboardMessage", () => {
  it("lists every shared command", () => {
    const text = helpMessage();
    for (const command of IMESSAGE_COMMANDS) expect(text).toContain(command);
  });

  it("links to the dashboard root", () => {
    expect(dashboardMessage(BASE)).toContain(`${BASE}/`);
  });
});
