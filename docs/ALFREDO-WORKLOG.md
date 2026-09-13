# Alfredo's worklog — everything, in order, checkable

Bill: this is the review entry point for all of my work on `main`, Saturday
evening through Sunday ~1:30 AM. Sixteen commits. Every claim below has a
command next to it; nothing needs to be taken on my word.

The deep dives live in three companion docs:

| Doc | Covers |
|---|---|
| `docs/ALFREDO-LOGIC-AUDIT.md` | Detector/engine audit, threshold rationale, measurements, proposals |
| `docs/AGENT_BEHAVIOR.md` | The speech contract every surface follows (you already built `policy.ts` from §1) |
| `docs/SYNTHETIC-DATA.md` | The year of history and the moving clock, decision by decision |

## Verify all of it in three commands

```text
npm run typecheck && npm test     1,202 tests, offline
npm run verify                    22 checks, ALL CHECKS PASSED
node scripts? no — the golden path: see "Production dry run" at the bottom
```

---

## The commits, oldest first

| Commit | What | Where |
|---|---|---|
| `c8915b6` | `npm run verify` had never run on Windows: the `import.meta.url` guard can't match there, so it printed nothing and exited 0 — a silent pass. `pathToFileURL` fix. | `packages/pipeline/src/verify.ts` |
| `9ba75e9` | Detector audit: 27 edge-case tests written first, one real bug fixed — `decomposeContributors` on a change point of −1 published each entity's full-series average as its *delta*. Masked in prod, but exported contract surface. | `packages/detectors`, `packages/engine` tests |
| `49f8a40` | `docs/AGENT_BEHAVIOR.md`, and WHY now names the rule that fired with its parameters. Wording only; every figure still comes from the incident object. | `apps/api/src/messages.ts` |
| `542884b` | Third detector: recurring-charge drift. Median of a vendor's earlier charges vs later ones, so no single invoice moves both sides. Speaks in $/charge, not $/week, so it complements the contributor rates instead of contradicting them. Folds into the burn incident per contract §10 — including the time-overlap clause that had no implementation. Demo: Datadog $3,782 → $6,026/charge, +59%. | `packages/detectors/src/recurring-drift.ts`, `incidents.ts`, `pipeline/run.ts`, one new verify check |
| `d6089da` | Messy statement shapes, **test profile only**: same-day double-post + reversal, credit larger than the charge, `CHECK 1042 J MORALES`, anonymous `ACH DEBIT`, orphan transfer leg, never-settling pending. End-to-end assertions that cash stays exact and detectors don't hallucinate. Demo profile asserted untouched. | `packages/generator`, `packages/pipeline/src/messy-profile.test.ts` |
| `d827134` | What-if says *why* nothing changed (payroll vs typo vs credits), and no longer inverts a negative balance — "20% lower" on net credits used to report burn RISING. | `packages/engine/src/whatif.ts`, `apps/api/src/speech.ts` |
| `fb10bf6` | Docs sync. | `docs/` |
| `4ae7355` | **A year of history.** 52 weeks, 626 transactions. Growth lives in payroll (fixed) and revenue (inflow); the monitored series stays flat until the planted shift — see the growth-detector commit below for why that later became unnecessary. Fixture positions became weeks-before-end. `raised_cents` $3M → $5M so the opening balance is affordable. **Found and fixed a real bug in your `projectRecurring`: median over the whole history projected payroll at $37,901 when the last six runs were $48,000. Now `RECURRING.RECENT_OBSERVATIONS`.** | `packages/generator`, `packages/shared/src/config.ts`, `company.ts`, `packages/engine/src/views/recurring.ts` |
| `1e65748` | **The moving clock.** Generator emits a 26-week horizon past history; `runPipeline({ asOf })` projects the ledger to any day; the bank reports its balance as of the same day. Anchor untouched: it binds at end of history, so every existing assertion holds. Measured across five simulated months: `discrepancy_cents` 0 at every point while cash fell $2,139,954 → $1,490,739. | `packages/generator`, `packages/pipeline/src/run.ts`, `apps/api/src/clock.ts`, `data/pipeline-provider.ts` |
| `5031bde` | Clock drift capped at 10 days. Found by watching prod: the 3-hour cycle had drifted the live site to Dec 26. | `apps/api/src/clock.ts` |
| `057e3aa` | My own test pushed red (CI caught it): sampled past one clock cycle, and wrongly asserted cash falls *daily* — revenue lands weekly, so days can end richer. | `apps/api/src/data/live-clock.test.ts` |
| `b6f1bfb` | **The big one. CUSUM no longer alarms on growth itself.** It measured every week against the median of the first eight; a growing company sits above that forever, so over 300 randomised 52-week series it false-alarmed **99% of the time** around week 18. Now each week is measured against the trend the baseline established — fitted multiplicatively (growth compounds; a straight line leaves a rising tail residual), residuals relative (absolute noise grows with the level), slope believed only past `trend_significance_z` standard errors over a half-series window. Growth false alarms: 99% → 40%, which equals the flat-company rate, so growth is no longer a systematic cause. Flat companies byte-identical. WHY discloses the growth it allowed for. | `packages/detectors/src/cusum.ts`, `packages/shared/src/types.ts` + `config.ts` |
| `d0a3d30` | The SPA now refreshes itself every 30s, stale-while-revalidate so nothing blinks: old numbers stay on screen until new ones land; a failed background refresh keeps the working page and retries. Key changes still reset (different incident = different data). | `apps/web/src/api/useDerived.ts`, `main.tsx` |
| `8576b2a`, `d408f4d` | One-off incident id is `inc_40e99e9c` on the year ledger (hashes the txn id); HANDOFF + README re-quoted verbatim from `npm run verify`. | docs, README |
| `c251c1f` | `h_multiplier` 4σ → 6σ **after measuring it demo-identical**: alarm week, change point, lag and incident id byte-equal at 4 and 6 on every clock day, so the false-alarm cut (31% → 24%/yr, detection 98.7% → 96.7%, same zero lag) was free. Also: `DEMO_CLOCK_MINUTES_PER_DAY` Worker var — set `0` in the dashboard to freeze the ledger for the recorded clip, delete to go live; no deploy either way. | `packages/shared/src/config.ts`, `apps/api/src/{env,index}.ts` |

---

## Every touch on packages/shared — your contract, so check these first

All additive or value-only; no field removed or renamed, no consumer broken.

| File | Change |
|---|---|
| `config.ts` | `DEMO.WEEKS` 20→52 · `CHANGE_START_INDEX` 10→42 · `HORIZON_WEEKS: 26` (new) · `CUSUM_DEFAULTS.h_multiplier` 4→6 · `+trend_window_fraction: 0.5` · `+trend_significance_z: 1.5` · `RECURRING.RECENT_OBSERVATIONS: 6` (new) |
| `types.ts` | `CusumConfig` +2 fields above · `CusumResult` +`baseline_slope_weekly_cents` (required; three constructors updated) |
| `contracts.ts` | `GenerateDemoCompanyOptions` +`horizonWeeks?` (optional) |
| `company.ts` | `raised_cents` $3M→$5M (a year of burn needs a bigger seed) |
| `dates.test.ts`, `fixtures.test.ts` | Span assertions derive from `DEMO.WEEKS` instead of hard-coding 20 |

Every threshold has a one-line rationale in `ALFREDO-LOGIC-AUDIT.md` §5; the
three measured ones (`h_multiplier`, `trend_significance_z`, sigma-floor
proposal) carry their Monte Carlo tables in §6c.

## Where I edited code you wrote

1. `packages/engine/src/views/recurring.ts` — recent-window median (bug above,
   with the failing number in the commit message).
2. `packages/engine/src/views/{pivot,calendar,recurring}.test.ts` and
   `apps/web/src/pages/CalendarPage.test.tsx`, `apps/api/src/routes/views.test.ts`
   — 20-week literals became span-derived. Intent preserved; one assertion
   changed meaning: with a year of data an untagged one-off no longer breaks
   Figma's cadence (12 monthly charges vs 5), so the test now pins the guarantee
   that actually matters — the median expectation is uninflated either way.
3. `apps/web/src/api/useDerived.ts` — stale-while-revalidate inside your
   `useAsyncResource`; your cache/version architecture unchanged, the heartbeat
   just drives it.

## Open decisions, yours

- **Sigma floor 2% → 5%** (audit proposal 1) — still open; h=6σ softened the
  symptom (a flat-baseline single-week alarm now needs +13%, was +9%).
- **`MIN_CHILD_SIGNAL_SHARE`** so `+$1/wk` contributors aren't narrated (prop. 2).
- **`npm run verify` in CI** (prop. 3) — one line after `npm test`; offline.
- **`WhatIfResult.no_change_reason`** additive field so the web panel can show
  what voice already says (prop. 4).
- **Post-hackathon:** `ids.ts` hashes entity into rate-shift ids while your
  dedup ignores entity — cold-start id instability; fixing changes `inc_5b393334`.

## Known limitations, stated on purpose

- Change-point precision under heavy noise: alarm right 99%, exact week within
  ±2 only ~55%. Estimator improvement sketched in the audit.
- A shift starting inside the first half of history is absorbed into the trend
  baseline. Production answer is a rolling reference window; documented.
- The clock cycles every 10 minutes by design; freeze var above for recordings.

## Production dry run (Sunday ~1:20 AM)

17/17 against the live Worker: SPA serves; health-summary reconciled at the
moving clock; year visible; `inc_5b393334` with evidence in taxonomy order,
drift line present, h=$6,753.51, trend field present; `inc_40e99e9c` loads;
what-if −20% AWS correct and labelled; what-if on payroll *explains* the
no-change; agent tool speech present; `/voice` returns `audio/mpeg`; ledger,
calendar and needs-review views 200. Two probes 65s apart showed the account
advance a day with books exact.
