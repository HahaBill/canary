# Canary — Handoff (state as of 2026-09-13)

Everything in the P0 build order (`docs/BUILD.md`) is implemented, integrated, tested, and deployed. This document explains what exists, how the pieces connect, how to operate it, and what is deliberately left out.

## 1. Live system

| Thing | Where |
|---|---|
| Production (SPA + API + webhook) | https://canary.bill-nguyentonhoang.workers.dev |
| Dashboard | `/` |
| Primary incident (demo) | `/incidents/inc_5b393334` (tabs: `?tab=overview\|drivers\|evidence\|whatif`) |
| Standalone one-off incident | `/incidents/inc_40e99e9c` |
| Health | `GET /api/health` |
| Sendblue line (founder texts this) | +1 786 213 9361 |
| Founder phone (receives alerts) | `FOUNDER_PHONE` secret |
| Cloudflare D1 | database `canary` (binding `DB`), migrations `0001`–`0005` applied |
| CI | `.github/workflows/deploy.yml`: PR → test; push to `main` → test, build, D1 migrate, deploy |

Worker secrets already set (plus optional `CALENDAR_ICS_URL` — Google Calendar "Secret address in iCal format" — and `CALENDAR_SHOW_TITLES`) (so anyone deploying `main` gets a working system): `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SENDBLUE_FROM_NUMBER`, `OPENAI_API_KEY`, `TAVILY_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `WEBHOOK_SECRET`, `FOUNDER_PHONE`, `PUBLIC_BASE_URL`. Optional: `ALLOWED_PHONES` (comma-separated extra numbers Canary will reply to), `ELEVENLABS_AGENT_ID` (Ask Canary conversational agent). Optional Google Calendar: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CALENDAR_TIMEZONE`, `FOUNDER_EMAIL` (expected account — a mismatch is flagged, not rejected; example `bill.nguyentonhoang@gmail.com` in `.dev.vars.example`).

For local dev copy `apps/api/.dev.vars.example` → `apps/api/.dev.vars` and fill it (ask the team for values; never commit it).

## 2. Data flow

```text
packages/shared/company.ts     Perch Analytics, Inc. (fictional) · Canary Sandbox Bank · closing balances (the ANCHOR)
        │
generator  → 626 transactions over 52 Mon–Sun weeks, generated BACKWARD so opening + Σ cash = closing exactly
           │    plus a 26-week horizon of un-posted rows; the demo clock walks the final ten days OF HISTORY, a day every 30s, and never past DEMO.END_DATE
        │    planted: AWS-led variable-spend ramp from week 42, Figma one-off (12× median), Ashby (real unknown vendor),
        │    transfer pair, card purchases + settlements, pending/settled pair, refund
classification → per-merchant: flow-type rules → merchant regex rules → OpenAI proposal → Tavily corroboration
        │    agree → LLM_CORROBORATED/HIGH; disagree → NEEDS_REVIEW (still counts in burn). Cached in
        │    packages/pipeline/cache/*.json so the Worker is offline + deterministic.
engine     → buildLedger (dedup pending, pair transfers/settlements, net refunds, financing out of burn, real
        │    reconciliation against the bank's opening balance) → weekly buckets → computeBurn (post-change window)
detectors  → detectOneOffs (vendor median/MAD, ≥3 priors) → tag → rebuild buckets (one-off winsorized out)
        │    → runCusum (k=0.5σ, h=6σ, σ from baseline MAD measured against a fitted multiplicative trend) → decomposeContributors → buildIncidents (+dedup)
pipeline   → DerivedDemoObject  (the ONLY source of numbers for web, iMessage, voice, tools)
        │
apps/api   → REST (/api/*), tools (/api/tools/*), Sendblue webhook, alerts (text + voice), D1 overlay for status
apps/web   → dashboard + incident page, all figures via shared formatters
```

Demo numbers (derived, printed by `npm run verify`): cash $2,012,880.19 · net burn $163,481.89/mo (post-change window 2026-06-29..2026-09-13) · runway 12.3 mo (17 before the shift) · variable spend $15,403.41 → $19,374.12/wk · CUSUM σ=$1,125.58 k=$562.79 h=$6,753.51, alarm week of 2026-07-20, change point week of 2026-06-29 · AWS +$3,144/wk, Datadog +$624/wk · Figma one-off $14,055.00 = 12.0× median $1,171.09 · incidents `inc_5b393334`, `inc_40e99e9c`.

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

## 3b. Web app surfaces (added 2026-09-12 evening)

Collapsible sidebar (one toggle, persisted; bottom tab bar on phones): **Home** (dashboard + sparkline + Conversation strip from the iMessage log), **Incidents** (list), **Ledger** (`/ledger` — hierarchical pivot Revenue / Variable / Fixed / One-offs / Net burn / Financing / Cash, Weekly·Monthly toggle + run-rate column, post-change tint, cell drill-down, CSV), **Needs Review** (`/needs-review` — assign a category; Assign is public on the demo), **Scout** (`/scout` — dated pricing, plan, and credit announcements at vendors we already pay; Refresh runs a live search and never creates incidents). **Calendar** stays at `/calendar` (and its API — founder free/busy from Google Calendar or an iCal feed; the same signal that holds iMessage alerts during meetings) but is omitted from chrome so it is not on the walkthrough. Production reports `provider: "none"` until an operator completes `https://canary.bill-nguyentonhoang.workers.dev/oauth/google/start?secret=<WEBHOOK_SECRET>` (`GOOGLE_*` and `FOUNDER_EMAIL` are already Worker secrets; D1 has no `google_oauth` row yet). Ledger figures come from `@canary/engine` view functions (`pivotLedger`, `pivotCell`, `projectRecurring`) served by `apps/api`; the pivot's weekly Variable-spend row equals the CUSUM series to the cent (asserted in tests).

**Ask Canary**: ElevenLabs ConvAI **Start a call** widget in the bottom-right of every page (auto-mounted once a ticket exists). The Worker mints a short-lived signed URL (`GET /api/ask-canary`) so the browser never sees `ELEVENLABS_API_KEY`. Without an agent a short explainer stays in that corner. `/ask` is a short explainer. The agent uses the same `/api/tools/*` surface as iMessage.

**Notification policy** (`docs/AGENT_BEHAVIOR.md` §1, enforced in `apps/api/src/alerts/policy.ts`): `/api/alerts/send` only sends for OPEN, material, not-yet-notified incidents; if the founder is in a meeting (Google Calendar when connected, else private iCal via `CALENDAR_ICS_URL`; optional `CALENDAR_SHOW_TITLES=1`) the alert is queued in D1 `pending_alerts` and delivered by the 5-minute cron once free. `force: true` bypasses for the demo. `GET /api/availability` shows the current state; `POST /api/alerts/deliver-pending` (secret) runs the job on demand.

## 4. API surface (`packages/shared/src/api.ts` is the contract)

Views: `GET /api/ledger?granularity=week|month`, `GET /api/ledger/cell?row_id&period_key&granularity`, `GET /api/calendar?from&to` (founder free/busy + booked reviews), `GET /api/calendar/connection`, `GET /api/availability`, `GET /api/alerts/history?limit`, `GET /api/alerts/pending`, `GET /api/needs-review`, `POST /api/classifications/override`, `GET /api/incidents/:id/voice` (mp3), `GET /api/ask-canary` (signed conversation URL; `{ configured: false }` when the agent is unset). Core: `GET /api/health`, `GET /api/health-summary` (with speech strings), `GET /api/demo`, `GET /api/incidents`, `GET /api/incidents/:id` (evidence assembled in taxonomy order), `GET /api/incidents/:id/evidence`, `POST /api/incidents/:id/status`, `POST /api/simulate {entity, percentage}`, `GET /api/vendors/:entity/enrichment`, `GET /api/bank/accounts`, `GET /api/bank/transactions`, `POST /api/alerts/send` (secret), `POST /webhooks/sendblue` (secret), and agent tools `GET|POST /api/tools/{get_health_summary,get_incident,get_active_incidents,simulate_cost_change,get_evidence,create_app_link,get_vendor_spend,list_transactions,refuse}` — the same `runTool` payloads iMessage uses — for an ElevenLabs/voice agent. Deep links are only ever built by `buildAppPath` + `PUBLIC_BASE_URL`.

## 5. Testing & verification

- `npm test` — 1,335 unit tests (4 skipped), offline. Live OpenAI/Tavily/Rho tests auto-skip without keys.
- `npm run verify` — runs the full pipeline and asserts contract §15 (closing balance exact, transfer $0, settlements not double counted, one-off ≥3 priors and fires, winsorized out of CUSUM, CUSUM fires before last week, change point within ±2 weeks, post-change burn window, contributor sums, dedup incl. driver drift and stale incidents, Tavily cited, Ashby corroborated). Must print `ALL CHECKS PASSED`.
- Local e2e: `npm run dev:api` then curl the routes above against `localhost:8787` (use `x-canary-secret` from `.dev.vars` for the webhook/alerts).
- `npm run verify` had never actually run on Windows (the `import.meta.url` entry-point guard never matched, so it printed nothing and exited 0). Fixed in `c8915b6`. CI still does not run it — see `docs/ALFREDO-LOGIC-AUDIT.md` proposal 3.

## 6. Known gaps / P1 backlog

- Cron does no bank sync or detector rerun. `scheduled()` is not a no-op: the `*/5` trigger drains `pending_alerts` (`apps/api/src/index.ts`).
- Statement reconciliation UI beyond the data-quality strip; `reconciliation.warnings` not rendered in the SPA.
- SPA bundle is one 846 kB chunk (Recharts); `/api/demo` includes the full `classifications` map the SPA doesn't read.
- `miguel_santos` (a contractor paid by name) lands in Needs Review by design — that's the "nothing falls through silently" demo beat.
- Rotate all API keys after the hackathon (they were shared in chat).

## 6b. Logic layer (Alfredo)

**Review entry point: `docs/ALFREDO-WORKLOG.md`** — every commit in
order, every packages/shared touch listed, the places Bill's code was edited,
open decisions, and the production dry run. Everything below is detailed there.

`docs/AGENT_BEHAVIOR.md` — the speech contract binding iMessage, the incident
copy and any voice agent: when Canary may interrupt, the OBSERVED → DETECTED →
EVIDENCE → ESTIMATE → SUGGESTION order, where numbers may come from, what it
must refuse, and the exact answer shapes for runway / why / what-if.

`docs/ALFREDO-LOGIC-AUDIT.md` — the detector/engine audit: what was broken, the
81 tests added, threshold rationale for every constant in `config.ts`, gaps left
alone on purpose, and three additive `packages/shared` diffs awaiting sign-off (the fourth, `h_multiplier` 4→6, was adopted and shipped in `c251c1f`).

Added since: a third detector (recurring-charge drift, folded into the incident
it contributes to per contract §10), messy statement shapes in the `test`
profile with end-to-end reconciliation assertions, and a what-if that explains
why a scenario changed nothing.

## 7. How it was built

Six parallel agents in isolated git worktrees, each owning one package/app against the frozen `@canary/shared` contract (see `docs/WORKSTREAMS.md` for the original briefs), integrated in dependency order, then three independent read-only audits (financial correctness, API/security, web vs. real data) whose HIGH/MEDIUM findings were fixed. Commit history on `main` tells the story.
