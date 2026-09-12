/**
 * How a ledger row lands in the sheet.
 *
 * The precedence here is deliberately the same as `buildWeeklyBuckets`
 * (fixed → monitoring-excluded → variable), so a section total is always the
 * weekly bucket total for that section. That identity is the whole point of the
 * sheet: it is the CUSUM input, laid out by vendor.
 */
import {
  FIXED_CATEGORIES,
  type Cents,
  type LedgerTransaction,
  type PivotCell,
  type PivotSection,
} from "@canary/shared";

export type PivotFlag = PivotCell["flags"][number];

/** Canonical flag order, so a cell serializes identically every run. */
export const FLAG_ORDER: readonly PivotFlag[] = [
  "one_off",
  "needs_review",
  "refund",
  "annual_renewal",
  "pending_dropped",
];

export const SECTION_ORDER: readonly PivotSection[] = [
  "REVENUE",
  "VARIABLE_SPEND",
  "FIXED_SPEND",
  "ONE_OFF",
  "NET_BURN",
  "FINANCING_AND_TRANSFERS",
  "CASH_END",
];

/** Sections with category (level 1) and vendor (level 2) children. */
export const DRILLDOWN_SECTIONS: readonly PivotSection[] = [
  "REVENUE",
  "VARIABLE_SPEND",
  "FIXED_SPEND",
  "ONE_OFF",
];

/** Sections whose totals make up net burn. */
export const SPEND_SECTIONS: readonly PivotSection[] = ["VARIABLE_SPEND", "FIXED_SPEND", "ONE_OFF"];

/** Level-1 rows under FINANCING_AND_TRANSFERS, in display order. */
export const FINANCING_CATEGORY_ORDER = ["FINANCING", "INTERNAL_TRANSFER", "CARD_SETTLEMENT"] as const;

/** Tags that keep a row in burn but out of the monitored variable series. */
const MONITORING_EXCLUDED_TAGS = ["one_off", "annual_renewal"] as const;

/**
 * Section for any row, including the dropped ones — a superseded pending row
 * still has to know which vendor cell to raise `pending_dropped` on, and
 * `counts_in_burn` is false purely because it was dropped.
 */
export function sectionOf(tx: LedgerTransaction): PivotSection {
  switch (tx.flow_type) {
    case "OPERATING_INFLOW":
      return "REVENUE";
    case "FINANCING":
    case "INTERNAL_TRANSFER":
    case "CARD_SETTLEMENT":
      return "FINANCING_AND_TRANSFERS";
    default:
      break;
  }
  if (FIXED_CATEGORIES.includes(tx.category)) return "FIXED_SPEND";
  if (isMonitoringExcluded(tx)) return "ONE_OFF";
  return "VARIABLE_SPEND";
}

function isMonitoringExcluded(tx: LedgerTransaction): boolean {
  return MONITORING_EXCLUDED_TAGS.some((t) => tx.tags.includes(t));
}

/**
 * Contribution to a cell: signed for revenue and financing rows (inflow > 0),
 * positive magnitude for spend rows — so a refund reduces the vendor's spend
 * and can take a cell negative.
 */
export function cellDelta(tx: LedgerTransaction, section: PivotSection): Cents {
  return section === "REVENUE" || section === "FINANCING_AND_TRANSFERS" ? tx.amount_cents : -tx.amount_cents;
}

/** Flags a live row raises on the cell it lands in. */
export function flagsOf(tx: LedgerTransaction, section: PivotSection): PivotFlag[] {
  const flags: PivotFlag[] = [];
  if (section === "ONE_OFF" || tx.tags.includes("one_off")) flags.push("one_off");
  if (tx.category === "NEEDS_REVIEW" || tx.tags.includes("needs_review")) flags.push("needs_review");
  if (tx.flow_type === "REFUND") flags.push("refund");
  if (tx.tags.includes("annual_renewal")) flags.push("annual_renewal");
  return flags;
}

/**
 * A card purchase moves burn but not cash: the settlement that pays the card
 * off is the cash movement. Both still belong on the calendar.
 */
export function isCardPurchase(tx: LedgerTransaction): boolean {
  return tx.counts_in_burn && !tx.counts_in_cash;
}
