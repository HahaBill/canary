/**
 * View-model contracts for the Ledger sheet, the cash Calendar, notification
 * policy, and Needs Review actions. All figures are engine-derived (Rule 0):
 * the pivot and the recurring projection are pure functions in @canary/engine,
 * served by apps/api, rendered by apps/web. Nothing here is computed in the browser.
 */
import type { Category, Cents, FlowType, IncidentType, ISODate, ISODateTime } from "./types.ts";

// ---------------------------------------------------------------------------
// Ledger pivot (the "sheet")
// ---------------------------------------------------------------------------

export type PivotGranularity = "week" | "month";

export interface PivotPeriod {
  /** Stable key: week → Monday `YYYY-MM-DD`; month → `YYYY-MM`. */
  key: string;
  start: ISODate;
  end: ISODate;
  /** True when the period is partially outside the history window. */
  partial: boolean;
  /** True for periods at/after the confirmed regime start (tinted in the UI). */
  post_change: boolean;
}

export type PivotSection =
  | "REVENUE"
  | "VARIABLE_SPEND"
  | "FIXED_SPEND"
  | "ONE_OFF"
  | "NET_BURN"
  | "FINANCING_AND_TRANSFERS"
  | "CASH_END";

export interface PivotCell {
  /** Signed for REVENUE/FINANCING/CASH rows (inflow > 0); positive magnitude for spend rows; NET_BURN positive = burning. */
  amount_cents: Cents;
  transaction_count: number;
  /** Markers the UI renders as hints. */
  flags: Array<"one_off" | "needs_review" | "refund" | "annual_renewal" | "pending_dropped">;
}

export interface PivotRow {
  /** `section:` / `category:CLOUD_INFRASTRUCTURE` / `vendor:aws` — unique within the pivot. */
  id: string;
  level: 0 | 1 | 2;
  section: PivotSection;
  label: string;
  category?: Category;
  entity?: string;
  /** Row id of the parent (undefined for level 0). */
  parent_id?: string;
  /** One cell per `periods[i]`. */
  cells: PivotCell[];
  /** Σ over all periods (same sign convention as cells). */
  total_cents: Cents;
  /** Total ÷ weeks of history × 52 (spend/revenue rows) — "run-rate", labeled as such. */
  annualized_cents: Cents | null;
  /** Vendor rows: link to the incident this entity drives, if any. */
  incident_id?: string;
}

export interface LedgerPivot {
  granularity: PivotGranularity;
  periods: PivotPeriod[];
  rows: PivotRow[];
  history_start: ISODate;
  history_end: ISODate;
  weeks_of_history: number;
  /** Regime start week (Monday) when a shift was confirmed. */
  regime_start: ISODate | null;
}

/** Individual transactions behind one vendor × period cell (lazy detail). */
export interface PivotCellDetail {
  row_id: string;
  period_key: string;
  transactions: Array<{
    id: string;
    date: ISODate;
    merchant_raw: string;
    description: string;
    amount_cents: Cents;
    flow_type: FlowType;
    category: Category;
    tags: string[];
    dropped: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// Cash calendar
// ---------------------------------------------------------------------------

export type CalendarEventKind =
  /** A settled transaction that happened. */
  | "actual"
  /** Projected recurring charge from observed cadence — "expected · from history". */
  | "expected"
  /** Canary markers: change point, alarm, one-off, scheduled review. */
  | "canary"
  /** Founder is busy (from the private calendar feed). Titles hidden unless configured. */
  | "busy";

export interface CalendarEvent {
  id: string;
  kind: CalendarEventKind;
  date: ISODate;
  /** ISO timestamps for timed events (busy blocks, review slots); undefined for all-day cash events. */
  start?: ISODateTime;
  end?: ISODateTime;
  title: string;
  /** Signed cents for actual/expected. */
  amount_cents?: Cents;
  entity?: string;
  category?: Category;
  incident_id?: string;
  incident_type?: IncidentType;
  /** For `expected`: the cadence the projection is based on. */
  cadence?: "weekly" | "biweekly" | "monthly";
  /** For `expected`: how many prior observations support it. */
  confidence_n?: number;
}

export interface CalendarDay {
  date: ISODate;
  events: CalendarEvent[];
  /** Σ signed cents of `actual` events that day. */
  net_actual_cents: Cents;
  /** Σ signed cents of `expected` events that day. */
  net_expected_cents: Cents;
}

export interface CashCalendar {
  from: ISODate;
  to: ISODate;
  days: CalendarDay[];
  /** Whether a founder calendar feed was configured and readable. */
  busy_source: "ics" | "none";
}

/** Recurring charge detected from the ledger (input to the calendar projection). */
export interface RecurringSeries {
  entity: string;
  category: Category;
  cadence: "weekly" | "biweekly" | "monthly";
  /** Median signed amount of the observed occurrences. */
  typical_amount_cents: Cents;
  observations: number;
  last_seen: ISODate;
  /** Next expected dates within the projection horizon. */
  next_dates: ISODate[];
}

// ---------------------------------------------------------------------------
// Availability / notification policy (docs/AGENT_BEHAVIOR.md §1)
// ---------------------------------------------------------------------------

export interface AvailabilityResponse {
  busy: boolean;
  /** End of the current busy block, when busy. */
  until: ISODateTime | null;
  /** Start of the next busy block within the lookahead, when free. */
  next_busy_start: ISODateTime | null;
  source: "ics" | "none";
  checked_at: ISODateTime;
}

export type NotifyDecision =
  | { send: true }
  | { send: false; reason: "not_open" | "already_notified" | "not_material" | "calendar_busy"; until?: ISODateTime };

export interface PendingAlert {
  /** Deterministic id (incident + recipient), server-assigned. */
  id?: string;
  incident_id: string;
  to: string;
  voice: boolean;
  created_at: ISODateTime;
  /** Earliest time the alert may be delivered (end of the busy block). */
  deliver_after: ISODateTime;
  attempts: number;
}

// ---------------------------------------------------------------------------
// Alert history (from imessage_log)
// ---------------------------------------------------------------------------

export interface AlertHistoryItem {
  id: number;
  direction: "inbound" | "outbound";
  phone: string;
  body: string;
  created_at: ISODateTime;
  command: string | null;
  /** True when the body is a voice-note transcript. */
  voice: boolean;
  /** Incident the message was about, when known. */
  incident_id?: string;
}

// ---------------------------------------------------------------------------
// Needs Review actions
// ---------------------------------------------------------------------------

export interface ClassificationOverride {
  transaction_id: string;
  merchant_normalized: string;
  category: Category;
  /** Apply to every transaction of this merchant, not just this one. */
  apply_to_merchant: boolean;
  note?: string;
  created_at: ISODateTime;
}
