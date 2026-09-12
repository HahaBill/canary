/**
 * Display labels for the ledger sheet and the cash calendar.
 *
 * The pivot and the calendar ship their labels in the payload, so the strings
 * the founder reads are built here rather than in the browser. `apps/web` and
 * `apps/api` keep their own entity maps for the surfaces they render
 * themselves; add a vendor in all three or it falls back to title case.
 */
import type { Category, PivotSection } from "@canary/shared";

/**
 * Entities whose title-cased key would read wrong (acronyms, camel-cased
 * brands). Everything else falls through to title case.
 */
const ENTITY_DISPLAY_NAMES: Record<string, string> = {
  aws: "AWS",
  gcp: "GCP",
  github: "GitHub",
  gitlab: "GitLab",
  doordash: "DoorDash",
  uber_eats: "Uber Eats",
  openai: "OpenAI",
  hubspot: "HubSpot",
  wework: "WeWork",
  irs: "IRS",
};

/** `aws` → `AWS`, `gusto_payroll` → `Gusto Payroll`. */
export function entityDisplayName(entity: string): string {
  const key = entity.trim().toLowerCase();
  if (!key) return "";
  return ENTITY_DISPLAY_NAMES[key] ?? titleCase(key);
}

/** Sentence case, because these are row labels in a sheet, not headings. */
const CATEGORY_LABELS: Record<Category, string> = {
  PAYROLL: "Payroll",
  RENT: "Rent",
  CLOUD_INFRASTRUCTURE: "Cloud infrastructure",
  SAAS_SOFTWARE: "SaaS software",
  CONTRACTORS: "Contractors",
  RECRUITING: "Recruiting",
  MARKETING: "Marketing",
  TRAVEL: "Travel",
  MEALS: "Meals",
  EQUIPMENT: "Equipment",
  PROFESSIONAL_SERVICES: "Professional services",
  INSURANCE: "Insurance",
  TAXES_FEES: "Taxes & fees",
  CUSTOMER_REVENUE: "Customer revenue",
  FINANCING: "Financing",
  INTERNAL_TRANSFER: "Internal transfers",
  CARD_SETTLEMENT: "Card settlements",
  REFUND: "Refunds",
  NEEDS_REVIEW: "Needs review",
};

export function categoryLabel(category: Category): string {
  return CATEGORY_LABELS[category] ?? titleCase(category);
}

const SECTION_LABELS: Record<PivotSection, string> = {
  REVENUE: "Revenue",
  VARIABLE_SPEND: "Variable spend",
  FIXED_SPEND: "Fixed spend",
  ONE_OFF: "One-off & renewals",
  NET_BURN: "Net burn",
  FINANCING_AND_TRANSFERS: "Financing & transfers",
  CASH_END: "Cash at period end",
};

export function sectionLabel(section: PivotSection): string {
  return SECTION_LABELS[section];
}

function titleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}
