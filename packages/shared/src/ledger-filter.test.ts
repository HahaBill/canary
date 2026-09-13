import { describe, expect, it } from "vitest";
import {
  applyLedgerFilter,
  describeLedgerFilter,
  isEmptyLedgerFilter,
  parseLedgerQuery,
  parseQueryCents,
  sanitizeLedgerFilter,
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
        label: "Figma",
      },
      [cell(12_000, ["one_off"]), cell(0)],
    ),
  ],
  history_start: "2026-04-27",
  history_end: "2026-09-13",
  weeks_of_history: 20,
  regime_start: "2026-06-29",
};

describe("parseLedgerQuery", () => {
  it("resolves a vendor alias and a change-point clause", () => {
    const spec = parseLedgerQuery("Amazon after the change", pivot);
    expect(spec.entities).toEqual(["aws"]);
    expect(spec.post_change_only).toBe(true);
  });

  it("reads a dollar threshold from the query, never invents one", () => {
    const spec = parseLedgerQuery("vendors over $5k in July", pivot);
    expect(spec.min_abs_cents).toBe(500_000);
    expect(spec.period_keys).toEqual(["2026-07"]);
  });

  it("maps Needs Review and cloud category words", () => {
    const spec = parseLedgerQuery("cloud needs review", pivot);
    expect(spec.categories).toEqual(["CLOUD_INFRASTRUCTURE"]);
    expect(spec.flags).toEqual(["needs_review"]);
  });

  it("returns an empty spec for off-topic chatter", () => {
    expect(isEmptyLedgerFilter(parseLedgerQuery("what's the weather", pivot))).toBe(true);
  });
});

describe("applyLedgerFilter", () => {
  it("keeps AWS and its ancestors, not Figma", () => {
    const filtered = applyLedgerFilter(pivot, parseLedgerQuery("AWS", pivot));
    expect(filtered.rows.map((r) => r.id)).toEqual([
      "section:VARIABLE_SPEND",
      "category:CLOUD_INFRASTRUCTURE",
      "vendor:aws",
    ]);
    expect(filtered.periods).toHaveLength(2);
  });

  it("drops pre-change columns when asked for the new regime", () => {
    const filtered = applyLedgerFilter(pivot, parseLedgerQuery("after the change", pivot));
    expect(filtered.periods.map((p) => p.key)).toEqual(["2026-07"]);
    expect(filtered.rows[0]!.cells).toHaveLength(1);
    expect(filtered.rows[0]!.annualized_cents).toBeNull();
  });

  it("keeps only rows whose remaining cell is over the typed threshold", () => {
    const spec = parseLedgerQuery(`over ${formatUsdWhole(700_000)}`, pivot);
    expect(spec.min_abs_cents).toBe(700_000);
    const filtered = applyLedgerFilter(pivot, spec);
    expect(filtered.rows.some((r) => r.id === "vendor:aws")).toBe(true);
    expect(filtered.rows.some((r) => r.id === "vendor:figma")).toBe(false);
  });
});

describe("sanitize / describe", () => {
  it("drops invented entity keys", () => {
    expect(sanitizeLedgerFilter({ entities: ["aws", "snowflake"] }, pivot).entities).toEqual(["aws"]);
  });

  it("names the chips from the pivot and the typed amount", () => {
    const spec = parseLedgerQuery("AWS after the change over $1k", pivot);
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
