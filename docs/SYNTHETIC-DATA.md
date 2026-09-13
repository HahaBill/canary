# Synthetic data: a year of history and a moving clock

How Canary's data went from a frozen 20-week snapshot to a year of history that
keeps advancing while you watch, and why each decision went the way it did.

Owner: Alfredo. Companion to `docs/DATA_AND_DETECTOR_CONTRACT.md`.

---

## What changed

| | Before | After |
|---|---|---|
| History | 20 weeks | 52 weeks, 2025-09-15 to 2026-09-13 |
| Transactions | 246 | 626 in history, 937 including the future |
| Future | none | 26 weeks generated, un-posted |
| Company | static | 8 people to 14, revenue up to 2.2x |
| Clock | frozen | advances, revealing the future a day at a time |

Everything the demo relies on survives: reconciliation exact to the cent, the
CUSUM alarm, the Figma one-off, the Datadog drift, the Ashby corroboration, and
Needs Review.

---

## The decision that shaped everything else

A year of history sounds like "the same thing, longer". It is not, and the
reason is the detector.

CUSUM baselines on the **first eight weeks** of whatever series it is handed. It
then accumulates every week that sits above that baseline by more than `k`. Feed
it a year in which the company organically grew, and every week after the first
quarter is above a year-old median. The statistic climbs steadily and the alarm
fires on the growth, months before the planted event. The change point it
reports would be an artefact of the company getting bigger.

I checked the arithmetic rather than guessing. At a plausible 3% a month, the
statistic clears `h` around week 23 of the year. The alarm would be real, and
completely uninformative.

There were two honest ways out.

**Detect on a rolling recent window** rather than the whole year. This is what a
production system should do, and it is correct. It also means slicing the series
for the detectors while keeping the full year for the ledger, then re-mapping
every index that comes back: the change point, the statistic array that the
chart aligns to, the decomposition segments, the burn window offset. That is
four places that must agree, at hour twenty of a hackathon, with "no bugs" as an
explicit requirement.

**Put the growth where it does not reach the monitored series.** A seed-stage
company's growth shows up in headcount and revenue long before it shows up in
tooling. Payroll is a FIXED category and revenue is an inflow, so neither enters
the CUSUM series. Variable spend stays flat with noise until the planted shift.

I took the second. It is realistic on its own terms, it needed no index
remapping, and it produces a **better chart**: a visibly stable baseline for ten
months and then a clean break, instead of a noisy upward drift with a step
somewhere inside it. A judge can see the shift without being told where to look.

The first option is still the right long-term answer, and it is written down in
`docs/ALFREDO-LOGIC-AUDIT.md` as the known limitation it is.

---

## What "reasonable" means here

- **Payroll steps four times** over the year, 8 people to 14, rather than
  drifting smoothly. Payroll moves when someone starts, not continuously.
- **Revenue compounds** from 45% of today's rate, about 1.6% a week.
- **A holiday dip** over the turn of the year on the monitored series. A
  one-sided upward CUSUM cannot alarm on a dip, and the demo span's first eight
  weeks begin in mid-September, so the baseline is clear of it regardless.
- **The opening balance is now ~$3.55M**, because a year of burn has to come
  from somewhere. The seed round in the company profile went from $3M to $5M to
  keep the story arithmetically possible.
- **Planted events are positioned as weeks before the end**, not absolute
  indexes. "The shift started ten weeks ago" stays true on a year-long demo span
  and on a 16-week test span. Absolute indexes would have bunched every planted
  event into the first quarter of a year.

---

## The moving clock

The generator now produces `DEMO.HORIZON_WEEKS` of schedule **past** the end of
history. Those rows are ordinary transactions that have not posted yet.

`runPipeline({ asOf })` projects the ledger to a point in time. Rows dated after
it are invisible: not in cash, not in burn, not in any detector. Advancing
`asOf` reveals them one day at a time, which is exactly what a bank feed does.

**The anchor still holds.** The generator closes on the sandbox bank balance at
the **end of history**, not at the end of generation, so every existing
assertion is unchanged. The bank then reports its balance *as of* the same
moment the ledger is projected to, by shifting the closing balance by the rows
between the two dates. Reconciliation is therefore a real check at every instant,
not just at the end of history. Measured across eight simulated dates spanning
five months, `discrepancy_cents` is 0 at every one.

`apps/api/src/clock.ts` maps wall-clock time to a simulated date. It is a pure
function: the same instant always gives the same day, so two Worker isolates
agree and the pipeline stays deterministic in its own `asOf` parameter.

**Why the clock cycles.** Simulated time has to run much faster than real time
or a demo shows nothing moving. Running monotonically from a fixed epoch would
sprint through the horizon within hours and then sit clamped months in the
future, showing a cash position nobody recognises. Anchoring to the top of each
three-hour cycle keeps the picture recent: the clock always starts at the end of
history, advances one simulated day per real minute, and never runs past the
generated horizon. Whenever anyone opens the page, they see today and then watch
it move.

`minutesPerDay: 0` freezes it at the end of history, which is precisely how
Canary behaved before the clock existed. That is the setting for a screenshot or
a recorded clip that has to be reproducible.

A full pipeline run is about 12ms, so the provider simply re-derives when the
simulated day changes rather than maintaining anything clever.

---

## A bug this surfaced

Bill's recurring-charge projection, which feeds the cash calendar, took the
median amount over a vendor's **whole** history. On 20 flat weeks that is right.
On a year in which the company grew, it projected next month's payroll at
$37,901 when the last six runs were all $48,000 — it was projecting the smaller
company the founder used to run, and every upcoming fixed cost on the calendar
would have been understated.

It now takes the median of the most recent `RECURRING.RECENT_OBSERVATIONS`.
Still a median, so one true-up can never inflate it, but it tracks the rate the
company is actually paying.

This is the argument for longer history in one paragraph: the extra data did not
just look better, it found something wrong.

---

## What runs green

```
npm run typecheck   all workspaces, no errors
npm test            1150 tests
npm run verify      22 checks, ALL CHECKS PASSED
```

Demo numbers at the end of history:

| | |
|---|---|
| cash | $2,012,880.19 |
| monthly net burn | $163,481.89 |
| runway | 12.3 months |
| CUSUM | alarm 2026-07-20, change point 2026-06-29, lag 3 weeks |
| variable spend | $15,403 to $19,374 /wk |
| primary driver | aws +$3,144/wk |
| one-off | figma $14,055 = 12.0x median |
| drift | datadog +45% per charge |

Tests that hard-coded a 20-week span now derive it from the fixture, so the next
span change costs nothing.
