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
export function categoryLabel(category: Category | null | undefined): string | null {
  return category ? titleCase(category) : null;
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
