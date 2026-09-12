/** The connect flow end to end: the guarded `start`, the state-checked `callback`, disconnect, and what `/api/calendar/connection` reports. */
import { beforeEach, describe, expect, it } from "vitest";
import { signState } from "../calendar/google/crypto.ts";
import { GOOGLE_SCOPE_PARAM } from "../calendar/google/oauth.ts";
import { clearGoogleCalendarCache } from "../calendar/google/provider.ts";
import { GoogleOauthStore } from "../calendar/google/store.ts";
import { clearGoogleTokenCache } from "../calendar/google/tokens.ts";
import { FakeD1 } from "../test/fake-d1.ts";
import { connectGoogle, createHarness, FIXED_NOW, GOOGLE_TEST_ENV, googleFetchHandler, TEST_ENV, type GoogleScript } from "../test/harness.ts";
import type { CalendarConnectionResponse, DisconnectResponse } from "./oauth.ts";

const SECRET = TEST_ENV.WEBHOOK_SECRET;
const REDIRECT_URI = "https://canary.test/oauth/google/callback";

function harness(options: { script?: GoogleScript; db?: FakeD1; env?: Record<string, string | undefined> } = {}) {
  return createHarness({
    db: options.db ?? new FakeD1(),
    fetchHandler: googleFetchHandler(options.script ?? {}),
    env: { ...GOOGLE_TEST_ENV, ...options.env },
  });
}

const validState = () => signState(SECRET, Date.parse(FIXED_NOW));

beforeEach(() => {
  clearGoogleTokenCache();
  clearGoogleCalendarCache();
});

describe("GET /oauth/google/start", () => {
  it("redirects to Google with every parameter the offline grant needs", async () => {
    const h = harness();
    const res = await h.app.request(`/oauth/google/start?secret=${SECRET}`);
    expect(res.status).toBe(302);

    const url = new URL(res.headers.get("location")!);
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: GOOGLE_TEST_ENV.GOOGLE_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    });

    const scopes = url.searchParams.get("scope")!.split(" ");
    expect(scopes).toEqual([
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.readonly",
      "openid",
      "email",
    ]);
  });

  it("signs the state so the callback can recognise its own redirect", async () => {
    const h = harness();
    const res = await h.app.request(`/oauth/google/start?secret=${SECRET}`);
    const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
    expect(state.split(".")).toHaveLength(3);
    expect(state).not.toContain(SECRET);
  });

  it("refuses without the operator secret, and never reveals whether one was close", async () => {
    const h = harness();
    for (const query of ["", "?secret=", "?secret=wrong", `?secret=${SECRET}x`]) {
      const res = await h.app.request(`/oauth/google/start${query}`);
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("Not authorized");
      expect(body).not.toContain(SECRET);
    }
  });

  it("says so plainly when no OAuth client is configured", async () => {
    const h = createHarness({ db: new FakeD1(), env: { GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined } });
    const res = await h.app.request(`/oauth/google/start?secret=${SECRET}`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("GOOGLE_CLIENT_ID");
  });
});

describe("GET /oauth/google/callback", () => {
  it("exchanges the code and stores an encrypted connection", async () => {
    const db = new FakeD1();
    const h = harness({ db, script: { refreshToken: "1//real-refresh-token", accessToken: "ya29.access", accountEmail: "founder@perch.test" } });

    const res = await h.app.request(`/oauth/google/callback?code=auth-code-123&state=${await validState()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Google Calendar connected for founder@perch.test");
    expect(html).toContain("You can close this tab");
    expect(html).not.toContain("1//real-refresh-token");
    expect(html).not.toContain("ya29.access");

    const exchange = h.calls.find((c) => c.url === "https://oauth2.googleapis.com/token")!;
    expect(exchange.body).toEqual({
      code: "auth-code-123",
      client_id: GOOGLE_TEST_ENV.GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_TEST_ENV.GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    });

    const row = db.rows("google_oauth")[0]!;
    expect(row.id).toBe("founder");
    expect(row.account_email).toBe("founder@perch.test");
    expect(row.connected_at).toBe(FIXED_NOW);
    expect(row.revoked_at).toBeNull();
    // Ciphertext at rest, plaintext only through the store.
    expect(String(row.refresh_token_encrypted)).not.toContain("1//real-refresh-token");
    expect(String(row.access_token_encrypted)).not.toContain("ya29.access");

    const decrypted = await new GoogleOauthStore(db, SECRET).read();
    expect(decrypted).toMatchObject({
      refresh_token: "1//real-refresh-token",
      access_token: "ya29.access",
      expires_at: "2026-09-14T13:00:00.000Z",
      account_email: "founder@perch.test",
    });
    expect(decrypted!.scopes).toEqual(GOOGLE_SCOPE_PARAM.split(" "));
  });

  it("fetches the account email with the new token", async () => {
    const h = harness({ script: { accessToken: "ya29.fresh" } });
    await h.app.request(`/oauth/google/callback?code=abc&state=${await validState()}`);
    const userinfo = h.calls.find((c) => c.url.includes("/oauth2/v3/userinfo"))!;
    expect(userinfo.headers.authorization).toBe("Bearer ya29.fresh");
  });

  it("connects even when userinfo declines — the email is cosmetic", async () => {
    const h = harness({ script: { override: (url) => (url.includes("userinfo") ? new Response("nope", { status: 403 }) : null) } });
    const res = await h.app.request(`/oauth/google/callback?code=abc&state=${await validState()}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("connected for your account");
  });

  it("rejects a forged state and never exchanges the code", async () => {
    const h = harness();
    const forged = await signState("not-the-webhook-secret", Date.parse(FIXED_NOW));
    const res = await h.app.request(`/oauth/google/callback?code=abc&state=${forged}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("bad_signature");
    expect(h.calls).toHaveLength(0);
  });

  it("rejects an expired state", async () => {
    const h = harness();
    const stale = await signState(SECRET, Date.parse(FIXED_NOW) - 11 * 60_000);
    const res = await h.app.request(`/oauth/google/callback?code=abc&state=${stale}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("expired");
    expect(h.calls).toHaveLength(0);
  });

  it("rejects a callback with no state or no code", async () => {
    const h = harness();
    expect((await h.app.request("/oauth/google/callback?code=abc")).status).toBe(400);
    expect((await h.app.request(`/oauth/google/callback?state=${await validState()}`)).status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it("reports Google's own refusal", async () => {
    const h = harness();
    const res = await h.app.request("/oauth/google/callback?error=access_denied");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("access_denied");
  });

  it("reports a rejected authorization code without storing anything", async () => {
    const db = new FakeD1();
    const h = harness({
      db,
      script: {
        override: (url) =>
          url.includes("/token")
            ? new Response(JSON.stringify({ error: "invalid_grant", error_description: "Bad code" }), {
                status: 400,
                headers: { "content-type": "application/json" },
              })
            : null,
      },
    });
    const res = await h.app.request(`/oauth/google/callback?code=stale&state=${await validState()}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Bad code");
    expect(db.rows("google_oauth")).toHaveLength(0);
  });

  it("refuses a grant with no refresh token — an hour-long connection is not a connection", async () => {
    const db = new FakeD1();
    const h = harness({ db, script: { refreshToken: null } });
    const res = await h.app.request(`/oauth/google/callback?code=abc&state=${await validState()}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("no refresh token");
    expect(db.rows("google_oauth")).toHaveLength(0);
  });

  it("keeps the original connection date when the same account reconnects", async () => {
    const db = new FakeD1();
    await connectGoogle(db, { connectedAt: "2026-09-01T09:00:00.000Z", now: "2026-09-01T09:00:00.000Z" });
    const h = harness({ db });
    await h.app.request(`/oauth/google/callback?code=abc&state=${await validState()}`);
    const row = db.rows("google_oauth")[0]!;
    expect(row.connected_at).toBe("2026-09-01T09:00:00.000Z");
    expect(row.updated_at).toBe(FIXED_NOW);
  });

  it("clears a previous revocation", async () => {
    const db = new FakeD1();
    await connectGoogle(db);
    await new GoogleOauthStore(db, SECRET).markRevoked("2026-09-13T09:00:00.000Z");
    const h = harness({ db });
    await h.app.request(`/oauth/google/callback?code=abc&state=${await validState()}`);
    expect((await new GoogleOauthStore(db, SECRET).read())?.revoked_at).toBeNull();
  });
});

describe("POST /oauth/google/disconnect", () => {
  it("deletes the row and revokes at Google", async () => {
    const db = new FakeD1();
    await connectGoogle(db, { refreshToken: "1//to-be-revoked" });
    const h = harness({ db });

    const { status, body } = await h.authed<DisconnectResponse>("/oauth/google/disconnect");
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, disconnected: true, revoked: true });
    expect(db.rows("google_oauth")).toHaveLength(0);

    const revoke = h.calls.find((c) => c.url === "https://oauth2.googleapis.com/revoke")!;
    expect(revoke.body).toEqual({ token: "1//to-be-revoked" });
  });

  it("still disconnects locally when Google's revoke call fails", async () => {
    const db = new FakeD1();
    await connectGoogle(db);
    const h = harness({ db, script: { override: (url) => (url.includes("/revoke") ? new Response("nope", { status: 400 }) : null) } });
    const { body } = await h.authed<DisconnectResponse>("/oauth/google/disconnect");
    expect(body).toEqual({ ok: true, disconnected: true, revoked: false });
    expect(db.rows("google_oauth")).toHaveLength(0);
  });

  it("is a no-op when nothing is connected", async () => {
    const h = harness();
    const { body } = await h.authed<DisconnectResponse>("/oauth/google/disconnect");
    expect(body).toEqual({ ok: true, disconnected: false, revoked: false });
  });

  it("requires the secret in a header — not the query string", async () => {
    const db = new FakeD1();
    await connectGoogle(db);
    const h = harness({ db });
    expect((await h.post("/oauth/google/disconnect")).status).toBe(401);
    expect((await h.post(`/oauth/google/disconnect?secret=${SECRET}`)).status).toBe(401);
    expect(db.rows("google_oauth")).toHaveLength(1);
  });
});

describe("GET /api/calendar/connection", () => {
  it("reports google, with the account and scopes but no tokens", async () => {
    const db = new FakeD1();
    await connectGoogle(db, { accountEmail: "founder@perch.test", connectedAt: "2026-09-10T09:00:00.000Z" });
    const h = harness({ db });

    const { status, body } = await h.json<CalendarConnectionResponse>("/api/calendar/connection");
    expect(status).toBe(200);
    expect(body).toEqual({
      provider: "google",
      account_email: "founder@perch.test",
      connected_at: "2026-09-10T09:00:00.000Z",
      scopes: GOOGLE_SCOPE_PARAM.split(" "),
    });
    expect(JSON.stringify(body)).not.toContain("refresh");
    expect(JSON.stringify(body)).not.toContain("test-access-token");
  });

  it("reports ics when only the iCal feed is configured", async () => {
    const h = harness({ env: { CALENDAR_ICS_URL: "https://calendar.google.com/calendar/ical/x/private-abc/basic.ics" } });
    expect((await h.json<CalendarConnectionResponse>("/api/calendar/connection")).body).toEqual({ provider: "ics" });
  });

  it("reports none when nothing is configured", async () => {
    const h = harness({ env: { GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined } });
    expect((await h.json<CalendarConnectionResponse>("/api/calendar/connection")).body).toEqual({ provider: "none" });
  });

  it("falls back and asks for a reconnect after Google revoked the token", async () => {
    const db = new FakeD1();
    await connectGoogle(db, { accountEmail: "founder@perch.test" });
    await new GoogleOauthStore(db, SECRET).markRevoked("2026-09-13T09:00:00.000Z");
    const h = harness({ db, env: { CALENDAR_ICS_URL: "https://calendar.google.com/calendar/ical/x/private-abc/basic.ics" } });

    expect((await h.json<CalendarConnectionResponse>("/api/calendar/connection")).body).toEqual({
      provider: "ics",
      account_email: "founder@perch.test",
      revoked_at: "2026-09-13T09:00:00.000Z",
    });
  });

  it("falls back to ics when the row cannot be decrypted (WEBHOOK_SECRET rotated)", async () => {
    const db = new FakeD1();
    await connectGoogle(db);
    const h = harness({ db, env: { WEBHOOK_SECRET: "rotated-secret", CALENDAR_ICS_URL: "https://example.test/f.ics" } });
    expect((await h.json<CalendarConnectionResponse>("/api/calendar/connection")).body).toEqual({ provider: "ics" });
  });

  it("falls back rather than failing when migration 0005 has not been applied", async () => {
    const db = new FakeD1({ rejectTables: ["google_oauth"] });
    const h = harness({ db });
    expect((await h.json<CalendarConnectionResponse>("/api/calendar/connection")).body).toEqual({ provider: "none" });
  });
});

describe("the connect flow, as the operator runs it", () => {
  it("start → callback → connection reports google; disconnect puts it back", async () => {
    const db = new FakeD1();
    const h = harness({ db, script: { accountEmail: "founder@perch.test" } });

    expect((await h.json<CalendarConnectionResponse>("/api/calendar/connection")).body).toEqual({ provider: "none" });

    const start = await h.app.request(`/oauth/google/start?secret=${SECRET}`);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    expect((await h.app.request(`/oauth/google/callback?code=code-from-google&state=${state}`)).status).toBe(200);

    expect((await h.json<CalendarConnectionResponse>("/api/calendar/connection")).body).toMatchObject({
      provider: "google",
      account_email: "founder@perch.test",
    });

    await h.authed("/oauth/google/disconnect");
    expect((await h.json<CalendarConnectionResponse>("/api/calendar/connection")).body).toEqual({ provider: "none" });
  });
});
