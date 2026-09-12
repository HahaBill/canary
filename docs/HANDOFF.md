# Canary — Handoff (state as of 2026-09-12)

Everything in the P0 build order (`docs/BUILD.md`) is implemented, integrated, tested, and deployed. This document explains what exists, how the pieces connect, how to operate it, and what is deliberately left out.

## 1. Live system

| Thing | Where |
|---|---|
| Production (SPA + API + webhook) | https://canary.bill-nguyentonhoang.workers.dev |
| Dashboard | `/` |
| Primary incident (demo) | `/incidents/inc_5b393334` (tabs: `?tab=overview\|drivers\|evidence\|whatif`) |
| Standalone one-off incident | `/incidents/inc_079155c3` |
| Health | `GET /api/health` |
| Sendblue line (founder texts this) | +1 786 213 9361 |
| Founder phone (receives alerts) | `FOUNDER_PHONE` secret |
| Cloudflare D1 | database `canary` (binding `DB`), migrations `0001`, `0002` applied |
| CI | `.github/workflows/deploy.yml`: PR → test; push to `main` → test, build, D1 migrate, deploy |

Worker secrets already set (so anyone deploying `main` gets a working system): `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SENDBLUE_FROM_NUMBER`, `OPENAI_API_KEY`, `TAVILY_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `WEBHOOK_SECRET`, `FOUNDER_PHONE`, `PUBLIC_BASE_URL`. Optional: `ALLOWED_PHONES` (comma-separated extra numbers Canary will reply to).

For local dev copy `apps/api/.dev.vars.example` → `apps/api/.dev.vars` and fill it (ask the team for values; never commit it).

## 2. Data flow

```text
packages/shared/company.ts     Perch Analytics, Inc. (fictional) · Canary Sandbox Bank · closing balances (the ANCHOR)
        │
generator  → 246 transactions over 20 Mon–Sun weeks, generated BACKWARD so opening + Σ cash = closing exactly
        │    planted: AWS-led variable-spend ramp from week 10, Figma one-off (12× median), Ashby (real unknown vendor),
        │    transfer pair, card purchases + settlements, pending/settled pair, refund
classification → per-merchant: flow-type rules → merchant regex rules → OpenAI proposal → Tavily corroboration
        │    agree → LLM_CORROBORATED/HIGH; disagree → NEEDS_REVIEW (still counts in burn). Cached in
        │    packages/pipeline/cache/*.json so the Worker is offline + deterministic.
engine     → buildLedger (dedup pending, pair transfers/settlements, net refunds, financing out of burn, real
        │    reconciliation against the bank's opening balance) → weekly buckets → computeBurn (post-change window)
detectors  → detectOneOffs (vendor median/MAD, ≥3 priors) → tag → rebuild buckets (one-off winsorized out)
        │    → runCusum (k=0.5σ, h=4σ, σ from 8-week baseline MAD) → decomposeContributors → buildIncidents (+dedup)
pipeline   → DerivedDemoObject  (the ONLY source of numbers for web, iMessage, voice, tools)
        │
apps/api   → REST (/api/*), tools (/api/tools/*), Sendblue webhook, alerts (text + voice), D1 overlay for status
apps/web   → dashboard + incident page, all figures via shared formatters
```

Demo numbers (derived, printed by `npm run verify`): cash $2,012,880.19 · net burn ≈ $160K/mo (post-change window) · runway 12.6 mo (17.5 before the shift) · variable spend $15,352 → $19,479/wk · CUSUM alarm week of 2026-07-20, change point week of 2026-06-29 · AWS +$2,999/wk, Datadog +$681/wk · Figma one-off $13,827 = 12.0× median.

## 3. iMessage flow

1. Trigger the alert (privileged — needs the shared secret):
   ```text
   curl -X POST https://canary.bill-nguyentonhoang.workers.dev/api/alerts/send \
        -H "x-canary-secret: $WEBHOOK_SECRET" -H "content-type: application/json" -d '{}'
   ```
   Sends the text alert, then an ElevenLabs voice note (~15 s) rendered from the SAME incident object. Body options: `to`, `incident_id`, `voice: false`.
2. Founder replies `WHY` / `SHOW ME` / `SOURCES` / `HELP` → Sendblue posts to `POST /webhooks/sendblue` with the Global Secret in `sb-signing-secret` → Canary replies with generator-derived text. Only `FOUNDER_PHONE` / `ALLOWED_PHONES` get replies; others are logged and ignored.
3. Voice pipeline: ElevenLabs `pcm_24000` → loudness-normalized (−10 dBFS RMS, soft limiter) → CAF container written in-Worker → uploaded to Sendblue's CDN (`/api/upload-file`) → sent as `media_url` (renders as a native voice memo). No R2, no ffmpeg.

Sendblue dashboard config: Inbound Messages webhook = `https://canary.bill-nguyentonhoang.workers.dev/webhooks/sendblue`, Global Secret = `WEBHOOK_SECRET`.

## 4. API surface (`packages/shared/src/api.ts` is the contract)

`GET /api/health`, `GET /api/health-summary` (with speech strings), `GET /api/demo`, `GET /api/incidents`, `GET /api/incidents/:id` (evidence assembled in taxonomy order), `GET /api/incidents/:id/evidence`, `POST /api/incidents/:id/status`, `POST /api/simulate {entity, percentage}`, `GET /api/vendors/:entity/enrichment`, `GET /api/bank/accounts`, `GET /api/bank/transactions`, `POST /api/alerts/send` (secret), `POST /webhooks/sendblue` (secret), and agent tools `POST /api/tools/{get_health_summary,get_incident,simulate_cost_change,create_app_link}` for an ElevenLabs/voice agent. Deep links are only ever built by `buildAppPath` + `PUBLIC_BASE_URL`.

## 5. Testing & verification

- `npm test` — ~510 unit tests, offline. Live OpenAI/Tavily tests auto-skip without keys.
- `npm run verify` — runs the full pipeline and asserts contract §15 (closing balance exact, transfer $0, settlements not double counted, one-off ≥3 priors and fires, winsorized out of CUSUM, CUSUM fires before last week, change point within ±2 weeks, post-change burn window, contributor sums, dedup incl. driver drift and stale incidents, Tavily cited, Ashby corroborated). Must print `ALL CHECKS PASSED`.
- Local e2e: `npm run dev:api` then curl the routes above against `localhost:8787` (use `x-canary-secret` from `.dev.vars` for the webhook/alerts).

## 6. Known gaps / P1 backlog

- Embedded "Ask Canary" ElevenLabs web voice agent (tool endpoints exist; no UI yet).
- Cron triggers (bank sync / detector rerun) — `scheduled()` is a no-op.
- What-if for a fixed-category or unknown entity reports "no change" without saying why (`packages/engine/src/whatif.ts`).
- Statement reconciliation UI beyond the data-quality strip; `reconciliation.warnings` not rendered in the SPA.
- SPA bundle is one 742 kB chunk (Recharts); `/api/demo` includes the full `classifications` map the SPA doesn't read.
- `miguel_santos` (a contractor paid by name) lands in Needs Review by design — that's the "nothing falls through silently" demo beat.
- Rotate all API keys after the hackathon (they were shared in chat).

## 7. How it was built

Six parallel agents in isolated git worktrees, each owning one package/app against the frozen `@canary/shared` contract (see `docs/WORKSTREAMS.md` for the original briefs), integrated in dependency order, then three independent read-only audits (financial correctness, API/security, web vs. real data) whose HIGH/MEDIUM findings were fixed. Commit history on `main` tells the story.
