import { describe, expect, it } from "vitest";
import { fakeLedgerProposer } from "./ledger-filter-fake.ts";
import {
  applyLedgerFilter,
  buildLedgerCatalog,
  describeLedgerFilter,
  extractLedgerQueryAmounts,
  formatLedgerCatalog,
  interpretLedgerFilter,
  isEmptyLedgerFilter,
  parseQueryCents,
  sanitizeLedgerFilter,
  type LedgerFilterProposal,
} from "./ledger-filter.ts";
import { formatUsdWhole } from "./money.ts";
import type { LedgerPivot, PivotCell, PivotRow } from "./views.ts";

function cell(amount: number, flags: PivotCell["flags"] = []): PivotCell {
  return { amount_cents: amount, transaction_count: amount === 0 ? 0 : 1, flags };
}

function row(partial: Omit<PivotRow, "cells" | "total_cents" | "annualized_cents">, cells: PivotCell[]): PivotRow {
  return { ...partial, cells, total_cents: cells.reduce((s, c) => s + c.amount_cents, 0), annualized_cents: 1_000_000 };
}

const pivot: LedgerPivot = {
  granularity: "month",
  periods: [
    { key: "2026-06", start: "2026-06-01", end: "2026-06-30", partial: false, post_change: false },
    { key: "2026-07", start: "2026-07-01", end: "2026-07-31", partial: false, post_change: true },
  ],
  rows: [
    row({ id: "section:VARIABLE_SPEND", level: 0, section: "VARIABLE_SPEND", label: "Variable spend" }, [cell(600_000), cell(900_000)]),
    row(
      {
        id: "category:CLOUD_INFRASTRUCTURE",
        level: 1,
        section: "VARIABLE_SPEND",
        parent_id: "section:VARIABLE_SPEND",
        category: "CLOUD_INFRASTRUCTURE",
        label: "Cloud infrastructure",
      },
      [cell(500_000), cell(800_000)],
    ),
    row(
      {
        id: "vendor:aws",
        level: 2,
        section: "VARIABLE_SPEND",
        parent_id: "category:CLOUD_INFRASTRUCTURE",
        entity: "aws",
        category: "CLOUD_INFRASTRUCTURE",
        label: "AWS",
        incident_id: "inc_1",
      },
      [cell(500_000), cell(800_000, ["needs_review"])],
    ),
    row(
      {
        id: "vendor:figma",
        level: 2,
        section: "VARIABLE_SPEND",
        parent_id: "category:CLOUD_INFRASTRUCTURE",
        entity: "figma",
        category: "CLOUD_INFRASTRUCTURE",
        label: "Figma",
      },
      [cell(12_000, ["one_off"]), cell(0)],
    ),
    row(
      {
        id: "category:MEALS",
        level: 1,
        section: "VARIABLE_SPEND",
        parent_id: "section:VARIABLE_SPEND",
        category: "MEALS",
        label: "Meals",
      },
      [cell(20_000), cell(24_000)],
    ),
    row(
      {
        id: "vendor:doordash",
        level: 2,
        section: "VARIABLE_SPEND",
        parent_id: "category:MEALS",
        entity: "doordash",
        category: "MEALS",
        label: "DoorDash",
      },
      [cell(20_000), cell(24_000)],
    ),
    row(
      {
        id: "vendor:uber_eats",
        level: 2,
        section: "VARIABLE_SPEND",
        parent_id: "category:MEALS",
        entity: "uber_eats",
        category: "MEALS",
        label: "Uber Eats",
      },
      [cell(8_000), cell(9_000)],
    ),
  ],
  history_start: "2026-04-27",
  history_end: "2026-09-13",
  weeks_of_history: 20,
  regime_start: "2026-06-29",
};

describe("buildLedgerCatalog", () => {
  it("lists distinct merchants and categories from the sheet, not every cell", () => {
    const catalog = buildLedgerCatalog(pivot);
    expect(catalog.merchants.map((m) => m.entity)).toEqual(["aws", "doordash", "figma", "uber_eats"]);
    expect(catalog.categories.map((c) => c.key)).toEqual(["CLOUD_INFRASTRUCTURE", "MEALS"]);
    expect(catalog.merchants.find((m) => m.entity === "doordash")).toMatchObject({
      label: "DoorDash",
      category: "MEALS",
      category_label: "Meals",
    });
    expect(formatLedgerCatalog(catalog)).toContain("doordash · DoorDash · MEALS (Meals)");
    expect(formatLedgerCatalog(catalog)).not.toMatch(/500000|800000/);
  });
});

describe("interpretLedgerFilter", () => {
  it("maps cloud costs through the proposer to the cloud category on this sheet", async () => {
    const result = await interpretLedgerFilter("cloud costs", pivot, fakeLedgerProposer);
    expect(result.source).toBe("model");
    expect(result.unmatched).toBe(false);
    expect(result.spec.categories).toEqual(["CLOUD_INFRASTRUCTURE"]);
    const filtered = applyLedgerFilter(pivot, result.spec);
    expect(filtered.rows.some((r) => r.id === "vendor:aws")).toBe(true);
    expect(filtered.rows.some((r) => r.id === "vendor:doordash")).toBe(false);
  });

  it("maps display-all delivery services to meal vendors that exist on the sheet", async () => {
    const result = await interpretLedgerFilter("display all delivery services", pivot, fakeLedgerProposer);
    expect(result.spec.categories).toEqual(["MEALS"]);
    const filtered = applyLedgerFilter(pivot, result.spec);
    expect(filtered.rows.map((r) => r.id)).toEqual([
      "section:VARIABLE_SPEND",
      "category:MEALS",
      "vendor:doordash",
      "vendor:uber_eats",
    ]);
    expect(filtered.rows.some((r) => r.id === "vendor:aws")).toBe(false);
  });

  it("resolves a vendor name from the catalog", async () => {
    const result = await interpretLedgerFilter("DoorDash", pivot, fakeLedgerProposer);
    expect(result.spec.entities).toEqual(["doordash"]);
    const filtered = applyLedgerFilter(pivot, result.spec);
    expect(filtered.rows.some((r) => r.id === "vendor:doordash")).toBe(true);
    expect(filtered.rows.some((r) => r.id === "vendor:aws")).toBe(false);
  });

  it("does not show the full sheet for an unmatched phrase", async () => {
    const result = await interpretLedgerFilter("what's the weather", pivot, fakeLedgerProposer);
    expect(result.unmatched).toBe(true);
    expect(result.spec.unmatched).toBe(true);
    expect(isEmptyLedgerFilter(result.spec)).toBe(false);
    expect(applyLedgerFilter(pivot, result.spec).rows).toEqual([]);
    expect(applyLedgerFilter(pivot, result.spec).rows.length).not.toBe(pivot.rows.length);
  });

  it("does not invent a category that is not on the sheet", async () => {
    const proposer = async (): Promise<LedgerFilterProposal> => ({ categories: ["TRAVEL"] });
    const result = await interpretLedgerFilter("travel", pivot, proposer);
    expect(result.unmatched).toBe(true);
    expect(result.spec.categories).toBeUndefined();
    expect(applyLedgerFilter(pivot, result.spec).rows).toEqual([]);
  });

  it("ignores amounts the model invents and keeps the founder's figure", async () => {
    const proposer = async (): Promise<LedgerFilterProposal> =>
      ({ entities: ["aws"], min_abs_cents: 99_999 }) as LedgerFilterProposal;
    const result = await interpretLedgerFilter("AWS over $5k", pivot, proposer);
    expect(result.spec.entities).toEqual(["aws"]);
    expect(result.spec.min_abs_cents).toBe(500_000);
  });

  it("treats a missing proposer as unmatched, not a full-sheet no-op", async () => {
    const result = await interpretLedgerFilter("cloud costs", pivot, null);
    expect(result.source).toBe("unconfigured");
    expect(result.unmatched).toBe(true);
    expect(applyLedgerFilter(pivot, result.spec).rows).toEqual([]);
  });

  it("leaves a blank query unfiltered", async () => {
    const result = await interpretLedgerFilter("  ", pivot, fakeLedgerProposer);
    expect(result.source).toBe("empty");
    expect(result.unmatched).toBe(false);
    expect(applyLedgerFilter(pivot, result.spec).rows).toHaveLength(pivot.rows.length);
  });

  it("does not map delivery to meals when that category is absent", async () => {
    const noMeals: LedgerPivot = {
      ...pivot,
      rows: pivot.rows.filter((r) => r.category !== "MEALS" && r.entity !== "doordash" && r.entity !== "uber_eats"),
    };
    const result = await interpretLedgerFilter("display all delivery services", noMeals, fakeLedgerProposer);
    expect(result.unmatched).toBe(true);
    expect(result.spec.categories).toBeUndefined();
  });
});

describe("applyLedgerFilter", () => {
  it("keeps AWS and its ancestors, not Figma", () => {
    const filtered = applyLedgerFilter(pivot, { entities: ["aws"] });
    expect(filtered.rows.map((r) => r.id)).toEqual([
      "section:VARIABLE_SPEND",
      "category:CLOUD_INFRASTRUCTURE",
      "vendor:aws",
    ]);
    expect(filtered.periods).toHaveLength(2);
  });

  it("drops pre-change columns when asked for the new regime", () => {
    const filtered = applyLedgerFilter(pivot, { post_change_only: true });
    expect(filtered.periods.map((p) => p.key)).toEqual(["2026-07"]);
    expect(filtered.rows[0]!.cells).toHaveLength(1);
    expect(filtered.rows[0]!.annualized_cents).toBeNull();
  });

  it("keeps only rows whose remaining cell is over the typed threshold", () => {
    const spec = { min_abs_cents: 700_000 as const };
    expect(extractLedgerQueryAmounts(`over ${formatUsdWhole(700_000)}`).min_abs_cents).toBe(700_000);
    const filtered = applyLedgerFilter(pivot, spec);
    expect(filtered.rows.some((r) => r.id === "vendor:aws")).toBe(true);
    expect(filtered.rows.some((r) => r.id === "vendor:figma")).toBe(false);
  });
});

describe("sanitize / describe", () => {
  it("drops invented entity keys", () => {
    expect(sanitizeLedgerFilter({ entities: ["aws", "snowflake"] }, pivot).entities).toEqual(["aws"]);
  });

  it("marks a proposal unmatched when every named key was invented", () => {
    const spec = sanitizeLedgerFilter({ categories: ["TRAVEL"] }, pivot);
    expect(spec.unmatched).toBe(true);
    expect(spec.categories).toBeUndefined();
  });

  it("names the chips from the pivot and the typed amount", () => {
    const spec = { entities: ["aws"], post_change_only: true, min_abs_cents: 100_000 };
    expect(describeLedgerFilter(spec, pivot)).toEqual(["AWS", "after the change", `over ${formatUsdWhole(100_000)}`]);
  });
});

describe("parseQueryCents", () => {
  it("reads the founder's own figures", () => {
    expect(parseQueryCents("$10k")).toBe(1_000_000);
    expect(parseQueryCents("1.5m")).toBe(150_000_000);
    expect(parseQueryCents("nope")).toBeNull();
  });
});
