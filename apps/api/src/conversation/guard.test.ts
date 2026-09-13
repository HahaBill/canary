/** The number guard and URL stripper — docs/AGENT_BEHAVIOR.md §3 and §4, enforced. */
import { formatMonths, formatSignedUsd, formatUsd, formatUsdCompact, formatUsdWhole, speakUsd } from "@canary/shared";
import { describe, expect, it } from "vitest";
import { allowedFigureText, checkFigures, extractFigures, stripUnknownUrls } from "./guard.ts";

/** What `simulate_cost_change` hands the model for AWS at −30% in the mock fixture. */
const WHAT_IF = {
  vendor: "AWS",
  percentage: -30,
  current_weekly: formatUsdWhole(672_000),
  current_monthly_burn: formatUsdWhole(8_480_300),
  scenario_monthly_burn: formatUsdWhole(7_606_700),
  monthly_burn_change: formatSignedUsd(-873_600, "/mo"),
  current_modeled_runway: formatMonths(23.7),
  scenario_modeled_runway: formatMonths(26.5),
  label: "Scenario estimate — not guaranteed savings.",
};

describe("extractFigures", () => {
  it("finds money, percentages and month counts", () => {
    const text = "AWS runs $6,720/wk. At 30% lower, modeled runway goes 23.7 months → 26.5 months (+$1.2K).";
    expect(extractFigures(text)).toEqual(expect.arrayContaining(["$6,720", "30%", "23.7 months", "26.5 months", "+$1.2K"]));
  });

  it("finds nothing in a reply with no figures", () => {
    expect(extractFigures("I don't have spend on record for Snowflake. Did you mean AWS or Datadog?")).toEqual([]);
  });
});

describe("checkFigures", () => {
  it("passes a reply that only repeats what the tool returned", () => {
    const reply = `AWS currently runs ${WHAT_IF.current_weekly}/wk.\nAt 30% lower, modeled monthly burn ${WHAT_IF.current_monthly_burn} → ${WHAT_IF.scenario_monthly_burn}, and modeled runway ${WHAT_IF.current_modeled_runway} → ${WHAT_IF.scenario_modeled_runway}.\n${WHAT_IF.label}`;
    expect(checkFigures(reply, [WHAT_IF])).toEqual({ ok: true, offending: [] });
  });

  it("rejects a plausible invented figure", () => {
    const check = checkFigures("AWS runs about $99,999/wk right now.", [WHAT_IF]);
    expect(check.ok).toBe(false);
    expect(check.offending).toEqual(["$99,999"]);
  });

  it("rejects a figure the model computed itself, even from two real ones", () => {
    // 8,480,300 − 7,606,700 = 873,600 cents. Real arithmetic, no tool behind it:
    // AGENT_BEHAVIOR §3 forbids arithmetic in the language layer, so the guard
    // only accepts the difference because `monthly_burn_change` was returned.
    const withoutDelta = { ...WHAT_IF, monthly_burn_change: undefined };
    expect(checkFigures("That saves $8,736 a month.", [withoutDelta]).ok).toBe(false);
    expect(checkFigures("That saves $8,736 a month.", [WHAT_IF]).ok).toBe(true);
  });

  it("accepts any shape a shared formatter can produce for a figure the tool returned", () => {
    const cents = 1_947_900;
    const results = [{ weekly_variable_spend_cents: cents }];
    for (const rendering of [formatUsd(cents), formatUsdWhole(cents), formatUsdCompact(cents), formatSignedUsd(cents), speakUsd(cents)]) {
      expect(checkFigures(`Variable spend is ${rendering}.`, results).ok).toBe(true);
    }
  });

  it("does not let a figure pass as the prefix of a longer one", () => {
    // "$1" must not be backed by "$1,234" or by its compact form "$1.23K",
    // or a model could shave digits off a real number.
    expect(checkFigures("It was $1.", [{ current_weekly: "$1,234" }]).ok).toBe(false);
    expect(checkFigures("It was $6.72.", [{ current_weekly: formatUsdCompact(672_000) }]).ok).toBe(false);
    expect(checkFigures("It was 3%.", [{ percentage: 30 }]).ok).toBe(false);
  });

  it("rejects a rounded restatement of an exact figure", () => {
    // AGENT_BEHAVIOR §4: "roughly $15K" when the tool said $15,352.18 is a fabrication.
    expect(checkFigures("Roughly $15K a week.", [{ weekly: formatUsd(1_535_218) }]).ok).toBe(false);
  });

  it("has nothing to check when the reply has no figures", () => {
    expect(checkFigures("Which vendor did you mean?", []).ok).toBe(true);
  });

  it("renders every numeric leaf of a tool result, however deeply nested", () => {
    const allowed = allowedFigureText([{ contributors: [{ detail: { delta_weekly_cents: 234_000 } }] }]);
    expect(allowed).toContain("$2,340");
  });

  it("lets the model restyle a figure the tool already formatted", () => {
    // Tools hand over `formatUsdWhole` output; a reply in `formatUsd` or
    // `formatUsdCompact` shape is the same number, not a new one.
    const results = [{ current_weekly: formatUsdWhole(672_000), current_modeled_runway: formatMonths(23.7) }];
    expect(checkFigures("AWS runs $6,720.00/wk.", results).ok).toBe(true);
    expect(checkFigures("AWS runs $6.72K/wk.", results).ok).toBe(true);
    expect(checkFigures("Modeled runway is 23.7 months.", results).ok).toBe(true);
    expect(checkFigures("AWS runs $6,721/wk.", results).ok).toBe(false);
  });
});

describe("stripUnknownUrls", () => {
  const link = "https://canary.test/incidents/inc_mock_burn";

  it("keeps a link a tool issued and deletes one the model wrote", () => {
    const reply = `Here's the incident: ${link}\nMore at https://aws.amazon.com/pricing`;
    const cleaned = stripUnknownUrls(reply, [link]);
    expect(cleaned).toContain(link);
    expect(cleaned).not.toContain("aws.amazon.com");
  });

  it("removes an internal id from prose without breaking it inside an allowed URL", () => {
    const cleaned = stripUnknownUrls(`Incident inc_mock_burn is open. ${link}`, [link]);
    expect(cleaned).toContain(link);
    expect(cleaned).not.toMatch(/Incident inc_mock_burn/);
  });

  it("deletes every URL when no tool issued one", () => {
    expect(stripUnknownUrls("See https://canary.test/dashboard for more.", [])).not.toContain("http");
  });
});
