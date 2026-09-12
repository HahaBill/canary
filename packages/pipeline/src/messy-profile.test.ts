/**
 * End-to-end reconciliation against a deliberately messy statement.
 *
 * The demo profile is a tidy ledger. Real bank statements are not: charges post
 * twice, credits arrive later and sometimes exceed the charge, checks go out to
 * people rather than merchants, descriptors identify nothing, a transfer's other
 * leg never shows up, and an authorisation sits pending forever.
 *
 * The `test` profile plants all of that. This file asserts the thing that has to
 * survive it: **cash is still exact**, nothing is silently dropped, and the
 * detectors do not start seeing things that are not there.
 */
import { DEMO, sandboxClosingCashCents } from "@canary/shared";
import { TEST_MESSY, TEST_UNPAIRED_TRANSFER_KEY } from "@canary/generator";
import { describe, expect, it } from "vitest";
import { runPipeline } from "./run.ts";

const messyRun = await runPipeline({ profile: "test", seed: DEMO.TEST_SEED, includeFixture: true });
const cleanRun = await runPipeline({ profile: "demo", includeFixture: true });

const { derived, ledger } = messyRun;
const rowsFor = (descriptor: string) => ledger.transactions.filter((t) => t.merchant_raw === descriptor);

describe("messy statement — cash is still exact", () => {
  it("closes on the sandbox bank balance to the cent", () => {
    // The single assertion this whole profile exists to make.
    expect(derived.reconciliation.matches).toBe(true);
    expect(derived.reconciliation.discrepancy_cents).toBe(0);
    expect(derived.reconciliation.computed_closing_balance_cents).toBe(sandboxClosingCashCents());
    expect(derived.reconciliation.opening_balance_reported).toBe(true);
  });

  it("still reconciles the tidy demo profile identically", () => {
    expect(cleanRun.derived.reconciliation.matches).toBe(true);
    expect(cleanRun.derived.reconciliation.discrepancy_cents).toBe(0);
    // The demo profile carries none of the mess.
    expect(cleanRun.derived.reconciliation.unpaired_transfer_legs).toBe(0);
    expect(cleanRun.derived.reconciliation.warnings).toEqual([]);
  });
});

describe("messy statement — nothing is silently dropped", () => {
  it("nets a double-post and its reversal down to exactly one charge", () => {
    const posts = rowsFor(TEST_MESSY.DOUBLE_POST.merchant_raw);
    const [reversal] = rowsFor(TEST_MESSY.REVERSAL.merchant_raw);
    expect(posts).toHaveLength(2);

    // Both debits are real rows that moved real cash; the engine does not
    // guess that one was a mistake.
    expect(posts.every((t) => t.counts_in_cash && t.counts_in_burn && !t.dropped)).toBe(true);
    expect(reversal!.counts_in_burn).toBe(true);

    // The vendor's net spend for that week is one charge, not two and not zero.
    const week = ledger.weeks.find((w) => w.week_start <= posts[0]!.date && posts[0]!.date <= w.week_end)!;
    expect(week.variable_by_entity[TEST_MESSY.DOUBLE_POST.merchant_normalized]).toBe(TEST_MESSY.DOUBLE_POST.amount_cents);
  });

  it("lets a vendor's week go negative when the credit exceeds the charge", () => {
    const [credit] = rowsFor(TEST_MESSY.OVER_CREDIT.merchant_raw);
    const week = ledger.weeks.find((w) => w.week_start <= credit!.date && credit!.date <= w.week_end)!;

    // Clamping this at zero would quietly overstate burn. The vendor genuinely
    // owed money back that week.
    expect(week.variable_by_entity[TEST_MESSY.OVER_CREDIT.merchant_normalized]!).toBeLessThan(0);
    expect(derived.reconciliation.refunds_netted_cents).toBeGreaterThan(0);
  });

  it("routes the check and the anonymous descriptors to Needs Review, still counted", () => {
    const unclassifiable = [
      TEST_MESSY.CHECK_TO_INDIVIDUAL.merchant_raw,
      TEST_MESSY.AMBIGUOUS_ACH.merchant_raw,
      TEST_MESSY.AMBIGUOUS_ONLINE.merchant_raw,
    ].flatMap(rowsFor);

    expect(unclassifiable.length).toBeGreaterThanOrEqual(4);
    for (const row of unclassifiable) {
      expect(row.category).toBe("NEEDS_REVIEW");
      // PRD §4: unknown category is not an ignored transaction.
      expect(row.counts_in_burn).toBe(true);
      expect(row.counts_in_cash).toBe(true);
      expect(derived.needs_review.items.some((i) => i.transaction_id === row.id)).toBe(true);
    }
    expect(derived.needs_review.outflow_cents).toBeGreaterThan(0);
  });

  it("counts a pending authorisation that never settles", () => {
    const [pending] = rowsFor(TEST_MESSY.UNSETTLED_PENDING.merchant_raw);

    expect(pending!.status).toBe("pending");
    // Only a pending row SUPERSEDED by a settled twin may be dropped.
    expect(pending!.dropped).toBe(false);
    expect(pending!.counts_in_cash).toBe(true);
    expect(pending!.counts_in_burn).toBe(true);
    expect(derived.reconciliation.pending_rows_dropped).toBe(messyRun.generated.fixture.pending_settled_pairs.length);
  });

  it("reports the orphan transfer leg instead of trusting it", () => {
    const legs = ledger.transactions.filter((t) => t.transfer_pair_id === TEST_UNPAIRED_TRANSFER_KEY);
    expect(legs).toHaveLength(1);

    expect(derived.reconciliation.unpaired_transfer_legs).toBe(1);
    expect(derived.reconciliation.warnings.some((w) => w.includes(TEST_UNPAIRED_TRANSFER_KEY))).toBe(true);

    // KNOWN GAP (docs/ALFREDO-LOGIC-AUDIT.md §3.1): the leg is still trusted as
    // internal and stays out of burn on its flow type alone. It is counted and
    // warned about, but it does NOT reach Needs Review the way an
    // unclassifiable outflow does. Pinned here so the day that changes, this
    // test says so.
    expect(legs[0]!.counts_in_burn).toBe(false);
    expect(derived.needs_review.items.some((i) => i.transaction_id === legs[0]!.id)).toBe(false);
  });
});

describe("messy statement — the detectors keep their heads", () => {
  it("still finds the planted shift", () => {
    const cusum = derived.primary_incident?.detection.cusum;
    expect(cusum?.fired).toBe(true);
    expect(derived.primary_incident?.entity).toBe(DEMO.PRIMARY_DRIVER_ENTITY);
    expect(cusum!.alarm_week_index!).toBeLessThan(ledger.weeks.length - 1);
  });

  it("flags only the planted one-off, not the mess", () => {
    const oneOffs = derived.incidents.filter((i) => i.type === "ONE_OFF_VENDOR_PAYMENT");
    expect(oneOffs).toHaveLength(1);
    expect(oneOffs[0]!.entity).toBe(DEMO.ONE_OFF_ENTITY);
    expect(oneOffs[0]!.detection.one_off!.transaction_id).toBe(messyRun.generated.fixture.one_off.transaction_id);
  });

  it("does not treat a reversed duplicate as an anomalous payment", () => {
    // The double-post is two ordinary-sized charges. Neither is 3x a median,
    // so the vendor-relative rule never looks at them twice.
    const flagged = derived.incidents
      .filter((i) => i.type === "ONE_OFF_VENDOR_PAYMENT")
      .map((i) => i.detection.one_off!.transaction_id);
    for (const post of rowsFor(TEST_MESSY.DOUBLE_POST.merchant_raw)) {
      expect(flagged).not.toContain(post.id);
    }
  });

  it("produces byte-identical output on a rerun", () => {
    expect(JSON.stringify(derived)).toBe(JSON.stringify(messyRun.derived));
  });
});
