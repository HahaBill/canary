/**
 * Connecting the founder's Google Calendar. Three operator routes plus one
 * public status route.
 *
 *   GET  /oauth/google/start?secret=…   → 302 to Google's consent screen
 *   GET  /oauth/google/callback         → exchanges the code, stores the tokens
 *   POST /oauth/google/disconnect       → deletes the row, revokes at Google
 *   GET  /api/calendar/connection       → which calendar is in use (no secrets)
 *
 * **Why `start` accepts `?secret=`.** Every other privileged route takes the
 * shared secret in `x-canary-secret`, precisely so it stays out of request logs
 * (`src/security.ts`). This one cannot: the operator reaches it by typing a URL
 * into a browser, and a browser cannot be made to send a custom header. So
 * `start` — and only `start` — also accepts the secret as a query parameter,
 * compared in constant time. A deliberate, documented exception: the route's only
 * effect is a redirect, and `WEBHOOK_SECRET` is rotated after the demo either
 * way. `callback` needs no secret because it authenticates itself with the
 * HMAC-signed `state` it must present.
 */
import { signState, verifyState } from "../calendar/google/crypto.ts";
import { buildAuthUrl, exchangeCode, fetchAccountEmail, GOOGLE_SCOPE_PARAM, googleRedirectUri, revokeToken } from "../calendar/google/oauth.ts";
import { clearGoogleCalendarCache } from "../calendar/google/provider.ts";
import { clearGoogleTokenCache } from "../calendar/google/tokens.ts";
import type { CalendarConnectionResponse } from "@canary/shared";
import { baseUrl, jsonError, type CanaryApp, type CanaryContext } from "../context.ts";
import { constantTimeEqual, requestAuthorized } from "../security.ts";

export type { CalendarConnectionResponse };

export interface DisconnectResponse {
  ok: true;
  /** False when there was nothing stored to remove. */
  disconnected: boolean;
  /** Whether Google acknowledged the revocation. Best-effort by design. */
  revoked: boolean;
}

function htmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The two lines the operator sees at the end of the flow. No tokens, no scripts, no framework. */
function page(title: string, body: string, status: 200 | 400 | 503): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Canary — ${htmlEscape(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0b0e14;color:#e6e9ef}main{max-width:32rem;padding:2rem}h1{font-size:1.125rem;margin:0 0 .5rem}p{margin:0;color:#9aa4b2}</style>
</head><body><main><h1>🐤 ${htmlEscape(title)}</h1><p>${htmlEscape(body)}</p></main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

interface OauthConfig {
  clientId: string;
  clientSecret: string;
  secret: string;
  redirectUri: string;
}

function oauthConfig(c: CanaryContext): OauthConfig | { detail: string } {
  const env = c.get("appEnv");
  const secret = env.WEBHOOK_SECRET?.trim();
  if (!secret) return { detail: "WEBHOOK_SECRET is not set." };
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return { detail: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set." };
  // Must match the redirect URI registered on the OAuth client, byte for byte.
  return { clientId, clientSecret, secret, redirectUri: googleRedirectUri(baseUrl(c)) };
}

export function registerOauthRoutes(app: CanaryApp): void {
  app.get("/oauth/google/start", async (c) => {
    const config = oauthConfig(c);
    if (!("clientId" in config)) return page("Not configured", config.detail, 503);

    // See the module comment: this ONE route reads the secret from the query string.
    const presented = c.req.query("secret") ?? "";
    if (!presented || !constantTimeEqual(presented, config.secret)) {
      return page("Not authorized", "Append ?secret=<WEBHOOK_SECRET> to this URL. Only the operator connects the calendar.", 400);
    }

    const state = await signState(config.secret, new Date(c.get("now")()).getTime());
    const loginHint = c.get("appEnv").FOUNDER_EMAIL?.trim();
    console.log(JSON.stringify({ msg: "google_oauth_start", redirect_uri: config.redirectUri, scopes: GOOGLE_SCOPE_PARAM.split(" ") }));
    return c.redirect(
      buildAuthUrl({
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        state,
        ...(loginHint ? { loginHint } : {}),
      }),
      302,
    );
  });

  app.get("/oauth/google/callback", async (c) => {
    const config = oauthConfig(c);
    if (!("clientId" in config)) return page("Not configured", config.detail, 503);

    const declined = c.req.query("error");
    if (declined) return page("Not connected", `Google declined the request: ${declined}.`, 400);

    const code = c.req.query("code")?.trim() ?? "";
    const state = c.req.query("state")?.trim() ?? "";
    if (!code || !state) return page("Not connected", "The callback was missing `code` or `state`.", 400);

    const verdict = await verifyState(state, config.secret, new Date(c.get("now")()).getTime());
    if (!verdict.ok) {
      console.warn(JSON.stringify({ msg: "google_oauth_state_rejected", reason: verdict.reason }));
      return page("Not connected", `The sign-in link could not be verified (${verdict.reason}). Start again at /oauth/google/start.`, 400);
    }

    const store = c.get("calendarResolver").oauthStore;
    if (!store) return page("Not connected", "No D1 database is bound, so the connection cannot be stored.", 503);

    const fetchImpl = c.get("fetchImpl");
    const exchanged = await exchangeCode({
      code,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
      fetchImpl,
    });
    if (!exchanged.ok) {
      console.warn(JSON.stringify({ msg: "google_oauth_exchange_failed", error: exchanged.error, status: exchanged.status }));
      return page("Not connected", `Google rejected the authorization code (${exchanged.detail}).`, 400);
    }
    if (!exchanged.grant.refresh_token) {
      // Without a refresh token the connection dies in an hour: a failure, not a warning.
      return page(
        "Not connected",
        "Google returned no refresh token. Remove Canary under your Google account's third-party access, then connect again.",
        400,
      );
    }

    const now = c.get("now")();
    const accountEmail = await fetchAccountEmail(exchanged.grant.access_token, fetchImpl);
    const previous = await store.read().catch(() => null);
    await store.save({
      refresh_token: exchanged.grant.refresh_token,
      access_token: exchanged.grant.access_token,
      expires_at: new Date(new Date(now).getTime() + exchanged.grant.expires_in * 1000).toISOString(),
      scope: exchanged.grant.scope ?? GOOGLE_SCOPE_PARAM,
      account_email: accountEmail,
      now,
      // Reconnecting the same account keeps its original connection date.
      ...(previous?.connected_at ? { connected_at: previous.connected_at } : {}),
    });
    // A revoked (or simply older) token must not survive in the isolate memo.
    clearGoogleTokenCache();
    clearGoogleCalendarCache();

    // Structured and deliberately tokenless: the account and the scopes, nothing else.
    console.log(
      JSON.stringify({
        msg: "google_oauth_connected",
        account_email: accountEmail ?? null,
        scopes: (exchanged.grant.scope ?? GOOGLE_SCOPE_PARAM).split(/\s+/).filter(Boolean),
        connected_at: now,
      }),
    );

    const expected = c.get("appEnv").FOUNDER_EMAIL?.trim().toLowerCase();
    const mismatch = Boolean(expected && accountEmail && accountEmail.toLowerCase() !== expected);
    if (mismatch) console.warn(JSON.stringify({ msg: "google_oauth_account_mismatch", connected: accountEmail, expected }));
    return page(
      mismatch ? "Connected — but to a different account" : "Google Calendar connected",
      mismatch
        ? `Google Calendar connected for ${accountEmail}, but Canary expected ${expected}. Disconnect and reconnect with the founder account if this was a mistake.`
        : `Google Calendar connected for ${accountEmail ?? "your account"}. You can close this tab.`,
      200,
    );
  });

  app.post("/oauth/google/disconnect", async (c) => {
    const auth = requestAuthorized(c.req.raw.headers, c.get("appEnv").WEBHOOK_SECRET);
    if (auth === "unconfigured") return jsonError(c, 503, "webhook_not_configured", "WEBHOOK_SECRET is not set.");
    if (auth === "unauthorized") return jsonError(c, 401, "unauthorized", "Missing or invalid x-canary-secret.");

    const store = c.get("calendarResolver").oauthStore;
    if (!store) {
      const nothing: DisconnectResponse = { ok: true, disconnected: false, revoked: false };
      return c.json(nothing);
    }

    const existing = await store.read().catch(() => null);
    // Revoke first, delete second: a failed revocation still leaves Canary disconnected locally.
    const revoked = existing ? await revokeToken(existing.refresh_token, c.get("fetchImpl")) : false;
    await store.delete();
    clearGoogleTokenCache();
    clearGoogleCalendarCache();
    console.log(JSON.stringify({ msg: "google_oauth_disconnected", had_connection: Boolean(existing), revoked }));

    const body: DisconnectResponse = { ok: true, disconnected: Boolean(existing), revoked };
    return c.json(body);
  });

  app.get("/api/calendar/connection", async (c) => {
    const body: CalendarConnectionResponse = (await c.get("calendarResolver").resolve()).connection;
    return c.json(body);
  });
}
