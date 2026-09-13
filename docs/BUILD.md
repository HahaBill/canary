# Canary — Hackathon Build Order

This is the working build document. Do not expand it during the hackathon unless a blocker requires a decision.

---

# Goal

Ship the smallest coherent Canary:

```text
sandbox bank (fictional company) / synthetic history
      ↓
reconciliation-correct ledger
      ↓
CUSUM burn incident
      ↓
driver decomposition
      ↓
Tavily vendor corroboration
      ↓
Sendblue alert
      ↓
WHY / SHOW ME
      ↓
React incident page
      ↓
what-if simulator
      ↓
optional ElevenLabs
```

---

# Rule 0

**All financial numbers shown in the UI or demo must come from generator/engine output.**

No hand-written demo financial figures.

---

# Rule 0.5 — The demo does not run on Rho (but a Rho client exists)

The demo does not run on a live bank. A real Rho client does exist alongside it: `GET /api/bank/rho` runs the same engine over Rho's public sandbox, which needs no credentials and reconciles to zero. The demo itself runs on a fictional company (**Perch Analytics, Inc.**) banking with a fictional **Canary Sandbox Bank**, implemented behind the `BankProvider` interface in `packages/shared`. Wherever older text says "Rho balance", read "sandbox bank closing balance".

---

# Repository layout (fixed — CI depends on it)

```text
canary/
  package.json                 npm workspaces: apps/*, packages/*   (npm, NOT pnpm; Node 22 in CI)
  tsconfig.base.json
  packages/
    shared/                    @canary/shared  — types, config, money helpers, API contracts, test fixtures. FROZEN; only the lead edits it.
    generator/                 @canary/generator
    engine/                    @canary/engine  (reconciliation, burn, runway, what-if)
    detectors/                 @canary/detectors (one-off, CUSUM, decomposition, incidents)
    classification/            @canary/classification (rules, OpenAI, Tavily, cache)
    pipeline/                  @canary/pipeline (generator → engine → detectors → DerivedDemoObject; lead-owned)
  apps/
    api/                       Cloudflare Worker (Hono). wrangler.jsonc here. D1 migrations in apps/api/migrations. Serves SPA from apps/api/public.
    web/                       React/Vite/TS/Tailwind/shadcn/Recharts. `vite build` outDir = ../api/public
  .github/workflows/deploy.yml
```

CI runs, from the root: `npm ci` → `npm run typecheck --workspaces --if-present` → `npm test --workspaces --if-present` → `npm run build -w apps/web` → `npx wrangler deploy --cwd apps/api --dry-run`. Every workspace must therefore expose `typecheck` and `test` scripts (or omit them), and all of them must pass with **no network access and no secrets**. Live-API tests must be skipped when the corresponding env var is absent.

Package conventions: TypeScript ESM (`"type": "module"`), `vitest` for tests, package names `@canary/<name>`, source in `src/`, entry `src/index.ts`. Packages are consumed via TS path mapping / workspace symlinks — no build step is required for packages to be importable by other workspaces.

---

# Rule 1 — D1 migrations are additive

CI applies D1 migrations **before** deploying the new Worker, so the currently deployed Worker briefly runs against the new schema.

- All production D1 migrations must be forward-compatible.
- Prefer `CREATE TABLE`, `ADD COLUMN`, and additive indexes.
- Do not `DROP` or rename existing tables/columns during the hackathon.
- Existing deployed Worker code must keep working after a migration but before the next Worker deployment completes.

---

# Phase 0 — External Dependency Smoke Test

Do this before product code.

- [x] Create D1 database (`npx wrangler d1 create canary`) and paste `database_id` into `apps/api/wrangler.jsonc`
- [x] Configure GitHub `production` environment (branch rule `main`, secret `CLOUDFLARE_API_TOKEN`, variable `CLOUDFLARE_ACCOUNT_ID`); make `test` a required check on `main`
- [ ] Deploy skeleton Cloudflare Worker (push to `main` → `.github/workflows/deploy.yml`)
- [ ] Confirm public URL works
- [ ] Sandbox `BankProvider` serves fictional company accounts/balance/transactions (`/api/bank/*`)
- [ ] Confirm Tavily search
- [ ] Confirm Sendblue number is provisioned
- [ ] Confirm Sendblue outbound message
- [ ] Confirm Sendblue inbound webhook
- [ ] Add webhook secret/signature check
- [ ] Create ElevenLabs agent if time
- [ ] Confirm ElevenLabs can call one Worker tool

If Sendblue or ElevenLabs provisioning fails, know this immediately.

---

# Phase 1 — Generator

- [x] Define canonical transaction schema (`packages/shared/src/types.ts`)
- [ ] Read the sandbox bank closing balance from the company profile (`packages/shared/src/company.ts`)
- [x] Generate 52 weeks **backward** so the synthetic ledger closes on the sandbox bank balance (plus a 26-week horizon)
- [ ] Use deterministic seed
- [ ] Add recurring payroll/rent/SaaS/cloud
- [ ] Add sustained variable-spend shift
- [ ] Add one-off vendor anomaly
- [ ] Add internal transfer
- [ ] Add card settlement
- [ ] Add refund
- [ ] Add financing test fixture
- [ ] Add a **real obscure indexed vendor** for Tavily
- [ ] Add generator assertions

### Generator assertions

- [ ] Synthetic closing balance = sandbox bank closing balance
- [ ] Internal transfer contributes $0 spend
- [ ] Card settlement not double counted
- [ ] Financing excluded from operating burn
- [ ] One-off detector fires on planted payment
- [ ] CUSUM change point falls within expected tolerance

---

# Phase 2 — Financial Engine

- [ ] Normalize flow types
- [ ] Deduplicate pending/settled
- [ ] Pair internal transfers
- [ ] Pair card settlements
- [ ] Handle refunds
- [ ] Separate financing from revenue
- [ ] Keep Needs Review amounts in burn/cash
- [ ] Calculate available operating cash
- [ ] Calculate normalized burn
- [ ] Calculate runway
- [ ] Add post-change representative burn window

Definition:

```text
week_to_month = 52 / 12
```

Pin this conversion factor globally.

---

# Phase 3 — Classification

- [ ] Implement deterministic merchant rules
- [ ] Add OpenAI fallback
- [ ] Add allowed category enum
- [ ] Add supporting-signal model
- [ ] Add Needs Review state
- [ ] Implement Tavily structured vendor enrichment
- [ ] Return business type + source URL
- [ ] Compare Tavily extraction against OpenAI category
- [ ] Cache successful demo result

No LLM numeric confidence.

---

# Phase 4 — Detection

## One-off

- [ ] Require ≥3 prior vendor payments
- [ ] Use vendor median/MAD or simple multiple threshold
- [ ] Add one-off materiality threshold
- [ ] Mark one-off so it can be winsorized from CUSUM

## CUSUM

- [ ] Aggregate by non-overlapping calendar week
- [ ] Variable spend only
- [ ] Exclude/winsorize tagged one-offs
- [ ] One-sided upward
- [ ] k = 0.5σ
- [x] h = configured 6σ
- [ ] σ estimated robustly from baseline MAD
- [ ] Change point = last zero before alarm
- [ ] Re-baseline after confirmed shift

## Contributor decomposition

- [ ] Pre/post vendor rates
- [ ] Show dollar contribution
- [ ] Allow negative contributors

---

# Phase 5 — Incidents

- [ ] Create incident model
- [ ] OPEN / ACKNOWLEDGED / RESOLVED
- [ ] Match detections within ±2 weeks to existing incident
- [ ] Update instead of duplicate
- [ ] Group component signals into parent incident
- [ ] Keep standalone one-off separate
- [ ] Notify only on meaningful state change

---

# Phase 6 — React

Only build:

- [ ] Dashboard
- [ ] One incident page

Dashboard:

- [ ] cash
- [ ] current normalized burn
- [ ] runway
- [ ] open incident
- [ ] other standalone signal
- [ ] reconciliation/Needs Review status

Incident page:

- [ ] timeline
- [ ] estimated change point
- [ ] drivers
- [ ] financial impact
- [ ] why flagged
- [ ] evidence
- [ ] what-if simulator

---

# Phase 7 — Sendblue

P0 commands only:

- [x] Send alert
- [x] WHY
- [x] SHOW ME
- [x] Deep link generated by backend tool
- [ ] Record fallback demo video

Optional:

- [x] SOURCES
- [x] ElevenLabs voice note after the alert (text + native iMessage voice memo, same incident object; PRD §26a)

Natural-language routing is P1.

---

# Phase 8 — What-If

- [ ] Implement `simulate_cost_change(entity, percentage)`
- [ ] Calculate from engine values
- [ ] Return machine values
- [ ] Return speech-friendly values
- [ ] Label as scenario estimate

---

# Phase 9 — ElevenLabs

Only after P0 works.

- [x] Embed Ask Canary in React
- [x] Connect `get_health_summary`
- [x] Connect `get_incident`
- [x] Connect `simulate_cost_change`
- [x] Give agent evidence taxonomy
- [ ] Test speech-friendly financial numbers

Stretch:

- [ ] React client navigation

---

# Definition of Done

Canary is submission-ready when:

- [x] Sandbox `BankProvider` is the demo's source of current balance/accounts; the seam is real and `RhoBankClient` uses it at `GET /api/bank/rho`
- [ ] Demo ledger closes on the sandbox bank balance
- [ ] Financial engine handles transfers/settlements/financing correctly
- [ ] CUSUM detects the planted sustained shift
- [ ] Driver decomposition is generator-derived
- [ ] One-off detector identifies planted unusual payment
- [ ] Tavily corroborates one real indexed vendor with a citation
- [ ] One incident page works
- [ ] Sendblue alert reaches phone OR recorded fallback is ready
- [ ] WHY works
- [ ] SHOW ME deep-links to incident
- [ ] What-if simulator works
- [ ] All displayed financial numbers are engine-generated
- [ ] Demo works without ElevenLabs

If all boxes above are checked, stop adding architecture and polish the demo.
