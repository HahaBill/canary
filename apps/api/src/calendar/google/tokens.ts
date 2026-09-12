/**
 * Access tokens for the founder's Google connection.
 *
 * Google access tokens live an hour; refresh tokens live until revoked. Every
 * call here answers one question — "what bearer token should this request use?"
 * — from three sources in order: the isolate memo, the token stored in D1, and
 * finally a refresh grant.
 *
 * `invalid_grant` is the one terminal error: the founder revoked Canary's access
 * (or the token aged out of a Testing-mode consent screen). The row is marked
 * revoked so the app falls back to the ICS feed instead of retrying a dead token
 * on every request.
 */
import type { ISODateTime } from "@canary/shared";
import type { FetchLike } from "../../sendblue/client.ts";
import { refreshAccessToken } from "./oauth.ts";
import type { GoogleOauthStore } from "./store.ts";

/** Refresh this long before the stated expiry, so a token cannot die mid-request. */
export const TOKEN_SKEW_MS = 60_000;

export type AccessTokenResult =
  | { ok: true; access_token: string; expires_at: ISODateTime; refreshed: boolean }
  | { ok: false; error: "not_connected" | "not_configured" | "revoked" | "refresh_failed"; detail?: string };

interface MemoEntry {
  access_token: string;
  expires_at_ms: number;
}

/**
 * Per isolate, keyed by client id — one founder, but a client-id change means a
 * different app and must not reuse a token.
 */
const memo = new Map<string, MemoEntry>();

/** Test seam: drop the isolate-level access-token memo. */
export function clearGoogleTokenCache(): void {
  memo.clear();
}

export interface AccessTokenEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

/**
 * `now` is injected (never `Date.now()`), so a test can walk a token to the far
 * side of its expiry without waiting an hour.
 */
export async function getAccessToken(
  store: GoogleOauthStore,
  env: AccessTokenEnv,
  fetchImpl: FetchLike,
  now: () => string,
): Promise<AccessTokenResult> {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return { ok: false, error: "not_configured" };

  const nowMs = new Date(now()).getTime();
  const cached = memo.get(clientId);
  if (cached && cached.expires_at_ms - TOKEN_SKEW_MS > nowMs) {
    return { ok: true, access_token: cached.access_token, expires_at: new Date(cached.expires_at_ms).toISOString(), refreshed: false };
  }

  const connection = await store.read();
  if (!connection) return { ok: false, error: "not_connected" };
  if (connection.revoked_at) return { ok: false, error: "revoked" };

  const storedExpiryMs = connection.expires_at ? new Date(connection.expires_at).getTime() : 0;
  if (connection.access_token && Number.isFinite(storedExpiryMs) && storedExpiryMs - TOKEN_SKEW_MS > nowMs) {
    memo.set(clientId, { access_token: connection.access_token, expires_at_ms: storedExpiryMs });
    return { ok: true, access_token: connection.access_token, expires_at: new Date(storedExpiryMs).toISOString(), refreshed: false };
  }

  const result = await refreshAccessToken({ refreshToken: connection.refresh_token, clientId, clientSecret, fetchImpl });
  if (!result.ok) {
    if (result.error === "invalid_grant") {
      memo.delete(clientId);
      await store.markRevoked(now());
      // Detail only: Google's `error_description` never contains the token.
      console.warn(JSON.stringify({ msg: "google_oauth_revoked", detail: result.detail }));
      return { ok: false, error: "revoked", detail: result.detail };
    }
    console.warn(JSON.stringify({ msg: "google_token_refresh_failed", status: result.status, detail: result.detail }));
    return { ok: false, error: "refresh_failed", detail: result.detail };
  }

  const expiresAtMs = nowMs + result.grant.expires_in * 1000;
  const expiresAt = new Date(expiresAtMs).toISOString();
  memo.set(clientId, { access_token: result.grant.access_token, expires_at_ms: expiresAtMs });
  await store.saveAccessToken(result.grant.access_token, expiresAt, now());
  return { ok: true, access_token: result.grant.access_token, expires_at: expiresAt, refreshed: true };
}
