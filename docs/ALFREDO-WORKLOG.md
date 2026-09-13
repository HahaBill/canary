# Alfredo's worklog — everything, in order, checkable

Bill: this is the review entry point for all of my work on `main`, Saturday
evening through Sunday morning. Twenty-three commits. Every claim below has a
command next to it; nothing needs to be taken on my word.

The deep dives live in three companion docs:

| Doc | Covers |
|---|---|
| `docs/ALFREDO-LOGIC-AUDIT.md` | Detector/engine audit, threshold rationale, measurements, proposals |
| `docs/AGENT_BEHAVIOR.md` | The speech contract every surface follows (you already built `policy.ts` from §1) |
| `docs/SYNTHETIC-DATA.md` | The year of history and the moving clock, decision by decision |

## Verify all of it in three commands

```text
npm run typecheck && npm test     1,335 passing, 4 skipped, offline
npm run verify                    ALL CHECKS PASSED
npm run build                     SPA into apps/api/public
node scripts? no — the golden path: see "Production dry run" at the bottom
```

---

## The commits, oldest first

| Commit | What | Where |
|---|---|---|
| `c8915b6` | `npm run verify` had never run on Windows: the `import.meta.url` guard can't match there, so it printed nothing and exited 0 — a silent pass. `pathToFileURL` fix. | `packages/pipeline/src/verify.ts` |
| `9ba75e9` | Detector audit: 27 edge-case tests written first, one real bug fixed — `decomposeContributors` on a change point of −1 published each entity's full-series average as its *delta*. Masked in prod, but exported contract surface. | `packages/detectors`, `packages/engine` tests |
| `49f8a40` | `docs/AGENT_BEHAVIOR.md`, and WHY now names the rule that fired with its parameters. Wording only; every figure still comes from the incident object. | `apps/api/src/messages.ts` |
| `542884b` | Third detector: recurring-charge drift. Median of a vendor's earlier charges vs later ones, so no single invoice moves both sides. Speaks in $/charge, not $/week, so it complements the contributor rates instead of contradicting them. Folds into the burn incident per contract §10 — including the time-overlap clause that had no implementation. Demo: Datadog $3,959.25 → $5,721.50/charge, +45%. | `packages/detectors/src/recurring-drift.ts`, `incidents.ts`, `pipeline/run.ts`, one new verify check |
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
| `2b20b17` | **The 2027 leak.** The iMessage agent answered a transactions question with rows dated 2027. The generator's 26-week horizon exists to feed the clock, but `getTransactions()` was handing the whole list to the bank endpoint and the agent's `list_transactions` tool. Clipped at the exact `asOf` — not `ledger.history_end`, which the engine widens to the week's Sunday and would still have leaked six days. The chat's system prompt was also told "today" from the wall clock while its data came from the demo clock; it now states the ledger's own date. | `apps/api/src/data/pipeline-provider.ts`, `conversation/prompt.ts` |
| `953ce80`, `680c908`, `d68293a`, `d4bc5fc` | **Rho.** Measured the sandbox first: 72 transactions over three years, ending 2026-06-27, $258K across 14 accounts. It cannot carry the demo — no weekly series for CUSUM, no planted shift, no one-off, no unknown vendor. So the demo keeps its synthetic year and the integration is real anyway: a genuine client for docs.rho.co v1 (bearer auth, `next_page_token`, date filters) that needs **no credentials** against the sandbox. The mapping of Rho's 22 transaction types onto flow types is the reconciliation judgement, each line reasoned. `GET /api/bank/rho` runs our engine over live Rho data and reconciles to 0. Then Alfredo's schema question found a gap in my own mapper: Rho's `money_movement_id` IS our `transfer_pair_id` and I was not mapping it. Finally `assessCoverage()` reports what could be VERIFIED vs assumed, after I tested and rejected reconstructing settlement coverage (the amounts do not reconcile — a wrong cross-check is worse than none). | `apps/api/src/bank/rho.ts`, `rho.test.ts`, `rho-brain.test.ts`, `routes/data.ts` |
| `4dda942` | **One date on screen, not two.** Found by opening the deployed dashboard: the banner read "as of Sep 20" while the CASH card captioned the same balance "Sep 13". The card uses `company.as_of`, which was not moving with the clock. | `packages/pipeline/src/run.ts` |
| `c251c1f` | `h_multiplier` 4σ → 6σ **after measuring it demo-identical**: alarm week, change point, lag and incident id byte-equal at 4 and 6 on every clock day, so the false-alarm cut (31% → 24%/yr, detection 98.7% → 96.7%, same zero lag) was free. Also: `DEMO_CLOCK_MINUTES_PER_DAY` Worker var — set `0` in the dashboard to freeze the ledger for the recorded clip, delete to go live; no deploy either way. | `packages/shared/src/config.ts`, `apps/api/src/{env,index}.ts` |
| `09423b4` | **Two projection bugs, both measured.** (a) Burn averaged the week IN PROGRESS — a few days of spend inside a seven-day bucket — so runway jumped **+0.9 months every Monday** and decayed through the week. Burn now reads complete weeks only; the partial week stays in the chart, where drawing it fill up is honest. (b) The account balance shift decided pending/settled supersession from the WHOLE transaction set, including rows dated after `asOf` — so on any day between an authorisation and its settlement it dropped the pending row while `buildLedger` still counted it. Measured: **$731.48 discrepancy on 2026-07-22**, the day the planted Vercel charge is pending. Demo numbers unchanged (Sep 13 is a Sunday; every week complete, nothing mid-flight). | `packages/pipeline/src/run.ts`, new `as-of-projection.test.ts` |
| `3c25858` | **The live stream is now actually visible, and stops fighting the user.** Seven render gates asked `if (loading)` before `if (!data)` — which threw away the stale-while-revalidate in `useDerived` and replaced the whole page with skeletons on every 30s heartbeat, resetting the what-if slider mid-drag and cutting the voice note off mid-playback. Every gate now tests for data. Plus `LiveBadge` in the provenance strip on every route: the simulated date, a dot that pulses while a fetch is in flight, and cash movement since the viewer arrived. It re-baselines when the 10-minute clock cycle wraps, so it never announces the company earning a week's burn every ten minutes. | `apps/web/src/components/LiveBadge.tsx`, `ProvenanceBanner.tsx`, `AppShell.tsx`, 5 pages |
| `9642188` | Two determinism fixes from review. `mapAccount` stamped `new Date()` while `mapTransaction` beside it correctly took `asOf` — and the engine folds account dates into `reconciliation.as_of`, so the Rho route's report claimed the moment the mapper ran, not the day asked about. And `parseAsOfOverride` re-derived the start of history as `END_DATE - WEEKS*7`; the generator's real first day is `historyStart`, which snaps to the Monday of the earliest week — 363 days before a Sunday, not 364 — so the bound accepted one day with no transactions. | `apps/api/src/bank/rho.ts`, `apps/api/src/clock.ts` |
| `bae2164` | iMessage answers a number configured WITHOUT its country code. Sendblue delivers E.164 (`+17875551234`); what an operator pastes is what was in their contacts (`787-555-1234`). `samePhone` compared raw digit strings, so those were two different numbers — Canary answered nobody and the only evidence was a `sender_not_allowed` log line. The leading NANP `1` is now optional on both sides, and only when exactly ten digits remain, so no other country code can collide. | `apps/api/src/imessage/router.ts` |
| `10bf7e4` | Documentation audited against the code, file by file. The repo was quoting six different test counts and two different values of `h`, and README claimed a block was "verbatim" from `npm run verify` while a figure in it disagreed. Also corrected: two FALSE safety claims in `AGENT_BEHAVIOR.md` (alert rules 3 and 4 are enforced, resolved incidents are not alerted on), the false "nothing in `packages/shared` was edited", five "the live Rho API is not used" lines, and two commit hashes in this file that were pre-rebase and unresolvable. | all docs |
| `b182e44` | **The partial-week bug, where it actually hurt.** `09423b4` fixed burn; CUSUM and the contributor decomposition were still averaging the week in progress. One day into a week the deployed card read "+$2,611/wk, AWS +$2,248/wk, +$11,315/mo" against a true "+$3,971/wk, AWS +$3,144/wk, +$17,206/mo" — a 34% understatement of the demo's headline, healing itself every Sunday, and read aloud by the agent. Demo output byte-identical. | `packages/pipeline/src/run.ts` |

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

## Rho: what a reviewer should know

- The demo does **not** run on Rho and should not. Measured: 72 transactions
  across three years. The commit messages and `apps/api/src/bank/rho.ts`
  carry the numbers.
- `GET /api/bank/rho` is live in production with no credentials and reconciles
  Rho's own data to 0 discrepancy. Set `RHO_API_KEY` and the same code reads
  production.
- Schema fit: `money_movement_id` → `transfer_pair_id` works natively. Rho sends
  no purchase→repayment link and no pending→settled link. Neither breaks
  correctness; both cost a cross-check, and `assessCoverage()` now says so
  rather than letting "assumed" look like "checked".
- **Open question for production:** when a Rho authorisation settles, does the
  same `id` flip status or does a second row appear? In-place is safe. A second
  row needs `pending_of` or burn is overstated by every pending charge. A static
  sandbox cannot answer it.
- Every doc that said "the live Rho API is not used, per hackathon guidance" now
  says what is actually true: the DEMO does not run on Rho, and a real Rho client
  exists at `GET /api/bank/rho` against the public **sandbox**, which needs no
  credentials. Somebody should still confirm that distinction with the organisers
  before leaning on it in the pitch.

## Is the continuous stream actually working? Measured, not asserted

Yes. The table below is the whole 10-day clock cycle, produced by running the
pipeline at each simulated day and by probing the deployed Worker. Local and
production agree to the cent (prod at simulated Sep 16 returned
`cash=$2,007,542.41`; prod at Sep 18 returned `$2,005,370.89` — both exactly the
local figures).

| Clock day | Simulated date | Cash | Burn / mo | Runway | Window |
|---|---|---|---|---|---|
| +0 | 2026-09-13 | $2,012,880.19 | $163,481.89 | 12.3 | 11 wk |
| +1 | 2026-09-14 | $2,007,112.29 | $163,481.89 | 12.3 | 11 wk |
| +2 | 2026-09-15 | $2,019,944.43 | $163,481.89 | 12.4 | 11 wk |
| +3 | 2026-09-16 | $2,007,542.41 | $163,481.89 | 12.3 | 11 wk |
| +4 | 2026-09-17 | $2,005,857.54 | $163,481.89 | 12.3 | 11 wk |
| +5 | 2026-09-18 | $2,005,370.89 | $163,481.89 | 12.3 | 11 wk |
| +6 | 2026-09-19 | $2,005,370.89 | $163,481.89 | 12.3 | 11 wk |
| +7 | 2026-09-20 | $2,005,370.89 | $153,119.68 | 13.1 | 12 wk |
| +8 | 2026-09-21 | $2,001,132.20 | $153,119.68 | 13.1 | 12 wk |
| +9 | 2026-09-22 | $2,015,399.21 | $153,119.68 | 13.2 | 12 wk |
| +10 | 2026-09-23 | $2,002,958.36 | $153,119.68 | 13.1 | 12 wk |

Read it as three separate claims.

**Cash moves every day, and moving UP some days is correct.** Revenue lands
weekly, spend lands daily, so day +2 and day +9 end richer than the day before.
I pushed a red test earlier in the week for asserting cash falls monotonically;
it does not, and should not. Reconciliation is exact (`discrepancy_cents = 0`)
on every one of these days, and on weekly samples across the entire generated
span — `packages/pipeline/src/as-of-projection.test.ts`.

**Every per-week average is now flat WITHIN a week and steps only at a real week
boundary.** That is the `09423b4` fix, extended in `b182e44` from burn to the
CUSUM series and the contributor decomposition — which is where it mattered
most. Measured on the deployed site one day into a week, the incident card read
"+$2,611/wk, AWS +$2,248/wk, +$11,315/mo" against a true "+$3,971/wk, AWS
+$3,144/wk, +$17,206/mo": a **34% understatement of the headline the whole demo
rests on**, healing itself every Sunday, and read aloud by the agent. A
seven-day bucket holding one day of spend is not a low week, it is an unfinished
one. The one-off and drift detectors deliberately keep the full ledger: they
read dated transactions, never weekly averages, and a charge that posted is a
real event whether or not its week has finished. Before it, burn averaged the week in progress — a few days
of spend inside a seven-day bucket — and runway jumped about +0.9 months every
Monday, then decayed through the week.

**The remaining +0.8-month step at day +7 is a measurement artifact, and I know
exactly what causes it.** It is not the company spending less. The post-change
burn window is "every complete week since the change point", so it GROWS one
week at a time — 11 weeks, then 12. Payroll runs biweekly. I counted: the
11-week window and the 12-week window contain **the same 8 payroll runs**, so
payroll density falls from 0.727 to 0.667 runs per week and the mean dilutes by
about 6%. Any averaging window whose length is not a whole number of pay cycles
does this.

I did NOT change it, on purpose. Fixing it means changing how the burn window
is chosen, which changes the demo's headline runway figure — the number in the
README, in HANDOFF, and in the recorded video — a few hours before submission.
That trade is not worth it. The fix for after the hackathon is in "Open
decisions" below.

**For judging, freeze the clock.** Set the Worker var
`DEMO_CLOCK_MINUTES_PER_DAY=0` in the Cloudflare dashboard; the ledger pins to
the end of history and every documented figure is exactly what is on screen. No
deploy needed either way — delete the var to go live again. With it frozen, the
day +7 step cannot occur at all.

## Where the stream is VISIBLE, not just working

Two problems made a working stream look like a broken page. Both fixed in
`3c25858`.

1. **The page tore itself down twice a minute.** Seven render gates asked
   `if (loading)` before `if (!data)`. `useDerived` is stale-while-revalidate on
   purpose: it sets `loading: true` while KEEPING the previous data, so a
   refresh is invisible. Gating on `loading` threw that away and swapped the
   whole subtree for skeletons on every heartbeat — which reset the what-if
   slider mid-drag and cut the incident voice note off mid-playback. Every gate
   now tests for data. `IncidentPage` keeps a skeleton for a genuine first load
   (`!data && loading`) so a real 404 still reaches NotFound.

2. **Nothing said the account was moving.** A number that was slightly different
   a minute ago is indistinguishable from a page that never changes.
   `LiveBadge` now sits in the provenance strip on every route: the simulated
   date, a dot that pulses while a fetch is in flight, and cash movement since
   the viewer arrived. It does no money math beyond subtracting two integer-cent
   readings the API returned, formatted by the shared helpers.

   Its one real rule is the wrap case. The clock runs a loop and
   then returns to the end of history, so cash jumps back up. Measured naively
   the badge would announce the company earning a week's burn every loop.
   A backwards date re-baselines instead and says "clock restarted".
   `advanceLive` is a pure function with its own tests.

## The clock no longer claims to know the future

Bill caught this by looking at a calendar: the dashboard said "Canary Sandbox
Bank balance as of Sep 20" while Sep 20 had not happened yet. He was right, and
it is not a cosmetic problem. `DEMO.END_DATE` is 2026-09-13, which is both the
last day of generated history AND a real date, so a clock that advanced PAST it
was stating a balance that does not exist. Nobody's bank knows next week's
balance.

**The clock now walks the last ten days of history and ENDS on 2026-09-13.** It
is the same amount of motion, in the same direction, revealing a day at a time —
it just runs up to today instead of past it. Measured across the whole loop:

| Simulated day | Cash | Burn / mo | Runway | Reconciles |
|---|---|---|---|---|
| 2026-09-04 | $2,071,252.51 | $165,465.04 | 12.5 | exact |
| 2026-09-06 | $2,069,694.39 | $156,141.48 | 13.3 | exact |
| 2026-09-08 | $2,081,065.54 | $156,141.48 | 13.3 | exact |
| 2026-09-11 | $2,015,585.04 | $156,141.48 | 12.9 | exact |
| **2026-09-13** | **$2,012,880.19** | **$163,481.89** | **12.3** | exact |

Three things that matter for the demo fall out of this:

- **Nothing on any surface can name a day that has not happened.** Asserted at
  the clock level every quarter-minute across four loops, and again end to end
  on the provenance date, the company profile, every account and the latest
  transaction the bank endpoint will list.
- **The loop ENDS on the documented day.** The last thing on screen before it
  restarts is exactly the state the README, this worklog and the demo script
  quote, so the numbers a judge reads match the numbers we wrote down.
- **Cash still moves every tick, and sometimes upward.** Revenue lands weekly.
  Sep 8 ends richer than Sep 7 and that is correct, not a glitch.

**Speed.** A simulated day now takes 30 seconds instead of 60, and the SPA
refreshes every 7 seconds instead of 30. The old 30s heartbeat was half the
reason the app "looked like a placeholder": watch it for twenty seconds and
nothing happened, because the page was lagging the backend by most of a
simulated day. Refreshes are invisible either way, since the data on screen is
kept until the new data lands.

## Three stale rows in the iMessage log, visible on the dashboard

The dashboard's CONVERSATION strip is real two-way traffic read from D1, not
canned copy — which is the strongest proof the app is not a placeholder, and
also means it still shows what we texted it while things were broken. Three rows
a judge can read right now say things that are no longer true:

| id | What it says | Why it is wrong |
|---|---|---|
| 29, 30 | "1. Mar 14, 2027 - Card settlement…" | The 2027 leak, before `2b20b17` clipped the horizon |
| 25 | "runway would increase from 12.6 months to 13.7" | Runway is 12.3 |
| 23 | "$15,352 → $19,479 … AWS +$2,999/wk" | Now $15,403 → $19,374, AWS +$3,144/wk |

No new message can say any of that. These are stored rows from before the fixes,
and clearing them needs D1 access I do not have:

```text
npx wrangler d1 execute canary --remote   --command "DELETE FROM imessage_log WHERE id IN (23,25,29,30)"
```

Texting the line fresh would regenerate a correct conversation, but sending is
outward-facing, so that is a decision for whoever is holding the phone.

## Two things only someone with Cloudflare access can do

I have no Cloudflare token on this machine, and both of these are settings on
the deployed Worker rather than code, so they are yours. Neither needs a deploy.

1. **`ALLOWED_PHONES` — add Alfredo's number, `787-628-9072`.** Canary only
   replies to `FOUNDER_PHONE` plus this comma-separated list; everyone else is
   logged and ignored. Since `bae2164` the format no longer matters — a number
   written `787-628-9072`, `+17876289072` or `(787) 628-9072` all match, because
   the leading North American `1` is optional on both sides. Before that commit
   the un-prefixed spelling silently matched nothing, which is worth knowing if
   anyone tests with an older deploy.

2. **`DEMO_CLOCK_MINUTES_PER_DAY=0` during judging.** Freezes the ledger at the
   end of history, so every figure in the README, in HANDOFF and in the video is
   exactly what is on screen, and the day +7 burn step in the table above cannot
   happen while a judge is watching. Delete the var to go live again.

## Open decisions, yours

- **Sigma floor 2% → 5%** (audit proposal 1) — still open; h=6σ softened the
  symptom (a flat-baseline single-week alarm now needs +13%, was +9%).
- **`MIN_CHILD_SIGNAL_SHARE`** so `+$1/wk` contributors aren't narrated (prop. 2).
- **`npm run verify` in CI** (prop. 3) — one line after `npm test`; offline.
- **`WhatIfResult.no_change_reason`** additive field so the web panel can show
  what voice already says (prop. 4).
- **Post-hackathon: the growing burn window.** POST_CHANGE_SEGMENT grows one
  week at a time while payroll is biweekly, so the mean dilutes ~6% whenever a
  payroll-free week joins a window that already holds every payroll run
  (measured above: 8 runs in both the 11- and 12-week window). Two candidate
  fixes: grow the post-change window in whole pay cycles, or slide a
  fixed-length window forward instead of growing it. Either changes the
  headline runway figure, so it is your call, not a hackathon-night change.
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
