# Detector & engine audit — findings, fixes, open proposals

Owner: Alfredo (behaviour and logic). Audience: Bill.
Date: 2026-09-12. Baseline commit: `c0c4399`.

The written record of the logic work: what was broken, what I changed, what I
deliberately did **not** change, and the proposals that need your sign-off
because they touch `packages/shared`.

Six commits on `main`, in order:

| Commit | What |
|---|---|
| `c8915b6` | `npm run verify` actually runs on Windows |
| `9ba75e9` | Detector audit: 27 tests, one real fix |
| `49f8a40` | `docs/AGENT_BEHAVIOR.md`; WHY names the rule that fired |
| `542884b` | Recurring-charge drift detector (third detector) |
| `d6089da` | Messy statement shapes in the test profile |
| `d827134` | What-if says why nothing changed; credit-balance fix |

Nothing in `packages/shared` was edited **by the audit commits, whose baseline is `c0c4399`**. Later work does touch it — see `docs/ALFREDO-WORKLOG.md` § "Every touch on packages/shared" for the full list, all additive or value-only. Three additive diffs are proposed in §6
and are ready to apply.

Every demo number is unchanged. `npm run verify` prints the same cash, runway,
alarm week, change point, primary driver and one-off multiple as before the
audit — that was the acceptance test for every commit here.

---

## 1. Fixed

### 1.1 `npm run verify` never ran on Windows (silent pass)

`packages/pipeline/src/verify.ts` guarded its entry point with:

```ts
if (import.meta.url === `file://${process.argv[1]}`) {
```

On Windows `process.argv[1]` is `C:\...\verify.ts`, so the comparison builds
`file://C:\...\verify.ts` while `import.meta.url` is `file:///C:/.../verify.ts`
— different slash count, different separator. The guard body never ran: the
command printed nothing and **exited 0**. Chained as `npm test && npm run verify`
that reads as success, so on a Windows machine the contract §15 assertions had
effectively been off.

Fixed with `pathToFileURL`, the same conversion Node's ESM loader uses:

```ts
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
```

The `process.argv[1] &&` guard is required, not cosmetic: `noUncheckedIndexedAccess`
types it as `string | undefined`.

This is the only entry-point guard in the repo. The three other runnable scripts
(`print-summary.ts`, `seed-demo-cache.ts`, `seed-cache.ts`) call `main()`
unconditionally, so they were never affected.

**Worth knowing:** CI never runs `npm run verify` at all (`.github/workflows/deploy.yml`
runs typecheck, test, build, dry-run deploy). So between this guard and CI, the
§15 assertions were only ever enforced by someone running the command on macOS
or Linux by hand. Proposal 3 below.

### 1.2 Contributor decomposition invented a change that never happened

`decomposeContributors` bailed out on `estimated_change_point_index === null`
but not on `-1` (`NO_PRE_CHANGE_SEGMENT` — the statistic never returned to zero
before the alarm, so the elevated regime covers the whole series).

With `-1`, `regimeStart` became `0`, the pre-segment was empty, and `meanRate`
returned `0` for every entity. Each entity's **full-series average** was then
published as its `delta_weekly_cents`: a company spending a steady $10,000/week
on AWS would be reported as "AWS up $10,000/week".

CUSUM itself is careful here — it reports `pre_change_rate_weekly_cents: null`
rather than a misleading zero. Decomposition did not follow that lead.

This was **masked, not harmless**: `buildRateShiftCandidate` bails on
`delta_weekly_cents === null` first, so no published incident was ever wrong.
But `decomposeContributors` is an exported part of the `DecomposeContributors`
contract, and any caller trusting it without re-checking the CUSUM delta got
fabricated deltas. Fixed by returning `[]`, with the reasoning in a comment.

Test: `decompose.test.ts` › "returns nothing when there is no pre-change segment
to compare against".

---

## 2. Tests added (27 new, all green; 508 → 535 total)

Written **before** looking for fixes, so each one either documents real behaviour
or proves a bug. Only 1.2 turned out to be a bug.

**`cusum.test.ts` — 6 new**
- Alarm on the final week: fires, and the post-change rate is an average of one
  or two weeks. Nothing in the detector refuses to publish that.
- No pre-change segment (`-1`): pre-rate and delta stay `null`.
- Sigma floor carrying the whole estimate when baseline MAD is 0.
- A single +10% week alarms under that floor — evidence for proposal 1.
- An all-zero week inside the baseline and inside the monitored window.
- A negative week (a credit larger than that week's charges): the statistic
  floors at zero and cannot go negative.

**`decompose.test.ts` — 3 new**
- No pre-change segment → no contributors (the 1.2 fix).
- Single-entity series → one contributor holding 100% of the delta.
- An entity whose refunds outweigh its charges → negative rate, not clamped.

**`one-off.test.ts` — 4 new**
- Both conditions at exact equality (`3×` median **and** exactly $2,000 above) fire.
- One cent below does not.
- A big multiple of a tiny median still fails the absolute floor.
- The reported prior count at exactly `MIN_PRIOR_VENDOR_PAYMENTS`.

**`materiality.test.ts` — 4 new** (only `MIN_ONE_OFF_AMOUNT_CENTS` had an exact-edge test)
- Share-of-burn at exactly the threshold, and one cent below.
- Runway impact at exactly `MIN_RUNWAY_IMPACT_MONTHS`.
- One-off share-of-burn at exactly the threshold.
- Runway `0` (out of cash) stays a number and is not collapsed into `null`
  ("not burning"). Those two states mean opposite things.

**`incidents.test.ts` — 4 new**
- Dedup at a change point that moved by exactly `INCIDENT_DEDUP_WEEKS`: matches.
  The rule is "within", not "closer than".
- A RESOLVED incident that is re-detected keeps `RESOLVED` and its `last_notified`,
  but its numbers are refreshed.
- An alarm on the final week still publishes an incident.
- No pre-change segment → no incident at all.

**`ledger.test.ts` — 3 new**
- A refund larger than the charge nets to a negative entity-week; cash still
  reconciles exactly.
- An unpaired transfer leg is counted and warned about but stays out of burn.
- Two same-day identical charges count as two real charges.

**`burn.test.ts` — 3 new**
- Revenue exceeding spend → `runway_months` is `null`, not negative.
- Spend exactly equal to revenue → `null`.
- Zero cash → runway `0`.

---

## 3. Known gaps I did NOT change (documented on purpose)

Each of these is real, none is demo-affecting, and each needs a decision rather
than a quick patch.

1. **An unpaired internal transfer leg never reaches Needs Review.**
   `counts_in_burn` is decided by `flow_type` alone, so a leg the engine could
   not pair is still trusted as internal and drops out of burn. It is counted
   (`unpaired_transfer_legs`) and warned about, but PRD §4 says "nothing falls
   through silently" and an outflow that *claims* to be internal and cannot
   prove it is exactly the case that principle is about. A one-sided wire
   mis-tagged as a transfer would understate burn with only a warning string as
   evidence. Fix is small but changes engine behaviour, so it is yours to call.

2. **`ids.ts` contradicts `incidents.ts` about incident identity.**
   Dedup deliberately ignores `entity` for `BURN_RATE_SHIFT` (your `c67391b`
   fix — the top contributor drifts as a regime matures). But `incidentIdFor`
   still hashes `type|entity|change_point`. On a cold start with no stored
   incident, two runs that disagree about the top driver mint two different ids
   for what dedup considers the same incident. I have **not** touched this:
   fixing it changes `inc_5b393334`, which is in `docs/HANDOFF.md`, the demo
   script and the deployed D1 overlay. Post-hackathon.

3. **A resolved incident can still be alerted on.** `POST /api/alerts/send`
   picks `primary_incident` without consulting `status` or `last_notified`, so
   re-texting a resolved incident is one curl away. Documented in
   `docs/AGENT_BEHAVIOR.md` as a rule rather than patched, since the alert route
   is yours.

4. **Child signals include noise.** The demo incident folds in `uber_eats` at
   `+$1/wk`. Every positive contributor becomes a child signal regardless of
   size. Proposal 2 below.

5. **`MIN_POST_CHANGE_WEEKS` guards the burn window, not the narrative.** If the
   alarm lands on the final week, the burn window correctly falls back to
   trailing (and says so via `burn_window_reason`), but the incident summary
   still quotes a post-change rate computed from one or two weeks. Now tested
   and documented; changing it would change what the detector publishes.

6. **`assertCents` is dead code.** Exported from `money.ts`, never called.
   Integer-cents discipline is enforced only by tests.

---

## 4. Doc vs code contradictions (code + tests win)

| Doc says | Code does |
|---|---|
| Contract §11: dedup needs same type **and same entity** | Entity is ignored for `BURN_RATE_SHIFT` on purpose (`c67391b`). Contract text is stale. |
| Contract §6: σ is "a robust estimate based on baseline MAD" | σ is `max(1.4826 × MAD, sigma_floor_fraction × median)`. The floor is undocumented in the contract and, on a flat baseline, is the *entire* estimate. |
| Contract §2 still says 16–20 weeks | The generator produces `DEMO.WEEKS` = 52; the code accepts ≥ 8. |
| PRD §9: statement reconciliation is P1 | Shipped in P0 — the real opening-balance check is live. |
| `BUILD.md` Phase 1 checkboxes unchecked | All of it is built. |
| `HANDOFF.md` §5: "`npm run verify` must print ALL CHECKS PASSED" | True only on macOS/Linux until the fix in 1.1. |
| `config.ts` reads as runtime thresholds | `CHANGE_POINT_TOLERANCE_WEEKS` and `CONTRIBUTOR_SUM_TOLERANCE` are test-only assertion tolerances with no production reference. Worth a comment. |
| `DEMO.SECONDARY_DRIVER_ENTITIES` includes `ashby` | The generator never ramps Ashby. It reads as a driver only because its three charges happen to land at weeks 11/14/17, after the change at week 10. Move either constant and that silently stops being true. |

---

## 5. Threshold rationale

Every value in `config.ts`, and why it is that number rather than another.

| Constant | Value | Why |
|---|---|---|
| `WEEKS_PER_MONTH` | 52/12 | Calendar-exact. 4-week months understate monthly burn by 7.7%. |
| `k_factor` | 0.5σ | Standard CUSUM slack: tuned to detect a 1σ shift fastest. |
| `h_multiplier` | 6σ | Measured, not assumed: 24%/yr false-alarm rate on a flat company, 96.7% detection of the planted shift, zero median lag — and byte-identical demo output to 4σ, so the cut was free. (Was 4σ; adopted in `c251c1f`.) |
| `min_baseline_weeks` | 8 | Smallest sample where median/MAD are stable; leaves 44 of 52 weeks to detect in. |
| `sigma_floor_fraction` | 2% | **Proposal 1 — raise to 5%.** |
| `MIN_POST_CHANGE_WEEKS` | 4 | One odd week weighs ≤25% of the window; matches a monthly billing cycle. |
| `TRAILING_WINDOW_WEEKS` | 8 | Two payroll cycles and two invoice cycles. |
| `MIN_PRIOR_VENDOR_PAYMENTS` | 3 | The fewest payments whose median survives one outlier. |
| `ONE_OFF_MEDIAN_MULTIPLE` | 3× | Beyond any plausible usage swing (±50%), so it catches annual renewals and bulk purchases rather than a busy month. |
| `ONE_OFF_MIN_ABS_DIFF_CENTS` | $2,000 | The smallest amount a seed-stage founder would act on. Kills the $30 → $120 multiple. |
| `MIN_MONTHLY_DELTA_CENTS` | $5,000 | ≈3% of this company's monthly net burn — a real line item, not drift. |
| `MIN_BURN_PERCENT` | 5% | Scale-free twin of the dollar rule, so the detector still works at a different company size. |
| `MIN_RUNWAY_IMPACT_MONTHS` | 0.5 | The smallest change that moves a fundraise date. |
| `MIN_ONE_OFF_AMOUNT_CENTS` | $5,000 | ≈ one day of burn. |
| `MIN_ONE_OFF_BURN_PERCENT` | 3% | Lower than the 5% rate rule on purpose: a single payment is cheap to verify, a sustained trend is expensive to misread. |
| `INCIDENT_DEDUP_WEEKS` | 2 | How far the CUSUM change-point estimate actually wanders as weeks arrive (detection lag here is 3 weeks). |
| `CHANGE_POINT_TOLERANCE_WEEKS` | 2 | Test tolerance: a 3-week ramp legitimately lands the estimate early. |
| `CONTRIBUTOR_SUM_TOLERANCE` | 2% | Test tolerance, far above per-entity rounding. |
| `SEVERITY HIGH` | 1.5 months | Losing a quarter of runway is a bridge-round conversation. |
| `SEVERITY MEDIUM` | 0.5 months | Same as the materiality floor, so nothing material is ever LOW. |

---

## 6. Proposals needing your sign-off

### Proposal 1 — raise `sigma_floor_fraction` from 0.02 to 0.05

`sigma_floor_fraction` looks like a divide-by-zero guard. It is not: when a
baseline has no dispersion (a company on flat monthly contracts), the floor
becomes the **entire** σ estimate, and h is then `6 × 2% = 12%` of the median.
A single week 10% above normal alarms on its own. Test:
`cusum.test.ts` › "alarms on a single modest week once the sigma floor is the
only dispersion estimate".

At 5%, h is 30% of the median — still sensitive, no longer trigger-happy.

**No effect on the demo:** the demo's real σ is $1,125.58 on a median of
$15,471.00, i.e. 7.3%, which is already above both floors. I verified this:
`npm run verify` is byte-identical either way. This is purely about the first
real customer whose spending is flatter than Perch Analytics'.

```diff
-  sigma_floor_fraction: 0.02,
+  sigma_floor_fraction: 0.05,
```

### Proposal 2 — stop folding noise into child signals

```diff
+/** A contributor below this share of the total delta is noise, not a driver. */
+export const MIN_CHILD_SIGNAL_SHARE = 0.02;
```

The demo incident currently lists `uber_eats` at `+$1/wk` as a contributing
driver "folded into this incident". It is rounding, and it costs credibility in
a Q&A. Filtering `child_signals` at 2% of the total delta drops `uber_eats`
(0.03%) and keeps everything from `pilot` (1.2%) upward — actually it drops
`notion` (0.5%), `pilot` (1.2%) and `uber_eats` too, leaving the five real
drivers. `contributors` keeps every entity, so nothing is hidden from the
drivers table or the API; this only affects what Canary *narrates* as a driver.

Headline numbers do not move. Child signals are not part of any verify assertion.

### Proposal 3 — run `npm run verify` in CI

Now that the command actually runs, the contract §15 assertions are worth
enforcing. One line in `.github/workflows/deploy.yml` after `npm test`:

```yaml
      - run: npm run verify
```

It is offline and deterministic (it reads the committed caches), so it needs no
secrets.

### Proposal 4 — surface the what-if reason in the UI

The reason reaches voice and every API/tool caller today. The web what-if panel
shows numbers only, so a founder who types a fixed-category vendor still sees
four zeros and no explanation. One additive field fixes that:

```diff
   runway_delta_months: number | null;
+  /** Why the scenario changed nothing, already phrased for a reader. Null when it did. */
+  no_change_reason?: string | null;
```

`apps/api` already computes the string (`noChangeExplanation`); it would just
stop throwing it away, and `WhatIfPanel.tsx` renders it under the tiles. Purely
additive — every existing consumer keeps working untouched.

### Also proposed, lower priority

- One-off severity `HIGH` when the amount is ≥25% of monthly gross burn. Today
  every material one-off is `MEDIUM`, so a $500,000 mistaken wire and a $14,055
  Figma upgrade look equally urgent. Figma at 6.6% stays MEDIUM.
- Mark `CHANGE_POINT_TOLERANCE_WEEKS` and `CONTRIBUTOR_SUM_TOLERANCE` as
  test-only in `config.ts`.

---

## 6b. Built after the audit

### Recurring-charge drift (`542884b`) — third detector, PRD §29 P1

`detectRecurringDrift(ledger, burn)` in `packages/detectors/src/recurring-drift.ts`.

The gap it closes: Datadog went from $3,959.25 to $5,721.50 across monthly
charges and **neither existing detector could see it**. The one-off rule asks
"was this payment unusual?" — every charge is normal next to the one before it.
CUSUM sees the aggregate but attributes it to a week, not to a bill.

Method, same shape as `one-off.ts`: group by vendor, compare the median of the
earlier half of its charges against the later half, so no single invoice can
move both sides. Fires at >= 40% (PRD's wording) **and** >= $1,000/month of real
cost, so +100% on a $9 seat stays quiet.

It reports **dollars per charge, not per week** — deliberately. Contributor
decomposition already owns the weekly rate; a second weekly number would read as
a contradiction. "$3,959 → $5,722 per charge" is complementary, and it is what
the invoice says.

`attachDriftSignals` implements contract §10 grouping including the
**time-overlap clause that had no implementation**: a drift joins a parent
incident only when its entity is in that incident's contributors AND its last
charge lands at or after the change point. It enriches the existing child signal
and adds one OBSERVED evidence line. Contributors, rates, severity and summary
are untouched. A drift with no parent creates no incident — `IncidentType` has
no member for it, and inventing one is the duplicate-alerting §10 forbids.

On the demo: exactly one drift (datadog, +45%, $3,959.25 → $5,721.50/charge), folded into
`inc_5b393334`. A new verify assertion covers it.

### Messy statement shapes (`d6089da`) — test profile only

Contract §4 says the test seed may carry reconciliation edge cases. It carried
none, so the engine had only ever been tested against a tidy ledger. Added, all
`profile: "test"`:

- a same-day double-post and the reversal that cancels one leg
- a vendor credit larger than anything that vendor was charged that week
- a paper check to a person (`CHECK 1042 J MORALES`)
- descriptors that identify nothing (`ACH DEBIT 0392481`, `ONLINE PAYMENT THANK YOU`)
- an internal transfer whose other leg never arrives
- a pending authorisation in the final week that never settles

`packages/pipeline/src/messy-profile.test.ts` proves what survives: cash closes
on the bank balance to the cent; the double-post plus reversal nets to exactly
one charge with both debits kept as real rows (the engine never guesses which
was the mistake); the over-credit drives that vendor's week negative rather than
clamping at zero, which would overstate burn; check and anonymous descriptors
reach Needs Review and still count; the never-settled pending row counts; the
orphan leg is counted and warned about. CUSUM still finds the shift and only the
planted one-off is flagged.

The demo profile is asserted clean of every one of these shapes, and its 626
transactions are unchanged.

### What-if now says why (`d827134`)

Closes the P1 gap in HANDOFF §6, and fixes a bug the messy profile exposed:
scaling a **negative** weekly figure (credits outweighing charges) by
`1 + pct/100` moves it toward zero, so "20% lower" reported burn **rising**.

Split by what each layer can honestly know. The engine returns
`ZERO_PERCENTAGE` / `NOT_MONITORED` / `NO_SPEND_TO_CHANGE`; `BurnSummary` carries
only monitored variable spend, so it genuinely cannot tell a fixed-category
vendor from one never seen, and it does not pretend to. `apps/api` has the full
derived object and refines `NOT_MONITORED` into the case that matters:

> "Gusto payroll is payroll, which Canary treats as fixed rather than variable
> spend, so this scenario does not move modeled burn."

versus

> "I have no spending on record for Acme Widgets, so there is nothing to model."

One means "that's payroll", the other means "check the spelling".

**This is the one place a shared change would still help** — see Proposal 4.

---

## 6c. The detector alarmed on growth itself

The defect Alfredo caught, and the most important thing in this document.

Canary measured every week against the **median of the first eight weeks**. A
company that grows sits above that median every week forever, so the statistic
climbs on the growth and alarms on it. Measured over 300 randomised 52-week
series: a growing company false-alarmed **99% of the time**, typically around
week 18, regardless of growth rate. Canary would have told nearly every
real startup that its spending pattern had shifted when the company was simply
getting bigger as planned.

That is not a property of our demo data. It is the product being wrong.

**The fix: measure against the trend the baseline established, not its median.**
Growth that was already there is expected and produces no signal; a departure
from it still does.

Three things had to be right at once, and only the first is obvious:

1. **The trend has to be fitted multiplicatively.** Growth compounds, so a
   straight line falls behind in the tail and leaves exactly the rising residual
   a change detector is built to catch. Fitted in log space, constant percentage
   growth is a straight line.
2. **Residuals have to be relative.** Absolute week-to-week variation grows with
   the level, so a σ measured early is too small later and ordinary noise starts
   clearing the threshold. Log space gives this for free.
3. **The slope needs a long window and a significance bar.** The standard error
   of a slope falls off as the window length to the power of 1.5, so eight weeks
   cannot separate 0.7%/week growth from 7% weekly noise. The trend window is
   half the series, and a slope that does not clear `trend_significance_z`
   standard errors is treated as flat rather than extrapolated. I learned this
   the hard way: my first attempt used a weaker guard, believed a noise-driven
   slope, and moved the demo's alarm from July to February.

A flat company yields a zero slope and behaves exactly as before, so nothing is
lost on a business that is not growing. The demo's alarm week, change point and
contributors are unchanged; σ moved by 0.1%.

### Measured, over 300 randomised 52-week series per setting

| Series | Before | After |
|---|---|---|
| Growing 1–8%/month, no real shift | 99% false alarm | 40% |
| Flat, no real shift | 29% | 31% |
| Growth plus a real shift | detected, change point wrong 99% of the time | detected 99%, change point within ±2 weeks |

After the fix a growing company false-alarms at **the same rate as a flat one**.
Growth is no longer a systematic cause.

### What that leaves, and a proposal

*(Written while `h` was still 4σ. Proposal 5 below was adopted, so `h` is 6σ
today and the shipped false-alarm rate is the 24% row of the table. The
reasoning is kept because it is what the decision was made on.)*

The residual ~30%/year false-alarm rate was not growth. It was the `h = 4σ`
decision interval, and it matched theory: for `k = 0.5σ, h = 4σ` the expected
run length to a false alarm is ~170 weeks, which over 52 weeks is ~26%. The
rationale I wrote in §5 was asserted from textbook values; it is now measured,
and it was right.

Whether 4σ was the right choice is a product decision, and it is Alfredo's. The
trade, on the same harness:

| `h` | False alarm, flat | Detected | Median lag |
|---|---|---|---|
| 4σ | 31% | 98.7% | 0 weeks |
| 5σ | 26% | 97.3% | 0 weeks |
| 6σ | 24% | 96.7% | 0 weeks |
| 8σ | 19% | 96.0% | 1 week |

**Proposal 5 — adopted.** `h_multiplier` is now 6. Before adopting it I measured
the one thing that made it look risky: on the demo ledger the alarm week, change
point, detection lag and therefore the incident id are byte-identical at 4σ and
6σ, on every day the demo clock can reach — the planted shift clears both
thresholds in the same week. So the false-alarm resistance was free, and the
only visible change is the honest one: the threshold the WHY message and the
Why-flagged panel quote.

---

## 7. What runs green

```
npm run typecheck   all workspaces, no errors
npm test            1,281 tests, 4 skipped
npm run verify      22 checks, ALL CHECKS PASSED (on Windows, finally)
```

Demo numbers, unchanged throughout:

| | |
|---|---|
| cash | $2,012,880.19 |
| monthly net burn | $163,481.89 (POST_CHANGE_SEGMENT, 2026-06-29..2026-09-13) |
| runway | 12.3 months (17 before the shift) |
| CUSUM | σ $1,125.58 · k $562.79 · h $6,753.51 · alarm 2026-07-20 · change point 2026-06-29 · lag 3 weeks |
| variable spend | $15,403.41 → $19,374.12 /wk (+$3,971/wk) |
| primary driver | aws +$3,144/wk |
| one-off | figma $14,055.00 = 12.0× median $1,171.09 |
| incidents | `inc_5b393334` · `inc_40e99e9c` |

Every commit above was gated on those numbers being byte-identical. The only
deliberate change to what an incident *contains* is the drift signal folded into
`inc_5b393334` (one enriched child signal, one extra OBSERVED evidence line) —
no rate, impact, severity or summary moved.
