/**
 * Seeds `cache/enrichments.json` with the REAL Tavily result for the demo's
 * unknown vendor (`DEMO.UNKNOWN_VENDOR` — Ashby), so the live demo cites a real
 * indexed source without depending on a network call on stage (contract §13).
 *
 * Run from the package or the repo root:
 *   npm run seed-cache -w @canary/classification
 *   node --experimental-strip-types scripts/seed-cache.ts
 *
 * Keys come from the environment, or from `apps/api/.dev.vars` (KEY=VALUE
 * lines) if present. Keys are never printed and never written to the cache.
 */
import { readFile } from "node:fs/promises";
import { DEMO, type Transaction } from "@canary/shared";
import { OpenAiProvider, TavilyProvider, classifyTransactions } from "../src/core.ts";
import { DEMO_CACHE_FILE, FileEnrichmentCache } from "../src/node.ts";

const DEV_VARS_URL = new URL("../../../apps/api/.dev.vars", import.meta.url);

/** Parses `KEY=VALUE` lines, ignoring comments and blank lines. Quotes are stripped. */
function parseDevVars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key !== "" && value !== "") out[key] = value;
  }
  return out;
}

async function loadKeys(): Promise<{ openai: string; tavily: string }> {
  let fromFile: Record<string, string> = {};
  try {
    fromFile = parseDevVars(await readFile(DEV_VARS_URL, "utf8"));
  } catch {
    // No .dev.vars — environment only.
  }
  const openai = process.env["OPENAI_API_KEY"] ?? fromFile["OPENAI_API_KEY"] ?? "";
  const tavily = process.env["TAVILY_API_KEY"] ?? fromFile["TAVILY_API_KEY"] ?? "";
  return { openai, tavily };
}

async function main(): Promise<void> {
  const { openai, tavily } = await loadKeys();
  if (tavily === "") {
    console.error("TAVILY_API_KEY is not set (checked process.env and apps/api/.dev.vars).");
    console.error(`Leaving ${DEMO_CACHE_FILE} unchanged.`);
    process.exitCode = 1;
    return;
  }
  if (openai === "") {
    console.warn("OPENAI_API_KEY is not set — seeding the Tavily enrichment only (method will be NEEDS_REVIEW).");
  }

  const vendor = DEMO.UNKNOWN_VENDOR;
  const transaction: Transaction = {
    id: "seed_unknown_vendor",
    account_id: "seed",
    date: DEMO.END_DATE,
    amount_cents: -150_000,
    currency: "USD",
    merchant_raw: vendor.merchant_raw,
    merchant_normalized: vendor.merchant_normalized,
    description: "",
    flow_type: "OPERATING_OUTFLOW",
    status: "settled",
    source: "synthetic",
    tags: [],
  };

  const cache = new FileEnrichmentCache(DEMO_CACHE_FILE);
  const result = await classifyTransactions([transaction], {
    ...(openai === "" ? {} : { llm: OpenAiProvider(openai) }),
    research: TavilyProvider(tavily, undefined, { now: () => new Date().toISOString() }),
    // Deliberately no `cache` here: this script refreshes the entry rather than reading it.
  });

  const classification = result.classifications[transaction.id]!;
  const enrichment = result.enrichments[0];

  console.log(`vendor            ${vendor.display_name} (${vendor.merchant_normalized})`);
  console.log(`category          ${classification.category} (expected ${vendor.expected_category})`);
  console.log(`method            ${classification.method} / ${classification.confidence_level}`);
  console.log(`reason            ${classification.reason}`);
  for (const signal of classification.supporting_signals) {
    console.log(`signal            ${signal.source}: ${signal.detail}${signal.url ? ` <${signal.url}>` : ""}`);
  }

  if (enrichment === undefined) {
    console.error("Tavily returned no usable result — nothing to cache.");
    process.exitCode = 1;
    return;
  }

  // Stored as a cache entry: anything read back is "previously retrieved".
  const record = await cache.read();
  record[enrichment.merchant_normalized] = { ...enrichment, cached: true };
  await cache.write(record);

  console.log(`business_type     ${enrichment.business_type}`);
  console.log(`mapped_category   ${enrichment.mapped_category}`);
  console.log(`source            ${enrichment.source_title} <${enrichment.source_url}>`);
  console.log(`retrieved_at      ${enrichment.retrieved_at}`);
  console.log(`wrote             ${DEMO_CACHE_FILE}`);

  if (enrichment.mapped_category !== vendor.expected_category) {
    console.warn(`WARNING: mapped category ${enrichment.mapped_category} != expected ${vendor.expected_category}.`);
  }
}

await main();
