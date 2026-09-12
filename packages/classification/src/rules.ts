/**
 * Deterministic classification. Rules run before any model call (PRD §4:
 * "rules where rules work"), so the demo's money math never depends on a
 * network call for the merchants we already know.
 *
 * Two layers:
 *   1. flow type  — INTERNAL_TRANSFER / CARD_SETTLEMENT / FINANCING / REFUND /
 *      OPERATING_INFLOW are structural facts from the bank, not vendor guesses.
 *   2. merchant regex table — ordered, most specific first.
 *
 * `DEMO.UNKNOWN_VENDOR` (Ashby) must NOT match any rule: it is the vendor the
 * OpenAI + Tavily path has to identify on stage. `rules.test.ts` enforces it.
 */
import type { Category, FlowType, Transaction } from "@canary/shared";

export interface MerchantRule {
  /** Stable id, quoted in the supporting signal. */
  id: string;
  category: Category;
  /** Tested against the lowercased `merchant_raw` and `merchant_normalized`. */
  pattern: RegExp;
}

/**
 * Flow types that are categories in their own right. `OPERATING_OUTFLOW` is
 * `null` because it needs a vendor decision.
 *
 * The engine may later re-point a REFUND at the refunded vendor's category so
 * it nets against that entity (WORKSTREAMS B step 2); classification just
 * records what the bank row is.
 */
export const FLOW_TYPE_CATEGORIES: Readonly<Record<FlowType, Category | null>> = {
  OPERATING_OUTFLOW: null,
  OPERATING_INFLOW: "CUSTOMER_REVENUE",
  INTERNAL_TRANSFER: "INTERNAL_TRANSFER",
  CARD_SETTLEMENT: "CARD_SETTLEMENT",
  FINANCING: "FINANCING",
  REFUND: "REFUND",
};

/**
 * Ordered — the first match wins. Specific vendors precede keyword rules, and
 * ambiguous brands are disambiguated by ordering (`UNITED HEALTHCARE` →
 * INSURANCE before `UNITED` → TRAVEL, `UBER EATS` → MEALS before `UBER` →
 * TRAVEL).
 */
export const RULES: readonly MerchantRule[] = [
  // --- Cloud infrastructure -------------------------------------------------
  { id: "aws", category: "CLOUD_INFRASTRUCTURE", pattern: /\b(aws|amazon web services)\b/ },
  { id: "gcp", category: "CLOUD_INFRASTRUCTURE", pattern: /\bgcp\b|\bgoogle cloud( platform)?\b/ },
  { id: "azure", category: "CLOUD_INFRASTRUCTURE", pattern: /\b(microsoft )?azure\b/ },
  { id: "cloudflare", category: "CLOUD_INFRASTRUCTURE", pattern: /\bcloudflare\b/ },
  { id: "digitalocean", category: "CLOUD_INFRASTRUCTURE", pattern: /\bdigital ?ocean\b/ },
  { id: "heroku", category: "CLOUD_INFRASTRUCTURE", pattern: /\bheroku\b/ },
  { id: "linode", category: "CLOUD_INFRASTRUCTURE", pattern: /\b(linode|vultr|hetzner)\b/ },
  { id: "fastly", category: "CLOUD_INFRASTRUCTURE", pattern: /\bfastly\b/ },

  // --- SaaS / software ------------------------------------------------------
  { id: "google_workspace", category: "SAAS_SOFTWARE", pattern: /\bgoogle workspace\b|\bg ?suite\b/ },
  { id: "microsoft_365", category: "SAAS_SOFTWARE", pattern: /\bmicrosoft 365\b|\boffice 365\b/ },
  { id: "datadog", category: "SAAS_SOFTWARE", pattern: /\bdatadog\b/ },
  { id: "github", category: "SAAS_SOFTWARE", pattern: /\bgithub\b/ },
  { id: "figma", category: "SAAS_SOFTWARE", pattern: /\bfigma\b/ },
  { id: "notion", category: "SAAS_SOFTWARE", pattern: /\bnotion\b/ },
  { id: "slack", category: "SAAS_SOFTWARE", pattern: /\bslack\b/ },
  { id: "linear", category: "SAAS_SOFTWARE", pattern: /\blinear\b/ },
  { id: "zoom", category: "SAAS_SOFTWARE", pattern: /\bzoom( ?video)?\b/ },
  { id: "vercel", category: "SAAS_SOFTWARE", pattern: /\bvercel\b/ },
  { id: "netlify", category: "SAAS_SOFTWARE", pattern: /\bnetlify\b/ },
  { id: "sentry", category: "SAAS_SOFTWARE", pattern: /\bsentry\b/ },
  { id: "atlassian", category: "SAAS_SOFTWARE", pattern: /\b(atlassian|jira|confluence)\b/ },
  { id: "productivity_saas", category: "SAAS_SOFTWARE", pattern: /\b(asana|airtable|dropbox|loom|calendly|retool|postman|pagerduty|launchdarkly|1password|twilio|sendgrid|segment|mixpanel|amplitude|openai|anthropic)\b/ },

  // --- Payroll --------------------------------------------------------------
  { id: "payroll_providers", category: "PAYROLL", pattern: /\b(gusto|rippling|justworks|adp|paychex|trinet|zenefits)\b/ },
  { id: "payroll_keyword", category: "PAYROLL", pattern: /\bpayroll\b|\bwages\b/ },

  // --- Recruiting (deliberately NOT ashby) ----------------------------------
  { id: "recruiting_vendors", category: "RECRUITING", pattern: /\b(lever|greenhouse|wellfound|triplebyte|hired|indeed)\b/ },
  { id: "recruiting_keyword", category: "RECRUITING", pattern: /\brecruit\w*\b|\bapplicant tracking\b|\bjob board\b/ },

  // --- Contractors ----------------------------------------------------------
  { id: "contractor_vendors", category: "CONTRACTORS", pattern: /\b(upwork|fiverr|toptal|deel|andela|braintrust)\b/ },
  { id: "contractor_keyword", category: "CONTRACTORS", pattern: /\bcontractor\b|\bfreelance\w*\b|\b1099\b/ },

  // --- Insurance (before TRAVEL so `DELTA DENTAL` / `UNITED HEALTH` win) ----
  { id: "insurance_keyword", category: "INSURANCE", pattern: /\binsur\w*\b|\bworkers comp\b|\bd&o\b|\be&o\b/ },
  { id: "insurance_vendors", category: "INSURANCE", pattern: /\b(vouch|hiscox|chubb|the hartford|delta dental|blue cross|blue shield|unitedhealthcare|united health\w*|kaiser|guardian life|state farm)\b/ },

  // --- Meals (before TRAVEL so `UBER EATS` wins) ---------------------------
  { id: "food_delivery", category: "MEALS", pattern: /\b(doordash|uber ?eats|grubhub|seamless|caviar|postmates|instacart)\b/ },
  { id: "meals_vendors", category: "MEALS", pattern: /\b(sweetgreen|chipotle|starbucks|blue bottle|philz|dunkin|panera)\b/ },
  { id: "meals_keyword", category: "MEALS", pattern: /\bcaterin\w*\b|\brestaurant\b|\bcoffee\b|\bteam lunch\b|\bmeals?\b/ },

  // --- Travel ---------------------------------------------------------------
  { id: "rideshare", category: "TRAVEL", pattern: /\b(uber|lyft)\b/ },
  { id: "airlines", category: "TRAVEL", pattern: /\b(delta|southwest|jetblue|alaska air\w*|american airlines|united airlines?|united\.com|frontier|spirit airlines)\b/ },
  { id: "lodging", category: "TRAVEL", pattern: /\b(airbnb|marriott|hilton|hyatt|westin|sheraton|vrbo)\b/ },
  { id: "travel_keyword", category: "TRAVEL", pattern: /\bairlines?\b|\bhotel\b|\bflight\b|\brental car\b|\bcar rental\b|\b(hertz|avis|enterprise rent|amtrak|expedia)\b/ },

  // --- Rent -----------------------------------------------------------------
  { id: "coworking", category: "RENT", pattern: /\b(wework|regus|industrious|knotel|spaces)\b/ },
  { id: "rent_keyword", category: "RENT", pattern: /\brent\b|\blease\b|\boffice space\b|\bproperty manag\w*\b|\blandlord\b/ },

  // --- Equipment ------------------------------------------------------------
  { id: "hardware_vendors", category: "EQUIPMENT", pattern: /\b(apple|dell|lenovo|logitech|best buy|newegg|cdw|b&h|herman miller|steelcase)\b/ },
  { id: "equipment_keyword", category: "EQUIPMENT", pattern: /\blaptops?\b|\bmonitors?\b|\bworkstation\b|\bfurniture\b|\bstanding desk\b/ },

  // --- Professional services ------------------------------------------------
  { id: "professional_vendors", category: "PROFESSIONAL_SERVICES", pattern: /\b(cooley|wilson sonsini|gunderson|orrick|fenwick|carta|clerky|pilot\.com|bench accounting)\b/ },
  { id: "professional_keyword", category: "PROFESSIONAL_SERVICES", pattern: /\b(law|llp|attorney|legal|counsel|paralegal)\b|\blaw (firm|group|office)\b|\baccountin\w*\b|\bbookkeep\w*\b|\bcpa\b|\baudit\w*\b|\bconsult\w*\b|\bnotary\b/ },

  // --- Marketing ------------------------------------------------------------
  { id: "marketing_vendors", category: "MARKETING", pattern: /\b(hubspot|mailchimp|marketo|klaviyo|ahrefs|semrush|webflow)\b/ },
  { id: "marketing_keyword", category: "MARKETING", pattern: /\b(google|facebook|meta|linkedin|twitter|x|tiktok|reddit) ads\b|\badwords\b|\badvertisin\w*\b|\bmarketin\w*\b|\bsponsorship\b/ },

  // --- Taxes & fees ---------------------------------------------------------
  { id: "tax_authorities", category: "TAXES_FEES", pattern: /\birs\b|\bfranchise tax\b|\bftb\b|\bdep(artmen)?t of revenue\b|\bsecretary of state\b|\bdelaware division of corporations\b/ },
  { id: "fees_keyword", category: "TAXES_FEES", pattern: /\btaxe?s?\b|\bbank fee\b|\bwire fee\b|\bservice charge\b|\boverdraft\b|\bmonthly maintenance\b|\bnsf fee\b/ },

  // --- Customer revenue -----------------------------------------------------
  { id: "payment_processor_payout", category: "CUSTOMER_REVENUE", pattern: /\b(stripe|braintree|adyen|paddle|square)\b[\s*_-]*payouts?\b|\bpayouts?\b[\s*_-]*\b(stripe|braintree|adyen|paddle)\b/ },
];

/** Lowercased descriptor + entity key, with `_` → ` ` so `\b` anchors work on both. */
export function ruleHaystack(merchantRaw: string, merchantNormalized: string): string {
  const raw = merchantRaw.toLowerCase();
  const key = merchantNormalized.toLowerCase();
  return `${raw} ${key.replace(/_/g, " ")}`;
}

/** First matching merchant rule, or `null`. */
export function matchMerchantRule(merchantRaw: string, merchantNormalized: string): MerchantRule | null {
  const haystack = ruleHaystack(merchantRaw, merchantNormalized);
  for (const rule of RULES) {
    if (rule.pattern.test(haystack)) return rule;
  }
  return null;
}

/** Category implied by the bank row's flow type, or `null` for operating outflows. */
export function matchFlowTypeRule(flowType: FlowType): Category | null {
  return FLOW_TYPE_CATEGORIES[flowType];
}

/** Convenience for callers holding a whole transaction. */
export function matchRules(tx: Pick<Transaction, "merchant_raw" | "merchant_normalized" | "flow_type">):
  | { via: "FLOW_TYPE"; category: Category; flowType: FlowType }
  | { via: "RULE"; category: Category; rule: MerchantRule }
  | null {
  const flowCategory = matchFlowTypeRule(tx.flow_type);
  if (flowCategory !== null) return { via: "FLOW_TYPE", category: flowCategory, flowType: tx.flow_type };
  const rule = matchMerchantRule(tx.merchant_raw, tx.merchant_normalized);
  return rule ? { via: "RULE", category: rule.category, rule } : null;
}
