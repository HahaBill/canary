/**
 * Ledger search: an agent proposes a structured filter from the *actual*
 * merchants and categories on the loaded sheet; this module applies that
 * filter deterministically.
 *
 * The language layer never computes an amount. Dollar thresholds are copied
 * from the founder's own words and compared to cell amounts the engine
 * already produced. Invented vendors/categories are dropped.
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
  /**
   * The query was understood and nothing on this sheet applies.
   * The applicator returns no rows — never the full sheet.
   */
  unmatched?: boolean;
  /** Non-numeric. Why nothing matched. */
  unmatched_reason?: string;
}

/** Compact vocabulary taken from the loaded sheet — never a static synonym table. */
export interface LedgerCatalogMerchant {
  entity: string;
  label: string;
  category?: Category;
  category_label?: string;
}

export interface LedgerCatalogCategory {
  key: Category;
  label: string;
}

export interface LedgerCatalogSection {
  key: PivotSection;
  label: string;
}

export interface LedgerCatalogPeriod {
  key: string;
  start: ISODate;
  end: ISODate;
  post_change: boolean;
}

export interface LedgerCatalog {
  merchants: LedgerCatalogMerchant[];
  categories: LedgerCatalogCategory[];
  sections: LedgerCatalogSection[];
  periods: LedgerCatalogPeriod[];
  change_point?: ISODate;
  flags: readonly LedgerCellFlag[];
}

/**
 * What a proposer may return. Amounts are stripped before apply — they come
 * from the founder's words, not the model.
 */
export type LedgerFilterProposal = Omit<LedgerFilterSpec, "min_abs_cents" | "max_abs_cents">;

export type LedgerFilterProposer = (
  query: string,
  catalog: LedgerCatalog,
) => LedgerFilterProposal | Promise<LedgerFilterProposal>;

export type LedgerFilterSource = "model" | "unconfigured" | "empty";

export interface LedgerFilterInterpretation {
  spec: LedgerFilterSpec;
  chips: string[];
  source: LedgerFilterSource;
  unmatched: boolean;
  /** Non-numeric. Shown when nothing matched or the model is missing. */
  explanation?: string;
}

export const LEDGER_SEARCH_UNCONFIGURED =
  "Canary needs a language model to interpret that. Nothing on this sheet was filtered.";

export const LEDGER_SEARCH_UNMATCHED = "Nothing on this sheet matches that.";

export const LEDGER_SEARCH_FAILED = "Could not interpret that. Nothing on this sheet was filtered.";

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const value of values) {
    const k = key(value);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(value);
  }
  return out;
}

/** Distinct merchants, categories, sections and periods on this pivot. */
export function buildLedgerCatalog(pivot: LedgerPivot): LedgerCatalog {
  const merchants = uniqueBy(
    pivot.rows
      .filter((row) => row.entity && row.level === 2)
      .map((row) => {
        const categoryRow = row.category
          ? pivot.rows.find((candidate) => candidate.category === row.category && candidate.level === 1)
          : undefined;
        return {
          entity: row.entity!,
          label: row.label,
          ...(row.category ? { category: row.category } : {}),
          ...(categoryRow ? { category_label: categoryRow.label } : {}),
        };
      }),
    (merchant) => merchant.entity,
  ).sort((a, b) => a.entity.localeCompare(b.entity));

  const categories = uniqueBy(
    pivot.rows
      .filter((row) => row.category && row.level === 1)
      .map((row) => ({ key: row.category!, label: row.label })),
    (category) => category.key,
  ).sort((a, b) => a.key.localeCompare(b.key));

  const sections = uniqueBy(
    pivot.rows.filter((row) => row.level === 0).map((row) => ({ key: row.section, label: row.label })),
    (section) => section.key,
  );

  return {
    merchants,
    categories,
    sections,
    periods: pivot.periods.map((period) => ({
      key: period.key,
      start: period.start,
      end: period.end,
      post_change: period.post_change,
    })),
    ...(pivot.regime_start ? { change_point: pivot.regime_start } : {}),
    flags: LEDGER_CELL_FLAGS,
  };
}

/**
 * Compact catalog for a prompt. Distinct keys and labels only — no row
 * amounts, no every-transaction dump.
 */
export function formatLedgerCatalog(catalog: LedgerCatalog): string {
  const merchants =
    catalog.merchants.length === 0
      ? "(none)"
      : catalog.merchants
          .map((merchant) => {
            const category = merchant.category
              ? ` · ${merchant.category}${merchant.category_label ? ` (${merchant.category_label})` : ""}`
              : "";
            return `${merchant.entity} · ${merchant.label}${category}`;
          })
          .join("\n");
  const categories =
    catalog.categories.length === 0
      ? "(none)"
      : catalog.categories.map((category) => `${category.key} · ${category.label}`).join("\n");
  const sections = catalog.sections.map((section) => `${section.key} · ${section.label}`).join("; ");
  const periods = catalog.periods.map((period) => period.key).join(", ") || "(none)";
  return [
    "Merchants on this sheet (entity · label · category):",
    merchants,
    "Categories on this sheet (key · label):",
    categories,
    `Sections: ${sections || "(none)"}`,
    `Period keys: ${periods}`,
    catalog.change_point ? `Change point: ${catalog.change_point}` : "",
    `Flags you may set: ${catalog.flags.join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function isEmptyLedgerFilter(spec: LedgerFilterSpec): boolean {
  if (spec.unmatched) return false;
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

/** Parse a founder-typed amount (`$10k`, `10,000`, `1.5m`) into cents. */
export function parseQueryCents(raw: string): Cents | null {
  const match = /^\$?\s*([\d,]+(?:\.\d+)?)\s*([kmb])?$/i.exec(raw.trim());
  if (!match) return null;
  const magnitude = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[match[2]?.toLowerCase() ?? ""] ?? 1;
  const dollars = Number(match[1]!.replace(/,/g, "")) * magnitude;
  if (!Number.isFinite(dollars)) return null;
  return Math.round(dollars * 100);
}

/** Copy dollar thresholds the founder typed. Never invent one. */
export function extractLedgerQueryAmounts(text: string): Pick<LedgerFilterSpec, "min_abs_cents" | "max_abs_cents"> {
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

/** ISO dates the founder typed, matched to period keys already on the sheet. */
export function extractLedgerQueryIsoPeriods(
  text: string,
  pivot: LedgerPivot,
): Pick<LedgerFilterSpec, "period_keys"> {
  const iso = text.match(/\b(\d{4}-\d{2}(?:-\d{2})?)\b/g) ?? [];
  const keys: string[] = [];
  for (const token of iso) {
    if (token.length === 7) {
      keys.push(...pivot.periods.filter((p) => p.key === token || p.start.startsWith(token)).map((p) => p.key));
    } else {
      keys.push(...pivot.periods.filter((p) => p.start <= token && p.end >= token).map((p) => p.key));
    }
  }
  return keys.length > 0 ? { period_keys: unique(keys) } : {};
}

/** Drop dollar figures a model is not allowed to write. */
export function stripModelFigures(text: string): string {
  return text
    .replace(/\$[\d,.]+(?:\s*[kmb])?/gi, "")
    .replace(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function overlayTypedConstraints(spec: LedgerFilterSpec, query: string, pivot: LedgerPivot): LedgerFilterSpec {
  const amounts = extractLedgerQueryAmounts(query);
  const iso = extractLedgerQueryIsoPeriods(query, pivot);
  const next: LedgerFilterSpec = { ...spec };
  delete next.min_abs_cents;
  delete next.max_abs_cents;
  if (amounts.min_abs_cents !== undefined) next.min_abs_cents = amounts.min_abs_cents;
  if (amounts.max_abs_cents !== undefined) next.max_abs_cents = amounts.max_abs_cents;
  if (iso.period_keys?.length) next.period_keys = unique([...(next.period_keys ?? []), ...iso.period_keys]);
  return next;
}

function interpretation(
  spec: LedgerFilterSpec,
  pivot: LedgerPivot,
  source: LedgerFilterSource,
  explanation?: string,
): LedgerFilterInterpretation {
  const unmatched = Boolean(spec.unmatched);
  return {
    spec,
    chips: unmatched ? [] : describeLedgerFilter(spec, pivot),
    source,
    unmatched,
    ...(explanation ? { explanation } : unmatched ? { explanation: spec.unmatched_reason ?? LEDGER_SEARCH_UNMATCHED } : {}),
  };
}

/**
 * Understand `query` via `propose` (production: OpenAI; tests: a fake).
 * Apply/sanitize stay deterministic. A blank query is not a filter.
 * An unknown/empty proposal is unmatched — never a silent full-sheet no-op.
 */
export async function interpretLedgerFilter(
  query: string,
  pivot: LedgerPivot,
  propose: LedgerFilterProposer | null,
): Promise<LedgerFilterInterpretation> {
  const q = query.trim();
  if (!q) return interpretation({}, pivot, "empty");

  if (!propose) {
    return interpretation({ unmatched: true, unmatched_reason: LEDGER_SEARCH_UNCONFIGURED }, pivot, "unconfigured", LEDGER_SEARCH_UNCONFIGURED);
  }

  let proposal: LedgerFilterProposal;
  try {
    proposal = await propose(q, buildLedgerCatalog(pivot));
  } catch {
    return interpretation({ unmatched: true, unmatched_reason: LEDGER_SEARCH_FAILED }, pivot, "unconfigured", LEDGER_SEARCH_FAILED);
  }

  const sanitized = overlayTypedConstraints(sanitizeLedgerFilter(proposal, pivot), q, pivot);
  if (proposal.unmatched || sanitized.unmatched) {
    const reason = stripModelFigures(proposal.unmatched_reason ?? sanitized.unmatched_reason ?? "") || LEDGER_SEARCH_UNMATCHED;
    return interpretation({ unmatched: true, unmatched_reason: reason }, pivot, "model", reason);
  }
  if (isEmptyLedgerFilter(sanitized)) {
    return interpretation({ unmatched: true, unmatched_reason: LEDGER_SEARCH_UNMATCHED }, pivot, "model", LEDGER_SEARCH_UNMATCHED);
  }
  return interpretation(sanitized, pivot, "model");
}

function periodOverlaps(period: PivotPeriod, from?: ISODate, to?: ISODate): boolean {
  if (from && period.end < from) return false;
  if (to && period.start > to) return false;
  return true;
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
  if (spec.unmatched) {
    return { ...pivot, rows: [] };
  }
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
  if (spec.unmatched) return [];
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
  const namedWasInvented = Boolean(spec.entities?.length || spec.sections?.length || spec.categories?.length) &&
    !out.entities?.length &&
    !out.sections?.length &&
    !out.categories?.length;
  if (spec.unmatched || (namedWasInvented && isEmptyLedgerFilter(out))) {
    out.unmatched = true;
    const reason = spec.unmatched_reason ? stripModelFigures(spec.unmatched_reason) : "";
    out.unmatched_reason = reason || LEDGER_SEARCH_UNMATCHED;
  }
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
  if (base.min_abs_cents !== undefined) merged.min_abs_cents = base.min_abs_cents;
  if (base.max_abs_cents !== undefined) merged.max_abs_cents = base.max_abs_cents;
  if (base.unmatched || extra.unmatched) {
    merged.unmatched = true;
    merged.unmatched_reason = extra.unmatched_reason ?? base.unmatched_reason ?? LEDGER_SEARCH_UNMATCHED;
  }
  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0)),
  ) as LedgerFilterSpec;
}
