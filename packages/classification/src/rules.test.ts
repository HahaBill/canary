import { CATEGORIES, DEMO, FLOW_TYPES, type Category, type FlowType } from "@canary/shared";
import { describe, expect, it } from "vitest";
import { FLOW_TYPE_CATEGORIES, RULES, matchFlowTypeRule, matchMerchantRule, matchRules } from "./rules.ts";

describe("RULES table", () => {
  const cases: Array<[string, string, Category]> = [
    ["AMAZON WEB SERVICES AWS.AMAZON.CO", "aws", "CLOUD_INFRASTRUCTURE"],
    ["GOOGLE CLOUD PLATFORM", "gcp", "CLOUD_INFRASTRUCTURE"],
    ["MICROSOFT AZURE", "azure", "CLOUD_INFRASTRUCTURE"],
    ["CLOUDFLARE INC", "cloudflare", "CLOUD_INFRASTRUCTURE"],
    ["VERCEL INC", "vercel", "SAAS_SOFTWARE"],
    ["DATADOG", "datadog", "SAAS_SOFTWARE"],
    ["GITHUB INC", "github", "SAAS_SOFTWARE"],
    ["FIGMA INC", "figma", "SAAS_SOFTWARE"],
    ["NOTION LABS", "notion", "SAAS_SOFTWARE"],
    ["SLACK TECHNOLOGIES", "slack", "SAAS_SOFTWARE"],
    ["LINEAR ORBIT INC", "linear", "SAAS_SOFTWARE"],
    ["ZOOM VIDEO COMM", "zoom", "SAAS_SOFTWARE"],
    ["GOOGLE WORKSPACE", "google_workspace", "SAAS_SOFTWARE"],
    ["GUSTO PAYROLL", "gusto_payroll", "PAYROLL"],
    ["RIPPLING PEOPLE CENTER", "rippling", "PAYROLL"],
    ["JUSTWORKS INC", "justworks", "PAYROLL"],
    ["WEWORK RENT", "wework", "RENT"],
    ["MISSION ST PROPERTY RENT", "mission_st_property", "RENT"],
    ["UPWORK CONTRACTOR", "upwork", "CONTRACTORS"],
    ["DEEL INC", "deel", "CONTRACTORS"],
    ["LEVER INC", "lever", "RECRUITING"],
    ["GREENHOUSE SOFTWARE", "greenhouse", "RECRUITING"],
    ["DOORDASH*TEAM LUNCH", "doordash", "MEALS"],
    ["UBER EATS", "uber_eats", "MEALS"],
    ["UBER TRIP", "uber", "TRAVEL"],
    ["LYFT RIDE", "lyft", "TRAVEL"],
    ["DELTA AIR LINES", "delta", "TRAVEL"],
    ["UNITED AIRLINES", "united_airlines", "TRAVEL"],
    ["AIRBNB HQ", "airbnb", "TRAVEL"],
    ["APPLE STORE", "apple", "EQUIPMENT"],
    ["DELL TECHNOLOGIES", "dell", "EQUIPMENT"],
    ["COOLEY LLP LEGAL FEES", "cooley", "PROFESSIONAL_SERVICES"],
    ["BENCH ACCOUNTING", "bench_accounting", "PROFESSIONAL_SERVICES"],
    ["VOUCH INSURANCE", "vouch", "INSURANCE"],
    ["IRS USATAXPYMT", "irs", "TAXES_FEES"],
    ["CA FRANCHISE TAX BOARD", "franchise_tax_board", "TAXES_FEES"],
    ["MONTHLY BANK FEE", "bank_fee", "TAXES_FEES"],
    ["STRIPE PAYOUT", "stripe_payouts", "CUSTOMER_REVENUE"],
    // Ambiguous brands resolve by rule order.
    ["UNITED HEALTHCARE PREMIUM", "united_healthcare", "INSURANCE"],
    ["DELTA DENTAL OF CA", "delta_dental", "INSURANCE"],
  ];

  for (const [raw, normalized, expected] of cases) {
    it(`${raw} → ${expected}`, () => {
      expect(matchMerchantRule(raw, normalized)?.category).toBe(expected);
    });
  }

  it("does NOT match the demo's unknown vendor — Ashby is the OpenAI + Tavily case", () => {
    const { merchant_raw, merchant_normalized, display_name } = DEMO.UNKNOWN_VENDOR;
    expect(matchMerchantRule(merchant_raw, merchant_normalized)).toBeNull();
    expect(matchMerchantRule(display_name, merchant_normalized)).toBeNull();
    expect(matchMerchantRule("", merchant_normalized)).toBeNull();
    expect(matchRules({ merchant_raw, merchant_normalized, flow_type: "OPERATING_OUTFLOW" })).toBeNull();
  });

  it("has unique ids and valid categories", () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of RULES) expect(CATEGORIES).toContain(rule.category);
  });

  it("uses non-global regexes so repeated matching is stateless", () => {
    for (const rule of RULES) expect(rule.pattern.global).toBe(false);
    const twice = [matchMerchantRule("FIGMA INC", "figma")?.id, matchMerchantRule("FIGMA INC", "figma")?.id];
    expect(twice[0]).toBe(twice[1]);
  });
});

describe("flow-type rules", () => {
  const expected: Record<FlowType, Category | null> = {
    OPERATING_OUTFLOW: null,
    OPERATING_INFLOW: "CUSTOMER_REVENUE",
    INTERNAL_TRANSFER: "INTERNAL_TRANSFER",
    CARD_SETTLEMENT: "CARD_SETTLEMENT",
    FINANCING: "FINANCING",
    REFUND: "REFUND",
  };

  it("covers every flow type", () => {
    for (const flow of FLOW_TYPES) {
      expect(matchFlowTypeRule(flow)).toBe(expected[flow]);
      expect(FLOW_TYPE_CATEGORIES[flow]).toBe(expected[flow]);
    }
  });

  it("wins over the merchant table (a refund is a refund, whatever the vendor)", () => {
    const matched = matchRules({ merchant_raw: "UPWORK REFUND", merchant_normalized: "upwork", flow_type: "REFUND" });
    expect(matched).toEqual({ via: "FLOW_TYPE", category: "REFUND", flowType: "REFUND" });
  });
});
