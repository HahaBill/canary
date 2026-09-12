# Detector & engine audit — findings, fixes, open proposals

Owner: Alfredo (behaviour and logic). Audience: Bill.
Date: 2026-09-12. Baseline commit: `c0c4399`.

This is the written record of the detector/engine audit. It lists what was
broken, what I changed, what I deliberately did **not** change, and the three
proposals that need your sign-off because they touch `packages/shared`.

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
| Contract §2: generator produces 16–20 weeks | Code accepts ≥ 8. |
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
| `h_multiplier` | 4σ | ARL₀ ≈ 170 weeks — a false alarm roughly every 3 years — while still catching a 2σ shift in ~3 weeks. |
| `min_baseline_weeks` | 8 | Smallest sample where median/MAD are stable; leaves 12 of 20 weeks to detect in. |
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
becomes the **entire** σ estimate, and h is then `4 × 2% = 8%` of the median.
A single week 10% above normal alarms on its own. Test:
`cusum.test.ts` › "alarms on a single modest week once the sigma floor is the
only dispersion estimate".

At 5%, h is 20% of the median — still sensitive, no longer trigger-happy.

**No effect on the demo:** the demo's real σ is $1,123.95 on a median of
$15,470.83, i.e. 7.3%, which is already above both floors. I verified this:
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

### Also proposed, lower priority

- One-off severity `HIGH` when the amount is ≥25% of monthly gross burn. Today
  every material one-off is `MEDIUM`, so a $500,000 mistaken wire and a $13,827
  Figma upgrade look equally urgent. Figma at 6.5% stays MEDIUM.
- Mark `CHANGE_POINT_TOLERANCE_WEEKS` and `CONTRIBUTOR_SUM_TOLERANCE` as
  test-only in `config.ts`.

---

## 7. What runs green

```
npm run typecheck   all workspaces, no errors
npm test            535 tests
npm run verify      21 checks, ALL CHECKS PASSED (on Windows, finally)
```

Demo numbers, unchanged throughout:

| | |
|---|---|
| cash | $2,012,880.19 |
| monthly net burn | $160,328.74 (POST_CHANGE_SEGMENT, 2026-06-29..2026-09-13) |
| runway | 12.6 months (17.5 before the shift) |
| CUSUM | σ $1,123.95 · k $561.98 · h $4,495.81 · alarm 2026-07-20 · change point 2026-06-29 · lag 3 weeks |
| variable spend | $15,352.18 → $19,479.09 /wk (+$4,127/wk) |
| primary driver | aws +$2,999/wk |
| one-off | figma $13,827.00 = 12.0× median $1,152.14 |
| incidents | `inc_5b393334` · `inc_079155c3` |
