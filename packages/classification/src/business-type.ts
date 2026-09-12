/**
 * Tavily's prose ("Ashby is an all-in-one recruiting platform …") → `Category`.
 *
 * This is the second, independent signal in the corroboration check
 * (contract §13): the mapping must be a deterministic keyword table, never a
 * model call, otherwise "two signals agreed" would just be one model agreeing
 * with itself.
 *
 * Ordered most specific first: a recruiting *platform* is RECRUITING, not
 * SAAS_SOFTWARE.
 */
import type { Category } from "@canary/shared";

export interface BusinessTypeRule {
  category: Category;
  pattern: RegExp;
}

export const BUSINESS_TYPE_RULES: readonly BusinessTypeRule[] = [
  { category: "RECRUITING", pattern: /\brecruit\w*\b|\bhiring\b|\bapplicant tracking\b|\bats\b|\btalent\b|\bjob board\b|\bcandidate\w*\b|\binterview\w*\b|\bsourcing\b/ },
  { category: "PAYROLL", pattern: /\bpayroll\b|\bpeo\b|\bemployer of record\b|\bhris\b|\bbenefits administration\b|\bhuman resources\b/ },
  { category: "CONTRACTORS", pattern: /\bfreelanc\w*\b|\bcontractor\w*\b|\bstaffing\b|\boutsourc\w*\b|\bgig work\w*\b/ },
  { category: "CLOUD_INFRASTRUCTURE", pattern: /\bcloud comput\w*\b|\bcloud (provider|platform|services?|hosting|storage)\b|\bweb hosting\b|\bhosting\b|\binfrastructure\b|\biaas\b|\bdata ?cent(er|re)\b|\bcdn\b|\bcontent delivery\b|\bserverless\b|\bkubernetes\b|\bcompute\b/ },
  { category: "MARKETING", pattern: /\bmarketing\b|\badvertis\w*\b|\bseo\b|\bcrm\b|\bemail campaign\w*\b|\bsocial media manage\w*\b|\bdemand gen\w*\b/ },
  { category: "TRAVEL", pattern: /\bairline\b|\bair travel\b|\bflights?\b|\bhotels?\b|\blodging\b|\btravel (booking|management)\b|\bride.?(hailing|sharing)\b|\bcar rental\b|\bvacation rental\b|\bshort.?term rental\b/ },
  { category: "MEALS", pattern: /\brestaurant\w*\b|\bfood deliver\w*\b|\bmeal\w*\b|\bcatering\b|\bcoffee\b|\bgrocer\w*\b|\bdining\b/ },
  { category: "EQUIPMENT", pattern: /\bhardware\b|\blaptops?\b|\bcomputer manufactur\w*\b|\belectronics\b|\bdevice manufactur\w*\b|\boffice furniture\b|\bperipherals?\b/ },
  { category: "PROFESSIONAL_SERVICES", pattern: /\blaw firm\b|\blegal services\b|\battorney\w*\b|\baccounting\b|\bbookkeep\w*\b|\btax preparation\b|\bauditing\b|\bconsult\w*\b|\badvisory\b|\bcap table\b|\bequity management\b/ },
  { category: "INSURANCE", pattern: /\binsur\w*\b|\bunderwrit\w*\b|\bhealth plan\b|\bdental plan\b|\bemployee benefits\b/ },
  { category: "TAXES_FEES", pattern: /\btax authority\b|\brevenue service\b|\bgovernment agency\b|\bbanking fees?\b|\bpayment processing fees?\b/ },
  { category: "SAAS_SOFTWARE", pattern: /\bsoftware\b|\bsaas\b|\bplatform\b|\bapplications?\b|\bapp\b|\btool\w*\b|\bproductivity\b|\bcollaboration\b|\banalytics\b|\bdeveloper tools?\b|\bapi\b|\bdatabase\b|\bmonitoring\b|\bobservability\b|\bdesign tool\b|\btechnology company\b/ },
];

/**
 * `null` when nothing matches — the caller must then treat the research signal
 * as absent rather than guessing.
 */
export function mapBusinessTypeToCategory(businessType: string): Category | null {
  const text = businessType.toLowerCase();
  if (text.trim() === "") return null;
  for (const rule of BUSINESS_TYPE_RULES) {
    if (rule.pattern.test(text)) return rule.category;
  }
  return null;
}
