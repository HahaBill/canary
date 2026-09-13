/**
 * Every iMessage Canary sends, as pure functions of engine/detector output.
 *
 * Wording follows docs/DEMO.md. Numbers are formatted with the shared money
 * helpers — nothing here hard-codes a financial figure, and no LLM writes a
 * word of it.
 */
import {
  daysBetween,
  formatMonths,
  formatSignedUsd,
  formatUsdWhole,
  IMESSAGE_COMMANDS,
  numberToWords,
  ONE_OFF_MEDIAN_MULTIPLE,
  ONE_OFF_MIN_ABS_DIFF_CENTS,
  speakMonths,
  speakUsd,
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
  SCHEDULE: "book a 15-minute review on your calendar",
  HELP: "this list",
};

/**
 * The outbound alert that opens the demo (docs/DEMO.md 0:15).
 * Text carries the exact facts and labels; the voice note (below) is the
 * conversational summary of the SAME incident object, so they can't disagree.
 */
export function alertMessage(incident: Incident): string {
  const lines = [CANARY];
  if (incident.type === "ONE_OFF_VENDOR_PAYMENT") {
    lines.push(`I flagged an unusual one-off payment to ${displayName(incident.entity)}.`);
    const amount = incident.financial_impact.one_off_amount_cents;
    if (amount) lines.push(`Amount: ${formatUsdWhole(amount)}, well above this vendor's usual payments.`);
  } else {
    lines.push("I detected a sustained increase in variable spending.", `${displayName(driverEntity(incident))} is currently the largest contributor.`);
    const { runway_before_months, runway_after_months } = incident.financial_impact;
    if (runway_before_months !== null && runway_after_months !== null) {
      lines.push(`Impact: modeled runway ${formatMonths(runway_before_months)} → ${formatMonths(runway_after_months)} versus the previous spending regime.`);
    }
  }
  lines.push("Reply WHY or SHOW ME.");
  return lines.join("\n");
}

/**
 * Script for the ElevenLabs voice note that follows the alert. ~10–20 seconds
 * when spoken. Rounded, conversational, and derived from the same incident —
 * no exact figures (those stay in the text), no URLs, nothing prescriptive.
 */
export function alertVoiceScript(incident: Incident): string {
  const driver = displayName(driverEntity(incident));
  if (incident.type === "ONE_OFF_VENDOR_PAYMENT") {
    const amount = incident.financial_impact.one_off_amount_cents;
    return [
      `Hi, it's Canary. I flagged a one-off payment to ${driver} that's ${amount ? `${speakUsd(amount)}, ` : ""}well above what you usually pay them.`,
      "It still counts in your burn, but I've kept it out of the trend analysis so it doesn't look like a lasting shift.",
      "Reply why for the details, or show me to open it.",
    ].join(" ");
  }
  const when = incident.estimated_change_point ? weeksAgoPhrase(incident.estimated_change_point, incident.last_updated) : "recently";
  const { runway_before_months, runway_after_months } = incident.financial_impact;
  const runway =
    runway_before_months !== null && runway_after_months !== null && runway_after_months < runway_before_months
      ? `At the new rate, modeled runway is ${speakMonths(runway_after_months)}, down from ${speakMonths(runway_before_months).replace(/ months$/, "")}.`
      : "I've summarized the main drivers and what it means for runway.";
  return [
    `Hi, it's Canary. Your spending pattern shifted upward ${when}, and ${driver} is the largest contributor.`,
    runway,
    "Reply why for the breakdown, or show me to open the full investigation.",
  ].join(" ");
}

/** "about three weeks ago" / "several weeks ago" — rounded, from the incident's own dates. */
function weeksAgoPhrase(changePoint: string, asOf: string): string {
  const weeks = Math.round(daysBetween(changePoint, asOf.slice(0, 10)) / 7);
  if (weeks <= 1) return "about a week ago";
  if (weeks <= 4) return `about ${numberToWords(weeks)} weeks ago`;
  if (weeks <= 8) return "several weeks ago";
  return `about ${numberToWords(Math.round(weeks / 4))} months ago`;
}

export interface AlertRendering {
  incident_id: string;
  /** Precise, data-heavy iMessage text. */
  text_summary: string;
  /** Natural, rounded voice-note script. */
  voice_summary: string;
  app_path: string;
}

/** One incident → both renderings, so text and voice can never disagree. */
export function renderAlert(incident: Incident, baseUrl: string): AlertRendering {
  return {
    incident_id: incident.id,
    text_summary: alertMessage(incident),
    voice_summary: alertVoiceScript(incident),
    app_path: incidentLink(incident.id, baseUrl).path,
  };
}

/**
 * WHY — OBSERVED (what the money did) → DETECTED (which rule fired, with its
 * parameters) → ESTIMATE (modeled runway effect), per docs/AGENT_BEHAVIOR.md §5.
 *
 * The DETECTED line is required: naming the rule and when it fired is what
 * separates Canary from a chart that happens to look alarming. A founder can
 * then argue with the method, not just the conclusion.
 */
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
    lines.push(
      `Rule: vendor-relative one-off — at least ${ONE_OFF_MEDIAN_MULTIPLE}× this vendor's median and at least ${formatUsdWhole(ONE_OFF_MIN_ABS_DIFF_CENTS)} above it. It still counts in burn, but it's kept out of the trend analysis.`,
    );
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

    const cusum = incident.detection.cusum;
    if (cusum?.alarm_week_start) {
      lines.push(
        `Rule: CUSUM change-point detection on weekly variable spend (${cusum.baseline_weeks}-week baseline, alarm above ${formatUsdWhole(cusum.h_cents)}), alarm in the week of ${formatDateShort(cusum.alarm_week_start)}.`,
      );
    }

    const { runway_before_months, runway_after_months } = incident.financial_impact;
    if (runway_before_months !== null && runway_after_months !== null) {
      lines.push(`Modeled runway: ${formatMonths(runway_before_months)} → ${formatMonths(runway_after_months)}.`);
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

/**
 * The things Canary declines, per docs/AGENT_BEHAVIOR.md §4. Each refusal names
 * the limit and then the nearest real answer — §4 again: "Canary says what it
 * *can* answer." Fixed text, never model-written, so a refusal cannot be
 * negotiated one message at a time.
 */
export type RefusalKind = "MOVE_MONEY" | "OPERATIONAL" | "ADVICE" | "PREDICTION";

const REFUSALS: Record<RefusalKind, string[]> = {
  MOVE_MONEY: [
    "I can't move money. I only read this ledger — I have no ability to pay, transfer or stop a payment, and I wouldn't take that instruction over text if I did.",
    "I can show you what a vendor costs per week and what a change to it would do to modeled burn and runway.",
  ],
  OPERATIONAL: [
    "That's your call, not mine. I don't recommend cancelling, downgrading or switching a vendor — I surface the change and its size, and the decision belongs to you.",
    "I can show you what changed, how much of it this vendor is, and what a percentage change would do to modeled runway.",
  ],
  ADVICE: [
    "I report, I don't advise. I can't tell you what you should do.",
    "I can tell you what the money did, which rule flagged it, and what a scenario would model.",
  ],
  PREDICTION: [
    "I don't forecast. Modeled runway is a present-tense ratio of cash to current burn, not a prediction of when you run out.",
    "I can give you the current figures, the window they're measured over, and a what-if scenario.",
  ],
};

export function refusalMessage(kind: RefusalKind): string {
  return REFUSALS[kind].join("\n");
}

/**
 * The deterministic answer the conversational path falls back to when the number
 * guard rejects a generated reply and there is no incident to explain.
 */
export function healthLineMessage(derived: DerivedDemoObject): string {
  const { monthly_net_burn_cents, runway_months, weeks_in_window } = derived.burn;
  const lines = [`${formatUsdWhole(derived.cash_cents)} in the bank, burning ${formatUsdWhole(monthly_net_burn_cents)} a month.`];
  lines.push(`That burn is measured over ${weeks_in_window} weeks. Modeled runway is ${formatMonths(runway_months)}.`);
  lines.push("Reply HELP for what I can do.");
  return lines.join("\n");
}

/** Reply when the founder asks about an incident and Canary has none. */
export function noIncidentMessage(): string {
  return [CANARY, "Nothing is flagged right now — spending is tracking with its baseline.", "Reply HELP for what I can do."].join("\n");
}
