/**
 * Presentation helpers that are NOT money. All currency/duration formatting
 * comes from `@canary/shared` (`formatUsd*`, `formatMonths`, `speak*`).
 */
import type { ISODate } from "@canary/shared";

/**
 * Vendor keys are `merchant_normalized` (lower_snake). Only entities whose
 * casing a title-case fallback would get wrong need an entry here.
 */
const DISPLAY_NAMES: Record<string, string> = {
  aws: "AWS",
  gcp: "GCP",
  github: "GitHub",
  doordash: "DoorDash",
  ubereats: "Uber Eats",
  wework: "WeWork",
  hubspot: "HubSpot",
  openai: "OpenAI",
  ashby: "Ashby",
  gusto_payroll: "Gusto payroll",
  stripe_payouts: "Stripe payouts",
  card_settlement: "Card settlement",
  internal_transfer: "Internal transfer",
  variable_spend: "Variable spending",
};

/** `aws` → `AWS`, `datadog` → `Datadog`, `acme_cloud` → `Acme Cloud`. */
export function displayName(entity: string): string {
  const key = entity.trim().toLowerCase();
  if (!key) return "";
  const known = DISPLAY_NAMES[key];
  if (known) return known;
  return key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-08-31` → `Aug 31, 2026`. Pure string math — no timezone surprises. */
export function formatDateShort(date: ISODate | null | undefined): string {
  if (!date) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return date;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return date;
  return `${month} ${Number(m[3])}, ${m[1]}`;
}
