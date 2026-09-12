/**
 * Seeds packages/pipeline/cache/{classifications,enrichments}.json by running the
 * classification pipeline LIVE (OpenAI + Tavily) over the demo generator output.
 *
 * Only merchants that the deterministic rules could NOT classify are stored, so
 * the committed cache is small and every rule-based decision stays live/deterministic.
 * The Worker and `npm run verify` then run fully offline and deterministically.
 *
 *   npm run seed -w @canary/pipeline
 *
 * Reads OPENAI_API_KEY / TAVILY_API_KEY from env, falling back to apps/api/.dev.vars.
 * Keys are never printed or written.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DEMO, type Classification, type VendorEnrichment } from "@canary/shared";
import { DEFAULT_DEMO_OPTIONS, generateDemoCompany } from "@canary/generator";
import { classifyTransactions, OpenAiProvider, TavilyProvider } from "@canary/classification";
import { FileEnrichmentCache, DEMO_CACHE_FILE } from "@canary/classification";

const here = dirname(fileURLToPath(import.meta.url));
const cacheDir = resolve(here, "../cache");
const devVars = resolve(here, "../../../apps/api/.dev.vars");

function loadEnv(): void {
  if (!existsSync(devVars)) return;
  for (const line of readFileSync(devVars, "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[2] && !process.env[m[1]!]) process.env[m[1]!] = m[2];
  }
}

async function main(): Promise<void> {
  loadEnv();
  const openai = process.env.OPENAI_API_KEY ?? "";
  const tavily = process.env.TAVILY_API_KEY ?? "";
  if (!openai || !tavily) {
    console.error("OPENAI_API_KEY and TAVILY_API_KEY are required (env or apps/api/.dev.vars).");
    process.exit(1);
  }

  const generated = generateDemoCompany({ ...DEFAULT_DEMO_OPTIONS, seed: DEMO.SEED, profile: "demo" });
  const now = () => new Date().toISOString();
  const result = await classifyTransactions(generated.transactions, {
    llm: OpenAiProvider(openai),
    research: TavilyProvider(tavily, undefined, { now }),
    cache: new FileEnrichmentCache(DEMO_CACHE_FILE),
  });

  const byMerchant: Record<string, Omit<Classification, "transaction_id">> = {};
  for (const [merchant, c] of Object.entries(result.by_merchant)) {
    if (c.method === "RULE") continue; // rules are deterministic; no need to cache
    const { transaction_id: _drop, ...rest } = c;
    byMerchant[merchant] = rest;
  }

  const enrichments: VendorEnrichment[] = result.enrichments.map((e) => ({ ...e, cached: true }));

  writeFileSync(resolve(cacheDir, "classifications.json"), JSON.stringify(byMerchant, null, 2) + "\n");
  writeFileSync(resolve(cacheDir, "enrichments.json"), JSON.stringify(enrichments, null, 2) + "\n");

  console.log(`merchants needing non-rule classification: ${Object.keys(byMerchant).length}`);
  for (const [m, c] of Object.entries(byMerchant)) console.log(`  ${m.padEnd(18)} ${c.category.padEnd(22)} ${c.method}/${c.confidence_level}  — ${c.reason.slice(0, 90)}`);
  console.log(`enrichments cached: ${enrichments.map((e) => `${e.merchant_normalized} → ${e.mapped_category} <${e.source_url}>`).join("; ") || "none"}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
