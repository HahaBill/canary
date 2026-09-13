/**
 * OpenAI proposer for ledger search.
 *
 * The model sees the founder's query plus a compact catalog of merchants and
 * categories actually on the loaded sheet. It returns a structured filter.
 * It never writes an amount. `interpretLedgerFilter` sanitizes keys against
 * the pivot and applies typed dollar/ISO constraints from the founder's words.
 */
import {
  formatLedgerCatalog,
  interpretLedgerFilter,
  type LedgerCatalog,
  type LedgerFilterInterpretation,
  type LedgerFilterProposal,
  type LedgerFilterProposer,
  type LedgerPivot,
} from "@canary/shared";
import type { LlmClient } from "../conversation/openai.ts";

const SYSTEM = [
  "You translate a founder's request into a filter over THIS ledger sheet.",
  "Choose only from the entity keys, category keys, section keys, period keys and flags in the catalog.",
  "Never invent a vendor, a category, a date, a dollar amount, or a row that is not listed.",
  "Never include min_abs_cents or max_abs_cents — amounts are parsed from the founder's words elsewhere.",
  "Match the request to rows that exist: e.g. a delivery/food ask maps to meal merchants and the Meals category if those appear in the catalog; a cloud/hosting ask maps to cloud merchants and CLOUD_INFRASTRUCTURE if those appear.",
  "If nothing in the catalog matches, return {\"unmatched\":true,\"unmatched_reason\":\"<one short sentence, no figures>\"}.",
  'Respond with JSON only: {"entities":[],"sections":[],"categories":[],"flags":[],"has_incident":false,"post_change_only":false,"pre_change_only":false,"period_keys":[],"unmatched":false}.',
].join("\n");

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseModelSpec(raw: string | null): LedgerFilterProposal {
  if (!raw) return { unmatched: true };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { unmatched: true };
    const record = parsed as Record<string, unknown>;
    const spec: LedgerFilterProposal = {};
    const entities = strings(record.entities);
    const sections = strings(record.sections);
    const categories = strings(record.categories);
    const flags = strings(record.flags);
    const periodKeys = strings(record.period_keys);
    if (entities.length) spec.entities = entities;
    if (sections.length) spec.sections = sections as LedgerFilterProposal["sections"];
    if (categories.length) spec.categories = categories as LedgerFilterProposal["categories"];
    if (flags.length) spec.flags = flags as LedgerFilterProposal["flags"];
    if (periodKeys.length) spec.period_keys = periodKeys;
    if (record.has_incident === true) spec.has_incident = true;
    if (record.post_change_only === true) spec.post_change_only = true;
    if (record.pre_change_only === true) spec.pre_change_only = true;
    if (typeof record.from === "string") spec.from = record.from as LedgerFilterProposal["from"];
    if (typeof record.to === "string") spec.to = record.to as LedgerFilterProposal["to"];
    if (record.unmatched === true) spec.unmatched = true;
    if (typeof record.unmatched_reason === "string") spec.unmatched_reason = record.unmatched_reason;
    return spec;
  } catch {
    return { unmatched: true };
  }
}

export function proposeLedgerFilterWithLlm(llm: LlmClient): LedgerFilterProposer {
  return async (query: string, catalog: LedgerCatalog): Promise<LedgerFilterProposal> => {
    const completion = await llm.complete({
      jsonMode: true,
      maxTokens: 250,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `${formatLedgerCatalog(catalog)}\n\nFounder: ${query}` },
      ],
    });
    return parseModelSpec(completion.content);
  };
}

export async function interpretLedgerQuery(
  query: string,
  pivot: LedgerPivot,
  llm: LlmClient,
): Promise<LedgerFilterInterpretation> {
  return interpretLedgerFilter(query, pivot, llm.configured ? proposeLedgerFilterWithLlm(llm) : null);
}
