/**
 * Offline stand-ins for the view routes (`/api/ledger`, `/api/calendar`,
 * `/api/availability`, `/api/needs-review`) — none of which the Worker serves
 * yet. Every figure is a reduction over the weekly buckets in
 * `DerivedDemoObject`, anchored on its bank closing balance; nothing here
 * invents a money number.
 *
 * These are pure builders. `api/mock.ts` owns the session snapshot and the
 * override state so there is still exactly one mutable mock store.
 */
import {
  addDays,
  isoWeekday,
  type AvailabilityResponse,
  type CalendarDay,
  type CalendarEvent,
  type CashCalendar,
  type Category,
  type Cents,
  type ClassificationOverride,
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
import { monthKeyOf } from "@/lib/month.ts";

/**
 * The mock weekly buckets carry spend per entity but no category mapping, so
 * the pivot hierarchy needs one. Matches how `buildMockDerived` groups
 * `variable_by_category`.
 */
const MOCK_ENTITY_CATEGORY: Record<string, Category> = {
  aws: "CLOUD_INFRASTRUCTURE",
  datadog: "SAAS_SOFTWARE",
  figma: "SAAS_SOFTWARE",
  ashby: "RECRUITING",
  upwork: "CONTRACTORS",
  doordash: "MEALS",
};

/** Vendor whose pending duplicates the mock reconciliation drops (see `pending_rows_dropped`). */
const MOCK_PENDING_DUP_ENTITY = "aws";

const SECTION_LABELS: Record<PivotSection, string> = {
  REVENUE: "Revenue",
  VARIABLE_SPEND: "Variable spend",
  FIXED_SPEND: "Fixed spend",
  ONE_OFF: "One-off",
  NET_BURN: "Net burn",
  FINANCING_AND_TRANSFERS: "Financing & transfers",
  CASH_END: "Cash at period end",
};

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

interface PeriodGroup {
  period: PivotPeriod;
  buckets: WeeklyBucket[];
}

function groupPeriods(d: DerivedDemoObject, granularity: PivotGranularity): PeriodGroup[] {
  const regime = d.primary_incident?.estimated_change_point ?? null;
  // "at/after the regime start": the period that contains it is the first tinted one.
  const postChange = (end: ISODate) => (regime === null ? false : end >= regime);

  if (granularity === "week") {
    return d.weeks.map((b) => ({
      period: {
        key: b.week_start,
        start: b.week_start,
        end: b.week_end,
        partial: false,
        post_change: postChange(b.week_end),
      },
      buckets: [b],
    }));
  }

  const byMonth = new Map<string, WeeklyBucket[]>();
  for (const b of d.weeks) {
    const key = monthKeyOf(b.week_start);
    const list = byMonth.get(key);
    if (list) list.push(b);
    else byMonth.set(key, [b]);
  }

  const months = [...byMonth.entries()];
  return months.map(([key, buckets], index) => ({
    period: {
      key,
      // Months are grouped by whole weeks, since the engine buckets weekly.
      start: buckets[0]!.week_start,
      end: buckets[buckets.length - 1]!.week_end,
      // Only the ends of the history are clipped by the window; the months in
      // between are covered by contiguous whole weeks.
      partial: index === 0 || index === months.length - 1,
      post_change: postChange(buckets[buckets.length - 1]!.week_end),
    },
    buckets,
  }));
}

// ---------------------------------------------------------------------------
// Ledger pivot
// ---------------------------------------------------------------------------

function cell(amount: Cents, count: number, flags: PivotCell["flags"] = []): PivotCell {
  return { amount_cents: amount, transaction_count: count, flags };
}

const emptyCell = (): PivotCell => cell(0, 0);

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/** Weekly buckets contributing a non-zero amount — the mock's stand-in for a transaction count. */
function contributingWeeks(buckets: WeeklyBucket[], amountOf: (b: WeeklyBucket) => Cents): WeeklyBucket[] {
  return buckets.filter((b) => amountOf(b) !== 0);
}

export function buildMockPivot(d: DerivedDemoObject, granularity: PivotGranularity): LedgerPivot {
  const groups = groupPeriods(d, granularity);
  const periods = groups.map((g) => g.period);
  const weeksOfHistory = d.provenance.weeks;
  const regime = d.primary_incident?.estimated_change_point ?? null;

  /** Total ÷ weeks of history × 52 — the run-rate the UI labels as such. */
  const annualize = (total: Cents): Cents => Math.round((total / weeksOfHistory) * 52);

  const rows: PivotRow[] = [];

  const pushRow = (
    row: Omit<PivotRow, "cells" | "total_cents" | "annualized_cents">,
    cells: PivotCell[],
    annualized = true,
  ) => {
    const total = sum(cells.map((c) => c.amount_cents));
    rows.push({
      ...row,
      cells,
      total_cents: total,
      annualized_cents: annualized ? annualize(total) : null,
    });
  };

  // Revenue — signed (inflow > 0). The mock nets refunds into operating inflow.
  const refundPeriod = lastIndexWhere(groups, (g) => sum(g.buckets.map((b) => b.operating_inflow_cents)) !== 0);
  pushRow(
    { id: "section:REVENUE", level: 0, section: "REVENUE", label: SECTION_LABELS.REVENUE },
    groups.map((g, i) => {
      const amount = sum(g.buckets.map((b) => b.operating_inflow_cents));
      const weeks = contributingWeeks(g.buckets, (b) => b.operating_inflow_cents);
      if (amount === 0) return emptyCell();
      return cell(amount, weeks.length, i === refundPeriod && d.reconciliation.refunds_netted_cents > 0 ? ["refund"] : []);
    }),
  );

  // Variable spend — positive magnitudes, with category → vendor children.
  const needsReviewPeriod = groups.findIndex((g) =>
    d.needs_review.items.some((item) => item.date >= g.period.start && item.date <= g.period.end),
  );
  pushRow(
    { id: "section:VARIABLE_SPEND", level: 0, section: "VARIABLE_SPEND", label: SECTION_LABELS.VARIABLE_SPEND },
    groups.map((g, i) => {
      const amount = sum(g.buckets.map((b) => b.variable_spend_cents));
      if (amount === 0) return emptyCell();
      // The unreviewable transaction is not attributed to a vendor, so the
      // marker sits on the section it is counted inside.
      return cell(amount, g.buckets.length, i === needsReviewPeriod ? ["needs_review"] : []);
    }),
  );

  const entities = Object.keys(d.weeks[0]?.variable_by_entity ?? {});
  const byCategory = new Map<Category, string[]>();
  for (const entity of entities) {
    const category = MOCK_ENTITY_CATEGORY[entity] ?? "NEEDS_REVIEW";
    const list = byCategory.get(category);
    if (list) list.push(entity);
    else byCategory.set(category, [entity]);
  }

  const oneOffPeriod = groups.findIndex((g) => sum(g.buckets.map((b) => b.excluded_from_monitoring_cents)) !== 0);
  const incidentByEntity = new Map(d.incidents.map((incident) => [incident.entity, incident.id]));

  for (const [category, members] of byCategory) {
    const categoryId = `category:${category}`;
    pushRow(
      {
        id: categoryId,
        level: 1,
        section: "VARIABLE_SPEND",
        label: categoryLabelOf(category),
        category,
        parent_id: "section:VARIABLE_SPEND",
      },
      groups.map((g) => {
        const amount = sum(g.buckets.map((b) => sum(members.map((e) => b.variable_by_entity[e] ?? 0))));
        return amount === 0 ? emptyCell() : cell(amount, g.buckets.length);
      }),
    );

    for (const entity of members) {
      const amountOf = (b: WeeklyBucket) => b.variable_by_entity[entity] ?? 0;
      const incidentId = incidentByEntity.get(entity);
      // The mock reconciliation drops a handful of pending duplicates, so only
      // the vendor's first period carries one.
      const dupPeriod =
        entity === MOCK_PENDING_DUP_ENTITY
          ? groups.findIndex((g) => sum(g.buckets.map(amountOf)) !== 0)
          : -1;
      pushRow(
        {
          id: `vendor:${entity}`,
          level: 2,
          section: "VARIABLE_SPEND",
          label: entity,
          category,
          entity,
          parent_id: categoryId,
          ...(incidentId ? { incident_id: incidentId } : {}),
        },
        groups.map((g, i) => {
          const amount = sum(g.buckets.map(amountOf));
          if (amount === 0) return emptyCell();
          const weeks = contributingWeeks(g.buckets, amountOf);
          const flags: PivotCell["flags"] = [];
          if (i === dupPeriod) flags.push("pending_dropped");
          if (i === oneOffPeriod && entity === d.one_off_incident?.entity) flags.push("one_off");
          // One synthetic settled row per contributing week, plus the dropped
          // pending duplicate the detail sheet shows struck through.
          return cell(amount, weeks.length + (i === dupPeriod ? 1 : 0), flags);
        }),
      );
    }
  }

  // Fixed spend — the mock buckets lump payroll and rent, so no children.
  pushRow(
    { id: "section:FIXED_SPEND", level: 0, section: "FIXED_SPEND", label: SECTION_LABELS.FIXED_SPEND },
    groups.map((g) => {
      const amount = sum(g.buckets.map((b) => b.fixed_spend_cents));
      return amount === 0 ? emptyCell() : cell(amount, g.buckets.length);
    }),
  );

  pushRow(
    { id: "section:ONE_OFF", level: 0, section: "ONE_OFF", label: SECTION_LABELS.ONE_OFF },
    groups.map((g) => {
      const amount = sum(g.buckets.map((b) => b.excluded_from_monitoring_cents));
      if (amount === 0) return emptyCell();
      return cell(amount, contributingWeeks(g.buckets, (b) => b.excluded_from_monitoring_cents).length, ["one_off"]);
    }),
    // A one-off does not recur, so extrapolating it to a yearly run-rate would
    // be a misleading number rather than a useful one.
    false,
  );

  pushRow(
    { id: "section:NET_BURN", level: 0, section: "NET_BURN", label: SECTION_LABELS.NET_BURN },
    groups.map((g) => {
      const amount = sum(g.buckets.map((b) => b.net_burn_cents));
      return amount === 0 ? emptyCell() : cell(amount, g.buckets.length);
    }),
  );

  // Cash at period end, walked backward from the bank's closing balance: the
  // mock series has no financing legs, so net cash movement is exactly −net burn.
  const netBurnByPeriod = groups.map((g) => sum(g.buckets.map((b) => b.net_burn_cents)));
  const cashEnd: Cents[] = new Array(groups.length);
  let running = d.cash_cents;
  for (let i = groups.length - 1; i >= 0; i--) {
    cashEnd[i] = running;
    running += netBurnByPeriod[i]!;
  }
  pushRow(
    { id: "section:CASH_END", level: 0, section: "CASH_END", label: SECTION_LABELS.CASH_END },
    cashEnd.map((amount, i) => cell(amount, groups[i]!.buckets.length)),
    false,
  );

  return {
    granularity,
    periods,
    rows,
    history_start: d.provenance.start_date,
    history_end: d.provenance.end_date,
    weeks_of_history: weeksOfHistory,
    regime_start: regime,
  };
}

/**
 * Individual rows behind one cell. Synthesized from the weekly buckets — one
 * settled row per contributing week, plus the dropped pending duplicate.
 */
export function buildMockCellDetail(
  d: DerivedDemoObject,
  rowId: string,
  periodKey: string,
  granularity: PivotGranularity,
): PivotCellDetail {
  const groups = groupPeriods(d, granularity);
  const group = groups.find((g) => g.period.key === periodKey);
  const entity = rowId.startsWith("vendor:") ? rowId.slice("vendor:".length) : null;
  if (!group || !entity) return { row_id: rowId, period_key: periodKey, transactions: [] };

  const category = MOCK_ENTITY_CATEGORY[entity] ?? "NEEDS_REVIEW";
  const oneOffWeek = d.one_off_incident?.entity === entity ? d.one_off_incident.alarm_date : null;
  // Must agree with the `pending_dropped` flag the pivot puts on this cell.
  const hasDroppedPending =
    entity === MOCK_PENDING_DUP_ENTITY &&
    groups.find((g) => sum(g.buckets.map((b) => b.variable_by_entity[entity] ?? 0)) !== 0)?.period.key ===
      periodKey;
  const transactions: PivotCellDetail["transactions"] = [];

  for (const bucket of group.buckets) {
    const amount = bucket.variable_by_entity[entity] ?? 0;
    if (amount === 0) continue;
    const isOneOff = oneOffWeek !== null && bucket.week_start === oneOffWeek;
    transactions.push({
      id: `mock_tx_${entity}_${bucket.week_start}`,
      date: bucket.week_start,
      merchant_raw: `${entity.toUpperCase()} MOCK DESCRIPTOR`,
      description: `${entity} — weekly charge`,
      // Outflows are signed negative on a transaction; the pivot shows magnitudes.
      amount_cents: -amount,
      flow_type: "OPERATING_OUTFLOW",
      category,
      tags: isOneOff ? ["one_off"] : [],
      dropped: false,
    });

    if (hasDroppedPending && transactions.length === 1) {
      transactions.push({
        id: `mock_tx_${entity}_${bucket.week_start}_pending`,
        date: bucket.week_start,
        merchant_raw: `${entity.toUpperCase()} MOCK DESCRIPTOR (PENDING)`,
        description: `${entity} — superseded pending row`,
        amount_cents: -amount,
        flow_type: "OPERATING_OUTFLOW",
        category,
        tags: [],
        dropped: true,
      });
    }
  }

  return { row_id: rowId, period_key: periodKey, transactions };
}

// ---------------------------------------------------------------------------
// Cash calendar
// ---------------------------------------------------------------------------

/** 9:00–9:30 standup on Mon/Wed/Fri — calendar metadata, not a cash figure. */
const BUSY_WEEKDAYS = new Set([0, 2, 4]);
const BUSY_START = "T09:00:00.000Z";
const BUSY_END = "T09:30:00.000Z";

export function buildMockCalendar(d: DerivedDemoObject, from: ISODate, to: ISODate): CashCalendar {
  const inRange = (date: ISODate) => date >= from && date <= to;
  const events: CalendarEvent[] = [];

  // Actuals: one event per (entity, week) plus the week's fixed spend and revenue.
  for (const bucket of d.weeks) {
    if (!inRange(bucket.week_start)) continue;
    for (const [entity, amount] of Object.entries(bucket.variable_by_entity)) {
      if (!amount) continue;
      events.push({
        id: `mock_actual_${entity}_${bucket.week_start}`,
        kind: "actual",
        date: bucket.week_start,
        title: entity,
        amount_cents: -amount,
        entity,
        category: MOCK_ENTITY_CATEGORY[entity] ?? "NEEDS_REVIEW",
      });
    }
    if (bucket.fixed_spend_cents) {
      events.push({
        id: `mock_actual_fixed_${bucket.week_start}`,
        kind: "actual",
        date: bucket.week_start,
        title: "Payroll & rent",
        amount_cents: -bucket.fixed_spend_cents,
        category: "PAYROLL",
      });
    }
    if (bucket.operating_inflow_cents) {
      events.push({
        id: `mock_actual_revenue_${bucket.week_start}`,
        kind: "actual",
        date: bucket.week_start,
        title: "Customer revenue",
        amount_cents: bucket.operating_inflow_cents,
        category: "CUSTOMER_REVENUE",
      });
    }
  }

  // Expected: the weekly cadence projected past the end of history, at the
  // vendor's most recent observed level.
  const lastBucket = d.weeks[d.weeks.length - 1];
  if (lastBucket) {
    for (const [entity, amount] of Object.entries(lastBucket.variable_by_entity)) {
      if (!amount) continue;
      const observations = d.weeks.filter((b) => (b.variable_by_entity[entity] ?? 0) !== 0).length;
      for (let week = 1; week <= 6; week++) {
        const date = addDays(lastBucket.week_start, week * 7);
        if (!inRange(date) || date <= d.provenance.end_date) continue;
        events.push({
          id: `mock_expected_${entity}_${date}`,
          kind: "expected",
          date,
          title: entity,
          amount_cents: -amount,
          entity,
          category: MOCK_ENTITY_CATEGORY[entity] ?? "NEEDS_REVIEW",
          cadence: "weekly",
          confidence_n: observations,
        });
      }
    }
  }

  // Canary markers.
  const primary = d.primary_incident;
  if (primary?.estimated_change_point && inRange(primary.estimated_change_point)) {
    events.push({
      id: `mock_canary_change_${primary.id}`,
      kind: "canary",
      date: primary.estimated_change_point,
      title: "Change point — variable spend shifted",
      incident_id: primary.id,
      incident_type: primary.type,
    });
  }
  if (primary?.alarm_date && inRange(primary.alarm_date)) {
    events.push({
      id: `mock_canary_alarm_${primary.id}`,
      kind: "canary",
      date: primary.alarm_date,
      title: "Alarm — CUSUM crossed its threshold",
      incident_id: primary.id,
      incident_type: primary.type,
    });
  }
  const oneOff = d.one_off_incident;
  if (oneOff?.alarm_date && inRange(oneOff.alarm_date)) {
    events.push({
      id: `mock_canary_oneoff_${oneOff.id}`,
      kind: "canary",
      date: oneOff.alarm_date,
      title: oneOff.title,
      amount_cents: oneOff.financial_impact.one_off_amount_cents
        ? -oneOff.financial_impact.one_off_amount_cents
        : undefined,
      entity: oneOff.entity,
      incident_id: oneOff.id,
      incident_type: oneOff.type,
    });
  }

  // Busy blocks.
  for (let date = from; date <= to; date = addDays(date, 1)) {
    if (!BUSY_WEEKDAYS.has(isoWeekday(date))) continue;
    events.push({
      id: `mock_busy_${date}`,
      kind: "busy",
      date,
      start: `${date}${BUSY_START}`,
      end: `${date}${BUSY_END}`,
      title: "Busy",
    });
  }

  const byDate = new Map<ISODate, CalendarEvent[]>();
  for (const event of events) {
    const list = byDate.get(event.date);
    if (list) list.push(event);
    else byDate.set(event.date, [event]);
  }

  const days: CalendarDay[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const dayEvents = byDate.get(date) ?? [];
    days.push({
      date,
      events: dayEvents,
      net_actual_cents: sum(dayEvents.filter((e) => e.kind === "actual").map((e) => e.amount_cents ?? 0)),
      net_expected_cents: sum(dayEvents.filter((e) => e.kind === "expected").map((e) => e.amount_cents ?? 0)),
    });
  }

  return { from, to, days, busy_source: "ics" };
}

export function buildMockAvailability(d: DerivedDemoObject): AvailabilityResponse {
  const checkedAt = d.provenance.generated_at;
  let nextBusy: ISODate | null = null;
  for (let i = 0; i < 7; i++) {
    const date = addDays(checkedAt.slice(0, 10), i + 1);
    if (BUSY_WEEKDAYS.has(isoWeekday(date))) {
      nextBusy = date;
      break;
    }
  }
  return {
    busy: false,
    until: null,
    next_busy_start: nextBusy ? `${nextBusy}${BUSY_START}` : null,
    source: "ics",
    checked_at: checkedAt,
  };
}

// ---------------------------------------------------------------------------
// Needs Review
// ---------------------------------------------------------------------------

export function buildMockNeedsReview(
  d: DerivedDemoObject,
  overrides: ClassificationOverride[],
): NeedsReviewResponse {
  const enrichment = d.vendor_enrichments[0];
  return {
    count: d.needs_review.count,
    outflow_cents: d.needs_review.outflow_cents,
    items: d.needs_review.items.map((item) => ({
      transaction_id: item.transaction_id,
      date: item.date,
      merchant_raw: item.merchant_raw,
      merchant_normalized: item.merchant_normalized,
      amount_cents: item.amount_cents,
      reason: item.reason,
      // Disagreeing proposals are exactly why a row lands here.
      proposals: [
        {
          source: "OPENAI",
          category: "PROFESSIONAL_SERVICES",
          detail: "MOCK: descriptor reads like an outside services vendor",
        },
        {
          source: "TAVILY",
          category: "SAAS_SOFTWARE",
          detail: "MOCK: closest indexed match is a software product",
          ...(enrichment ? { url: enrichment.source_url } : {}),
        },
      ],
    })),
    overrides,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function lastIndexWhere<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i]!)) return i;
  return -1;
}

/** Local copy of the display rule so the mock does not import UI code. */
function categoryLabelOf(category: Category): string {
  return category
    .split("_")
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
}
