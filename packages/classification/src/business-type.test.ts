import { CATEGORIES, DEMO } from "@canary/shared";
import { describe, expect, it } from "vitest";
import { BUSINESS_TYPE_RULES, mapBusinessTypeToCategory } from "./business-type.ts";

describe("mapBusinessTypeToCategory", () => {
  const cases: Array<[string, string | null]> = [
    // Specificity: a recruiting *platform* is RECRUITING, not SAAS_SOFTWARE.
    ["Ashby is an all-in-one recruiting platform for scaling companies.", "RECRUITING"],
    ["applicant tracking system and interview scheduling software", "RECRUITING"],
    ["talent acquisition suite", "RECRUITING"],
    ["payroll and benefits administration provider", "PAYROLL"],
    ["employer of record for global teams", "PAYROLL"],
    ["marketplace for freelance software developers", "CONTRACTORS"],
    ["cloud computing and hosting provider", "CLOUD_INFRASTRUCTURE"],
    ["content delivery network and edge compute platform", "CLOUD_INFRASTRUCTURE"],
    ["email marketing and CRM platform", "MARKETING"],
    ["airline operating domestic flights", "TRAVEL"],
    ["food delivery service for restaurants", "MEALS"],
    ["computer manufacturer selling laptops", "EQUIPMENT"],
    ["law firm serving startups", "PROFESSIONAL_SERVICES"],
    ["business insurance for technology companies", "INSURANCE"],
    ["collaborative design software", "SAAS_SOFTWARE"],
    // Monitoring tools land in SAAS_SOFTWARE, matching the generator's ground truth for datadog.
    ["observability and monitoring platform", "SAAS_SOFTWARE"],
    ["a company", null],
    ["", null],
    ["   ", null],
  ];

  for (const [text, expected] of cases) {
    it(`${expected ?? "null"} ← ${text.trim() || "(empty)"}`, () => {
      expect(mapBusinessTypeToCategory(text)).toBe(expected);
    });
  }

  it("is case-insensitive and deterministic", () => {
    expect(mapBusinessTypeToCategory("RECRUITING SOFTWARE")).toBe("RECRUITING");
    expect(mapBusinessTypeToCategory("Recruiting Software")).toBe("RECRUITING");
    expect(mapBusinessTypeToCategory("recruiting software")).toBe("RECRUITING");
  });

  it("maps the demo vendor's real description to its expected category", () => {
    expect(mapBusinessTypeToCategory("Ashby provides recruiting and applicant tracking software.")).toBe(
      DEMO.UNKNOWN_VENDOR.expected_category,
    );
  });

  it("only yields valid categories with stateless regexes", () => {
    for (const rule of BUSINESS_TYPE_RULES) {
      expect(CATEGORIES).toContain(rule.category);
      expect(rule.pattern.global).toBe(false);
    }
  });
});
