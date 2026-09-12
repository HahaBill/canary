/**
 * DEV-ONLY view builders: ledger pivot, pivot cell detail and cash-calendar
 * events projected from a `DerivedDemoObject`.
 *
 * These exist so the routes, the SPA and the tests can be built and exercised
 * before `@canary/engine`'s real `pivotLedger` / `projectRecurring` /
 * `buildCashCalendarEvents` land. Every figure is read from the weekly buckets
 * the engine already produced — nothing here invents a number — but the shapes
 * are simplified (no card/refund flags, no per-transaction truth, one synthetic
 * transaction per bucket in the cell detail). `PipelineDataProvider` replaces
 * them with the engine functions at integration.
 */
import {
  addDays,
  compareISODate,
  weeklyToAnnual,
  type CalendarEvent,
  type Category,
  type Cents,
  type DerivedDemoObject,
  type ISODate,
  type LedgerPivot,
  type NeedsReviewResponse,
  type PivotCell,
  type PivotCellDetail,
  type PivotGranularity,
  type PivotPeriod,
  type PivotRow,
  type PivotSection,
  type WeeklyBucket,
} from "@canary/shared";

export const PIVOT_GRANULARITIES = ["week", "month"] as const satisfies readonly PivotGranularity[];

const SECTION_LABELS: Record<PivotSection, string> = {
  REVENUE: "Revenue",
  VARIABLE_SPEND: "Variable spend",
  FIXED_SPEND: "Fixed spend",
  ONE_OFF: "One-off & annual",
  NET_BURN: "Net burn",
  FINANCING_AND_TRANSFERS: "Financing & transfers",
  CASH_END: "Cash at period end",
};

/** Positive magnitude for spend sections, signed for revenue/cash (contract in views.ts). */
const SECTION_AMOUNT: Record<Exclude<PivotSection, "CASH_END">, (w: WeeklyBucket) => Cents> = {
  REVENUE: (w) => w.operating_inflow_cents,
  VARIABLE_SPEND: (w) => w.variable_spend_cents,
  FIXED_SPEND: (w) => w.fixed_spend_cents,
  ONE_OFF: (w) => w.excluded_from_monitoring_cents,
  NET_BURN: (w) => w.net_burn_cents,
  // The mock fixture has no financing or transfer rows; the engine fills this in.
  FINANCING_AND_TRANSFERS: () => 0,
};

interface Period extends PivotPeriod {
  buckets: WeeklyBucket[];
}

function monthBounds(key: string): { first: ISODate; last: ISODate } {
  const [year, month] = key.split("-").map(Number) as [number, number];
  const first = `${key}-01`;
  const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { first, last };
}

/** Weekly buckets grouped into the requested periods, oldest first. */
function buildPeriods(derived: DerivedDemoObject, granularity: PivotGranularity, regimeStart: ISODate | null): Period[] {
  const postChange = (start: ISODate): boolean => regimeStart !== null && compareISODate(start, regimeStart) >= 0;

  if (granularity === "week") {
    return derived.weeks.map((w) => ({
      key: w.week_start,
      start: w.week_start,
      end: w.week_end,
      partial: false,
      post_change: postChange(w.week_start),
      buckets: [w],
    }));
  }

  const byMonth = new Map<string, WeeklyBucket[]>();
  for (const w of derived.weeks) {
    const key = w.week_start.slice(0, 7);
    const list = byMonth.get(key);
    if (list) list.push(w);
    else byMonth.set(key, [w]);
  }

  return [...byMonth.entries()].map(([key, buckets]) => {
    const start = buckets[0]!.week_start;
    const end = buckets[buckets.length - 1]!.week_end;
    const { first, last } = monthBounds(key);
    return {
      key,
      start,
      end,
      // Mon–Sun weeks almost never line up with month boundaries, so most months
      // are partial. Saying so is the point: the UI must not read them as months.
      partial: start !== first || end !== last,
      post_change: postChange(start),
      buckets,
    };
  });
}

function cell(amount: Cents, transactions: number, flags: PivotCell["flags"] = []): PivotCell {
  return { amount_cents: amount, transaction_count: transactions, flags };
}

function sumBy(buckets: WeeklyBucket[], pick: (w: WeeklyBucket) => Cents): Cents {
  return buckets.reduce((total, w) => total + pick(w), 0);
}

/**
 * entity → category, recovered from the buckets themselves: greedily fill each
 * category's weekly series with entity series that fit inside it. Exact for the
 * mock fixture (one or two vendors per category); entities that cannot be placed
 * simply get no vendor row, so section and category totals still add up.
 */
function categoryByEntity(weeks: WeeklyBucket[]): Map<string, Category> {
  const entities = new Set<string>();
  for (const w of weeks) for (const e of Object.keys(w.variable_by_entity)) entities.add(e);

  const totalFor = (pick: (w: WeeklyBucket) => Cents): Cents => sumBy(weeks, pick);
  const ranked = [...entities].sort(
    (a, b) => totalFor((w) => w.variable_by_entity[b] ?? 0) - totalFor((w) => w.variable_by_entity[a] ?? 0) || a.localeCompare(b),
  );

  const out = new Map<string, Category>();
  const categories = new Set<Category>();
  for (const w of weeks) for (const c of Object.keys(w.variable_by_category)) categories.add(c as Category);

  for (const category of [...categories].sort()) {
    const remaining = weeks.map((w) => w.variable_by_category[category] ?? 0);
    for (const entity of ranked) {
      if (out.has(entity)) continue;
      const series = weeks.map((w) => w.variable_by_entity[entity] ?? 0);
      if (series.every((v, i) => v <= remaining[i]!) && series.some((v) => v > 0)) {
        out.set(entity, category);
        series.forEach((v, i) => (remaining[i]! -= v));
      }
      if (remaining.every((v) => v === 0)) break;
    }
  }
  return out;
}

/** entity → the incident it drives, for vendor-row deep links. */
export function incidentByEntity(derived: DerivedDemoObject): Record<string, string> {
  const out: Record<string, string> = {};
  for (const incident of derived.incidents) {
    if (incident.entity && !out[incident.entity]) out[incident.entity] = incident.id;
    for (const contributor of incident.contributors) {
      if (contributor.delta_weekly_cents > 0 && !out[contributor.entity]) out[contributor.entity] = incident.id;
    }
  }
  return out;
}

function needsReviewDates(derived: DerivedDemoObject): ISODate[] {
  return derived.needs_review.items.map((i) => i.date);
}

export function mockLedgerPivot(derived: DerivedDemoObject, granularity: PivotGranularity): LedgerPivot {
  const regimeStart = derived.primary_incident?.estimated_change_point ?? null;
  const periods = buildPeriods(derived, granularity, regimeStart);
  const weeksOfHistory = derived.weeks.length;
  const reviewDates = needsReviewDates(derived);
  const links = incidentByEntity(derived);
  const entityCategory = categoryByEntity(derived.weeks);

  const annualized = (total: Cents): Cents => weeklyToAnnual(Math.round(total / Math.max(1, weeksOfHistory)));

  const rows: PivotRow[] = [];

  for (const section of Object.keys(SECTION_LABELS) as PivotSection[]) {
    if (section === "CASH_END") continue;
    const pick = SECTION_AMOUNT[section];
    const cells = periods.map((p) => {
      const flags: PivotCell["flags"] = [];
      if (section === "ONE_OFF" && sumBy(p.buckets, (w) => w.excluded_from_monitoring_cents) > 0) flags.push("one_off");
      if (section === "VARIABLE_SPEND" && reviewDates.some((d) => d >= p.start && d <= p.end)) flags.push("needs_review");
      return cell(sumBy(p.buckets, pick), sumBy(p.buckets, (w) => w.transaction_count), flags);
    });
    const total = cells.reduce((sum, c) => sum + c.amount_cents, 0);
    rows.push({
      id: `section:${section}`,
      level: 0,
      section,
      label: SECTION_LABELS[section],
      cells,
      total_cents: total,
      annualized_cents: annualized(total),
    });

    if (section !== "VARIABLE_SPEND") continue;

    const categories = [...new Set(derived.weeks.flatMap((w) => Object.keys(w.variable_by_category)))] as Category[];
    const byTotal = (a: Category, b: Category): number =>
      sumBy(derived.weeks, (w) => w.variable_by_category[b] ?? 0) - sumBy(derived.weeks, (w) => w.variable_by_category[a] ?? 0);

    for (const category of categories.sort(byTotal)) {
      const catCells = periods.map((p) => cell(sumBy(p.buckets, (w) => w.variable_by_category[category] ?? 0), p.buckets.length));
      const catTotal = catCells.reduce((sum, c) => sum + c.amount_cents, 0);
      rows.push({
        id: `category:${category}`,
        level: 1,
        section,
        label: category,
        category,
        parent_id: `section:${section}`,
        cells: catCells,
        total_cents: catTotal,
        annualized_cents: annualized(catTotal),
      });

      const vendors = [...entityCategory.entries()].filter(([, c]) => c === category).map(([entity]) => entity);
      for (const entity of vendors.sort()) {
        const vendorCells = periods.map((p) => cell(sumBy(p.buckets, (w) => w.variable_by_entity[entity] ?? 0), p.buckets.length));
        const vendorTotal = vendorCells.reduce((sum, c) => sum + c.amount_cents, 0);
        rows.push({
          id: `vendor:${entity}`,
          level: 2,
          section,
          label: entity,
          category,
          entity,
          parent_id: `category:${category}`,
          cells: vendorCells,
          total_cents: vendorTotal,
          annualized_cents: annualized(vendorTotal),
          ...(links[entity] ? { incident_id: links[entity] } : {}),
        });
      }
    }
  }

  // Cash is walked BACKWARD from the bank's closing balance, the same anchor the
  // generator uses, so the last period always equals `cash_cents` exactly.
  const cashEnds: Cents[] = [];
  let cash = derived.cash_cents;
  for (let i = periods.length - 1; i >= 0; i--) {
    cashEnds[i] = cash;
    cash += sumBy(periods[i]!.buckets, (w) => w.net_burn_cents);
  }
  rows.push({
    id: "section:CASH_END",
    level: 0,
    section: "CASH_END",
    label: SECTION_LABELS.CASH_END,
    cells: cashEnds.map((amount) => cell(amount, 0)),
    total_cents: cashEnds[cashEnds.length - 1] ?? derived.cash_cents,
    annualized_cents: null,
  });

  return {
    granularity,
    periods: periods.map(({ buckets: _buckets, ...period }) => period),
    rows,
    history_start: derived.provenance.start_date,
    history_end: derived.provenance.end_date,
    weeks_of_history: weeksOfHistory,
    regime_start: regimeStart,
  };
}

/**
 * Transactions behind one cell. The mock has no transaction ledger, so each
 * weekly bucket contributes one synthetic row carrying that week's amount —
 * enough for the UI's lazy drill-down, replaced by real rows at integration.
 */
export function mockPivotCell(
  derived: DerivedDemoObject,
  rowId: string,
  periodKey: string,
  granularity: PivotGranularity,
): PivotCellDetail | null {
  const pivot = mockLedgerPivot(derived, granularity);
  const row = pivot.rows.find((r) => r.id === rowId);
  const periodIndex = pivot.periods.findIndex((p) => p.key === periodKey);
  if (!row || periodIndex < 0) return null;
  // Only category and vendor rows have per-transaction truth to show.
  if (!row.category) return null;

  const period = pivot.periods[periodIndex]!;
  const buckets = derived.weeks.filter((w) => w.week_start >= period.start && w.week_start <= period.end);
  const amountOf = (w: WeeklyBucket): Cents =>
    row.entity ? (w.variable_by_entity[row.entity] ?? 0) : (w.variable_by_category[row.category!] ?? 0);

  return {
    row_id: rowId,
    period_key: periodKey,
    transactions: buckets
      .filter((w) => amountOf(w) !== 0)
      .map((w) => ({
        id: `mock_${row.entity ?? row.category}_${w.week_start}`,
        date: w.week_start,
        merchant_raw: (row.entity ?? row.category!).toUpperCase(),
        description: `MOCK weekly total for ${row.label}`,
        amount_cents: -amountOf(w),
        flow_type: "OPERATING_OUTFLOW" as const,
        category: row.category!,
        tags: [],
        dropped: false,
      })),
  };
}

/**
 * Actual + expected + canary events for `[from, to]`. Busy blocks are merged in
 * by the API from the founder's calendar feed, never here.
 *
 * `actual` = one event per vendor per week bucket (the mock's finest grain).
 * `expected` = the same vendors projected forward weekly from the burn window's
 * observed rates, for Mondays after history_end.
 * `canary` = the change point, the CUSUM alarm week, and one-off alarms.
 */
export function mockCalendarEvents(derived: DerivedDemoObject, from: ISODate, to: ISODate): CalendarEvent[] {
  const inRange = (d: ISODate): boolean => d >= from && d <= to;
  const entityCategory = categoryByEntity(derived.weeks);
  const events: CalendarEvent[] = [];

  for (const week of derived.weeks) {
    if (!inRange(week.week_start)) continue;
    for (const [entity, amount] of Object.entries(week.variable_by_entity).sort(([a], [b]) => a.localeCompare(b))) {
      if (amount === 0) continue;
      const category = entityCategory.get(entity);
      events.push({
        id: `actual_${entity}_${week.week_start}`,
        kind: "actual",
        date: week.week_start,
        title: entity,
        amount_cents: -amount,
        entity,
        ...(category ? { category } : {}),
      });
    }
  }

  const historyEnd = derived.provenance.end_date;
  const lastWeekStart = derived.weeks[derived.weeks.length - 1]?.week_start ?? historyEnd;
  for (let date = addDays(lastWeekStart, 7); date <= to; date = addDays(date, 7)) {
    if (!inRange(date) || date <= historyEnd) continue;
    for (const [entity, weekly] of Object.entries(derived.burn.weekly_variable_by_entity).sort(([a], [b]) => a.localeCompare(b))) {
      if (weekly === 0) continue;
      const category = entityCategory.get(entity);
      events.push({
        id: `expected_${entity}_${date}`,
        kind: "expected",
        date,
        title: entity,
        amount_cents: -weekly,
        entity,
        cadence: "weekly",
        confidence_n: derived.burn.weeks_in_window,
        ...(category ? { category } : {}),
      });
    }
  }

  for (const incident of derived.incidents) {
    const markers: Array<{ date: ISODate | null; suffix: string; title: string }> = [
      { date: incident.estimated_change_point, suffix: "change_point", title: "Change point" },
      { date: incident.alarm_date, suffix: "alarm", title: incident.type === "ONE_OFF_VENDOR_PAYMENT" ? "One-off flagged" : "Detector alarm" },
    ];
    for (const marker of markers) {
      if (!marker.date || !inRange(marker.date)) continue;
      events.push({
        id: `canary_${incident.id}_${marker.suffix}`,
        kind: "canary",
        date: marker.date,
        title: marker.title,
        entity: incident.entity,
        incident_id: incident.id,
        incident_type: incident.type,
      });
    }
  }

  return events;
}

/** `needs_review` items enriched with the classification signals a reviewer needs. */
export function needsReviewItems(derived: DerivedDemoObject): NeedsReviewResponse["items"] {
  return derived.needs_review.items.map((item) => {
    const classification = derived.classifications[item.transaction_id];
    return {
      transaction_id: item.transaction_id,
      date: item.date,
      merchant_raw: item.merchant_raw,
      merchant_normalized: item.merchant_normalized,
      amount_cents: item.amount_cents,
      reason: item.reason,
      proposals: (classification?.supporting_signals ?? []).map((signal) => ({
        source: signal.source,
        ...(signal.proposed_category ? { category: signal.proposed_category } : {}),
        detail: signal.detail,
        ...(signal.url ? { url: signal.url } : {}),
      })),
    };
  });
}
