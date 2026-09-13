/**
 * Writes one derived + ledger snapshot per demo-clock day, plus the posted
 * transaction list. `npm run build -w apps/web` runs this after Vite so the
 * files land in the Worker assets directory the production isolate fetches.
 *
 * Every figure is `runPipeline()` output. Nothing here invents money.
 *
 *   npm run seed-as-of -w @canary/api
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addDays, DEMO } from "@canary/shared";
import { projectRecurring } from "@canary/engine";
import { loadDemoCaches, runPipeline } from "@canary/pipeline";
import { CYCLE_DAYS } from "../src/clock.ts";
import { CANARY_ASSET_PREFIX } from "../src/data/as-of-snapshots.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(process.argv[2] ?? resolve(here, `../public/${CANARY_ASSET_PREFIX}`));
const asOfDir = resolve(outDir, "as-of");

const caches = await loadDemoCaches();
// One generated company for every day. The clock never leaves history, so the
// unused 26-week horizon is not generated — same as the Worker fallback path.
const { generated } = await runPipeline({ ...caches, asOf: DEMO.END_DATE });

mkdirSync(asOfDir, { recursive: true });
writeFileSync(resolve(outDir, "transactions.json"), JSON.stringify(generated.transactions));

let bytes = 0;
for (let i = 0; i < CYCLE_DAYS; i++) {
  const asOf = addDays(DEMO.END_DATE, i - (CYCLE_DAYS - 1));
  const { derived, ledger } = await runPipeline({
    ...caches,
    generated,
    asOf,
    now: `${asOf}T12:00:00.000Z`,
  });
  const recurring = projectRecurring(ledger, { horizonEnd: addDays(ledger.history_end, 183) });
  const derivedJson = JSON.stringify(derived);
  const ledgerJson = JSON.stringify({ ledger, recurring });
  writeFileSync(resolve(asOfDir, `${asOf}.derived.json`), derivedJson);
  writeFileSync(resolve(asOfDir, `${asOf}.ledger.json`), ledgerJson);
  bytes += derivedJson.length + ledgerJson.length;
}

bytes += JSON.stringify(generated.transactions).length;
console.log(`as-of snapshots: ${CYCLE_DAYS} days → ${outDir} (${(bytes / 1_000_000).toFixed(1)} MB)`);
