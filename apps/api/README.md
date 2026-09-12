# @canary/api — Cloudflare Worker

Hono + D1 + Sendblue + agent tools. Serves the SPA from `./public` (built by `apps/web`);
`/api/*` and `/webhooks/*` always run the Worker first.

```bash
npm run typecheck -w @canary/api
npm test -w @canary/api            # 105 vitest tests, Node env, no secrets, no workerd
npx wrangler deploy --dry-run      # from apps/api; needs a public/index.html
npm run dev -w apps/api            # wrangler dev; copy .dev.vars.example to .dev.vars first
```

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
}
```

`withD1Overlay(provider, db)` is applied by the app itself, so incident status, `last_notified`, and
vendor enrichments persist regardless of which provider is injected. Sandbox bank transactions come
from `createApp({ bankTransactions })` — currently an empty ledger.

## Layout

| Path | What |
| --- | --- |
| `src/app.ts` | `createApp(deps)` — every dependency injectable |
| `src/data/` | `DataProvider`, `MockDataProvider`, D1 overlay + typed store |
| `src/routes/` | one module per route group; bodies typed from `@canary/shared/api.ts` |
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
