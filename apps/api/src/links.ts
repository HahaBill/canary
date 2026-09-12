/**
 * The only place a Canary URL is ever formed. Paths come from shared
 * `buildAppPath`; the origin comes from `PUBLIC_BASE_URL`. LLMs never write URLs.
 */
import { buildAppPath, type CreateAppLinkRequest, type CreateAppLinkResponse } from "@canary/shared";

export function createAppLink(req: CreateAppLinkRequest, baseUrl: string): CreateAppLinkResponse {
  const path = buildAppPath(req);
  return { url: `${baseUrl.replace(/\/+$/, "")}${path}`, path };
}

export function incidentLink(incidentId: string, baseUrl: string, tab?: CreateAppLinkRequest["tab"]): CreateAppLinkResponse {
  return createAppLink({ destination: "incident", id: incidentId, ...(tab ? { tab } : {}) }, baseUrl);
}
