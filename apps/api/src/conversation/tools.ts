/**
 * The tools the conversational model may call (PRD §21).
 *
 * Every one is a thin wrapper over `src/tools.ts` or the `DataProvider`, so the
 * text path, the voice path and the web app cannot disagree about a number.
 * Tool results are the ONLY source of figures in a reply — they carry the
 * already-formatted strings (`"$19,479"`, `"12.6 months"`) so the model copies
 * rather than formats, and `guard.ts` then checks that it did.
 */
import {
  formatMonths,
  formatSignedUsd,
  formatUsd,
  formatUsdWhole,
  weeklyToMonthly,
  type DerivedDemoObject,
  type Incident,
} from "@canary/shared";
import type { DataProvider } from "../data/provider.ts";
import { driverEntity, positiveContributors, primaryIncident, variableSpendRates } from "../derive.ts";
import { assembleEvidence } from "../evidence.ts";
import { displayName, formatDateShort } from "../format.ts";
import { createLink, getHealthSummary, simulateCostChange, PERCENTAGE_MAX, PERCENTAGE_MIN } from "../tools.ts";
import { resolveEntity } from "./entities.ts";
import type { ToolSchema } from "./openai.ts";

export const TOOL_NAMES = [
  "get_health_summary",
  "get_incident",
  "get_active_incidents",
  "simulate_cost_change",
  "get_evidence",
  "create_app_link",
  "get_vendor_spend",
  "list_transactions",
  "refuse",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export type ToolResult = Record<string, unknown>;

export interface ToolContext {
  provider: DataProvider;
  baseUrl: string;
}

/** `refuse` short-circuits the loop, so it is reported rather than returned as data. */
export interface ToolOutcome {
  result: ToolResult;
  /** Set when the model called `refuse`. */
  refusal?: { reason: string };
  /** URLs the model is allowed to repeat verbatim (see `guard.ts`). */
  urls: string[];
}

const OBJECT = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "get_health_summary",
      description: "Cash in the bank, modeled monthly net burn, the window that burn is measured over, and modeled runway. Use for any question about runway, burn or how much cash is left.",
      parameters: OBJECT({}),
    },
  },
  {
    type: "function",
    function: {
      name: "get_incident",
      description: "One incident: what changed, the detector and its parameters, the top contributors and the modeled runway impact. Omit `id` for the incident Canary most recently flagged.",
      parameters: OBJECT({ id: { type: "string", description: "Incident id from get_active_incidents. Omit for the primary incident." } }),
    },
  },
  {
    type: "function",
    function: {
      name: "get_active_incidents",
      description: "Everything Canary currently has flagged, most severe first. Use for 'what should I worry about' or 'anything flagged'.",
      parameters: OBJECT({}),
    },
  },
  {
    type: "function",
    function: {
      name: "simulate_cost_change",
      description: "Deterministic what-if: change one vendor's spend by a percentage and report modeled burn and runway before and after. The ONLY way to answer a 'what if' question.",
      parameters: OBJECT(
        {
          entity: { type: "string", description: "Vendor name as the founder said it; it is resolved to a ledger key." },
          percentage: { type: "number", description: `Signed percentage change between ${PERCENTAGE_MIN} and ${PERCENTAGE_MAX}. "30% lower" is -30.` },
        },
        ["entity", "percentage"],
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "get_evidence",
      description: "The evidence behind an incident in taxonomy order, including cited external research with source URLs and retrieval dates.",
      parameters: OBJECT({ incident_id: { type: "string", description: "Omit for the primary incident." } }),
    },
  },
  {
    type: "function",
    function: {
      name: "create_app_link",
      description: "The only way to produce a Canary URL. Returns a link to the dashboard or an incident page.",
      parameters: OBJECT(
        {
          destination: { type: "string", enum: ["dashboard", "incident"] },
          id: { type: "string", description: "Incident id. Required when destination is incident." },
          tab: { type: "string", enum: ["overview", "drivers", "evidence", "whatif"] },
        },
        ["destination"],
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "get_vendor_spend",
      description: "One vendor's weekly and monthly spend in the current burn window, plus how much it contributed to a flagged change. Returns known:false with candidates when the name does not resolve.",
      parameters: OBJECT({ entity: { type: "string", description: "Vendor name as the founder said it." } }, ["entity"]),
    },
  },
  {
    type: "function",
    function: {
      name: "list_transactions",
      description: "Newest matching ledger rows: a vendor, a date range (YYYY-MM-DD), and/or Needs Review. Use for 'what was that charge', 'recent AWS transactions', 'anything in Needs Review'. Returns a short newest-first list — never the whole ledger.",
      parameters: OBJECT({
        entity: { type: "string", description: "Vendor name as the founder said it. Omit to search every vendor." },
        from: { type: "string", description: "Inclusive start date, YYYY-MM-DD." },
        to: { type: "string", description: "Inclusive end date, YYYY-MM-DD." },
        needs_review: { type: "boolean", description: "True to return only Needs Review rows." },
      }),
    },
  },
  {
    type: "function",
    function: {
      name: "refuse",
      description: "Decline the request. Use for moving money, operational orders (cancel/downgrade/switch/fire), 'should I' advice, predictions, and anything outside this company's cash/ledger/incidents.",
      parameters: OBJECT(
        { reason: { type: "string", enum: ["MOVE_MONEY", "OPERATIONAL", "ADVICE", "PREDICTION", "OFF_TOPIC"] } },
        ["reason"],
      ),
    },
  },
];

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

/** Dispatch one model tool call. Unknown names and bad arguments come back as data, never as throws. */
export async function runTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  switch (name) {
    case "get_health_summary":
      return plain(await healthSummary(ctx));
    case "get_incident":
      return plain(await incidentDetail(ctx, str(args.id)));
    case "get_active_incidents":
      return plain(await activeIncidents(ctx));
    case "simulate_cost_change":
      return plain(await whatIf(ctx, str(args.entity) ?? "", num(args.percentage)));
    case "get_evidence":
      return evidence(ctx, str(args.incident_id));
    case "create_app_link":
      return appLink(ctx, args);
    case "get_vendor_spend":
      return plain(await vendorSpend(ctx, str(args.entity) ?? ""));
    case "list_transactions":
      return plain(await listedTransactions(ctx, args));
    case "refuse": {
      const reason = str(args.reason) ?? "ADVICE";
      return { result: { refused: true, reason }, refusal: { reason }, urls: [] };
    }
    default:
      return plain({ error: "unknown_tool", detail: `${name} is not a Canary tool.` });
  }
}

function plain(result: ToolResult): ToolOutcome {
  return { result, urls: [] };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return Number.NaN;
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

async function healthSummary(ctx: ToolContext): Promise<ToolResult> {
  const summary = await getHealthSummary(ctx.provider);
  const burn = summary.burn;
  return {
    company: summary.company_name,
    bank: `${summary.bank_name} (synthetic sandbox data, not a live bank)`,
    cash: formatUsd(summary.cash_cents),
    monthly_net_burn: formatUsdWhole(burn.monthly_net_burn_cents),
    weekly_variable_spend: formatUsdWhole(burn.weekly_variable_spend_cents),
    weekly_fixed_spend: formatUsdWhole(burn.weekly_fixed_spend_cents),
    modeled_runway: formatMonths(burn.runway_months),
    burn_window: `${burn.weeks_in_window} weeks, ${formatDateShort(burn.burn_window_start)} to ${formatDateShort(burn.burn_window_end)}`,
    burn_window_reason: windowReason(burn.burn_window_reason),
    open_incident_count: summary.open_incident_count,
    needs_review_count: summary.needs_review_count,
    needs_review_outflow: formatUsdWhole(summary.needs_review_outflow_cents),
    reconciliation_status: summary.reconciliation_status,
  };
}

function windowReason(reason: string): string {
  if (reason === "POST_CHANGE_SEGMENT") return "burn is measured over the post-change segment only, because spending shifted";
  if (reason === "POST_CHANGE_INSUFFICIENT_FALLBACK_TRAILING") return "the post-change segment is too short to average, so burn falls back to the trailing window";
  return "burn is measured over the default trailing window";
}

async function incidentDetail(ctx: ToolContext, id?: string): Promise<ToolResult> {
  const derived = await ctx.provider.getDerived();
  const incident = id ? (derived.incidents.find((i) => i.id === id) ?? null) : primaryIncident(derived);
  if (!incident) return { flagged: false, detail: "Nothing is flagged right now — spending is tracking with its baseline." };
  return incidentPayload(derived, incident);
}

function incidentPayload(derived: DerivedDemoObject, incident: Incident): ToolResult {
  const impact = incident.financial_impact;
  const rates = variableSpendRates(derived, incident);
  const cusum = incident.detection.cusum;
  const oneOff = incident.detection.one_off;

  const payload: ToolResult = {
    id: incident.id,
    type: incident.type,
    status: incident.status,
    severity: incident.severity,
    vendor: displayName(driverEntity(incident)),
    entity_key: driverEntity(incident),
    material: incident.materiality.material,
    change_point: formatDateShort(incident.estimated_change_point),
    contributors: positiveContributors(incident, 3).map((c) => ({
      vendor: displayName(c.entity),
      entity_key: c.entity,
      weekly_change: formatSignedUsd(c.delta_weekly_cents, "/wk"),
      monthly_change: formatSignedUsd(c.delta_monthly_cents, "/mo"),
      before_weekly: formatUsdWhole(c.pre_rate_weekly_cents),
      after_weekly: formatUsdWhole(c.post_rate_weekly_cents),
    })),
  };

  if (rates) {
    payload.variable_spend_before_weekly = formatUsdWhole(rates.pre_weekly_cents);
    payload.variable_spend_after_weekly = formatUsdWhole(rates.post_weekly_cents);
    payload.variable_spend_change_weekly = formatSignedUsd(rates.delta_weekly_cents, "/wk");
  }
  if (impact.delta_monthly_cents !== null) payload.monthly_burn_change = formatSignedUsd(impact.delta_monthly_cents, "/mo");
  if (impact.one_off_amount_cents) payload.one_off_amount = formatUsdWhole(impact.one_off_amount_cents);
  if (impact.runway_before_months !== null && impact.runway_after_months !== null) {
    payload.modeled_runway_before = formatMonths(impact.runway_before_months);
    payload.modeled_runway_after = formatMonths(impact.runway_after_months);
  }
  if (cusum?.alarm_week_start) {
    payload.detector = `CUSUM change-point detection on weekly variable spend: ${cusum.baseline_weeks}-week baseline, alarm threshold ${formatUsdWhole(cusum.h_cents)}, alarm in the week of ${formatDateShort(cusum.alarm_week_start)}`;
    payload.post_change_weeks = cusum.post_change_weeks;
  }
  if (oneOff) {
    payload.detector = `Vendor-relative one-off rule: ${formatUsdWhole(oneOff.current_amount_cents)} against a median of ${oneOff.vendor_median_cents === null ? "(too few prior payments)" : formatUsdWhole(oneOff.vendor_median_cents)} over ${oneOff.prior_payment_count} prior payments. It counts in burn but is kept out of the trend analysis.`;
  }
  if (!payload.detector) payload.detector = incident.summary;
  return payload;
}

async function activeIncidents(ctx: ToolContext): Promise<ToolResult> {
  const derived = await ctx.provider.getDerived();
  const open = derived.incidents.filter((i) => i.status === "OPEN");
  if (open.length === 0) return { count: 0, incidents: [], detail: "Nothing is flagged right now — spending is tracking with its baseline." };
  return {
    count: open.length,
    incidents: open.map((incident) => ({
      id: incident.id,
      vendor: displayName(driverEntity(incident)),
      type: incident.type,
      severity: incident.severity,
      material: incident.materiality.material,
      title: incident.title,
      change_point: formatDateShort(incident.estimated_change_point),
    })),
  };
}

async function whatIf(ctx: ToolContext, rawEntity: string, percentage: number): Promise<ToolResult> {
  const derived = await ctx.provider.getDerived();
  const resolved = resolveEntity(derived, rawEntity);
  if (!resolved.known) {
    return { known: false, requested: rawEntity, candidates: resolved.candidates, detail: "Ask the founder which vendor they mean. Do not answer with figures." };
  }
  if (!Number.isFinite(percentage) || percentage < PERCENTAGE_MIN || percentage > PERCENTAGE_MAX) {
    return { error: "invalid_percentage", detail: `percentage must be between ${PERCENTAGE_MIN} and ${PERCENTAGE_MAX}.` };
  }

  const result = await simulateCostChange(ctx.provider, { entity: resolved.entity, percentage });
  return {
    known: true,
    vendor: resolved.display_name,
    percentage: result.percentage,
    current_weekly: formatUsdWhole(result.current_weekly_cents),
    current_monthly: formatUsdWhole(result.current_monthly_cents),
    scenario_weekly: formatUsdWhole(result.hypothetical_weekly_cents),
    scenario_monthly: formatUsdWhole(result.hypothetical_monthly_cents),
    current_monthly_burn: formatUsdWhole(result.current_burn_monthly_cents),
    scenario_monthly_burn: formatUsdWhole(result.scenario_burn_monthly_cents),
    monthly_burn_change: formatSignedUsd(result.delta_monthly_cents, "/mo"),
    current_modeled_runway: formatMonths(result.current_runway_months),
    scenario_modeled_runway: formatMonths(result.scenario_runway_months),
    changes_nothing: result.delta_monthly_cents === 0,
    label: result.label,
  };
}

async function evidence(ctx: ToolContext, id?: string): Promise<ToolOutcome> {
  const derived = await ctx.provider.getDerived();
  const incident = id ? (derived.incidents.find((i) => i.id === id) ?? null) : primaryIncident(derived);
  if (!incident) return plain({ flagged: false, evidence: [], detail: "Nothing is flagged right now, so there is no evidence to cite." });

  const { evidence: items } = await assembleEvidence(ctx.provider, derived, incident);
  const urls = items.map((item) => item.source_url).filter((url): url is string => Boolean(url));
  return {
    result: {
      incident_id: incident.id,
      evidence: items.map((item) => ({
        kind: item.kind,
        text: item.text,
        ...(item.source_url ? { source_url: item.source_url } : {}),
        ...(item.source_title ? { source_title: item.source_title } : {}),
        ...(item.retrieved_at ? { retrieved: formatDateShort(item.retrieved_at.slice(0, 10)) } : {}),
        ...(item.cached ? { cached: true } : {}),
      })),
    },
    urls,
  };
}

function appLink(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
  const destination = str(args.destination);
  if (destination !== "dashboard" && destination !== "incident") {
    return plain({ error: "invalid_destination", detail: "destination must be dashboard or incident." });
  }
  const id = str(args.id);
  if (destination === "incident" && !id) return plain({ error: "missing_id", detail: "id is required for an incident link." });
  const tab = str(args.tab);
  const allowedTab = tab === "overview" || tab === "drivers" || tab === "evidence" || tab === "whatif" ? tab : undefined;

  const link = createLink({ destination, ...(id ? { id } : {}), ...(allowedTab ? { tab: allowedTab } : {}) }, ctx.baseUrl);
  return { result: { url: link.url }, urls: [link.url] };
}

async function vendorSpend(ctx: ToolContext, rawEntity: string): Promise<ToolResult> {
  const derived = await ctx.provider.getDerived();
  const resolved = resolveEntity(derived, rawEntity);
  if (!resolved.known) {
    return {
      known: false,
      requested: rawEntity,
      candidates: resolved.candidates,
      detail: "Canary has no spend on record under that name. Ask which vendor the founder means; do not answer with figures.",
    };
  }

  const weekly = derived.burn.weekly_variable_by_entity[resolved.entity] ?? 0;
  const payload: ToolResult = {
    known: true,
    vendor: resolved.display_name,
    entity_key: resolved.entity,
    weekly: formatUsdWhole(weekly),
    monthly: formatUsdWhole(weeklyToMonthly(weekly)),
    burn_window: `${derived.burn.weeks_in_window} weeks, ${formatDateShort(derived.burn.burn_window_start)} to ${formatDateShort(derived.burn.burn_window_end)}`,
  };

  for (const incident of derived.incidents) {
    const contributor = incident.contributors.find((c) => c.entity === resolved.entity);
    if (!contributor) continue;
    payload.flagged_incident_id = incident.id;
    payload.before_weekly = formatUsdWhole(contributor.pre_rate_weekly_cents);
    payload.after_weekly = formatUsdWhole(contributor.post_rate_weekly_cents);
    payload.weekly_change = formatSignedUsd(contributor.delta_weekly_cents, "/wk");
    payload.monthly_change = formatSignedUsd(contributor.delta_monthly_cents, "/mo");
    break;
  }
  return payload;
}

function displayCategory(category: string): string {
  return category
    .toLowerCase()
    .split("_")
    .map((word) => (word === "saas" ? "SaaS" : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

async function listedTransactions(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const derived = await ctx.provider.getDerived();
  const rawEntity = str(args.entity);
  let entity: string | undefined;
  if (rawEntity) {
    const resolved = resolveEntity(derived, rawEntity);
    if (!resolved.known) {
      return {
        known: false,
        requested: rawEntity,
        candidates: resolved.candidates,
        detail: "Canary has no transactions on record under that name. Ask which vendor the founder means; do not answer with figures.",
      };
    }
    entity = resolved.entity;
  }

  const selection = await ctx.provider.listTransactions({
    ...(entity ? { entity } : {}),
    ...(str(args.from) ? { from: str(args.from) } : {}),
    ...(str(args.to) ? { to: str(args.to) } : {}),
    ...(args.needs_review === true ? { needs_review: true } : {}),
  });

  return {
    known: true,
    ...(entity ? { vendor: displayName(entity) } : {}),
    grain: derived.provenance.history_source === "mock" ? "weekly_vendor_totals" : "posted_transactions",
    matched: selection.matched,
    shown: selection.items.length,
    newest_first: true,
    transactions: selection.items.map((row) => ({
      date: formatDateShort(row.date),
      vendor: displayName(row.entity),
      amount: formatUsdWhole(Math.abs(row.amount_cents)),
      direction: row.amount_cents < 0 ? "outflow" : "inflow",
      ...(row.category ? { category: displayCategory(row.category) } : {}),
      needs_review: row.needs_review,
      ...(row.needs_review ? { note: "Needs Review — the amount still counts in cash and burn." } : {}),
    })),
    ...(selection.matched > selection.items.length
      ? { detail: `Showing the newest ${selection.items.length} of ${selection.matched} matching rows. Ask for a vendor or a date range to narrow it.` }
      : {}),
  };
}
