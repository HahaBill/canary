/**
 * Natural-language filter for the ledger pivot.
 *
 * The language layer only chooses which existing rows and periods to keep.
 * It never computes an amount. Dollar thresholds are parsed from the founder's
 * own words and compared to cell amounts the engine already produced.
 */
import { CATEGORIES, type Category, type Cents, type ISODate } from "./types.ts";
import { formatUsdWhole } from "./money.ts";
import type { LedgerPivot, PivotCell, PivotPeriod, PivotRow, PivotSection } from "./views.ts";

export const LEDGER_CELL_FLAGS = ["one_off", "needs_review", "refund", "annual_renewal", "pending_dropped"] as const;
export type LedgerCellFlag = (typeof LEDGER_CELL_FLAGS)[number];

export const PIVOT_SECTIONS = [
  "REVENUE",
  "VARIABLE_SPEND",
  "FIXED_SPEND",
  "ONE_OFF",
  "NET_BURN",
  "FINANCING_AND_TRANSFERS",
  "CASH_END",
] as const satisfies readonly PivotSection[];

export interface LedgerFilterSpec {
  entities?: string[];
  sections?: PivotSection[];
  categories?: Category[];
  flags?: LedgerCellFlag[];
  has_incident?: boolean;
  post_change_only?: boolean;
  /** Only periods that start before the change point. */
  pre_change_only?: boolean;
  period_keys?: string[];
  from?: ISODate;
  to?: ISODate;
  /** Inclusive. Copied from the query text, never invented. */
  min_abs_cents?: Cents;
  max_abs_cents?: Cents;
}

const VENDOR_ALIASES: Record<string, string> = {
  amazon: "aws",
  amazonwebservices: "aws",
  amazonwebservice: "aws",
  aws: "aws",
  googlecloud: "gcp",
  googlecloudplatform: "gcp",
  datadoghq: "datadog",
  openaiapi: "openai",
  ashbyhq: "ashby",
  gusto: "gusto_payroll",
  payroll: "gusto_payroll",
  stripe: "stripe_payouts",
};

const SECTION_WORDS: Array<{ words: string[]; section: PivotSection }> = [
  { words: ["revenue", "inflow", "income"], section: "REVENUE" },
  { words: ["variable"], section: "VARIABLE_SPEND" },
  { words: ["fixed"], section: "FIXED_SPEND" },
  { words: ["one-off", "oneoff", "one off"], section: "ONE_OFF" },
  { words: ["net burn", "netburn"], section: "NET_BURN" },
  { words: ["financing", "transfers", "transfer"], section: "FINANCING_AND_TRANSFERS" },
  { words: ["cash at period end", "cash end", "closing cash", "cash"], section: "CASH_END" },
];

const CATEGORY_WORDS: Array<{ words: string[]; category: Category }> = [
  { words: ["cloud", "hosting", "infrastructure"], category: "CLOUD_INFRASTRUCTURE" },
  { words: ["saas", "software"], category: "SAAS_SOFTWARE" },
  { words: ["recruiting", "hiring", "ats"], category: "RECRUITING" },
  { words: ["contractors", "contractor"], category: "CONTRACTORS" },
  { words: ["meals", "food", "doordash"], category: "MEALS" },
  { words: ["marketing", "ads"], category: "MARKETING" },
  { words: ["rent"], category: "RENT" },
  { words: ["travel"], category: "TRAVEL" },
  { words: ["insurance"], category: "INSURANCE" },
  { words: ["payroll"], category: "PAYROLL" },
];

const FLAG_WORDS: Array<{ words: string[]; flag: LedgerCellFlag }> = [
  { words: ["needs review", "needs-review", "uncategorized", "unreviewed"], flag: "needs_review" },
  { words: ["one-off", "one off", "oneoff"], flag: "one_off" },
  { words: ["refund", "refunds"], flag: "refund" },
  { words: ["renewal", "annual"], flag: "annual_renewal" },
];

const MONTHS: Record<string, string> = {
  jan: "01",
  january: "01",
  feb: "02",
  february: "02",
  mar: "03",
  march: "03",
  apr: "04",
  april: "04",
  may: "05",
  jun: "06",
  june: "06",
  jul: "07",
  july: "07",
  aug: "08",
  august: "08",
  sep: "09",
  sept: "09",
  september: "09",
  oct: "10",
  october: "10",
  nov: "11",
  november: "11",
  dec: "12",
  december: "12",
};

const STOP = new Set([
  "a",
  "an",
  "and",
  "at",
  "for",
  "in",
  "just",
  "me",
  "my",
  "of",
  "on",
  "only",
  "our",
  "please",
  "show",
  "the",
  "to",
  "what",
  "were",
  "was",
  "looking",
  "filter",
  "find",
  "list",
  "recent",
  "charges",
  "transactions",
  "transaction",
  "spend",
  "spending",
  "vendors",
  "vendor",
  "rows",
  "row",
]);

export function isEmptyLedgerFilter(spec: LedgerFilterSpec): boolean {
  return (
    !spec.entities?.length &&
    !spec.sections?.length &&
    !spec.categories?.length &&
    !spec.flags?.length &&
    !spec.has_incident &&
    !spec.post_change_only &&
    !spec.pre_change_only &&
    !spec.period_keys?.length &&
    !spec.from &&
    !spec.to &&
    spec.min_abs_cents === undefined &&
    spec.max_abs_cents === undefined
  );
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Parse a founder-typed amount (`$10k`, `10,000`, `1.5m`) into cents. */
export function parseQueryCents(raw: string): Cents | null {
  const match = /^\$?\s*([\d,]+(?:\.\d+)?)\s*([kmb])?$/i.exec(raw.trim());
  if (!match) return null;
  const magnitude = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[match[2]?.toLowerCase() ?? ""] ?? 1;
  const dollars = Number(match[1]!.replace(/,/g, "")) * magnitude;
  if (!Number.isFinite(dollars)) return null;
  return Math.round(dollars * 100);
}

function extractAmounts(text: string): Pick<LedgerFilterSpec, "min_abs_cents" | "max_abs_cents"> {
  const min = /(?:over|above|more than|at least|>=)\s+(\$?\s*[\d,]+(?:\.\d+)?\s*[kmb]?)/i.exec(text);
  const max = /(?:under|below|less than|at most|<=)\s+(\$?\s*[\d,]+(?:\.\d+)?\s*[kmb]?)/i.exec(text);
  const spec: LedgerFilterSpec = {};
  if (min) {
    const cents = parseQueryCents(min[1]!);
    if (cents !== null) spec.min_abs_cents = cents;
  }
  if (max) {
    const cents = parseQueryCents(max[1]!);
    if (cents !== null) spec.max_abs_cents = cents;
  }
  return spec;
}

function periodOverlaps(period: PivotPeriod, from?: ISODate, to?: ISODate): boolean {
  if (from && period.end < from) return false;
  if (to && period.start > to) return false;
  return true;
}

function matchPeriods(pivot: LedgerPivot, text: string): Pick<LedgerFilterSpec, "post_change_only" | "pre_change_only" | "period_keys" | "from" | "to"> {
  const spec: LedgerFilterSpec = {};
  if (/\b(after|since|post)[- ]?(the )?(change|shift|regime)\b|\bpost[- ]change\b/i.test(text)) spec.post_change_only = true;
  if (/\b(before|pre)[- ]?(the )?(change|shift|regime)\b|\bpre[- ]change\b/i.test(text)) spec.pre_change_only = true;

  const keys: string[] = [];
  const iso = text.match(/\b(\d{4}-\d{2}(?:-\d{2})?)\b/g) ?? [];
  for (const token of iso) {
    if (token.length === 7) {
      keys.push(...pivot.periods.filter((p) => p.key === token || p.start.startsWith(token)).map((p) => p.key));
    } else {
      keys.push(...pivot.periods.filter((p) => p.start <= token && p.end >= token).map((p) => p.key));
    }
  }

  const words = text.toLowerCase().split(/[^a-z0-9]+/);
  for (const word of words) {
    const month = MONTHS[word];
    if (!month) continue;
    keys.push(...pivot.periods.filter((p) => p.start.slice(5, 7) === month || p.key.slice(5, 7) === month).map((p) => p.key));
  }

  if (/\blast month\b/i.test(text) && pivot.granularity === "month" && pivot.periods.length > 0) {
    keys.push(pivot.periods[pivot.periods.length - 1]!.key);
  }
  if (/\blast week\b/i.test(text) && pivot.granularity === "week" && pivot.periods.length > 0) {
    keys.push(pivot.periods[pivot.periods.length - 1]!.key);
  }

  if (keys.length > 0) spec.period_keys = unique(keys);
  return spec;
}

function matchEntities(pivot: LedgerPivot, text: string): string[] {
  const entities = unique(pivot.rows.map((row) => row.entity).filter((e): e is string => Boolean(e)));
  const found: string[] = [];
  const folded = normalize(text);

  for (const entity of entities) {
    const label = pivot.rows.find((row) => row.entity === entity)?.label ?? entity;
    if (folded.includes(normalize(entity)) || folded.includes(normalize(label))) found.push(entity);
  }
  for (const [alias, entity] of Object.entries(VENDOR_ALIASES)) {
    if (folded.includes(alias) && entities.includes(entity)) found.push(entity);
  }

  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t));
  for (const token of tokens) {
    const alias = VENDOR_ALIASES[normalize(token)];
    if (alias && entities.includes(alias)) found.push(alias);
    const exact = entities.find((e) => normalize(e) === normalize(token));
    if (exact) found.push(exact);
  }
  return unique(found);
}

function includesPhrase(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s-]+");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
}

/**
 * Turn a founder sentence into a filter against this pivot's vocabulary.
 * Unknown words are ignored; an unmatched query returns an empty spec.
 */
export function parseLedgerQuery(text: string, pivot: LedgerPivot): LedgerFilterSpec {
  const q = text.trim();
  if (!q) return {};

  const spec: LedgerFilterSpec = {
    ...extractAmounts(q),
    ...matchPeriods(pivot, q),
  };

  const entities = matchEntities(pivot, q);
  if (entities.length > 0) spec.entities = entities;

  const sections: PivotSection[] = [];
  for (const { words, section } of SECTION_WORDS) {
    if (words.some((word) => includesPhrase(q, word))) sections.push(section);
  }
  if (sections.length > 0) spec.sections = unique(sections);

  const categories: Category[] = [];
  for (const { words, category } of CATEGORY_WORDS) {
    if (words.some((word) => includesPhrase(q, word))) categories.push(category);
  }
  if (categories.length > 0) spec.categories = unique(categories);

  const flags: LedgerCellFlag[] = [];
  for (const { words, flag } of FLAG_WORDS) {
    if (words.some((word) => includesPhrase(q, word))) flags.push(flag);
  }
  if (flags.length > 0) spec.flags = unique(flags);

  if (/\b(incident|flagged|alarm|cusum)\b/i.test(q)) spec.has_incident = true;

  return spec;
}

function visiblePeriods(pivot: LedgerPivot, spec: LedgerFilterSpec): PivotPeriod[] {
  return pivot.periods.filter((period) => {
    if (spec.post_change_only && !period.post_change) return false;
    if (spec.pre_change_only && period.post_change) return false;
    if (spec.period_keys?.length && !spec.period_keys.includes(period.key)) return false;
    return periodOverlaps(period, spec.from, spec.to);
  });
}

function cellAbs(cell: PivotCell): number {
  return Math.abs(cell.amount_cents);
}

function cellsIn(row: PivotRow, periodIndexes: number[]): PivotCell[] {
  return periodIndexes.map((i) => row.cells[i]).filter((cell): cell is PivotCell => cell !== undefined);
}

function amountOk(cells: PivotCell[], spec: LedgerFilterSpec): boolean {
  if (spec.min_abs_cents === undefined && spec.max_abs_cents === undefined) return true;
  return cells.some((cell) => {
    const abs = cellAbs(cell);
    if (spec.min_abs_cents !== undefined && abs < spec.min_abs_cents) return false;
    if (spec.max_abs_cents !== undefined && abs > spec.max_abs_cents) return false;
    return spec.min_abs_cents !== undefined || spec.max_abs_cents !== undefined;
  });
}

function flagsOk(cells: PivotCell[], spec: LedgerFilterSpec): boolean {
  if (!spec.flags?.length) return true;
  return spec.flags.every((flag) => cells.some((cell) => cell.flags.includes(flag)));
}

function identityMatch(row: PivotRow, spec: LedgerFilterSpec): boolean {
  const named = Boolean(spec.entities?.length || spec.sections?.length || spec.categories?.length || spec.has_incident);
  if (!named) return true;
  if (spec.entities?.length && row.entity && spec.entities.includes(row.entity)) return true;
  if (spec.sections?.length && spec.sections.includes(row.section) && row.level === 0) return true;
  if (spec.categories?.length && row.category && spec.categories.includes(row.category) && row.level <= 1) return true;
  if (spec.has_incident && row.incident_id) return true;
  return false;
}

function rowMatches(row: PivotRow, spec: LedgerFilterSpec, periodIndexes: number[]): boolean {
  const cells = cellsIn(row, periodIndexes);
  if (!identityMatch(row, spec)) return false;
  if (!flagsOk(cells, spec)) return false;
  if (!amountOk(cells, spec)) return false;
  return true;
}

/**
 * Keep matching rows (plus ancestors, plus descendants of a matched section
 * or category) and the requested period columns. Totals on a sliced sheet
 * are the sum of the remaining cells; run-rate is dropped when columns change
 * so we do not invent a new annualization.
 */
export function applyLedgerFilter(pivot: LedgerPivot, spec: LedgerFilterSpec): LedgerPivot {
  if (isEmptyLedgerFilter(spec)) return pivot;

  const periods = visiblePeriods(pivot, spec);
  if (periods.length === 0) {
    return { ...pivot, periods: [], rows: [] };
  }
  const periodIndexes = periods.map((period) => pivot.periods.findIndex((p) => p.key === period.key));
  const columnsUnchanged = periods.length === pivot.periods.length && periods.every((p, i) => p.key === pivot.periods[i]!.key);

  const byId = new Map(pivot.rows.map((row) => [row.id, row]));
  const childrenOf = new Map<string, PivotRow[]>();
  for (const row of pivot.rows) {
    if (!row.parent_id) continue;
    const list = childrenOf.get(row.parent_id) ?? [];
    list.push(row);
    childrenOf.set(row.parent_id, list);
  }

  const matched = new Set<string>();
  for (const row of pivot.rows) {
    if (rowMatches(row, spec, periodIndexes)) matched.add(row.id);
  }

  const keep = new Set<string>();
  const addAncestors = (rowId: string) => {
    let current: PivotRow | undefined = byId.get(rowId);
    while (current) {
      keep.add(current.id);
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
  };
  const addDescendants = (rowId: string) => {
    keep.add(rowId);
    for (const child of childrenOf.get(rowId) ?? []) addDescendants(child.id);
  };

  for (const id of matched) {
    const row = byId.get(id);
    if (!row) continue;
    addAncestors(id);
    if (row.level < 2) addDescendants(id);
  }

  const namedOnlyFlagsOrAmount =
    !spec.entities?.length && !spec.sections?.length && !spec.categories?.length && !spec.has_incident;
  if (namedOnlyFlagsOrAmount && (spec.flags?.length || spec.min_abs_cents !== undefined || spec.max_abs_cents !== undefined)) {
    // Don't expand whole sections — only the rows that actually carry the flag/amount.
    keep.clear();
    for (const id of matched) addAncestors(id);
  }

  const rows = pivot.rows
    .filter((row) => keep.has(row.id))
    .map((row) => {
      const cells = cellsIn(row, periodIndexes);
      const total_cents = cells.reduce((sum, cell) => sum + cell.amount_cents, 0);
      return {
        ...row,
        cells,
        total_cents,
        annualized_cents: columnsUnchanged ? row.annualized_cents : null,
      };
    });

  return { ...pivot, periods, rows };
}

/** Short chips for the UI. Figures only appear when the founder typed them. */
export function describeLedgerFilter(spec: LedgerFilterSpec, pivot: LedgerPivot): string[] {
  const chips: string[] = [];
  for (const entity of spec.entities ?? []) {
    const label = pivot.rows.find((row) => row.entity === entity)?.label ?? entity;
    chips.push(label);
  }
  for (const section of spec.sections ?? []) {
    chips.push(pivot.rows.find((row) => row.id === `section:${section}`)?.label ?? section);
  }
  for (const category of spec.categories ?? []) {
    chips.push(pivot.rows.find((row) => row.category === category && row.level === 1)?.label ?? category);
  }
  if (spec.flags?.includes("needs_review")) chips.push("Needs Review");
  if (spec.flags?.includes("one_off") && !spec.sections?.includes("ONE_OFF")) chips.push("one-off");
  if (spec.flags?.includes("refund")) chips.push("refunds");
  if (spec.has_incident) chips.push("open incident");
  if (spec.post_change_only) chips.push("after the change");
  if (spec.pre_change_only) chips.push("before the change");
  if (spec.period_keys?.length === 1) chips.push(spec.period_keys[0]!);
  else if (spec.period_keys && spec.period_keys.length > 1) chips.push(`${spec.period_keys.length} periods`);
  if (spec.min_abs_cents !== undefined) chips.push(`over ${formatUsdWhole(spec.min_abs_cents)}`);
  if (spec.max_abs_cents !== undefined) chips.push(`under ${formatUsdWhole(spec.max_abs_cents)}`);
  return chips;
}

/** Drop anything that is not a real row/period on this pivot. */
export function sanitizeLedgerFilter(spec: LedgerFilterSpec, pivot: LedgerPivot): LedgerFilterSpec {
  const entities = unique(pivot.rows.map((row) => row.entity).filter((e): e is string => Boolean(e)));
  const categories = new Set(pivot.rows.map((row) => row.category).filter((c): c is Category => Boolean(c)));
  const periodKeys = new Set(pivot.periods.map((p) => p.key));
  const out: LedgerFilterSpec = {};
  if (spec.entities?.length) {
    const kept = spec.entities.filter((e) => entities.includes(e));
    if (kept.length) out.entities = kept;
  }
  if (spec.sections?.length) {
    const kept = spec.sections.filter((s): s is PivotSection => (PIVOT_SECTIONS as readonly string[]).includes(s));
    if (kept.length) out.sections = kept;
  }
  if (spec.categories?.length) {
    const kept = spec.categories.filter((c) => categories.has(c) && (CATEGORIES as readonly string[]).includes(c));
    if (kept.length) out.categories = kept;
  }
  if (spec.flags?.length) {
    const kept = spec.flags.filter((f): f is LedgerCellFlag => (LEDGER_CELL_FLAGS as readonly string[]).includes(f));
    if (kept.length) out.flags = kept;
  }
  if (spec.has_incident) out.has_incident = true;
  if (spec.post_change_only) out.post_change_only = true;
  if (spec.pre_change_only) out.pre_change_only = true;
  if (spec.period_keys?.length) {
    const kept = spec.period_keys.filter((k) => periodKeys.has(k));
    if (kept.length) out.period_keys = kept;
  }
  if (spec.from) out.from = spec.from;
  if (spec.to) out.to = spec.to;
  // Amounts are never taken from a model — callers pass the parsed-from-text ones.
  if (spec.min_abs_cents !== undefined) out.min_abs_cents = spec.min_abs_cents;
  if (spec.max_abs_cents !== undefined) out.max_abs_cents = spec.max_abs_cents;
  return out;
}

export function mergeLedgerFilters(base: LedgerFilterSpec, extra: LedgerFilterSpec): LedgerFilterSpec {
  const merged: LedgerFilterSpec = {
    entities: unique([...(base.entities ?? []), ...(extra.entities ?? [])]),
    sections: unique([...(base.sections ?? []), ...(extra.sections ?? [])]),
    categories: unique([...(base.categories ?? []), ...(extra.categories ?? [])]),
    flags: unique([...(base.flags ?? []), ...(extra.flags ?? [])]),
    period_keys: unique([...(base.period_keys ?? []), ...(extra.period_keys ?? [])]),
  };
  if (base.has_incident || extra.has_incident) merged.has_incident = true;
  if (base.post_change_only || extra.post_change_only) merged.post_change_only = true;
  if (base.pre_change_only || extra.pre_change_only) merged.pre_change_only = true;
  if (base.from || extra.from) merged.from = extra.from ?? base.from;
  if (base.to || extra.to) merged.to = extra.to ?? base.to;
  // Amounts stay with `base` (the query-text parse).
  if (base.min_abs_cents !== undefined) merged.min_abs_cents = base.min_abs_cents;
  if (base.max_abs_cents !== undefined) merged.max_abs_cents = base.max_abs_cents;
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0))) as LedgerFilterSpec;
}
