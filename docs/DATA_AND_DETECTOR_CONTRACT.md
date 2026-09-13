# Canary — Demo Data & Detector Contract

This document is the contract between the synthetic generator, financial engine, detectors, UI, and demo.

**The generator is the source of truth.**

No financial figure should be hard-coded in the UI, demo script, or README if it can be derived from this system.

---

# 1. Global Financial Conventions

## Week → Month

Use one pinned conversion:

```text
WEEKS_PER_MONTH = 52 / 12
```

Never use 4-week months for financial reporting.

## Sign convention

Choose one convention and use it everywhere.

Recommended:

```text
cash inflow  > 0
cash outflow < 0
```

## Burn

Operating burn excludes:

- financing;
- internal transfers;
- duplicate card settlements.

Needs Review outflows still count.

---

# 2. Generator Requirements

The generator must:

- produce `DEMO.WEEKS` = 52 calendar weeks of history, plus `DEMO.HORIZON_WEEKS` = 26 weeks of un-posted future rows the demo clock reveals;
- be deterministic for a seed;
- produce non-overlapping calendar-week data;
- support backward generation from a required closing balance;
- produce event metadata for planted fixtures;
- expose expected detector assertions.

Suggested function:

```text
generateDemoCompany({
  seed,
  closingBalance,
  endDate,
  weeks
})
```

---

# 3. Sandbox Bank Balance Anchoring

The demo does not run on a live bank. A real Rho client does exist alongside it: `GET /api/bank/rho` runs the same engine over Rho's public sandbox, which needs no credentials and reconciles to zero. The fictional **Canary Sandbox Bank** (behind `BankProvider`) reports the closing balance for the fictional company **Perch Analytics, Inc.** That balance is a configured anchor in `packages/shared/src/company.ts`.

Process:

```text
Read sandbox bank closing balance (company profile)
        ↓
Set generator closingBalance
        ↓
Generate history backward
        ↓
Verify:
synthetic opening balance
+ synthetic net flows
= sandbox bank closing balance
```

The dashboard cash value should therefore be the sandbox bank closing balance, not a separately invented number. The UI must label it as sandbox-sourced and the company as fictional.

---

# 4. Demo Seed Structure

Use a dedicated **demo seed** and separate test seeds.

## Demo seed

Should contain only events needed for the live story.

Recommended:

- sustained variable-spend shift;
- one large vendor payment;
- one real indexed unknown vendor;
- one internal transfer;
- one card settlement;
- one refund if needed.

Avoid a giant SAFE wire in the demo seed unless it is necessary.

## Test seed

May include:

- financing event;
- more edge cases;
- reconciliation mismatches;
- annual renewal.

---

# 5. Sustained Burn Shift Fixture

The planted shift must satisfy the narrative:

- gradual/persistent;
- not a single extreme week;
- enough post-change weeks for confirmation;
- detected before the final week.

Recommended:

- change begins at `DEMO.CHANGE_START_INDEX` = week 42 of the 52-week history (ten weeks before the end);
- enough post-change observations exist for CUSUM and current-regime burn.

The generator should store:

```text
true_change_start
expected_driver_entities
expected_direction = upward
```

Do not hand-author a calendar date in docs. Derive it from:

```text
endDate
weeks
fixture start index
```

---

# 6. CUSUM Contract

Input:

- non-overlapping calendar-week variable spend;
- tagged one-off shocks winsorized/excluded;
- fixed/predictable categories excluded or normalized.

Configuration:

```text
direction = upward
k = 0.5 * sigma
h = H_MULTIPLIER * sigma
sigma = max(1.4826 x MAD, sigma_floor_fraction x median) of the baseline's
        residuals against a FITTED MULTIPLICATIVE TREND, not a flat median
```

Store `H_MULTIPLIER` in config.

Output:

```text
alarm_week
estimated_change_point
pre_change_rate
post_change_rate
detection_lag
```

Estimated change point:

> last week before alarm where cumulative statistic was zero.

On confirmation:

> mark regime and allow re-baselining.

---

# 7. Current Burn Window Contract

Before confirmed regime change:

> use configured trailing window.

After confirmed regime change:

> use the segment since the confirmed change point once `min_post_change_weeks` is satisfied.

Therefore current burn is not necessarily “last 8 weeks.”

Store:

```text
burn_window_start
burn_window_end
burn_window_reason
```

---

# 8. One-Off Fixture Contract

The demo vendor anomaly must have:

```text
prior_vendor_payments >= 3
```

and a planted payment satisfying configured threshold.

Output:

```text
vendor
current_amount
vendor_median
multiple_of_median
materiality
```

The one-off:

- remains in cash/burn;
- is tagged for CUSUM preprocessing.

---

# 9. New Vendor Rule

Consciously choose one behavior.

Recommended:

If vendor has fewer than 3 prior payments:

```text
do not run vendor-median anomaly rule
```

Instead optionally classify:

```text
new_vendor = true
```

A separate “large first payment to a new vendor” rule can be P1 unless it is useful to the demo.

---

# 10. Incident Grouping Contract

A signal joins an open parent incident if:

- the signal's entity/category appears in the incident contributor decomposition;
- the signal time overlaps the incident regime/change window.

One-off shocks remain standalone unless there is a clear causal grouping rule.

Do not show a SaaS recurring-drift signal as a separate top-level alert if it is already a contributor to the active burn incident.

---

# 11. Incident Dedup Contract

When a detector reruns:

Match against open incidents with:

```text
same type
AND
same entity
AND
estimated change point within ±2 weeks
```

If matched:

> update incident.

Do not create a duplicate because the change-point estimate moved by one week.

---

# 12. Materiality Contract

All thresholds live in config.

## Rate changes

Example config keys:

```text
MIN_MONTHLY_DELTA
MIN_BURN_PERCENT
MIN_RUNWAY_IMPACT_MONTHS
```

## One-offs

Example:

```text
MIN_ONE_OFF_AMOUNT
MIN_ONE_OFF_BURN_PERCENT
```

No LLM materiality decision.

---

# 13. Tavily Fixture Contract

Do not use a fictional company.

The demo generator should contain a real obscure indexed vendor name.

The Tavily workflow must return:

```text
vendor_name
business_type
mapped_category
source_url
source_title
retrieved_at
```

The category signal is considered corroborated only if:

```text
OpenAI proposed category
==
Tavily structured mapped category
```

Cache the successful result for fallback.

---

# 14. Derived Demo Object

The generator + engine should expose one object that drives:

- React dashboard;
- incident page;
- iMessage text;
- demo script;
- voice agent.

Example shape:

```json
{
  "cash": "...derived...",
  "current_burn_monthly": "...derived...",
  "runway_months": "...derived...",
  "primary_incident": {
    "change_point": "...derived...",
    "pre_rate_weekly": "...derived...",
    "post_rate_weekly": "...derived...",
    "delta_weekly": "...derived...",
    "primary_driver": "...derived...",
    "drivers": []
  },
  "one_off_signal": {
    "vendor": "...",
    "amount": "...derived...",
    "multiple_of_median": "...derived..."
  }
}
```

UI copy can format the numbers.

The numbers themselves come from this object.

---

# 15. Required Assertions

Before demo:

- [ ] closing balance matches sandbox bank balance exactly (integer cents)
- [ ] internal transfer net spend = 0
- [ ] card settlement not double counted
- [ ] financing excluded from operating burn
- [ ] Needs Review outflow included in burn
- [ ] one-off has ≥3 prior vendor payments
- [ ] one-off detector fires
- [ ] CUSUM does not fire only because of one-off
- [ ] estimated change point is within expected tolerance
- [ ] post-change burn window is representative
- [ ] contributor deltas sum to total delta within tolerance
- [ ] incident dedup prevents duplicates
- [ ] Tavily vendor result is cached and cited
- [ ] all dashboard/demo figures are derived

If these assertions pass, the demo numbers are trustworthy.
