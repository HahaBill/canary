/**
 * Google's OAuth endpoints, as plain `fetch` calls. No SDK, no `googleapis`.
 *
 * One account only: the founder's. There is no per-user auth in Canary, so
 * "connected" is a single D1 row and this module is the code that fills it.
 */
import type { FetchLike } from "../../sendblue/client.ts";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

/**
 * `calendar.events` is needed to insert the review event; `calendar.readonly`
 * covers freeBusy and the event list. `openid email` is only there so the
 * callback can name the account it just connected — Canary never stores a
 * profile.
 */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "openid",
  "email",
] as const;

export const GOOGLE_SCOPE_PARAM = GOOGLE_SCOPES.join(" ");

const TIMEOUT_MS = 10_000;

/** Fixed by the OAuth client in the Google Cloud console — it must match byte for byte. */
export function googleRedirectUri(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/oauth/google/callback`;
}

export interface AuthUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  /**
   * Google `login_hint` — pre-selects this account on the consent screen.
   * Taken from `FOUNDER_EMAIL` when set. Does not restrict who can consent;
   * a different account is still flagged, not rejected, on the callback.
   */
  loginHint?: string;
}

/**
 * `access_type=offline` + `prompt=consent` is what makes Google hand back a
 * refresh token; without both, a re-consent returns only an access token and the
 * connection silently expires in an hour.
 */
export function buildAuthUrl({ clientId, redirectUri, state, loginHint }: AuthUrlInput): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPE_PARAM,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  const hint = loginHint?.trim();
  if (hint) params.set("login_hint", hint);
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export interface TokenGrant {
  access_token: string;
  /** Only present on the authorization-code exchange (and only with `prompt=consent`). */
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

export type TokenResult =
  | { ok: true; grant: TokenGrant }
  | { ok: false; error: "invalid_grant" | "token_request_failed"; detail: string; status: number };

async function postForm(url: string, form: Record<string, string>, fetchImpl: FetchLike): Promise<Response> {
  return fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/**
 * Google reports a dead refresh token as `400 invalid_grant`, which is the one
 * error the caller must treat differently: it means "the founder revoked us",
 * not "try again later".
 */
async function readTokenResponse(res: Response): Promise<TokenResult> {
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Non-JSON error bodies happen; the status still tells us what to do.
  }

  if (!res.ok) {
    const error = typeof parsed.error === "string" ? parsed.error : "";
    const detail = typeof parsed.error_description === "string" ? parsed.error_description : error || `HTTP ${res.status}`;
    return { ok: false, error: error === "invalid_grant" ? "invalid_grant" : "token_request_failed", detail, status: res.status };
  }

  const accessToken = typeof parsed.access_token === "string" ? parsed.access_token : "";
  if (!accessToken) return { ok: false, error: "token_request_failed", detail: "response carried no access_token", status: res.status };

  return {
    ok: true,
    grant: {
      access_token: accessToken,
      ...(typeof parsed.refresh_token === "string" && parsed.refresh_token ? { refresh_token: parsed.refresh_token } : {}),
      expires_in: typeof parsed.expires_in === "number" ? parsed.expires_in : 3600,
      ...(typeof parsed.scope === "string" ? { scope: parsed.scope } : {}),
    },
  };
}

export interface ExchangeCodeInput {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl: FetchLike;
}

export async function exchangeCode(input: ExchangeCodeInput): Promise<TokenResult> {
  try {
    const res = await postForm(
      GOOGLE_TOKEN_URL,
      {
        code: input.code,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: input.redirectUri,
        grant_type: "authorization_code",
      },
      input.fetchImpl,
    );
    return await readTokenResponse(res);
  } catch (err) {
    return { ok: false, error: "token_request_failed", detail: err instanceof Error ? err.message : String(err), status: 0 };
  }
}

export interface RefreshTokenInput {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetchImpl: FetchLike;
}

export async function refreshAccessToken(input: RefreshTokenInput): Promise<TokenResult> {
  try {
    const res = await postForm(
      GOOGLE_TOKEN_URL,
      {
        refresh_token: input.refreshToken,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        grant_type: "refresh_token",
      },
      input.fetchImpl,
    );
    return await readTokenResponse(res);
  } catch (err) {
    return { ok: false, error: "token_request_failed", detail: err instanceof Error ? err.message : String(err), status: 0 };
  }
}

/** The connected account's email, for the "connected as" line. Null when the call fails — cosmetic, never fatal. */
export async function fetchAccountEmail(accessToken: string, fetchImpl: FetchLike): Promise<string | null> {
  try {
    const res = await fetchImpl(GOOGLE_USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { email?: unknown };
    return typeof body.email === "string" && body.email ? body.email : null;
  } catch {
    return null;
  }
}

/** Best-effort revocation on disconnect: the local row is deleted either way. */
export async function revokeToken(token: string, fetchImpl: FetchLike): Promise<boolean> {
  try {
    const res = await postForm(GOOGLE_REVOKE_URL, { token }, fetchImpl);
    return res.ok;
  } catch {
    return false;
  }
}
