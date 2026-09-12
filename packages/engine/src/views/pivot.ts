/**
 * The ledger sheet (contract "Views", PRD §26).
 *
 * `pivotLedger` lays the reconciled ledger out as section → category → vendor
 * rows × period columns. It is a pure re-projection of `Ledger`: every figure is
 * a sum of `LedgerTransaction.amount_cents`, so per week the sections reproduce
 * `ledger.weeks[i]` exactly (variable / fixed / one-off / inflow / net burn) and
 * the CASH_END row lands on the bank-reported closing balance. Nothing is
 * re-derived, nothing is rounded except the annualized run-rate column.
 *
 * `pivotCell` answers "what is behind this number" for one row × period,
 * including the pending rows the engine dropped.
 */
import {
  CATEGORIES,
  compareISODate,
  weekStart,
  type Category,
  type Cents,
  type Ledger,
  type LedgerPivot,
  type LedgerTransaction,
  type PivotCell,
  type PivotCellDetail,
  type PivotCellLookup,
  type PivotGranularity,
  type PivotLedger,
  type PivotRow,
  type PivotSection,
} from "@canary/shared";
import { categoryLabel, entityDisplayName, sectionLabel } from "./labels.ts";
import { buildPeriodGrid, type PeriodGrid } from "./periods.ts";
import {
  cellDelta,
  DRILLDOWN_SECTIONS,
  FINANCING_CATEGORY_ORDER,
  FLAG_ORDER,
  flagsOf,
  SECTION_ORDER,
  sectionOf,
  SPEND_SECTIONS,
  type PivotFlag,
} from "./sections.ts";

const WEEKS_PER_YEAR = 52;

// ---------------------------------------------------------------------------
// Row ids
// ---------------------------------------------------------------------------

export function sectionRowId(section: PivotSection): string {
  return `section:${section}`;
}

export function categoryRowId(section: PivotSection, category: Category): string {
  return `category:${section}:${category}`;
}

export function vendorRowId(section: PivotSection, category: Category, entity: string): string {
  return `vendor:${section}:${category}:${entity}`;
}

type ParsedRowId =
  | { kind: "section"; section: PivotSection }
  | { kind: "category"; section: PivotSection; category: Category }
  | { kind: "vendor"; section: PivotSection; category: Category; entity: string };

export function parseRowId(rowId: string): ParsedRowId {
  const parts = rowId.split(":");
  const kind = parts[0];
  const section = asSection(parts[1]);
  if (kind === "section" && parts.length === 2) return { kind: "section", section };
  if (kind === "category" && parts.length === 3) {
    return { kind: "category", section, category: asCategory(parts[2]) };
  }
  if (kind === "vendor" && parts.length >= 4) {
    // Entity keys are lower_snake, but never assume: keep everything after the category.
    return { kind: "vendor", section, category: asCategory(parts[2]), entity: parts.slice(3).join(":") };
  }
  throw new Error(`Unknown pivot row id: ${rowId}`);
}

function asSection(value: string | undefined): PivotSection {
  if (value !== undefined && (SECTION_ORDER as readonly string[]).includes(value)) {
    return value as PivotSection;
  }
  throw new Error(`Unknown pivot section: ${value}`);
}

function asCategory(value: string | undefined): Category {
  if (value !== undefined && (CATEGORIES as readonly string[]).includes(value)) return value as Category;
  throw new Error(`Unknown category: ${value}`);
}

// ---------------------------------------------------------------------------
// pivotLedger
// ---------------------------------------------------------------------------

interface CellAcc {
  amount: Cents;
  count: number;
  flags: Set<PivotFlag>;
}

interface VendorAcc {
  entity: string;
  cells: CellAcc[];
}

interface CategoryAcc {
  category: Category;
  cells: CellAcc[];
  vendors: Map<string, VendorAcc>;
}

interface SectionAcc {
  section: PivotSection;
  cells: CellAcc[];
  categories: Map<Category, CategoryAcc>;
}

function emptyCells(n: number): CellAcc[] {
  return Array.from({ length: n }, () => ({ amount: 0, count: 0, flags: new Set<PivotFlag>() }));
}

export const pivotLedger: PivotLedger = (ledger, opts): LedgerPivot => {
  const granularity = opts.granularity;
  // The regime always starts on a Monday; normalize so a mid-week input can't
  // tint half a column.
  const regimeStart = opts.regimeStart ? weekStart(opts.regimeStart) : null;
  const grid = buildPeriodGrid(granularity, ledger.history_start, ledger.history_end, regimeStart);
  const periodCount = grid.periods.length;
  const incidentByEntity = opts.incidentByEntity ?? {};

  const sections = new Map<PivotSection, SectionAcc>();
  for (const section of SECTION_ORDER) {
    if (section === "NET_BURN" || section === "CASH_END") continue;
    sections.set(section, { section, cells: emptyCells(periodCount), categories: new Map() });
  }

  for (const tx of ledger.transactions) {
    const i = grid.indexOf(tx.date);
    if (i < 0) continue; // Outside history — `buildLedger` already warned.
    const section = sectionOf(tx);
    const acc = sections.get(section)!;
    const category = ensureCategory(acc, tx.category, periodCount);
    const vendor = DRILLDOWN_SECTIONS.includes(section)
      ? ensureVendor(category, tx.merchant_normalized, periodCount)
      : null;

    // A dropped pending row contributes no money: it only marks the cell it
    // would have hit, so the sheet can say "a pending row was superseded here".
    const delta = tx.dropped ? 0 : cellDelta(tx, section);
    const flags = tx.dropped ? (["pending_dropped"] as const) : flagsOf(tx, section);
    const count = tx.dropped ? 0 : 1;
    for (const cell of [acc.cells[i]!, category.cells[i]!, ...(vendor ? [vendor.cells[i]!] : [])]) {
      cell.amount += delta;
      cell.count += count;
      for (const f of flags) cell.flags.add(f);
    }
  }

  const weeksOfHistory = ledger.weeks.length;
  const rows: PivotRow[] = [];

  for (const section of SECTION_ORDER) {
    if (section === "NET_BURN") {
      rows.push(netBurnRow(sections, periodCount, weeksOfHistory));
      continue;
    }
    if (section === "CASH_END") {
      rows.push(cashEndRow(ledger, grid));
      continue;
    }
    const acc = sections.get(section)!;
    const annualize = section !== "FINANCING_AND_TRANSFERS";
    rows.push(
      buildRow({
        id: sectionRowId(section),
        level: 0,
        section,
        label: sectionLabel(section),
        cells: acc.cells,
        weeksOfHistory,
        annualize,
      }),
    );
    for (const category of sortedCategories(acc)) {
      rows.push(
        buildRow({
          id: categoryRowId(section, category.category),
          level: 1,
          section,
          label: categoryLabel(category.category),
          category: category.category,
          parent_id: sectionRowId(section),
          cells: category.cells,
          weeksOfHistory,
          annualize,
        }),
      );
      if (!DRILLDOWN_SECTIONS.includes(section)) continue;
      for (const vendor of sortedVendors(category)) {
        rows.push(
          buildRow({
            id: vendorRowId(section, category.category, vendor.entity),
            level: 2,
            section,
            label: entityDisplayName(vendor.entity),
            category: category.category,
            entity: vendor.entity,
            parent_id: categoryRowId(section, category.category),
            cells: vendor.cells,
            weeksOfHistory,
            annualize,
            incident_id: incidentByEntity[vendor.entity],
          }),
        );
      }
    }
  }

  return {
    granularity,
    periods: grid.periods,
    rows,
    history_start: ledger.history_start,
    history_end: ledger.history_end,
    weeks_of_history: weeksOfHistory,
    regime_start: regimeStart,
  };
};

function ensureCategory(acc: SectionAcc, category: Category, periodCount: number): CategoryAcc {
  const existing = acc.categories.get(category);
  if (existing) return existing;
  const created: CategoryAcc = { category, cells: emptyCells(periodCount), vendors: new Map() };
  acc.categories.set(category, created);
  return created;
}

function ensureVendor(acc: CategoryAcc, entity: string, periodCount: number): VendorAcc {
  const existing = acc.vendors.get(entity);
  if (existing) return existing;
  const created: VendorAcc = { entity, cells: emptyCells(periodCount) };
  acc.vendors.set(entity, created);
  return created;
}

/** Biggest first, then alphabetical — financing keeps its documented order. */
function sortedCategories(acc: SectionAcc): CategoryAcc[] {
  const list = [...acc.categories.values()];
  if (acc.section === "FINANCING_AND_TRANSFERS") {
    return list.sort((a, b) => financingRank(a.category) - financingRank(b.category));
  }
  return list.sort((a, b) => compareByTotalThenName(total(a.cells), a.category, total(b.cells), b.category));
}

function sortedVendors(acc: CategoryAcc): VendorAcc[] {
  return [...acc.vendors.values()].sort((a, b) =>
    compareByTotalThenName(total(a.cells), a.entity, total(b.cells), b.entity),
  );
}

function financingRank(category: Category): number {
  const i = (FINANCING_CATEGORY_ORDER as readonly string[]).indexOf(category);
  return i < 0 ? FINANCING_CATEGORY_ORDER.length : i;
}

function compareByTotalThenName(aTotal: Cents, aName: string, bTotal: Cents, bName: string): number {
  if (aTotal !== bTotal) return bTotal - aTotal;
  return aName < bName ? -1 : aName > bName ? 1 : 0;
}

function total(cells: CellAcc[]): Cents {
  return cells.reduce((s, c) => s + c.amount, 0);
}

function toCell(cell: CellAcc): PivotCell {
  return {
    amount_cents: cell.amount,
    transaction_count: cell.count,
    flags: FLAG_ORDER.filter((f) => cell.flags.has(f)),
  };
}

interface RowInput {
  id: string;
  level: 0 | 1 | 2;
  section: PivotSection;
  label: string;
  category?: Category;
  entity?: string;
  parent_id?: string;
  cells: CellAcc[];
  weeksOfHistory: number;
  annualize: boolean;
  incident_id?: string;
}

function buildRow(input: RowInput): PivotRow {
  const totalCents = total(input.cells);
  return {
    id: input.id,
    level: input.level,
    section: input.section,
    label: input.label,
    category: input.category,
    entity: input.entity,
    parent_id: input.parent_id,
    cells: input.cells.map(toCell),
    total_cents: totalCents,
    annualized_cents: input.annualize ? annualize(totalCents, input.weeksOfHistory) : null,
    incident_id: input.incident_id,
  };
}

/** Run-rate, not a forecast: the observed total scaled to 52 weeks. */
function annualize(totalCents: Cents, weeksOfHistory: number): Cents | null {
  if (weeksOfHistory <= 0) return null;
  return Math.round((totalCents / weeksOfHistory) * WEEKS_PER_YEAR);
}

/** (variable + fixed + one-off) − revenue. Positive = burning. */
function netBurnRow(
  sections: Map<PivotSection, SectionAcc>,
  periodCount: number,
  weeksOfHistory: number,
): PivotRow {
  const revenue = sections.get("REVENUE")!.cells;
  const cells = emptyCells(periodCount);
  for (let i = 0; i < periodCount; i++) {
    const cell = cells[i]!;
    for (const section of SPEND_SECTIONS) {
      const source = sections.get(section)!.cells[i]!;
      cell.amount += source.amount;
      cell.count += source.count;
      for (const f of source.flags) cell.flags.add(f);
    }
    const rev = revenue[i]!;
    cell.amount -= rev.amount;
    cell.count += rev.count;
    for (const f of rev.flags) cell.flags.add(f);
  }
  return buildRow({
    id: sectionRowId("NET_BURN"),
    level: 0,
    section: "NET_BURN",
    label: sectionLabel("NET_BURN"),
    cells,
    weeksOfHistory,
    annualize: true,
  });
}

/**
 * Cash (checking + savings) at the close of each period: the reconciled opening
 * balance plus every cash movement dated on or before `period.end`. The last
 * period therefore lands on the bank-reported closing balance.
 */
function cashEndRow(ledger: Ledger, grid: PeriodGrid): PivotRow {
  const cashRows = ledger.transactions.filter((t) => t.counts_in_cash).sort(byDateThenId);
  const cells: PivotCell[] = [];
  let running = ledger.reconciliation.opening_balance_cents;
  let ptr = 0;
  for (const period of grid.periods) {
    while (ptr < cashRows.length && compareISODate(cashRows[ptr]!.date, period.end) <= 0) {
      running += cashRows[ptr]!.amount_cents;
      ptr += 1;
    }
    cells.push({ amount_cents: running, transaction_count: 0, flags: [] });
  }
  return {
    id: sectionRowId("CASH_END"),
    level: 0,
    section: "CASH_END",
    label: sectionLabel("CASH_END"),
    cells,
    // A balance is not a flow: the "total" of a balance row is where it ended.
    total_cents: cells.length ? cells[cells.length - 1]!.amount_cents : running,
    annualized_cents: null,
  };
}

function byDateThenId(a: LedgerTransaction, b: LedgerTransaction): number {
  const byDate = compareISODate(a.date, b.date);
  if (byDate !== 0) return byDate;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// pivotCell
// ---------------------------------------------------------------------------

export const pivotCell: PivotCellLookup = (
  ledger,
  rowId: string,
  periodKey: string,
  granularity: PivotGranularity,
): PivotCellDetail => {
  const parsed = parseRowId(rowId);
  const grid = buildPeriodGrid(granularity, ledger.history_start, ledger.history_end, null);
  const index = grid.periods.findIndex((p) => p.key === periodKey);
  if (index < 0) throw new Error(`Unknown ${granularity} period: ${periodKey}`);

  const matches = ledger.transactions
    .filter((tx) => grid.indexOf(tx.date) === index && matchesRow(tx, parsed))
    .sort(byDateThenId);

  return {
    row_id: rowId,
    period_key: periodKey,
    transactions: matches.map((tx) => ({
      id: tx.id,
      date: tx.date,
      merchant_raw: tx.merchant_raw,
      description: tx.description,
      amount_cents: tx.amount_cents,
      flow_type: tx.flow_type,
      category: tx.category,
      tags: [...tx.tags],
      dropped: tx.dropped,
    })),
  };
};

function matchesRow(tx: LedgerTransaction, parsed: ParsedRowId): boolean {
  if (parsed.section === "CASH_END") {
    // The balance row shows the movements that made the balance move this period.
    return parsed.kind === "section" && tx.counts_in_cash;
  }
  if (parsed.section === "NET_BURN") {
    const section = sectionOf(tx);
    return (
      parsed.kind === "section" &&
      (section === "REVENUE" || (SPEND_SECTIONS as readonly PivotSection[]).includes(section))
    );
  }
  if (sectionOf(tx) !== parsed.section) return false;
  if (parsed.kind === "section") return true;
  if (tx.category !== parsed.category) return false;
  if (parsed.kind === "category") return true;
  return tx.merchant_normalized === parsed.entity;
}
