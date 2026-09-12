import { SAMPLE_TRANSACTIONS } from "@canary/shared/fixtures";
import { describe, expect, it } from "vitest";
import { normalizeMerchant } from "./normalize.ts";

describe("normalizeMerchant", () => {
  const cases: Array<[string, string]> = [
    ["ASHBYHQ INC SAN FRANCISCO CA", "ashby"],
    ["AMAZON WEB SERVICES AWS.AMAZON.CO", "aws"],
    ["GUSTO PAYROLL", "gusto_payroll"],
    ["STRIPE PAYOUT", "stripe_payouts"],
    ["FIGMA INC", "figma"],
    ["NOTION LABS INC NEW YORK NY", "notion"],
    ["DOORDASH*TEAM LUNCH", "doordash"],
    ["SQ *BLUE BOTTLE COFFEE", "blue_bottle_coffee"],
    ["UBER *EATS 8UY2X", "uber_eats"],
    ["APPLE.COM/BILL CUPERTINO CA", "apple"],
    ["WEWORK RENT", "wework"],
    ["TRANSFER TO SAVINGS", "internal_transfer"],
    ["CARD PAYMENT", "card_settlement"],
    ["GOOGLE CLOUD PLATFORM", "gcp"],
  ];

  for (const [raw, expected] of cases) {
    it(`${raw} → ${expected}`, () => {
      expect(normalizeMerchant(raw)).toBe(expected);
    });
  }

  it("is deterministic and never returns an empty key", () => {
    for (const [raw] of cases) {
      expect(normalizeMerchant(raw)).toBe(normalizeMerchant(raw));
      expect(normalizeMerchant(raw).length).toBeGreaterThan(0);
    }
    expect(normalizeMerchant("")).toBe("unknown_merchant");
    expect(normalizeMerchant("  ###  ")).toBe("unknown_merchant");
  });

  it("is idempotent on the generator's entity keys", () => {
    for (const key of new Set(SAMPLE_TRANSACTIONS.map((tx) => tx.merchant_normalized))) {
      expect(normalizeMerchant(key)).toBe(key);
    }
  });

  it("keeps the demo's unknown vendor distinct from its city and suffix noise", () => {
    expect(normalizeMerchant("ASHBYHQ INC")).toBe("ashby");
    expect(normalizeMerchant("ASHBY")).toBe("ashby");
  });
});
