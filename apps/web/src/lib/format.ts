/**
 * Thin wrappers over the shared money formatters plus display-name helpers.
 *
 * Every figure the UI renders goes through `@canary/shared` — this module never
 * does arithmetic on money and never builds a currency string by hand.
 */
import {
  formatMonths,
  formatSignedUsd,
  formatUsd,
  formatUsdCompact,
  formatUsdWhole,
  parseISODate,
  type BurnSummary,
  type Category,
  type Cents,
  type ISODate,
  type ISODateTime,
  type PivotSection,
} from "@canary/shared";

export { formatMonths, formatSignedUsd, formatUsd, formatUsdCompact, formatUsdWhole };

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** Signed weekly delta, per-week suffix. */
export function formatWeeklyRate(cents: Cents): string {
  return formatSignedUsd(cents, "/wk");
}

/** Signed monthly delta, per-month suffix. */
export function formatMonthlyRate(cents: Cents): string {
  return formatSignedUsd(cents, "/mo");
}

/** Unsigned weekly level (a rate, not a delta). */
export function formatWeeklyLevel(cents: Cents): string {
  return `${formatUsdWhole(cents)}/wk`;
}

/** Unsigned monthly level (a rate, not a delta). */
export function formatMonthlyLevel(cents: Cents): string {
  return `${formatUsdWhole(cents)}/mo`;
}

/**
 * One ledger cell. The pivot's sign conventions differ per section (contract
 * `PivotCell`): spend rows are positive magnitudes, revenue and financing are
 * signed, positive net burn means burning, and cash is a balance.
 */
export function formatPivotAmount(section: PivotSection, cents: Cents): string {
  if (section === "CASH_END") return formatUsdCompact(cents);
  if (section === "REVENUE" || section === "FINANCING_AND_TRANSFERS") return formatSignedUsd(cents);
  // Spend and net burn arrive as magnitudes; a negative net burn is a net
  // inflow, which only reads correctly with its sign.
  return cents < 0 ? formatSignedUsd(cents) : formatUsdWhole(cents);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** ISO dates are calendar dates; format them in UTC so they never shift a day. */
const weekLabelFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const mediumFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** `Sep 7` — chart axis / inline week references. */
export function formatWeekLabel(date: ISODate): string {
  return weekLabelFmt.format(parseISODate(date));
}

/** `Sep 13, 2026` */
export function formatDateMedium(date: ISODate): string {
  return mediumFmt.format(parseISODate(date));
}

/** `Sep 12, 2026` from an ISO 8601 timestamp. */
export function formatTimestampMedium(ts: ISODateTime): string {
  const day = ts.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? formatDateMedium(day) : ts;
}

const monthShortFmt = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const monthLongFmt = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** `Jun 2026` — ledger column headers. Takes a `YYYY-MM` key. */
export function formatMonthShort(month: string): string {
  return monthShortFmt.format(parseISODate(`${month}-01`));
}

/** `June 2026` — calendar page title. Takes a `YYYY-MM` key. */
export function formatMonthLong(month: string): string {
  return monthLongFmt.format(parseISODate(`${month}-01`));
}

/** Mon-first weekday headers for the month grid. */
export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** `13` — the day number in a calendar cell. */
export function formatDayOfMonth(date: ISODate): string {
  return String(parseISODate(date).getUTCDate());
}

/**
 * `3:30 PM`, read straight off the timestamp's own wall clock. Same choice as
 * `formatTimestampMedium`: the string is authoritative, so a founder in
 * another timezone never sees a meeting slide by five hours.
 */
export function formatTimeOfDay(ts: ISODateTime): string {
  const m = /T(\d{2}):(\d{2})/.exec(ts);
  if (!m) return ts;
  const hour24 = Number(m[1]);
  const minute = m[2]!;
  const suffix = hour24 < 12 ? "AM" : "PM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${minute} ${suffix}`;
}

/** `9:00 AM – 9:30 AM` */
export function formatTimeRange(start: ISODateTime, end?: ISODateTime): string {
  return end ? `${formatTimeOfDay(start)} – ${formatTimeOfDay(end)}` : formatTimeOfDay(start);
}

// ---------------------------------------------------------------------------
// Ratios
// ---------------------------------------------------------------------------

const percentFmt = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });

/** `62%` from a 0–1 share. Negative shares keep their sign. */
export function formatShare(share: number): string {
  return percentFmt.format(share);
}

/** `-20%` for the what-if slider readout. */
export function formatSignedPercent(pct: number): string {
  const rounded = Math.round(pct);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

/** Multiple of a median, e.g. for "n× vendor median". */
export function formatMultiple(multiple: number): string {
  return `${multiple.toFixed(1)}×`;
}

// ---------------------------------------------------------------------------
// Names & labels
// ---------------------------------------------------------------------------

/**
 * Entities whose title-cased key would read wrong (acronyms, camel-cased
 * brands). Everything else falls through to title case.
 */
const ENTITY_DISPLAY_NAMES: Record<string, string> = {
  aws: "AWS",
  datadog: "Datadog",
  ashby: "Ashby",
  figma: "Figma",
  gcp: "GCP",
  github: "GitHub",
  gitlab: "GitLab",
  doordash: "DoorDash",
  openai: "OpenAI",
  hubspot: "HubSpot",
  wework: "WeWork",
  irs: "IRS",
};

export function entityDisplayName(entity: string): string {
  const known = ENTITY_DISPLAY_NAMES[entity.toLowerCase()];
  return known ?? titleCase(entity);
}

/** `CLOUD_INFRASTRUCTURE` → `Cloud Infrastructure`. */
const CATEGORY_LABELS: Partial<Record<Category, string>> = {
  SAAS_SOFTWARE: "SaaS software",
  CLOUD_INFRASTRUCTURE: "Cloud infrastructure",
  TAXES_FEES: "Taxes & fees",
  NEEDS_REVIEW: "Needs Review",
  CUSTOMER_REVENUE: "Customer revenue",
  PROFESSIONAL_SERVICES: "Professional services",
  INTERNAL_TRANSFER: "Internal transfer",
  CARD_SETTLEMENT: "Card settlement",
};

export function categoryLabel(category: Category | null | undefined): string | null {
  return category ? (CATEGORY_LABELS[category] ?? titleCase(category)) : null;
}

/** `MIN_MONTHLY_DELTA` → `Min monthly delta`. */
export function ruleLabel(rule: string): string {
  const words = rule.toLowerCase().split(/[_\s-]+/).filter(Boolean).join(" ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : rule;
}

function titleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

// ---------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------

/** Explains which weeks the burn figure averages over. */
export function burnWindowCaption(burn: BurnSummary): string {
  if (burn.burn_window_reason === "POST_CHANGE_SEGMENT") {
    return `post-change window ${formatWeekLabel(burn.burn_window_start)} – ${formatWeekLabel(burn.burn_window_end)}`;
  }
  return `trailing ${burn.weeks_in_window} weeks`;
}
