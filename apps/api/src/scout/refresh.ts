/**
 * Explicit Scout Refresh. Live Tavily only lives here.
 *
 * Writes Scout rows into `vendor_enrichments` under `scout:` keys. Does not
 * create incidents, set materiality, send a message, or overwrite a
 * corroboration row (`ashby` stays `ashby`).
 */
import { scoutRefreshErrorFrom, searchScoutVendor, type FetchLike as ClassificationFetch } from "@canary/classification/core";
import {
  SCOUT,
  markScoutFindingsCached,
  mergeScoutCaches,
  scoutCacheFresh,
  selectScoutVendors,
  type DerivedDemoObject,
  type ISODateTime,
  type ScoutCacheFile,
  type ScoutPage,
  type ScoutRefreshError,
  type ScoutVendorCache,
} from "@canary/shared";
import type { D1Store } from "../data/d1.ts";
import type { FetchLike } from "../sendblue/client.ts";
import { displayName } from "../format.ts";
import { loadScoutCache, scoutPageFrom } from "./page.ts";

export function asClassificationFetch(fetchImpl: FetchLike): ClassificationFetch {
  return async (url, init) => {
    const response = await fetchImpl(url, { method: init.method, headers: init.headers, body: init.body });
    return { ok: response.ok, status: response.status, text: () => response.text() };
  };
}

export async function refreshScoutPage(input: {
  derived: DerivedDemoObject;
  store: D1Store | null;
  now: ISODateTime;
  tavilyKey?: string;
  fetchImpl: FetchLike;
}): Promise<ScoutPage> {
  const cache = await loadScoutCache(input.store, input.now);
  const entities = selectScoutVendors(input.derived.burn.weekly_variable_by_entity);
  const tavilyKey = input.tavilyKey?.trim();

  if (!tavilyKey) {
    return scoutPageFrom(input.derived, cache, { now: input.now, tavilyCalls: 0, refreshError: "TAVILY_NOT_CONFIGURED" });
  }

  const overlay: ScoutCacheFile = { kind: "scout", lookback_days: SCOUT.LOOKBACK_DAYS, retrieved_at: input.now, vendors: {} };
  let calls = 0;
  let refreshError: ScoutRefreshError | undefined;
  const freshEntities: string[] = [];

  for (const entity of entities) {
    const existing = cache.vendors[entity];
    if (existing && scoutCacheFresh(existing.retrieved_at, input.now)) {
      overlay.vendors[entity] = markScoutFindingsCached(existing);
      continue;
    }
    if (calls >= SCOUT.MAX_TAVILY_CALLS_PER_RUN) {
      if (existing) overlay.vendors[entity] = existing;
      continue;
    }

    try {
      const brief: ScoutVendorCache = await searchScoutVendor(
        tavilyKey,
        { merchant_raw: displayName(entity), merchant_normalized: entity, display_name: displayName(entity) },
        asClassificationFetch(input.fetchImpl),
        { now: () => input.now },
      );
      calls += 1;
      overlay.vendors[entity] = brief;
      overlay.retrieved_at = input.now;
      freshEntities.push(entity);
      if (input.store) {
        try {
          await input.store.saveScoutBrief(brief, displayName(entity));
        } catch {
          // D1 write is best-effort; the response still carries this run.
        }
      }
    } catch (error) {
      refreshError = scoutRefreshErrorFrom(error);
      if (existing) overlay.vendors[entity] = existing;
      if (refreshError === "TAVILY_UNAUTHORIZED" || refreshError === "TAVILY_QUOTA") break;
    }
  }

  return scoutPageFrom(input.derived, mergeScoutCaches(cache, overlay), {
    now: input.now,
    tavilyCalls: calls,
    refreshError,
    freshEntities,
  });
}
