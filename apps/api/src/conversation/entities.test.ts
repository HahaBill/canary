/** Natural vendor names → ledger keys, and the "which vendor?" path when they don't resolve. */
import type { Category, Classification, DerivedDemoObject } from "@canary/shared";
import { buildMockDerived } from "@canary/shared/fixtures";
import { describe, expect, it } from "vitest";
import { knownEntities, resolveEntity } from "./entities.ts";

const derived = buildMockDerived();

/** The mock fixture ships no classifications; category-phrase resolution needs them. */
function withClassifications(base: DerivedDemoObject, byEntity: Record<string, Category>): DerivedDemoObject {
  const classifications: Record<string, Classification> = {};
  Object.entries(byEntity).forEach(([merchant_normalized, category], i) => {
    classifications[`txn_${i}`] = {
      transaction_id: `txn_${i}`,
      merchant_normalized,
      category,
      method: "RULE",
      reason: "test fixture",
      supporting_signals: [],
      confidence_level: "HIGH",
    };
  });
  return { ...base, classifications };
}

describe("knownEntities", () => {
  it("is every vendor with spend in the burn window, plus the incident contributors", () => {
    expect(knownEntities(derived)).toEqual(expect.arrayContaining(["aws", "datadog", "ashby", "upwork"]));
  });
});

describe("resolveEntity", () => {
  it("resolves the ledger key itself, any casing", () => {
    expect(resolveEntity(derived, "aws")).toMatchObject({ known: true, entity: "aws", display_name: "AWS" });
    expect(resolveEntity(derived, "AWS")).toMatchObject({ known: true, entity: "aws" });
    expect(resolveEntity(derived, " DataDog ")).toMatchObject({ known: true, entity: "datadog", display_name: "Datadog" });
  });

  it("resolves the names a founder actually types", () => {
    for (const name of ["Amazon", "amazon web services", "Amazon Web Services"]) {
      expect(resolveEntity(derived, name)).toMatchObject({ known: true, entity: "aws" });
    }
  });

  it("picks the vendor out of a sentence", () => {
    expect(resolveEntity(derived, "what about our datadog spend")).toMatchObject({ known: true, entity: "datadog" });
    expect(resolveEntity(derived, "how much is the Upwork bill")).toMatchObject({ known: true, entity: "upwork" });
  });

  it("resolves a category phrase when exactly one vendor matches", () => {
    const classified = withClassifications(derived, { ashby: "RECRUITING", aws: "CLOUD_INFRASTRUCTURE" });
    expect(resolveEntity(classified, "the recruiting tool")).toMatchObject({ known: true, entity: "ashby" });
    expect(resolveEntity(classified, "our cloud bill")).toMatchObject({ known: true, entity: "aws" });
  });

  it("returns candidates rather than guessing when a category phrase is ambiguous", () => {
    const classified = withClassifications(derived, { ashby: "SAAS_SOFTWARE", datadog: "SAAS_SOFTWARE" });
    const resolved = resolveEntity(classified, "that software vendor");
    expect(resolved.known).toBe(false);
    expect(resolved).toMatchObject({ candidates: expect.arrayContaining(["Ashby", "Datadog"]) });
  });

  it("returns known:false with candidates for a vendor Canary has never seen", () => {
    const resolved = resolveEntity(derived, "Snowflake");
    expect(resolved.known).toBe(false);
    expect(resolved).toMatchObject({ candidates: expect.arrayContaining(["AWS", "Datadog"]) });
  });
});
