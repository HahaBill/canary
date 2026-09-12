# @canary/api — Cloudflare Worker

Hono + D1 + Sendblue + agent tools. Serves the SPA from `./public` (built by `apps/web`);
`/api/*` and `/webhooks/*` always run the Worker first.

```bash
npm run typecheck -w @canary/api
npm test -w @canary/api            # 260 vitest tests, Node env, no secrets, no workerd
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

The three view methods need the full `Ledger` (transactions included), which `runPipeline` does not
return yet, so `PipelineDataProvider` throws `not wired` for them — `MockDataProvider` serves
simplified projections of the weekly buckets (`src/data/mock-views.ts`) until the engine functions
land. `/api/calendar` merges whatever `getCalendarEvents` returns with busy blocks from the feed.

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
| `src/calendar/` | iCal reader, `Intl`-based TZID resolution, cash-calendar merge |
| `src/messages.ts` | every iMessage template (alert / WHY / SHOW ME / SOURCES / HELP) |
| `src/speech.ts` | pre-rendered voice strings via shared `speak*` helpers |
| `src/evidence.ts` | OBSERVED → DETECTED → EVIDENCE → ESTIMATE → SUGGESTION assembly |
| `src/imessage/` | keyword router |
| `src/sendblue/` | outbound client |
| `src/bank/` | `SandboxBankProvider` |
| `src/tools.ts` | agent tools shared by REST, iMessage, and voice |
| `src/test/` | in-memory D1 + app harness (no miniflare) |

No number in any response is hand-written: figures come from engine/detector output and are
formatted with `@canary/shared` money helpers. URLs only ever come from `buildAppPath`.
