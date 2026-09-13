# Canary — guide for coding agents and teammates

Read this first. Then `docs/HANDOFF.md` (what is built and how it fits together), and the product docs (`docs/PRD.md`, `docs/BUILD.md`, `docs/DATA_AND_DETECTOR_CONTRACT.md`, `docs/DEMO.md`).

Before changing anything Canary *says*, read `docs/AGENT_BEHAVIOR.md` — it is the speech contract for iMessage, incident copy and any voice agent. Before changing a detector or a threshold, read `docs/ALFREDO-LOGIC-AUDIT.md` — it carries the rationale for every constant in `config.ts` and the gaps that are open on purpose.

## What this is

Canary is an explainable early-warning system for startup cash: it reconciles a (fictional) company's bank ledger, detects sustained spending shifts (CUSUM) and one-off vendor anomalies, researches unknown vendors (OpenAI + Tavily), and alerts the founder over iMessage (Sendblue text + ElevenLabs voice note) with a React incident page and a deterministic what-if simulator. Production: https://canary.bill-nguyentonhoang.workers.dev

## Non-negotiable rules

1. **No hand-typed financial numbers** in UI, messages, docs, or demo script. Every figure comes from `packages/pipeline` → `DerivedDemoObject`. Format with `@canary/shared` helpers (`formatUsd*`, `formatMonths`, `speakUsd`, `speakMonths`).
2. **LLMs never compute money** (burn, runway, deltas, materiality, scenarios) and never write URLs or numeric confidence. OpenAI only proposes categories and Tavily only corroborates them.
3. **Integer cents everywhere.** Transactions are signed (inflow > 0, outflow < 0); aggregates are positive magnitudes. `WEEKS_PER_MONTH = 52/12`, never 4.
4. **Determinism.** No `Date.now()` / `Math.random()` in production paths; `now` and `seed` are injected. Two pipeline runs must be byte-identical.
5. **`packages/shared` is the contract.** Change types/config there first, then consumers. Don't duplicate types elsewhere.
6. **Evidence taxonomy** on every user-facing explanation: OBSERVED → DETECTED → EVIDENCE → ESTIMATE → SUGGESTION. Suggestions are never prescriptive operational decisions. `docs/AGENT_BEHAVIOR.md` is the full contract.
7. **Secrets** live only in `apps/api/.dev.vars` (gitignored) and Cloudflare Worker secrets. Never commit or print them.
8. **D1 migrations are additive only** (`apps/api/migrations/NNNN_*.sql`): CI applies them before the new Worker goes live.

## Layout

```text
packages/shared          types, config (all thresholds), company profile, dates, money, API + tool contracts, test fixtures
packages/generator       deterministic 52-week synthetic ledger (+26-week horizon for the demo clock) anchored to the sandbox bank balance (planted shift, one-off, unknown vendor; `test` profile adds messy statement shapes)
packages/engine          reconciliation ledger, weekly buckets, burn/runway windows, what-if, views (pivot, cash calendar, recurring)
packages/detectors       one-off rule, one-sided CUSUM, recurring-charge drift, contributor decomposition, materiality, incidents + dedup
packages/classification  merchant rules → OpenAI → Tavily corroboration → Needs Review; cache/
packages/pipeline        runPipeline() → DerivedDemoObject; verify.ts (contract §15 assertions); committed demo caches
apps/api                 Cloudflare Worker (Hono): REST API, Sendblue webhook + alerts (text + voice), agent tools, D1, sandbox bank, Rho client, demo clock, Scout, Google Calendar OAuth
apps/web                 Vite + React SPA (dashboard, incidents, ledger, calendar, needs review, scout, ask); builds into apps/api/public and is served by the Worker
```

## Commands (from repo root, Node 22+, npm)

```text
npm install
npm run typecheck                 # all workspaces
npm test                          # all workspaces (offline, no secrets needed)
npm run verify                    # end-to-end pipeline assertions — must print ALL CHECKS PASSED
npm run build                     # SPA → apps/api/public
npm run dev:api                   # wrangler dev on :8787 (reads apps/api/.dev.vars; run `npm run migrate:local -w @canary/api` once)
npm run dev:web                   # vite on :5173, proxies /api to :8787 (VITE_USE_MOCK=1 for fixtures)
```

Deploy: push to `main` (GitHub Actions runs test → build → D1 migrate → `wrangler deploy`). Manual: `npm run build && cd apps/api && npx wrangler deploy`.

## Before you open a PR

- `npm run typecheck && npm test && npm run verify` all green.
- If you touched generator/engine/detectors: `npm run verify` numbers still make demo sense (CUSUM alarms before the last week, AWS is the primary driver, Figma one-off fires).
- If you touched classification providers: re-seed caches with real keys — `npm run seed-cache -w @canary/classification && npm run seed -w @canary/pipeline` — and commit the JSON.
- If you touched `apps/api` routes: keep `packages/shared/src/api.ts` in sync; tests run with `app.request()` and injected fakes (no workerd).
- Don't add dependencies without a reason; the Worker bundle must stay free of `node:` imports (import `@canary/classification/core`, not the package root).
