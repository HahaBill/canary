/**
 * Assemble the Scout page from the ledger + the Scout cache.
 * GET never calls Tavily. Spend always comes from the burn window.
 */
import {
  assembleScoutPage,
  mergeScoutCaches,
  type DerivedDemoObject,
  type ISODateTime,
  type ScoutCacheFile,
  type ScoutPage,
  type ScoutRefreshError,
} from "@canary/shared";
import { loadDemoScoutCache } from "@canary/pipeline";
import type { D1Store } from "../data/d1.ts";
import { displayName } from "../format.ts";

export function committedScoutCache(): ScoutCacheFile {
  return loadDemoScoutCache();
}

export async function loadScoutCache(store: D1Store | null, now: ISODateTime): Promise<ScoutCacheFile> {
  const committed = committedScoutCache();
  if (!store) return committed;
  try {
    return mergeScoutCaches(committed, await store.listScoutCache(now));
  } catch {
    return committed;
  }
}

export function scoutPageFrom(derived: DerivedDemoObject, cache: ScoutCacheFile, extras: {
  now: ISODateTime;
  tavilyCalls?: number;
  refreshError?: ScoutRefreshError;
  freshEntities?: readonly string[];
}): ScoutPage {
  return assembleScoutPage({
    weeklyVariableByEntity: derived.burn.weekly_variable_by_entity,
    windowStart: derived.burn.burn_window_start,
    windowEnd: derived.burn.burn_window_end,
    whatifIncidentId: derived.primary_incident?.id ?? null,
    cache,
    now: extras.now,
    displayName,
    tavilyCalls: extras.tavilyCalls,
    refreshError: extras.refreshError,
    freshEntities: extras.freshEntities,
  });
}

export async function readScoutPage(derived: DerivedDemoObject, store: D1Store | null, now: ISODateTime): Promise<ScoutPage> {
  return scoutPageFrom(derived, await loadScoutCache(store, now), { now, tavilyCalls: 0 });
}
