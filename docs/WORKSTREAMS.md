# Canary — Parallel Workstreams (historical briefs)

> These were the briefs given to the six parallel build agents. All workstreams are complete and merged. For the current state of the system read `AGENTS.md` and `docs/HANDOFF.md`; the ownership rules below no longer apply (anyone may edit any package, but `packages/shared` remains the contract to change first).

Read this first if you are implementing a workstream. Then read `docs/PRD.md`, `docs/BUILD.md`, `docs/DATA_AND_DETECTOR_CONTRACT.md`, and every file in `packages/shared/src/`.

## Rules for every workstream

1. **`packages/shared` is frozen.** You may not edit anything under `packages/shared/`. If a type, config key, or helper is missing or wrong, implement around it locally and list the gap under "Contract gaps" in your final report. The lead integrator will make the change.
2. **Ownership is exclusive.** Only touch files inside your owned directory (listed below). Do not touch other packages, `apps/`, root config, CI, or docs (except your own package README if you want one).
3. **Import shared via `@canary/shared`** (and `@canary/shared/fixtures` for test fixtures). Never copy types out of it. Your package must export functions assignable to the types in `packages/shared/src/contracts.ts`.
4. **Money is integer cents.** Signed on transactions (inflow > 0, outflow < 0); positive magnitudes on aggregates. Use `WEEKS_PER_MONTH` from shared; never 4-week months. Use `packages/shared/src/dates.ts` for all week bucketing.
5. **No hand-typed financial figures** in anything that could reach the UI/demo. Test fixtures are fine.
6. **LLMs never compute numbers** (burn, runway, deltas, materiality, scenarios) and never emit URLs or numeric confidence.
7. **Determinism.** Same inputs → byte-identical outputs. No `Date.now()`/`Math.random()` in production code paths (accept `now` / `seed` as parameters).
8. **Tests must pass offline with no secrets.** `npm test -w <your package>` and `npm run typecheck -w <your package>` from the repo root must be green. Any live-API test must `skip` when the env var is absent. Use vitest (already configured). No new dependencies unless unavoidable — if you must add one, add it only to your own `package.json`, run `npm install` from the repo root, and call it out in your report.
9. **Node/TS conventions.** ESM, TypeScript strict, `.ts` extensions in relative imports (`allowImportingTsExtensions` is on), no build step (packages are consumed as source through `exports: ./src/index.ts`).
10. **Final report** (your last message) must contain: what you built, how to run tests, test results, any deviations from the docs and why, contract gaps, and any open risks. Keep it under ~60 lines.

## Repository layout

```text
packages/shared          FROZEN contracts (types, config, company, dates, money, contracts, api, fixtures)
packages/generator       Workstream A
packages/engine          Workstream B
packages/detectors       Workstream C
packages/classification  Workstream D
packages/pipeline        Lead-owned (integration)
apps/api                 Workstream E (Cloudflare Worker, Hono, D1, Sendblue, tools, sandbox bank)
apps/web                 Workstream F (React/Vite SPA)
```

---

## A — Generator (`packages/generator`)

Export `generateDemoCompany: GenerateDemoCompany` (see `contracts.ts`) plus `DEFAULT_DEMO_OPTIONS` that fills defaults from shared (`DEMO.SEED`, `sandboxClosingCashCents()`, `DEMO.END_DATE`, `DEMO.WEEKS`, `profile: "demo"`, `SANDBOX_ACCOUNTS`).

Must produce:
- `weeks` complete Mon–Sun weeks ending at `endDate` (use `weekStartsEndingAt`). Every transaction date inside that span.
- A seeded PRNG (implement a small one, e.g. mulberry32/xoshiro; no deps).
- **Backward anchoring**: after generating all flows, compute the implied opening balance so that `opening + Σ(cash-moving amounts) === closingBalanceCents` exactly. Cash-moving = every settled row on checking/savings accounts (card-account rows are liability movements, not cash). Pending rows superseded by a settled row must NOT be counted (the engine drops them). Put `opening_balance_cents` in `FixtureMetadata`.
- Accounts per `SANDBOX_ACCOUNTS`: checking (most flows), savings (transfer destination), card (card purchases; settled weekly or biweekly by a `CARD_SETTLEMENT` pair — a negative leg on checking and a positive leg on the card account sharing `settlement_pair_id`; every covered card purchase carries that settlement id).
- Recurring: biweekly payroll (`gusto_payroll`, PAYROLL), monthly rent (`RENT`), monthly SaaS (several vendors incl. `figma`, `datadog`, `notion`, `slack`, `github`, `vercel`, `linear` → SAAS_SOFTWARE), weekly/monthly cloud (`aws` → CLOUD_INFRASTRUCTURE, the primary driver), contractors (`upwork`/named contractors → CONTRACTORS), employee card spend (meals, travel, equipment; card account), customer inflows (`stripe_payouts` → CUSTOMER_REVENUE, OPERATING_INFLOW), insurance (INSURANCE).
- Realistic noise on every variable amount (±5–15%), deterministic.
- Planted **sustained variable-spend shift** beginning at week `DEMO.CHANGE_START_INDEX`, ramping over `DEMO.CHANGE_RAMP_WEEKS`, driven mostly by `aws` with smaller contributions from `DEMO.SECONDARY_DRIVER_ENTITIES`. Not a single spike; post-change weeks must stay elevated through the last week. Ramped total delta should be large enough for CUSUM (k=0.5σ, h=4σ with σ from baseline MAD) to alarm **before the final week** but not in the first post-change week — target ≈ 3–5× baseline weekly σ once ramped. Record `burn_shift` in `FixtureMetadata`.
- Planted **one-off**: `figma` payment in a post-change week (not the last), with ≥ 3 prior `figma` payments of similar size and the planted amount ≥ `ONE_OFF_MEDIAN_MULTIPLE × median + ONE_OFF_MIN_ABS_DIFF_CENTS` and ≥ `MATERIALITY.MIN_ONE_OFF_AMOUNT_CENTS`. Do **not** tag it `one_off` — the detector must find it. Record it in `FixtureMetadata.one_off`.
- Planted **unknown vendor**: `DEMO.UNKNOWN_VENDOR` (Ashby) with 2–3 payments, `description: ""`, RECRUITING hint. Not tagged.
- One **internal transfer** pair (checking → savings), one **pending/settled** pair (pending row then settled row with `pending_of`), one **refund** (`REFUND`, positive, same `merchant_normalized` as a prior vendor payment).
- `profile: "test"` additionally adds a `FINANCING` inflow, an `annual_renewal`-tagged payment, and a second internal transfer.
- `category_hint` on every transaction (ground truth for tests).
- Amounts should give a plausible seed-stage picture: monthly gross burn roughly $150–200K pre-shift, revenue roughly $40–60K/month, so runway on a ~$2.0M balance lands around 12–16 months. These are guidance ranges, not contract values.

Tests (vitest, in `packages/generator/src/*.test.ts`): determinism (same seed → deep-equal); different seed → different; closing balance identity (exact); weeks span; every id unique; transfer legs net 0 and share id; every card purchase's settlement exists and sums match; pending/settled pair present; ≥3 prior figma payments before the planted one and the planted amount satisfies the thresholds; post-change mean weekly variable spend (by `category_hint`, excluding the planted one-off) exceeds pre-change mean by the planted delta within tolerance; `aws` accounts for the largest share of the delta; unknown vendor present with empty description; `profile: "test"` includes financing.

Also export `summarizeWeeklyVariableSpend(txns): number[]` (by `category_hint`, for your own tests only) — keep it out of the pipeline path.

---

## B — Engine + What-If (`packages/engine`)

Export `buildLedger: BuildLedger`, `computeBurn: ComputeBurn`, `simulateCostChange: SimulateCostChange`, and `buildWeeklyBuckets(ledgerTransactions, historyStart, historyEnd): WeeklyBucket[]`.

`buildLedger` must, in order:
1. **Pending/settled dedup**: any row with `status: "pending"` that is referenced by another row's `pending_of` is marked `dropped: true` with `excluded_reason`. (Pending rows with no settled successor stay and count.)
2. **Classification**: attach `category` + `classification_method` from `classifications[tx.id]`; missing → `NEEDS_REVIEW` / method `NEEDS_REVIEW` and tag `needs_review`. Flow-type-driven categories override: INTERNAL_TRANSFER → INTERNAL_TRANSFER, CARD_SETTLEMENT → CARD_SETTLEMENT, FINANCING → FINANCING, REFUND keeps the vendor's category if known (so it nets against it) else REFUND, OPERATING_INFLOW → CUSTOMER_REVENUE unless classified otherwise.
3. **Internal transfers**: pair by `transfer_pair_id`; both legs `counts_in_burn: false`. Legs whose sum ≠ 0 or that lack a partner → warning + `unpaired_transfer_legs`.
4. **Card settlements**: settlement legs `counts_in_burn: false`. Verify Σ covered purchases === |checking settlement leg|; mismatch → warning. Count `card_settlements`, `card_purchases_covered`, `unpaired_settlements`.
5. **Financing**: `counts_in_burn: false`, counts in cash. Sum into `financing_net_cents`.
6. **Refunds**: `counts_in_burn: true` with negative spend effect (they reduce that entity's spend in the week they land). Sum into `refunds_netted_cents`.
7. **Needs Review**: outflows count in burn and cash. Count and sum.
8. `counts_in_cash`: true for non-dropped rows on checking/savings accounts; false for card-account rows.
9. **Reconciliation**: `reported_closing = Σ balances of non-card accounts`; `computed_closing = opening + Σ counts_in_cash amounts` where `opening = reported_closing − Σ counts_in_cash amounts` — i.e. derive opening from the anchor and verify the identity holds exactly (`matches`). Also expose the check the other way if `input` provides an explicit opening (not required for P0).
10. **Weekly buckets** via `buildWeeklyBuckets`: one bucket per calendar week from `historyStart` to `historyEnd` (empty weeks included, zeros). For each non-dropped `counts_in_burn` row: FIXED_CATEGORIES → `fixed_spend_cents`; tagged `one_off`/`annual_renewal` → `excluded_from_monitoring_cents`; else → `variable_spend_cents`, `variable_by_entity[merchant_normalized]`, `variable_by_category[category]`. Refunds subtract from the same buckets. OPERATING_INFLOW → `operating_inflow_cents`. `net_burn = total_outflow − inflow`. Card purchases bucket by their own date (not settlement date).
11. `oneOffTransactionIds` → apply the `one_off` tag before bucketing.

`computeBurn(ledger, { regimeStartWeekIndex })`: window = last `TRAILING_WINDOW_WEEKS` weeks (`TRAILING_DEFAULT`); if `regimeStartWeekIndex !== null` and weeks from it to the end ≥ `MIN_POST_CHANGE_WEEKS` → window = those weeks (`POST_CHANGE_SEGMENT`); else trailing with reason `POST_CHANGE_INSUFFICIENT_FALLBACK_TRAILING`. Averages are rounded integer cents. `monthly_* = weeklyToMonthly(weekly_*)`. `available_operating_cash_cents = Σ non-card balances`. `runway_months = runwayMonths(cash, monthly_net_burn)`. `weekly_variable_by_entity` averaged over the window (entities absent in a week count as 0).

`simulateCostChange(burn, { entity, percentage })`: pure arithmetic per `WhatIfResult`. Unknown entity → current 0 and a result that changes nothing (do not throw). `speech` via `speakUsd`/`speakMonths`/`speakPercentage`, e.g. `summary: "If aws were twenty percent lower, monthly burn would fall by about thirty-nine hundred dollars and runway would extend to about fourteen and a half months."` Always `label: SCENARIO_LABEL`.

Tests against `@canary/shared/fixtures` `SAMPLE_TRANSACTIONS`/`SAMPLE_EXPECTED` (hand-verified values in that file) plus your own: reconciliation identity exact; transfer $0 burn; settlement not double counted; pending dropped; financing excluded from burn but in cash; refund netted; NEEDS_REVIEW outflow in burn; empty-week zero buckets; window selection for all three reasons; what-if math (−20% on a known entity reduces monthly burn by exactly `weeklyToMonthly(round(0.2 × weekly))` and extends runway).

---

## C — Detectors + Incidents (`packages/detectors`)

Export `detectOneOffs: DetectOneOffs`, `runCusum: RunCusum`, `decomposeContributors: DecomposeContributors`, `buildIncidents: BuildIncidents`, `evaluateRateMateriality(deltaWeekly, burnBefore, burnAfter): MaterialityVerdict`, `evaluateOneOffMateriality(amount, burn): MaterialityVerdict`, `ewma(values, alpha): number[]` (visualization only).

**One-off** (PRD §12, contract §8–9): iterate non-dropped `counts_in_burn` outflows in date order (then id). For each, history = prior payments to the same `merchant_normalized` (strictly earlier date). If `prior < MIN_PRIOR_VENDOR_PAYMENTS` → `is_new_vendor: true`, not anomalous. Else anomalous iff `amount ≥ ONE_OFF_MEDIAN_MULTIPLE × median` AND `amount − median ≥ ONE_OFF_MIN_ABS_DIFF_CENTS`. Materiality: `amount ≥ MIN_ONE_OFF_AMOUNT_CENTS` OR `amount ≥ MIN_ONE_OFF_BURN_PERCENT × monthly_gross_burn`. Use `median`/`mad` from shared. Return anomalous or new-vendor results only.

**CUSUM** (PRD §13, contract §6): input `weeks[i].variable_spend_cents`. Baseline = first `min_baseline_weeks` weeks: `μ0 = median`, `σ = max(MAD_TO_SIGMA × mad, sigma_floor_fraction × μ0)`. `k = k_factor × σ`, `h = h_multiplier × σ`. `S_0 = 0; S_i = max(0, S_{i-1} + (x_i − μ0) − k)`. Alarm at first `i` with `S_i > h`. `estimated_change_point_index` = last index `j < alarm` with `S_j == 0` (the new regime starts at `j+1`; document this clearly in the result). `pre_change_rate` = mean of weeks `0..j`, `post_change_rate` = mean of weeks `j+1..end`, `delta = post − pre`, `detection_lag = alarm − (j+1)`, `post_change_weeks = len − (j+1)`. Keep the statistic running after alarm (no reset) for the chart; re-baselining is a flag for callers, not a second alarm. Round everything to integer cents.

**Decomposition** (PRD §15): for every entity present in any week, `pre = mean(variable_by_entity[e]) over 0..j`, `post = mean over j+1..end`, delta, monthly via `weeklyToMonthly`, `share = delta / total_delta`. Sort by delta desc. Negative contributors allowed. Σ deltas must equal `cusum.delta_weekly_cents` within rounding (±entities count cents).

**Rate materiality** (PRD §18): `monthly_delta ≥ MIN_MONTHLY_DELTA_CENTS` OR `monthly_delta ≥ MIN_BURN_PERCENT × burnBefore.monthly_gross_burn_cents` OR `runway_impact ≥ MIN_RUNWAY_IMPACT_MONTHS` where `runway_impact = runway_before − runway_after` (null-safe).

**Incidents** (PRD §16–17, contract §10–11): if CUSUM fired and material → one `BURN_RATE_SHIFT` incident: `entity` = top positive contributor, `estimated_change_point` = week_start of `j+1`, `alarm_date`, severity from `SEVERITY_THRESHOLDS` on runway impact, `financial_impact` from delta and `burnBefore`/`burnAfter` runways, `contributors`, `child_signals` = contributors other than the top with positive delta (these are NOT separate incidents), `detection.cusum`, `materiality`, `evidence` with OBSERVED (top contributor rate change, from numbers) and DETECTED (CUSUM alarm, parameters) items — leave EVIDENCE/ESTIMATE/SUGGESTION to the API layer. Each material anomalous one-off → standalone `ONE_OFF_VENDOR_PAYMENT` incident (even if its entity is a contributor — one-offs stay separate per contract §10) with `financial_impact.one_off_amount_cents`. **Dedup**: for each candidate, find an `existing` incident with same `type` + `entity` (for one-offs: same `detection.one_off.transaction_id`) and, for rate shifts, `|change_point − existing.change_point| ≤ INCIDENT_DEDUP_WEEKS` weeks → update in place (`last_updated = now`, keep `id`, `first_detected`, `status`, `last_notified`), else create with a deterministic id (`inc_` + short hash of type+entity+first change point). Return existing-not-matched incidents unchanged.

`ids`: deterministic, no randomness.

Tests: synthetic 20-week series with a planted step at index 10 → fires, change point within ±1 of 10, lag reasonable; pure noise → no fire; single spike week (one-off not winsorized) may fire but the same series with the spike moved to `excluded_from_monitoring_cents` must NOT fire; contributors sum to delta; one-off with 3 priors fires, with 2 priors is new-vendor; materiality rules each trigger independently; dedup: re-running with change point shifted by 1 week updates rather than duplicates; a contributor entity does not spawn a second BURN incident.

---

## D — Classification (`packages/classification`)

Export `classifyTransactions: ClassifyTransactions`, `RULES` (the deterministic table), `normalizeMerchant(raw): string`, `OpenAiProvider(apiKey, fetchImpl?)`, `TavilyProvider(apiKey, fetchImpl?)`, `MemoryEnrichmentCache`, `FileEnrichmentCache(path)` (JSON file, for the demo cache committed at `packages/classification/cache/enrichments.json`), and `mapBusinessTypeToCategory(businessType: string): Category | null`.

Pipeline per merchant (group transactions by `merchant_normalized`; classify once per merchant per flow type):
1. Flow-type rules first: INTERNAL_TRANSFER/CARD_SETTLEMENT/FINANCING/REFUND/OPERATING_INFLOW map directly (method RULE, HIGH).
2. Deterministic merchant rules (regex on `merchant_raw` and `merchant_normalized`): cover at least aws, gcp, azure, vercel, cloudflare, datadog, github, figma, notion, slack, linear, zoom, google workspace, hubspot, gusto/rippling/justworks (PAYROLL), wework/rent keywords (RENT), upwork/deel (CONTRACTORS), lever/greenhouse (RECRUITING — deliberately NOT ashby), doordash/uber eats (MEALS), uber/lyft/delta/united/airbnb (TRAVEL), apple/dell (EQUIPMENT), law/accounting keywords (PROFESSIONAL_SERVICES), insurance keywords (INSURANCE), irs/franchise tax/bank fee (TAXES_FEES), stripe payout (CUSTOMER_REVENUE). Method RULE, HIGH.
3. Unknown → if `llm` provided, ask for a category (constrain to `CATEGORIES` minus non-operating). Then if `research` provided (and `cache` miss), call `enrichVendor`; map business type → category with `mapBusinessTypeToCategory` (keyword table: "recruiting|hiring|applicant tracking" → RECRUITING, "cloud|hosting|infrastructure" → CLOUD_INFRASTRUCTURE, "software|saas|platform" → SAAS_SOFTWARE, etc.). If LLM category === Tavily mapped category → method `LLM_CORROBORATED`, HIGH, signals [OPENAI, TAVILY(url)]. If Tavily returned nothing but LLM answered → `LLM_ONLY`, MEDIUM. If they disagree → `NEEDS_REVIEW`, LOW, both signals recorded. No providers at all → `NEEDS_REVIEW`.
4. Apply the merchant decision to every transaction of that merchant; `ClassifyResult.enrichments` collects unique enrichments.

Providers use plain `fetch` (no SDKs). OpenAI: chat completions with JSON mode / structured output, model `gpt-4o-mini`, temperature 0, and validate the category against the allowed list (reject anything else → treat as no answer). Tavily: `POST https://api.tavily.com/search` with `query: "<display name or raw merchant> company what does it do"`, `search_depth: "basic"`, `include_answer: true`, `max_results: 5`; build `VendorEnrichment` with `business_type` from the answer/snippets, `source_url`/`source_title` from the top result (must be a real URL returned by Tavily — never fabricate), `retrieved_at` from an injected `now()`; return null when no results.

Cache: `FileEnrichmentCache` reads/writes JSON `{ [merchant_normalized]: VendorEnrichment }`. Ship a committed cache file at `packages/classification/cache/enrichments.json` containing the real Ashby result: if `TAVILY_API_KEY` and `OPENAI_API_KEY` are in your environment run `npm run seed-cache -w @canary/classification` (write that script: `scripts/seed-cache.ts`, invoked with `node --experimental-strip-types`) to populate it live; if they are not, leave a clearly-marked placeholder with `cached: true` and say so in your report — the lead will run the seeding.

Tests (offline, mocked `fetch`/providers): rules hit for representative merchants; flow-type mapping; agree → LLM_CORROBORATED; disagree → NEEDS_REVIEW; no research → LLM_ONLY; no providers → NEEDS_REVIEW; invalid LLM category rejected; Tavily null → handled; cache hit short-circuits research; `mapBusinessTypeToCategory` table; `normalizeMerchant("ASHBYHQ INC SAN FRANCISCO CA") === "ashby"` and similar. One live test each for OpenAI and Tavily guarded by `process.env.X ? it : it.skip`.

---

## E — API Worker (`apps/api`)

Hono on Cloudflare Workers. Keep `wrangler.jsonc`, `migrations/0001_init.sql` (you may add `0002_*.sql`, additive only), and the `Env` interface shape. Build against `buildMockDerived()` from `@canary/shared/fixtures` through a `DataProvider` interface — the lead will swap in the real pipeline provider at integration, so isolate every data access behind `src/data/provider.ts`:

```ts
export interface DataProvider {
  getDerived(): Promise<DerivedDemoObject>;
  getIncident(id: string): Promise<Incident | null>;
  updateIncidentStatus(id: string, status: IncidentStatus, now: string): Promise<Incident | null>;
  markNotified(id: string, now: string): Promise<void>;
  getEnrichment(entity: string): Promise<VendorEnrichment | null>;
}
```

Implement `MockDataProvider` (in-memory, from `buildMockDerived()`) and a `D1IncidentStore` that persists incident status/last_notified and enrichments to the D1 tables in `0001_init.sql` (provider = derived object from an injected `getDerived()` + D1 overlay for status). Routes exactly per `API_ROUTES` in `packages/shared/src/api.ts` with the typed request/response bodies there:
- `/api/health`, `/api/health-summary` (build `speech` with shared `speakUsd`/`speakMonths`), `/api/demo` (strip `fixture`), `/api/incidents`, `/api/incidents/:id` (assemble `IncidentDetailResponse`; `evidence` = incident.evidence + EVIDENCE items from `vendor_enrichments` for entities in contributors (label `cached` where applicable) + one ESTIMATE from `simulateCostChange`-equivalent math on the primary driver at −20% (call `@canary/engine` `simulateCostChange` if it exists at integration — for now compute via `mockWhatIf` from fixtures behind the provider) + one SUGGESTION string that never prescribes an operational decision), `/api/incidents/:id/evidence`, `POST /api/incidents/:id/status`, `POST /api/simulate` (validate body; `percentage` numeric within [−100, 100]), `/api/vendors/:entity/enrichment`, `/api/bank/accounts`, `/api/bank/transactions` (sandbox `BankProvider` — implement `SandboxBankProvider` in `src/bank/sandbox.ts` reading accounts/transactions from an injected source; for now the mock derived's `accounts` and an empty/sample transaction list from fixtures).
- **Sendblue**: `src/sendblue/client.ts` — `sendMessage({ to, content })` → `POST https://api.sendblue.co/api/send-message` with headers `sb-api-key-id`, `sb-api-secret-key`, JSON `{ number, content, from_number }`. `POST /api/alerts/send` builds the alert from the derived object (template in `src/messages.ts`: "🐤 Canary\nI detected a sustained increase in variable spending.\n{PrimaryDriver} is currently the largest contributor.\nReply WHY or SHOW ME.") and sends to `body.to ?? env.FOUNDER_PHONE`, then `markNotified`. `POST /webhooks/sendblue`: reject unless `?secret=` query or `x-canary-secret` header equals `env.WEBHOOK_SECRET` (constant-time compare); parse Sendblue inbound payload (`{ content, from_number, number, ... }`), route keywords case-insensitively (`WHY` → explanation from derived numbers: change period, pre/post weekly variable spend, top 2 contributors with +$/week; `SHOW ME` → `create_app_link({destination:"incident", id})` URL; `SOURCES` → enrichment citations; anything else → HELP text), reply via `sendMessage`, log to `imessage_log`. Never let the LLM write URLs; use `buildAppPath` + `env.PUBLIC_BASE_URL`.
- **Tools**: `/api/tools/*` per `api.ts`, JSON in/out, with `speech` strings for `get_incident`.
- `create_app_link` uses `buildAppPath` and `env.PUBLIC_BASE_URL`.
- CORS permissive for `/api/*`. JSON error shape `ErrorResponse`. 
- `scheduled()` handler stub that logs (cron wiring is P1; do not add triggers to wrangler.jsonc).

Tests (vitest, Node environment, calling `app.request()` from Hono with a `MockDataProvider` and a fake D1 or an in-memory store — do NOT require miniflare): every route's status + body shape; webhook rejects bad secret; keyword routing for WHY/SHOW ME/SOURCES/HELP with a mocked `fetch` capturing the Sendblue request; simulate validation; deep link format. Run `npx wrangler deploy --dry-run` from `apps/api` to prove it bundles (needs `apps/api/public/index.html` — create a placeholder if `apps/web` hasn't built; do not commit `public/`).

---

## F — Web (`apps/web`)

Vite + React 18 + TypeScript + Tailwind v4 (`@tailwindcss/vite` is configured) + shadcn-style components (write them by hand in `src/components/ui/` using the radix/cva/clsx/tailwind-merge deps already installed — do not run the shadcn CLI) + Recharts + react-router-dom. Keep `vite.config.ts` build output (`../api/public`) and proxy. Typed API client in `src/api/client.ts` using the types in `@canary/shared` (`api.ts`). `VITE_USE_MOCK=1` (default in `npm run dev` when the API is unreachable) → serve from `buildMockDerived()`/`mockWhatIf()` in `src/api/mock.ts`; otherwise fetch `/api/*`.

Routes: `/` dashboard, `/incidents/:id` incident page (`?tab=overview|drivers|evidence|whatif` selects the tab). Consumer-quality, calm, not accounting-heavy. Dark-on-light, one accent color (canary yellow) used sparingly.

Dashboard: hero row (Cash, Current normalized burn (monthly net), Runway) each with a one-line provenance caption ("Canary Sandbox Bank balance as of {date}" / "post-change window {start}–{end}" using `burn.burn_window_reason`); a prominent **primary incident card** (title, one-sentence summary from numbers, top contributor `+$X/wk`, severity, "View incident"); a smaller **standalone signal card** for the one-off; a **Data quality** strip: reconciliation status (matches / mismatch), transfers paired, settlements paired, pending dropped, Needs Review count + total — click opens a modal listing Needs Review items; a persistent thin banner "Fictional company · synthetic history · sandbox bank" and a loud red banner when `provenance.history_source === "mock"`.

Incident page: header (title, status pill, severity, change point date, "Detected {alarm_date}"); tabs:
- **Overview**: Recharts line chart of `weeks[].variable_spend_cents` with a vertical reference line at the change point and a shaded post-change band, optional EWMA overlay toggle, and a second small area chart of `cusum_statistic_cents` with a reference line at `h` (from `incident.detection.cusum.h_cents` when present). Impact panel: pre vs post weekly variable rate, +$/week, +$/month, runway before → after.
- **Drivers**: horizontal bar list from `contributors` (dollar deltas, negative allowed, colored), category chips; child signals listed as "folded into this incident".
- **Evidence**: sections in taxonomy order OBSERVED → DETECTED → EVIDENCE → ESTIMATE → SUGGESTION, each item styled by kind; external items show source title + link + retrieved date and a "previously retrieved" badge when `cached`. Why-flagged panel: CUSUM parameters (k, h, σ, baseline weeks) and materiality rules triggered.
- **What-if**: entity select (default = incident entity), percentage slider (−50…+50, default −20), live `POST /api/simulate`; show current vs scenario monthly burn, monthly delta, runway current → scenario, and the `label` verbatim in a visible caption.

All numbers formatted via shared `formatUsd*`/`formatMonths`; **never hard-code a figure**. Loading and error states. Mobile-friendly (the SHOW ME deep link opens on a phone).

Tests: component tests (vitest + testing-library + jsdom, already configured) for: dashboard renders values from a `DerivedDemoObject` (use `buildMockDerived()`), mock banner shows only for mock provenance, evidence grouped in taxonomy order, what-if panel displays `SCENARIO_LABEL`, incident route reads `?tab=`. `npm run build -w apps/web` must succeed and write to `apps/api/public`.
