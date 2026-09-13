# @canary/api — Cloudflare Worker

Hono + D1 + Sendblue + agent tools. Serves the SPA from `./public` (built by `apps/web`);
`/api/*` and `/webhooks/*` always run the Worker first.

```bash
npm run typecheck -w @canary/api
npm test -w @canary/api            # 412 vitest tests, Node env, no secrets, no workerd
npx wrangler deploy --dry-run      # from apps/api; needs a public/index.html
npm run dev -w apps/api            # wrangler dev; copy .dev.vars.example to .dev.vars first
```

## When Canary speaks, and when it waits

`POST /api/alerts/send` no longer texts whatever the primary incident is. `src/alerts/policy.ts`
enforces docs/AGENT_BEHAVIOR.md §1 — the incident must be `OPEN`, material, and not already
notified — and returns `200 { sent: false, decision }` when it declines, without spending a
Sendblue call. `{ force: true }` bypasses all of it for the demo.

If the founder's calendar says they are in a meeting, the alert is **deferred**, not dropped:
`202 { sent: false, decision, pending }` queues it in `pending_alerts`, and the five-minute cron
trigger (`scheduled()` → `src/alerts/pending.ts`) delivers it once they are free, re-checking the
policy first. `POST /api/alerts/deliver-pending` runs the same job on demand.

Availability comes from one private iCal URL (`CALENDAR_ICS_URL`) read by `src/calendar/ics.ts`:
a small RFC 5545 reader (TZID via `Intl`, all-day, DURATION, DAILY/WEEKLY RRULEs, CANCELLED and
TRANSP:TRANSPARENT skipped), cached per isolate for five minutes. With no URL configured Canary has
no availability signal and never defers. Meeting titles stay inside that module unless
`CALENDAR_SHOW_TITLES=1`; the calendar view renders "Busy".

## Google Calendar (optional, replaces the iCal feed)

`src/calendar/resolve.ts` picks the calendar per request: **Google > ICS > none**. Google wins when
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are set *and* a live `google_oauth` row exists.
`GET /api/calendar/connection` reports which one is in use. `GoogleCalendarProvider` implements the
same `CalendarFeed` interface as the iCal reader (`isBusyAt` from freeBusy with a 60-second cache,
`fetchEvents` from the events list with a five-minute one), so `/api/availability`, `/api/calendar`
and the alert policy cannot tell them apart — including the failure mode: if Google cannot be
reached the provider reports `source: "none"` and the founder looks free, because a broken calendar
must never be why a material incident goes unsaid.

What Google adds is write access: `POST /api/incidents/:id/schedule-review` (operator secret) books
15 minutes with `nextFreeSlot` — the first free quarter-hour in 09:00–18:00 `CALENDAR_TIMEZONE`
(default `America/New_York`), at least 30 minutes out, searching three business days — and records a
`canary` marker in `review_events` so the cash calendar shows it. It answers 503 with an ICS feed,
because an iCal feed is read-only. `src/calendar/schedule-command.ts` is the same action as an
iMessage reply.

### One-time setup in the Google Cloud console

One account only — the founder's. There is no per-user auth in Canary.

1. **Project** → create one (or reuse), then **APIs & Services → Library → Google Calendar API →
   Enable**.
2. **OAuth consent screen** → *External*, leave it in **Testing**, and add the founder's Google
   account under **Test users**. Testing mode is deliberate: no verification review, and the refresh
   token lasts long enough for the demo (a Testing-mode grant expires after 7 days — reconnect).
   Scopes: `calendar.events`, `calendar.readonly`, `openid`, `email`.
3. **Credentials → Create credentials → OAuth client ID → Web application**. Authorized redirect
   URIs — add both, exactly:
   - `https://canary.bill-nguyentonhoang.workers.dev/oauth/google/callback`
   - `http://localhost:8787/oauth/google/callback`
4. Put the client id/secret in `.dev.vars` locally, and in the Worker:
   `npx wrangler secret put GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

### Connecting

Visit `…/oauth/google/start?secret=$WEBHOOK_SECRET` in a browser, consent, and the callback stores
the connection and shows "Google Calendar connected for <email>". `POST /oauth/google/disconnect`
(`x-canary-secret`) deletes the row and revokes at Google.

`start` is the **only** route that accepts the shared secret in the query string: the operator
reaches it by typing a URL, and a browser cannot be made to send `x-canary-secret`. It is compared in
constant time and the route's only effect is a redirect. The callback needs no secret because it
authenticates itself with an HMAC-SHA256 `state` (10-minute validity, keyed on `WEBHOOK_SECRET`).

Both tokens are AES-GCM encrypted with a key derived from `WEBHOOK_SECRET` before they reach D1
(migration `0005`), so a database dump shows ciphertext. Rotating `WEBHOOK_SECRET` therefore
invalidates the connection — reconnect. `invalid_grant` on refresh marks the row `revoked_at`, and
Canary falls back to ICS rather than retrying a dead token on every request.

## Swapping in the real pipeline

Every data access goes through `DataProvider` (`src/data/provider.ts`). To go live, implement it
over `@canary/pipeline` + `@canary/engine` and pass it to `createApp({ provider })` in `src/index.ts`:

```ts
export interface DataProvider {
  getDerived(): Promise<DerivedDemoObject>;
  getIncident(id: string): Promise<Incident | null>;
  updateIncidentStatus(id: string, status: IncidentStatus, now: ISODateTime): Promise<Incident | null>;
  markNotified(id: string, now: ISODateTime): Promise<void>;
  getEnrichment(entity: string): Promise<VendorEnrichment | null>;
  simulate(req: WhatIfRequest): Promise<WhatIfResult>;   // ← back this with engine `simulateCostChange`
  getLedgerPivot(granularity: PivotGranularity): Promise<LedgerPivot>;                        // ← engine `pivotLedger`
  getLedgerCell(rowId: string, periodKey: string, granularity: PivotGranularity): Promise<PivotCellDetail | null>;
  getCalendarEvents(from: ISODate, to: ISODate): Promise<CalendarEvent[]>;                    // ← engine `buildCashCalendarEvents`
  getNeedsReview(): Promise<NeedsReviewResponse["items"]>;
  applyClassificationOverride(o: ClassificationOverride): Promise<{ needs_review_count: number }>;
}
```

The engine view functions (`pivotLedger`, `pivotCell`, `projectRecurring`, `buildCashCalendarEvents`) are wired into `PipelineDataProvider`; `MockDataProvider` serves small deterministic projections for tests and `VITE_USE_MOCK` dev.

`withD1Overlay(provider, db)` is applied by the app itself, so incident status, `last_notified`, and
vendor enrichments persist regardless of which provider is injected. Sandbox bank transactions come
from `createApp({ bankTransactions })` — currently an empty ledger.

## Layout

| Path | What |
| --- | --- |
| `src/app.ts` | `createApp(deps)` / `createScheduled(deps)` — every dependency injectable, one wiring path |
| `src/data/` | `DataProvider`, `MockDataProvider`, dev view projections, D1 overlay + typed store |
| `src/routes/` | one module per route group; bodies typed from `@canary/shared/api.ts` |
| `src/alerts/` | notification policy, the shared delivery path, the deferred-alert queue + cron job |
| `src/calendar/` | iCal reader, `Intl`-based TZID resolution, cash-calendar merge, provider resolution |
| `src/calendar/google/` | OAuth + encrypted token store, access-token refresh, freeBusy/events provider, slot picker |
| `src/messages.ts` | every iMessage template (alert / WHY / SHOW ME / SOURCES / HELP) |
| `src/speech.ts` | pre-rendered voice strings via shared `speak*` helpers |
| `src/evidence.ts` | OBSERVED → DETECTED → EVIDENCE → ESTIMATE → SUGGESTION assembly |
| `src/imessage/` | keyword router |
| `src/sendblue/` | outbound client |
| `src/voice/` | ElevenLabs TTS (iMessage CAF / web MP3) and the Ask Canary signed URL |
| `src/bank/` | `SandboxBankProvider` |
| `src/tools.ts` | agent tools shared by REST, iMessage, and voice |
| `src/routes/tools.ts` | `GET|POST /api/tools/<name>` — same `runTool` payloads as iMessage (ElevenLabs) |
| `src/test/` | in-memory D1 + app harness (no miniflare) |

No number in any response is hand-written: figures come from engine/detector output and are
formatted with `@canary/shared` money helpers. URLs only ever come from `buildAppPath`.
