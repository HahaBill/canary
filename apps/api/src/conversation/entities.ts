/**
 * Natural vendor names → `merchant_normalized` keys.
 *
 * A founder types "Amazon", "the recruiting tool" or "datadog"; every tool below
 * this layer wants `aws`, `ashby`, `datadog`. Resolution is deterministic and
 * lives here rather than in the model: the model may not invent an entity key,
 * and an unresolved name must come back as a question ("which vendor?"), not as
 * a silently-zero scenario (docs/AGENT_BEHAVIOR.md §5).
 */
import type { Category, DerivedDemoObject } from "@canary/shared";
import { DISPLAY_NAMES, displayName } from "../format.ts";

export type EntityResolution =
  | { known: true; entity: string; display_name: string }
  | { known: false; candidates: string[] };

/**
 * Hand-written aliases for names a founder says but the ledger never spells.
 * Keys are normalized (lowercase, alphanumeric only) — see `normalize`.
 */
const ALIASES: Record<string, string> = {
  amazon: "aws",
  amazonwebservices: "aws",
  amazonwebservice: "aws",
  aws: "aws",
  googlecloud: "gcp",
  googlecloudplatform: "gcp",
  google: "gcp",
  datadoghq: "datadog",
  openaiapi: "openai",
  ashbyhq: "ashby",
  gusto: "gusto_payroll",
  payroll: "gusto_payroll",
  stripe: "stripe_payouts",
};

/** Category words a founder is likely to use instead of a vendor name. */
const CATEGORY_WORDS: Array<{ word: string; category: Category }> = [
  { word: "recruiting", category: "RECRUITING" },
  { word: "ats", category: "RECRUITING" },
  { word: "hiring", category: "RECRUITING" },
  { word: "cloud", category: "CLOUD_INFRASTRUCTURE" },
  { word: "hosting", category: "CLOUD_INFRASTRUCTURE" },
  { word: "infrastructure", category: "CLOUD_INFRASTRUCTURE" },
  { word: "payroll", category: "PAYROLL" },
  { word: "marketing", category: "MARKETING" },
  { word: "ads", category: "MARKETING" },
  { word: "software", category: "SAAS_SOFTWARE" },
  { word: "saas", category: "SAAS_SOFTWARE" },
];

const STOP_WORDS = new Set(["the", "our", "my", "a", "an", "that", "this", "tool", "vendor", "bill", "spend", "spending", "cost", "costs"]);

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Every entity key Canary has spend for, plus the incident contributors. */
export function knownEntities(derived: DerivedDemoObject): string[] {
  const keys = new Set<string>(Object.keys(derived.burn.weekly_variable_by_entity));
  for (const incident of derived.incidents) {
    if (incident.entity) keys.add(incident.entity);
    for (const contributor of incident.contributors) keys.add(contributor.entity);
  }
  return [...keys].sort();
}

/** The entity's category, from the classification map. Null when unclassified. */
export function categoryOf(derived: DerivedDemoObject, entity: string): Category | null {
  const match = Object.values(derived.classifications).find((c) => c.merchant_normalized === entity);
  return match?.category ?? null;
}

/**
 * Resolution order: exact key → display name → alias → word-level containment →
 * category phrase. A phrase that maps to several entities returns them as
 * candidates so the model can ask which one, rather than guessing.
 */
export function resolveEntity(derived: DerivedDemoObject, raw: string): EntityResolution {
  const entities = knownEntities(derived);
  const query = normalize(raw);
  if (query.length === 0) return { known: false, candidates: entities.map(displayName) };

  const found = (entity: string): EntityResolution => ({ known: true, entity, display_name: displayName(entity) });

  const byKey = entities.find((e) => normalize(e) === query);
  if (byKey) return found(byKey);

  const byDisplay = entities.find((e) => normalize(displayName(e)) === query);
  if (byDisplay) return found(byDisplay);

  const alias = ALIASES[query];
  if (alias && entities.includes(alias)) return found(alias);

  // Reverse of the shared display-name map, for keys the ledger does not carry.
  const byDisplayMap = Object.entries(DISPLAY_NAMES).find(([key, name]) => normalize(name) === query && entities.includes(key));
  if (byDisplayMap) return found(byDisplayMap[0]);

  // Word-level: "what about datadog spend" → datadog. Aliases apply per word too.
  const words = raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  for (const word of words) {
    const direct = entities.find((e) => normalize(e) === word || normalize(displayName(e)) === word);
    if (direct) return found(direct);
    const aliased = ALIASES[word];
    if (aliased && entities.includes(aliased)) return found(aliased);
  }

  // "the recruiting tool" → the only RECRUITING entity Canary has spend for.
  for (const { word, category } of CATEGORY_WORDS) {
    if (!words.includes(word)) continue;
    const matches = entities.filter((e) => categoryOf(derived, e) === category);
    if (matches.length === 1) return found(matches[0]!);
    if (matches.length > 1) return { known: false, candidates: matches.map(displayName) };
  }

  return { known: false, candidates: entities.map(displayName) };
}
