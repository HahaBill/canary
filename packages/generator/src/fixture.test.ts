/**
 * Structural and reconciliation guarantees for the generated fixture.
 * These are the "generator assertions" from docs/BUILD.md Phase 1.
 */
import {
  DEMO,
  MATERIALITY,
  ONE_OFF_MEDIAN_MULTIPLE,
  ONE_OFF_MIN_ABS_DIFF_CENTS,
  SANDBOX_ACCOUNTS,
  addDays,
  historyStart,
  median,
  sandboxClosingCashCents,
  weekStartsEndingAt,
  type GenerateDemoCompany,
  type GeneratedCompany,
  type Transaction,
} from "@canary/shared";
import { describe, expect, it } from "vitest";
import { DEFAULT_DEMO_OPTIONS, assertFixtureInvariants, generateDemoCompany } from "./index.ts";
import { TEST_MESSY, TEST_UNPAIRED_TRANSFER_KEY } from "./plan.ts";

/** Compile-time proof that the export satisfies the shared contract. */
const _contract: GenerateDemoCompany = generateDemoCompany;

const demo = generateDemoCompany(DEFAULT_DEMO_OPTIONS);
const test = generateDemoCompany({ ...DEFAULT_DEMO_OPTIONS, seed: DEMO.TEST_SEED, profile: "test" });

const cashAccountIds = (gen: GeneratedCompany): Set<string> =>
  new Set(gen.accounts.filter((a) => a.type !== "card").map((a) => a.id));
const cardAccountIds = (gen: GeneratedCompany): Set<string> =>
  new Set(gen.accounts.filter((a) => a.type === "card").map((a) => a.id));
const supersededIds = (txns: Transaction[]): Set<string> =>
  new Set(txns.filter((t) => t.pending_of).map((t) => t.pending_of!));

describe("DEFAULT_DEMO_OPTIONS", () => {
  it("fills every default from @canary/shared", () => {
    expect(DEFAULT_DEMO_OPTIONS).toEqual({
      seed: DEMO.SEED,
      closingBalanceCents: sandboxClosingCashCents(),
      endDate: DEMO.END_DATE,
      weeks: DEMO.WEEKS,
      profile: "demo",
      accounts: SANDBOX_ACCOUNTS,
    });
  });
});

describe("determinism", () => {
  it("same seed produces a deep-equal result", () => {
    expect(generateDemoCompany(DEFAULT_DEMO_OPTIONS)).toEqual(generateDemoCompany(DEFAULT_DEMO_OPTIONS));
  });

  it("same seed produces byte-identical JSON", () => {
    const a = JSON.stringify(generateDemoCompany(DEFAULT_DEMO_OPTIONS));
    const b = JSON.stringify(generateDemoCompany(DEFAULT_DEMO_OPTIONS));
    expect(a).toBe(b);
  });

  it("a different seed produces different transactions", () => {
    const other = generateDemoCompany({ ...DEFAULT_DEMO_OPTIONS, seed: DEMO.SEED + 1 });
    expect(other.transactions).not.toEqual(demo.transactions);
    expect(other.fixture.opening_balance_cents).not.toBe(demo.fixture.opening_balance_cents);
    // …but the invariants still hold, so the fixture is not seed-fragile.
    expect(assertFixtureInvariants(other)).toEqual([]);
  });

  it("passes its own invariant checks in both profiles", () => {
    expect(assertFixtureInvariants(demo)).toEqual([]);
    expect(assertFixtureInvariants(test)).toEqual([]);
  });
});

describe("history span", () => {
  it("covers exactly DEMO.WEEKS complete Mon–Sun weeks ending at the end date", () => {
    const starts = weekStartsEndingAt(DEMO.END_DATE, DEMO.WEEKS);
    expect(starts).toHaveLength(DEMO.WEEKS);
    expect(demo.fixture.start_date).toBe(historyStart(DEMO.END_DATE, DEMO.WEEKS));
    expect(demo.fixture.end_date).toBe(DEMO.END_DATE);
    expect(addDays(starts[DEMO.WEEKS - 1]!, 6)).toBe(DEMO.END_DATE);
    expect(demo.fixture.weeks).toBe(DEMO.WEEKS);
  });

  it("places every transaction inside the span", () => {
    for (const t of demo.transactions) {
      expect(t.date >= demo.fixture.start_date).toBe(true);
      expect(t.date <= demo.fixture.end_date).toBe(true);
    }
  });

  it("puts at least one transaction in every week", () => {
    const starts = weekStartsEndingAt(DEMO.END_DATE, DEMO.WEEKS);
    for (const [i, ws] of starts.entries()) {
      const we = addDays(ws, 6);
      const inWeek = demo.transactions.filter((t) => t.date >= ws && t.date <= we);
      expect(inWeek.length, `week ${i} (${ws}) is empty`).toBeGreaterThan(0);
    }
  });
});

describe("transaction shape", () => {
  it("uses unique deterministic ids", () => {
    const ids = demo.transactions.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(new RegExp(`^txn_${DEMO.SEED}_\\d+$`));
  });

  it("keeps every amount in non-zero integer cents", () => {
    for (const t of demo.transactions) {
      expect(Number.isInteger(t.amount_cents)).toBe(true);
      expect(t.amount_cents).not.toBe(0);
    }
  });

  it("signs amounts so inflows are positive and outflows negative", () => {
    for (const t of demo.transactions) {
      if (t.flow_type === "OPERATING_OUTFLOW") expect(t.amount_cents).toBeLessThan(0);
      if (t.flow_type === "OPERATING_INFLOW") expect(t.amount_cents).toBeGreaterThan(0);
      if (t.flow_type === "REFUND") expect(t.amount_cents).toBeGreaterThan(0);
      if (t.flow_type === "FINANCING") expect(t.amount_cents).toBeGreaterThan(0);
    }
  });

  it("puts a category_hint on every transaction", () => {
    for (const t of demo.transactions) expect(t.category_hint, `${t.id} ${t.merchant_raw}`).toBeTruthy();
  });

  it("marks everything synthetic and USD", () => {
    for (const t of demo.transactions) {
      expect(t.source).toBe("synthetic");
      expect(t.currency).toBe("USD");
    }
  });

  it("only puts transactions on the accounts it was given", () => {
    const ids = new Set(demo.accounts.map((a) => a.id));
    for (const t of demo.transactions) expect(ids.has(t.account_id)).toBe(true);
  });
});

describe("backward anchoring", () => {
  it("closes exactly on the sandbox bank balance, in integer cents", () => {
    const cash = cashAccountIds(demo);
    const dropped = supersededIds(demo.transactions);
    const net = demo.transactions
      .filter((t) => cash.has(t.account_id) && !dropped.has(t.id))
      .reduce((s, t) => s + t.amount_cents, 0);
    expect(demo.fixture.opening_balance_cents + net).toBe(demo.fixture.closing_balance_cents);
    expect(demo.fixture.closing_balance_cents).toBe(sandboxClosingCashCents());
    expect(Number.isInteger(demo.fixture.opening_balance_cents)).toBe(true);
  });

  it("excludes superseded pending rows from the identity", () => {
    const cash = cashAccountIds(demo);
    const withPending = demo.transactions
      .filter((t) => cash.has(t.account_id))
      .reduce((s, t) => s + t.amount_cents, 0);
    // Including the dropped pending row must break the identity — proof it was excluded.
    expect(demo.fixture.opening_balance_cents + withPending).not.toBe(demo.fixture.closing_balance_cents);
  });

  it("holds for the test profile too", () => {
    const cash = cashAccountIds(test);
    const dropped = supersededIds(test.transactions);
    const net = test.transactions
      .filter((t) => cash.has(t.account_id) && !dropped.has(t.id))
      .reduce((s, t) => s + t.amount_cents, 0);
    expect(test.fixture.opening_balance_cents + net).toBe(test.fixture.closing_balance_cents);
  });

  it("implies a plausible opening balance above the closing anchor", () => {
    expect(demo.fixture.opening_balance_cents).toBeGreaterThan(demo.fixture.closing_balance_cents);
  });
});

describe("internal transfers", () => {
  it("pairs every leg, nets to zero, and moves checking → savings", () => {
    expect(demo.fixture.internal_transfer_pair_ids).toHaveLength(1);
    for (const pairId of demo.fixture.internal_transfer_pair_ids) {
      const legs = demo.transactions.filter((t) => t.transfer_pair_id === pairId);
      expect(legs).toHaveLength(2);
      expect(legs.reduce((s, t) => s + t.amount_cents, 0)).toBe(0);
      expect(legs.every((t) => t.flow_type === "INTERNAL_TRANSFER")).toBe(true);
      const out = legs.find((t) => t.amount_cents < 0)!;
      const into = legs.find((t) => t.amount_cents > 0)!;
      expect(demo.accounts.find((a) => a.id === out.account_id)!.type).toBe("checking");
      expect(demo.accounts.find((a) => a.id === into.account_id)!.type).toBe("savings");
      expect(out.date).toBe(into.date);
    }
  });

  it("adds a second transfer in the test profile", () => {
    expect(test.fixture.internal_transfer_pair_ids).toHaveLength(2);
  });

  it("leaves no unpaired legs", () => {
    const legs = demo.transactions.filter((t) => t.flow_type === "INTERNAL_TRANSFER");
    expect(legs).toHaveLength(demo.fixture.internal_transfer_pair_ids.length * 2);
    for (const l of legs) expect(l.transfer_pair_id).toBeTruthy();
  });
});

describe("corporate card", () => {
  const cardIds = cardAccountIds(demo);
  const purchases = demo.transactions.filter(
    (t) => cardIds.has(t.account_id) && t.flow_type === "OPERATING_OUTFLOW",
  );

  it("generates card purchases", () => {
    expect(purchases.length).toBeGreaterThan(20);
  });

  it("covers every card purchase with a settlement that exists", () => {
    const settlementIds = new Set(demo.fixture.card_settlement_ids);
    expect(settlementIds.size).toBeGreaterThan(0);
    for (const p of purchases) {
      expect(p.settlement_pair_id, `${p.id} has no settlement`).toBeTruthy();
      expect(settlementIds.has(p.settlement_pair_id!)).toBe(true);
    }
  });

  it("settles each batch with two legs whose magnitude equals the covered purchases", () => {
    for (const id of demo.fixture.card_settlement_ids) {
      const legs = demo.transactions.filter(
        (t) => t.settlement_pair_id === id && t.flow_type === "CARD_SETTLEMENT",
      );
      expect(legs).toHaveLength(2);
      expect(legs.reduce((s, t) => s + t.amount_cents, 0)).toBe(0);
      const cashLeg = legs.find((t) => !cardIds.has(t.account_id))!;
      const cardLeg = legs.find((t) => cardIds.has(t.account_id))!;
      expect(cashLeg.amount_cents).toBeLessThan(0);
      expect(cardLeg.amount_cents).toBeGreaterThan(0);
      expect(cashLeg.id).toBe(id);
      const covered = purchases
        .filter((p) => p.settlement_pair_id === id)
        .reduce((s, p) => s - p.amount_cents, 0);
      expect(covered).toBe(Math.abs(cashLeg.amount_cents));
    }
  });

  it("leaves the card account fully settled at as_of, matching SANDBOX_ACCOUNTS", () => {
    const balance = demo.transactions
      .filter((t) => cardIds.has(t.account_id))
      .reduce((s, t) => s + t.amount_cents, 0);
    expect(balance).toBe(0);
    expect(demo.accounts.find((a) => a.type === "card")!.balance_cents).toBe(0);
  });
});

describe("pending / settled", () => {
  it("emits one pending row superseded by a settled row", () => {
    expect(demo.fixture.pending_settled_pairs).toHaveLength(1);
    for (const pair of demo.fixture.pending_settled_pairs) {
      const pending = demo.transactions.find((t) => t.id === pair.pending_id)!;
      const settled = demo.transactions.find((t) => t.id === pair.settled_id)!;
      expect(pending.status).toBe("pending");
      expect(settled.status).toBe("settled");
      expect(settled.pending_of).toBe(pending.id);
      expect(settled.merchant_normalized).toBe(pending.merchant_normalized);
      expect(settled.amount_cents).toBe(pending.amount_cents);
      expect(settled.date >= pending.date).toBe(true);
    }
  });

  it("has no other pending rows", () => {
    const pending = demo.transactions.filter((t) => t.status === "pending");
    expect(pending).toHaveLength(demo.fixture.pending_settled_pairs.length);
  });
});

describe("refund", () => {
  it("emits a positive refund against a vendor that was already paid", () => {
    expect(demo.fixture.refund_transaction_ids).toHaveLength(1);
    const refund = demo.transactions.find((t) => t.id === demo.fixture.refund_transaction_ids[0])!;
    expect(refund.flow_type).toBe("REFUND");
    expect(refund.amount_cents).toBeGreaterThan(0);
    const priorPayments = demo.transactions.filter(
      (t) =>
        t.merchant_normalized === refund.merchant_normalized &&
        t.flow_type === "OPERATING_OUTFLOW" &&
        t.date < refund.date,
    );
    expect(priorPayments.length).toBeGreaterThan(0);
    // Ground truth is the category it nets against, so the engine's buckets line up.
    expect(refund.category_hint).toBe(priorPayments[0]!.category_hint);
  });
});

describe("unknown vendor (Tavily fixture)", () => {
  it("emits the real indexed vendor with an empty description and no tag", () => {
    const meta = demo.fixture.unknown_vendor;
    expect(meta.merchant_normalized).toBe(DEMO.UNKNOWN_VENDOR.merchant_normalized);
    expect(meta.merchant_raw).toBe(DEMO.UNKNOWN_VENDOR.merchant_raw);
    expect(meta.expected_category).toBe(DEMO.UNKNOWN_VENDOR.expected_category);
    expect(meta.transaction_ids.length).toBeGreaterThanOrEqual(2);
    expect(meta.transaction_ids.length).toBeLessThanOrEqual(3);
    for (const id of meta.transaction_ids) {
      const t = demo.transactions.find((x) => x.id === id)!;
      expect(t.merchant_raw).toBe(DEMO.UNKNOWN_VENDOR.merchant_raw);
      expect(t.description).toBe("");
      expect(t.tags).toEqual([]);
      expect(t.category_hint).toBe(DEMO.UNKNOWN_VENDOR.expected_category);
      expect(t.amount_cents).toBeLessThan(0);
    }
  });

  it("has fewer than MIN_PRIOR_VENDOR_PAYMENTS priors so it reads as a new vendor", () => {
    const payments = demo.transactions.filter(
      (t) => t.merchant_normalized === DEMO.UNKNOWN_VENDOR.merchant_normalized,
    );
    expect(payments.length).toBeLessThan(4);
  });
});

describe("planted one-off", () => {
  const meta = demo.fixture.one_off;
  const oneOff = demo.transactions.find((t) => t.id === meta.transaction_id)!;

  it("sits on the configured vendor in a post-change week that is not the last", () => {
    expect(meta.entity).toBe(DEMO.ONE_OFF_ENTITY);
    expect(oneOff.merchant_normalized).toBe(DEMO.ONE_OFF_ENTITY);
    const starts = weekStartsEndingAt(DEMO.END_DATE, DEMO.WEEKS);
    const weekIndex = starts.findIndex((ws) => oneOff.date >= ws && oneOff.date <= addDays(ws, 6));
    expect(weekIndex).toBeGreaterThan(demo.fixture.burn_shift.true_change_start_index);
    expect(weekIndex).toBeLessThan(DEMO.WEEKS - 1);
  });

  it("has at least MIN_PRIOR_VENDOR_PAYMENTS prior payments of similar size", () => {
    const priors = demo.transactions.filter(
      (t) =>
        t.merchant_normalized === DEMO.ONE_OFF_ENTITY &&
        t.flow_type === "OPERATING_OUTFLOW" &&
        t.date < oneOff.date,
    );
    expect(priors.length).toBeGreaterThanOrEqual(3);
    expect(meta.prior_payment_count).toBe(priors.length);
    const amounts = priors.map((t) => -t.amount_cents);
    expect(meta.prior_median_cents).toBe(Math.round(median(amounts)));
    // "similar size": every prior is within ±25% of their median.
    for (const a of amounts) {
      expect(Math.abs(a - meta.prior_median_cents) / meta.prior_median_cents).toBeLessThan(0.25);
    }
  });

  it("clears every configured one-off threshold", () => {
    const amount = -oneOff.amount_cents;
    expect(amount).toBe(meta.amount_cents);
    expect(amount).toBeGreaterThanOrEqual(ONE_OFF_MEDIAN_MULTIPLE * meta.prior_median_cents);
    expect(amount - meta.prior_median_cents).toBeGreaterThanOrEqual(ONE_OFF_MIN_ABS_DIFF_CENTS);
    expect(amount).toBeGreaterThanOrEqual(
      ONE_OFF_MEDIAN_MULTIPLE * meta.prior_median_cents + ONE_OFF_MIN_ABS_DIFF_CENTS,
    );
    expect(amount).toBeGreaterThanOrEqual(MATERIALITY.MIN_ONE_OFF_AMOUNT_CENTS);
  });

  it("is NOT tagged — the detector has to find it", () => {
    expect(oneOff.tags).toEqual([]);
    expect(demo.transactions.some((t) => t.tags.includes("one_off"))).toBe(false);
  });
});

describe("profile: test", () => {
  it("adds a financing inflow", () => {
    expect(test.fixture.financing_transaction_ids).toHaveLength(1);
    const financing = test.transactions.find((t) => t.id === test.fixture.financing_transaction_ids[0])!;
    expect(financing.flow_type).toBe("FINANCING");
    expect(financing.amount_cents).toBeGreaterThan(0);
    expect(financing.category_hint).toBe("FINANCING");
    expect(demo.fixture.financing_transaction_ids).toEqual([]);
    expect(demo.transactions.some((t) => t.flow_type === "FINANCING")).toBe(false);
  });

  it("adds an annual_renewal-tagged payment", () => {
    const renewals = test.transactions.filter((t) => t.tags.includes("annual_renewal"));
    expect(renewals).toHaveLength(1);
    expect(renewals[0]!.flow_type).toBe("OPERATING_OUTFLOW");
    expect(demo.transactions.some((t) => t.tags.includes("annual_renewal"))).toBe(false);
  });
});

describe("fixture metadata", () => {
  it("is filled in completely", () => {
    const f = demo.fixture;
    expect(f.seed).toBe(DEMO.SEED);
    expect(f.profile).toBe("demo");
    expect(f.burn_shift.true_change_start_index).toBe(DEMO.CHANGE_START_INDEX);
    expect(f.burn_shift.true_change_start_week).toBe(
      weekStartsEndingAt(DEMO.END_DATE, DEMO.WEEKS)[DEMO.CHANGE_START_INDEX],
    );
    expect(f.burn_shift.expected_direction).toBe("upward");
    expect(f.burn_shift.expected_driver_entities).toContain(DEMO.PRIMARY_DRIVER_ENTITY);
    for (const e of DEMO.SECONDARY_DRIVER_ENTITIES) expect(f.burn_shift.expected_driver_entities).toContain(e);
    expect(f.burn_shift.planted_delta_weekly_cents).toBeGreaterThan(0);
    expect(f.card_settlement_ids.length).toBeGreaterThan(0);
    expect(f.needs_review_candidate_ids.length).toBeGreaterThan(0);
  });

  it("references only real transaction ids", () => {
    const ids = new Set(demo.transactions.map((t) => t.id));
    const referenced = [
      demo.fixture.one_off.transaction_id,
      ...demo.fixture.unknown_vendor.transaction_ids,
      ...demo.fixture.card_settlement_ids,
      ...demo.fixture.refund_transaction_ids,
      ...demo.fixture.needs_review_candidate_ids,
      ...demo.fixture.pending_settled_pairs.flatMap((p) => [p.pending_id, p.settled_id]),
      ...test.fixture.financing_transaction_ids.filter(() => false),
    ];
    for (const id of referenced) expect(ids.has(id), `${id} is not a real transaction`).toBe(true);
  });
});

describe("other week counts (contract §2 allows 16–20)", () => {
  for (const weeks of [16, 17, 18, 20]) {
    it(`stays internally consistent at ${weeks} weeks`, () => {
      const gen = generateDemoCompany({ ...DEFAULT_DEMO_OPTIONS, weeks });
      expect(assertFixtureInvariants(gen)).toEqual([]);
      expect(gen.fixture.weeks).toBe(weeks);
      expect(gen.fixture.start_date).toBe(historyStart(DEMO.END_DATE, weeks));
    });
  }
});

describe("company profile", () => {
  it("reports the fictional company against the accounts it was given", () => {
    expect(demo.company.legal_name).toBe("Perch Analytics, Inc.");
    expect(demo.company.bank_name).toBe("Canary Sandbox Bank");
    expect(demo.company.as_of).toBe(DEMO.END_DATE);
    expect(demo.company.accounts).toBe(demo.accounts);
    expect(demo.accounts).toBe(SANDBOX_ACCOUNTS);
  });
});

/**
 * Messy statement shapes, test profile only (contract §4). These are patterns
 * that show up on real business bank statements — not how a tidy ledger is
 * supposed to look. Every one of them breaks a naive reconciliation somewhere.
 */
describe("profile: test — messy statement shapes", () => {
  const messy = (key: string) => test.transactions.filter((t) => t.merchant_raw === key);

  it("keeps the demo profile clean of every messy shape", () => {
    const messyDescriptors = [
      TEST_MESSY.REVERSAL.merchant_raw,
      TEST_MESSY.OVER_CREDIT.merchant_raw,
      TEST_MESSY.CHECK_TO_INDIVIDUAL.merchant_raw,
      TEST_MESSY.AMBIGUOUS_ACH.merchant_raw,
      TEST_MESSY.AMBIGUOUS_ONLINE.merchant_raw,
      TEST_MESSY.ORPHAN_TRANSFER.merchant_raw,
      TEST_MESSY.UNSETTLED_PENDING.merchant_raw,
    ];
    for (const descriptor of messyDescriptors) {
      expect(demo.transactions.some((t) => t.merchant_raw === descriptor)).toBe(false);
    }
    // In the demo profile every pending row is superseded by a settled twin.
    const demoOrphanPending = demo.transactions.filter(
      (t) => t.status === "pending" && !demo.transactions.some((s) => s.pending_of === t.id),
    );
    expect(demoOrphanPending).toHaveLength(0);
  });

  it("plants a same-day double-post and the reversal that cancels one leg", () => {
    const posts = messy(TEST_MESSY.DOUBLE_POST.merchant_raw);
    expect(posts).toHaveLength(2);
    // Identical amount, identical day, different ids. Nothing in the data says
    // which one is the mistake.
    expect(posts[0]!.date).toBe(posts[1]!.date);
    expect(posts[0]!.amount_cents).toBe(posts[1]!.amount_cents);
    expect(posts[0]!.id).not.toBe(posts[1]!.id);

    const [reversal] = messy(TEST_MESSY.REVERSAL.merchant_raw);
    expect(reversal!.flow_type).toBe("REFUND");
    expect(reversal!.amount_cents).toBe(-posts[0]!.amount_cents);
    expect(reversal!.date > posts[0]!.date).toBe(true);
    // Net effect on the vendor: exactly one charge.
    expect(posts.reduce((s, t) => s + t.amount_cents, 0) + reversal!.amount_cents).toBe(posts[0]!.amount_cents);
  });

  it("plants a credit larger than that vendor's charges", () => {
    const [credit] = messy(TEST_MESSY.OVER_CREDIT.merchant_raw);
    expect(credit!.flow_type).toBe("REFUND");
    expect(credit!.amount_cents).toBeGreaterThan(0);

    const sameWeekCharges = test.transactions.filter(
      (t) => t.merchant_normalized === credit!.merchant_normalized && t.amount_cents < 0,
    );
    const largestCharge = Math.max(...sameWeekCharges.map((t) => Math.abs(t.amount_cents)));
    expect(credit!.amount_cents).toBeGreaterThan(largestCharge);
  });

  it("plants a check to a person and descriptors that identify nothing", () => {
    const [check] = messy(TEST_MESSY.CHECK_TO_INDIVIDUAL.merchant_raw);
    expect(check!.category_hint).toBe("NEEDS_REVIEW");
    expect(check!.amount_cents).toBeLessThan(0);

    // Two mystery ACH debits: enough to be a repeat, too few for vendor history.
    const ach = messy(TEST_MESSY.AMBIGUOUS_ACH.merchant_raw);
    expect(ach).toHaveLength(TEST_MESSY.AMBIGUOUS_ACH.week_indexes.length);
    expect(ach.every((t) => t.description === "")).toBe(true);
    expect(ach.length).toBeLessThan(3); // below MIN_PRIOR_VENDOR_PAYMENTS: new vendor, never anomalous

    expect(messy(TEST_MESSY.AMBIGUOUS_ONLINE.merchant_raw)).toHaveLength(1);
  });

  it("plants an internal transfer whose other leg never arrives", () => {
    const legs = test.transactions.filter((t) => t.transfer_pair_id === TEST_UNPAIRED_TRANSFER_KEY);
    expect(legs).toHaveLength(1);
    expect(legs[0]!.flow_type).toBe("INTERNAL_TRANSFER");
    expect(legs[0]!.amount_cents).toBeLessThan(0);
    // Every other pair still nets to zero.
    const byPair = new Map<string, number>();
    for (const t of test.transactions.filter((t) => t.transfer_pair_id && t.transfer_pair_id !== TEST_UNPAIRED_TRANSFER_KEY)) {
      byPair.set(t.transfer_pair_id!, (byPair.get(t.transfer_pair_id!) ?? 0) + t.amount_cents);
    }
    for (const sum of byPair.values()) expect(sum).toBe(0);
  });

  it("plants a pending authorisation that never settles", () => {
    const [pending] = messy(TEST_MESSY.UNSETTLED_PENDING.merchant_raw);
    expect(pending!.status).toBe("pending");
    // Nothing supersedes it: the money is gone as far as the founder is concerned.
    expect(test.transactions.some((t) => t.pending_of === pending!.id)).toBe(false);
    expect(test.fixture.pending_settled_pairs.some((p) => p.pending_id === pending!.id)).toBe(false);
  });

  it("still closes on the sandbox bank balance with all of it in place", () => {
    // The whole point: messy input, exact cash.
    const cashIds = new Set(SANDBOX_ACCOUNTS.filter((a) => a.type !== "card").map((a) => a.id));
    const superseded = new Set(test.transactions.filter((t) => t.pending_of).map((t) => t.pending_of!));
    const net = test.transactions
      .filter((t) => cashIds.has(t.account_id) && !superseded.has(t.id))
      .reduce((s, t) => s + t.amount_cents, 0);

    expect(test.fixture.opening_balance_cents + net).toBe(test.fixture.closing_balance_cents);
    expect(test.fixture.closing_balance_cents).toBe(sandboxClosingCashCents());
  });
});
