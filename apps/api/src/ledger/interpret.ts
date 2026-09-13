/**
 * Natural-language → ledger filter spec.
 *
 * Rules parse first. The model may only name rows and periods that already
 * exist on the pivot; it never writes an amount. Dollar thresholds stay
 * whatever the founder typed (`parseLedgerQuery`).
 */
import {
  describeLedgerFilter,
  isEmptyLedgerFilter,
  mergeLedgerFilters,
  parseLedgerQuery,
  sanitizeLedgerFilter,
  type LedgerFilterQueryResponse,
  type LedgerFilterSpec,
  type LedgerPivot,
} from "@canary/shared";
import type { LlmClient } from "../conversation/openai.ts";

const SYSTEM = [
  "You translate a founder's request into a filter over an existing ledger sheet.",
  "You may only choose from the entity keys, sections, categories and period keys provided.",
  "Never invent a vendor, a date, a dollar amount, or a row that is not listed.",
  "Never include min_abs_cents or max_abs_cents — amounts are parsed from the founder's words elsewhere.",
  "If the request is not about this ledger, return {}.",
  'Respond with JSON only: {"entities":[],"sections":[],"categories":[],"flags":[],"has_incident":false,"post_change_only":false,"pre_change_only":false,"period_keys":[]}.',
].join("\n");

function vocabulary(pivot: LedgerPivot): string {
  const entities = [...new Set(pivot.rows.map((row) => row.entity).filter((e): e is string => Boolean(e)))];
  const categories = [...new Set(pivot.rows.map((row) => row.category).filter((c): c is NonNullable<typeof c> => Boolean(c)))];
  const sections = [...new Set(pivot.rows.filter((row) => row.level === 0).map((row) => row.section))];
  return [
    `entities: ${entities.join(", ") || "(none)"}`,
    `sections: ${sections.join(", ")}`,
    `categories: ${categories.join(", ") || "(none)"}`,
    `period_keys: ${pivot.periods.map((p) => p.key).join(", ")}`,
    pivot.regime_start ? `change_point: ${pivot.regime_start}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseModelSpec(raw: string | null): LedgerFilterSpec {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as LedgerFilterSpec;
  } catch {
    return {};
  }
}

export async function interpretLedgerQuery(
  query: string,
  pivot: LedgerPivot,
  llm: LlmClient,
): Promise<LedgerFilterQueryResponse> {
  const rules = parseLedgerQuery(query, pivot);
  const q = query.trim();

  let spec = rules;
  let source: LedgerFilterQueryResponse["source"] = "rules";

  // Short, already-resolved queries do not need a model (and must stay offline).
  const words = q.split(/\s+/).filter(Boolean);
  const needsModel = q.length > 0 && isEmptyLedgerFilter(rules) && words.length >= 3 && llm.configured;

  if (needsModel) {
    try {
      const completion = await llm.complete({
        jsonMode: true,
        maxTokens: 250,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `${vocabulary(pivot)}\n\nFounder: ${q}` },
        ],
      });
      const refined = sanitizeLedgerFilter(parseModelSpec(completion.content), pivot);
      if (!isEmptyLedgerFilter(refined)) {
        spec = sanitizeLedgerFilter(mergeLedgerFilters(rules, refined), pivot);
        source = "model";
      }
    } catch (err) {
      console.warn(JSON.stringify({ msg: "ledger_query_llm_failed", error: err instanceof Error ? err.message : String(err) }));
    }
  }

  // Amounts always come from the founder's words, even when the model refined the rest.
  if (rules.min_abs_cents !== undefined) spec.min_abs_cents = rules.min_abs_cents;
  else delete spec.min_abs_cents;
  if (rules.max_abs_cents !== undefined) spec.max_abs_cents = rules.max_abs_cents;
  else delete spec.max_abs_cents;

  return { spec, chips: describeLedgerFilter(spec, pivot), source };
}
