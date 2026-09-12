/**
 * Every iMessage Canary sends, as pure functions of engine/detector output.
 *
 * Wording follows docs/DEMO.md. Numbers are formatted with the shared money
 * helpers — nothing here hard-codes a financial figure, and no LLM writes a
 * word of it.
 */
import {
  formatMonths,
  formatSignedUsd,
  formatUsdWhole,
  IMESSAGE_COMMANDS,
  type DerivedDemoObject,
  type IMessageCommand,
  type Incident,
  type VendorEnrichment,
} from "@canary/shared";
import { driverEntity, incidentEntities, positiveContributors, variableSpendRates } from "./derive.ts";
import { displayName, formatDateShort } from "./format.ts";
import { createAppLink, incidentLink } from "./links.ts";

const CANARY = "🐤 Canary";

const COMMAND_HELP: Record<IMessageCommand, string> = {
  WHY: "why I flagged this",
  "SHOW ME": "open the incident page",
  SOURCES: "external sources I cited",
  HELP: "this list",
};

/** The outbound alert that opens the demo (docs/DEMO.md 0:15). */
export function alertMessage(incident: Incident): string {
  return [
    CANARY,
    "I detected a sustained increase in variable spending.",
    `${displayName(driverEntity(incident))} is currently the largest contributor.`,
    "Reply WHY or SHOW ME.",
  ].join("\n");
}

/** WHY — the change period, the rate change, the top drivers, the runway effect. */
export function whyMessage(derived: DerivedDemoObject, incident: Incident): string {
  const lines: string[] = [];

  if (incident.type === "ONE_OFF_VENDOR_PAYMENT") {
    const vendor = displayName(incident.entity);
    const when = incident.alarm_date ?? incident.estimated_change_point;
    lines.push(`I flagged a one-off payment to ${vendor}${when ? ` in the week of ${formatDateShort(when)}` : ""}.`);
    const amount = incident.financial_impact.one_off_amount_cents;
    if (amount) lines.push(`Amount: ${formatUsdWhole(amount)} — well above this vendor's usual payments.`);
    const oneOff = incident.detection.one_off;
    if (oneOff?.vendor_median_cents) {
      lines.push(`Prior ${vendor} payments ran around ${formatUsdWhole(oneOff.vendor_median_cents)} (${oneOff.prior_payment_count} payments).`);
    }
  } else {
    if (incident.estimated_change_point) {
      lines.push(`Since the week of ${formatDateShort(incident.estimated_change_point)}, variable spending has stayed elevated.`);
    }

    const rates = variableSpendRates(derived, incident);
    if (rates) {
      lines.push(`Weekly variable spend: ${formatUsdWhole(rates.pre_weekly_cents)} → ${formatUsdWhole(rates.post_weekly_cents)}.`);
    }

    const top = positiveContributors(incident, 2);
    if (top.length > 0) {
      const parts = top.map((c) => `${displayName(c.entity)} ${formatSignedUsd(c.delta_weekly_cents, "/wk")}`);
      lines.push(`Top contributors: ${parts.join(", ")}.`);
    }

    const { runway_before_months, runway_after_months } = incident.financial_impact;
    if (runway_before_months !== null && runway_after_months !== null) {
      lines.push(`Runway: ${formatMonths(runway_before_months)} → ${formatMonths(runway_after_months)}.`);
    }
  }

  if (lines.length === 0) lines.push(incident.summary);
  lines.push("Reply SHOW ME for the incident page.");
  return lines.join("\n");
}

/** SHOW ME — one line plus the backend-generated deep link. */
export function showMeMessage(incident: Incident, baseUrl: string): string {
  const { url } = incidentLink(incident.id, baseUrl);
  return [`Here's the full ${displayName(driverEntity(incident))} incident:`, url].join("\n");
}

/** SHOW ME with nothing flagged — send them to the dashboard instead. */
export function dashboardMessage(baseUrl: string): string {
  return ["Here's your Canary dashboard:", createAppLink({ destination: "dashboard" }, baseUrl).url].join("\n");
}

/** SOURCES — cited external research, or an honest "nothing yet". */
export function sourcesMessage(derived: DerivedDemoObject, incident: Incident | null): string {
  const all = derived.vendor_enrichments;
  const relevant = incident ? all.filter((e) => incidentEntities(incident).includes(e.merchant_normalized)) : [];
  const shown = relevant.length > 0 ? relevant : all;
  if (shown.length === 0) return "No external sources yet.";
  return ["Sources Canary cited:", ...shown.map(citation)].join("\n");
}

function citation(e: VendorEnrichment): string {
  const retrieved = formatDateShort(e.retrieved_at.slice(0, 10));
  const cached = e.cached ? " (previously retrieved)" : "";
  return `• ${e.vendor_name}: ${e.source_title} — ${e.source_url}\n  Retrieved ${retrieved}${cached}`;
}

/** HELP — always in sync with the shared IMESSAGE_COMMANDS list. */
export function helpMessage(): string {
  return [`${CANARY} commands`, ...IMESSAGE_COMMANDS.map((c) => `${c} — ${COMMAND_HELP[c]}`)].join("\n");
}

/** Reply when the founder asks about an incident and Canary has none. */
export function noIncidentMessage(): string {
  return [CANARY, "Nothing is flagged right now — spending is tracking with its baseline.", "Reply HELP for what I can do."].join("\n");
}
