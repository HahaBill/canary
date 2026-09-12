# @canary/classification

Deterministic rules → OpenAI → Tavily corroboration → Needs Review (PRD §10, contract §13).

```ts
import { classifyTransactions, OpenAiProvider, TavilyProvider, demoEnrichmentCache } from "@canary/classification";

const { classifications, enrichments, by_merchant } = await classifyTransactions(transactions, {
  llm: OpenAiProvider(env.OPENAI_API_KEY),
  research: TavilyProvider(env.TAVILY_API_KEY, undefined, { now: () => new Date().toISOString() }),
  cache: demoEnrichmentCache(),          // Node only; use MemoryEnrichmentCache in the Worker
  min_amount_for_research_cents: 0,
});
```

`classifications` is keyed by transaction id and drops straight into `BuildLedgerInput.classifications`;
`enrichments` drops into `DerivedDemoObject.vendor_enrichments`.

## Method and confidence

Confidence comes from signal agreement — never from a model's self-report.

| Signals | Method | Confidence | Category |
| --- | --- | --- | --- |
| Flow type or merchant rule | `RULE` | HIGH | the rule's category |
| OpenAI + Tavily agree | `LLM_CORROBORATED` | HIGH | the agreed category |
| OpenAI only (no research, or nothing found) | `LLM_ONLY` | MEDIUM | OpenAI's category |
| Disagreement, one signal, or none | `NEEDS_REVIEW` | LOW | `NEEDS_REVIEW` |

Every signal consulted is recorded in `supporting_signals` (OPENAI carries `proposed_category`, TAVILY
carries `proposed_category` + `url`), and NEEDS_REVIEW amounts still count in cash and burn downstream.

Work happens once per (merchant, flow type) group: cache first, then at most one LLM call and one
research call per merchant. `DEMO.UNKNOWN_VENDOR` (Ashby) deliberately matches no rule — it is the
vendor the OpenAI + Tavily path identifies on stage.

## Imports

- `@canary/classification` — everything (Node).
- `@canary/classification/core` — no `node:*` imports; use this from the Cloudflare Worker.
  `FileEnrichmentCache`, `DEMO_CACHE_FILE`, and `demoEnrichmentCache()` live in `src/node.ts`.

## Demo cache

`cache/enrichments.json` is `{ [merchant_normalized]: VendorEnrichment }`. The committed entry is a
clearly-marked placeholder; placeholders read as a **cache miss** so the demo never cites
`example.invalid` as corroboration. Replace it with the real Tavily result:

```sh
OPENAI_API_KEY=... TAVILY_API_KEY=... npm run seed-cache -w @canary/classification
```

Keys are also read from `apps/api/.dev.vars` if present. They are never printed and never written to the cache.

## Tests

```sh
npm run typecheck -w @canary/classification
npm test -w @canary/classification
```

All offline. The two live provider tests skip unless `OPENAI_API_KEY` / `TAVILY_API_KEY` are set.
