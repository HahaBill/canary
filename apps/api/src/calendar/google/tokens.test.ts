/** Access-token lifecycle: the memo, the stored token, the refresh, and the one error that is terminal. */
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1 } from "../../test/fake-d1.ts";
import { connectGoogle, GOOGLE_TEST_ENV, googleFetchHandler, TEST_ENV } from "../../test/harness.ts";
import type { FetchLike } from "../../sendblue/client.ts";
import { GoogleOauthStore } from "./store.ts";
import { clearGoogleTokenCache, getAccessToken, TOKEN_SKEW_MS } from "./tokens.ts";

const NOW = "2026-09-14T12:00:00.000Z";
const ENV = { GOOGLE_CLIENT_ID: GOOGLE_TEST_ENV.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: GOOGLE_TEST_ENV.GOOGLE_CLIENT_SECRET };

interface Recorder {
  fetchImpl: FetchLike;
  calls: Array<{ url: string; form: Record<string, string> }>;
}

/** Google's token endpoint, plus a record of exactly what was posted to it. */
function recorder(response?: () => Response): Recorder {
  const handler = googleFetchHandler();
  const state: Recorder = {
    calls: [],
    fetchImpl: async (input, init) => {
      const body = typeof init?.body === "string" ? Object.fromEntries(new URLSearchParams(init.body)) : {};
      state.calls.push({ url: String(input), form: body });
      return response ? response() : ((await handler(input, init)) ?? new Response("", { status: 404 }));
    },
  };
  return state;
}

function storeOver(db: FakeD1): GoogleOauthStore {
  return new GoogleOauthStore(db, TEST_ENV.WEBHOOK_SECRET);
}

beforeEach(clearGoogleTokenCache);

describe("configuration and connection state", () => {
  it("reports `not_configured` without an OAuth client, and never calls Google", async () => {
    const db = new FakeD1();
    await connectGoogle(db);
    const rec = recorder();
    const result = await getAccessToken(storeOver(db), {}, rec.fetchImpl, () => NOW);
    expect(result).toEqual({ ok: false, error: "not_configured" });
    expect(rec.calls).toHaveLength(0);
  });

  it("reports `not_connected` when no row exists", async () => {
    const rec = recorder();
    const result = await getAccessToken(storeOver(new FakeD1()), ENV, rec.fetchImpl, () => NOW);
    expect(result).toEqual({ ok: false, error: "not_connected" });
    expect(rec.calls).toHaveLength(0);
  });

  it("reports `revoked` for a row Google already rejected, without retrying it", async () => {
    const db = new FakeD1();
    await connectGoogle(db);
    await storeOver(db).markRevoked(NOW);
    const rec = recorder();
    expect(await getAccessToken(storeOver(db), ENV, rec.fetchImpl, () => NOW)).toEqual({ ok: false, error: "revoked" });
    expect(rec.calls).toHaveLength(0);
  });
});

describe("using a live token", () => {
  it("uses the stored access token while it is still good", async () => {
    const db = new FakeD1();
    await connectGoogle(db, { accessToken: "stored-token", expiresAt: "2026-09-14T13:00:00.000Z" });
    const rec = recorder();
    const result = await getAccessToken(storeOver(db), ENV, rec.fetchImpl, () => NOW);
    expect(result).toEqual({ ok: true, access_token: "stored-token", expires_at: "2026-09-14T13:00:00.000Z", refreshed: false });
    expect(rec.calls).toHaveLength(0);
  });

  it("memoizes per isolate: a second call reads neither D1 nor Google", async () => {
    const db = new FakeD1();
    await connectGoogle(db, { accessToken: "stored-token", expiresAt: "2026-09-14T13:00:00.000Z" });
    const rec = recorder();
    await getAccessToken(storeOver(db), ENV, rec.fetchImpl, () => NOW);
    const before = db.executed.length;
    const second = await getAccessToken(storeOver(db), ENV, rec.fetchImpl, () => NOW);
    expect(second).toMatchObject({ ok: true, access_token: "stored-token" });
    expect(db.executed).toHaveLength(before);
    expect(rec.calls).toHaveLength(0);
  });

  it("refreshes inside the skew window rather than risking a token that dies mid-request", async () => {
    const db = new FakeD1();
    const expiresAt = new Date(new Date(NOW).getTime() + TOKEN_SKEW_MS - 1_000).toISOString();
    await connectGoogle(db, { accessToken: "about-to-expire", expiresAt });
    const rec = recorder();
    const result = await getAccessToken(storeOver(db), ENV, rec.fetchImpl, () => NOW);
    expect(result).toMatchObject({ ok: true, access_token: "fresh-access-token", refreshed: true });
    expect(rec.calls).toHaveLength(1);
  });
});

describe("refreshing", () => {
  it("posts a refresh_token grant with the client credentials, and never the founder's phone or anything else", async () => {
    const db = new FakeD1();
    await connectGoogle(db, { refreshToken: "the-refresh-token", expiresAt: "2026-09-14T11:00:00.000Z" });
    const rec = recorder();
    await getAccessToken(storeOver(db), ENV, rec.fetchImpl, () => NOW);

    expect(rec.calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(rec.calls[0]!.form).toEqual({
      grant_type: "refresh_token",
      refresh_token: "the-refresh-token",
      client_id: ENV.GOOGLE_CLIENT_ID,
      client_secret: ENV.GOOGLE_CLIENT_SECRET,
    });
  });

  it("persists the new token and its expiry, encrypted", async () => {
    const db = new FakeD1();
    await connectGoogle(db, { expiresAt: "2026-09-14T11:00:00.000Z" });
    const rec = recorder();
    const result = await getAccessToken(storeOver(db), ENV, rec.fetchImpl, () => NOW);

    expect(result).toEqual({ ok: true, access_token: "fresh-access-token", expires_at: "2026-09-14T13:00:00.000Z", refreshed: true });
    const stored = await storeOver(db).read();
    expect(stored?.access_token).toBe("fresh-access-token");
    expect(stored?.expires_at).toBe("2026-09-14T13:00:00.000Z");
    expect(String(db.rows("google_oauth")[0]!.access_token_encrypted)).not.toContain("fresh-access-token");
  });

  it("keeps the refresh token: Google does not resend one on a refresh grant", async () => {
    const db = new FakeD1();
    await connectGoogle(db, { refreshToken: "long-lived", expiresAt: "2026-09-14T11:00:00.000Z" });
    const handler = googleFetchHandler({ refreshToken: null });
    const fetchImpl: FetchLike = async (input, init) => (await handler(input, init)) ?? new Response("", { status: 404 });
    await getAccessToken(storeOver(db), ENV, fetchImpl, () => NOW);
    expect((await storeOver(db).read())?.refresh_token).toBe("long-lived");
  });

  it("treats `invalid_grant` as terminal: marks the row revoked so the app falls back to ICS", async () => {
    const db = new FakeD1();
    await connectGoogle(db, { expiresAt: "2026-09-14T11:00:00.000Z" });
    const rec = recorder(
      () =>
        new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await getAccessToken(storeOver(db), ENV, rec.fetchImpl, () => NOW);
    expect(result).toMatchObject({ ok: false, error: "revoked" });

    const stored = await storeOver(db).read();
    expect(stored?.revoked_at).toBe(NOW);
    expect(stored?.access_token).toBeNull();
    // The row survives, so `/api/calendar/connection` can say "reconnect".
    expect(stored?.refresh_token).toBe("test-refresh-token");
  });

  it("does not revoke on a transient failure — a 500 is worth retrying", async () => {
    const db = new FakeD1();
    await connectGoogle(db, { expiresAt: "2026-09-14T11:00:00.000Z" });
    const rec = recorder(() => new Response("upstream boom", { status: 500 }));
    const result = await getAccessToken(storeOver(db), ENV, rec.fetchImpl, () => NOW);
    expect(result).toMatchObject({ ok: false, error: "refresh_failed" });
    expect((await storeOver(db).read())?.revoked_at).toBeNull();
  });

  it("does not revoke when the network throws", async () => {
    const db = new FakeD1();
    await connectGoogle(db, { expiresAt: "2026-09-14T11:00:00.000Z" });
    const fetchImpl: FetchLike = async () => {
      throw new Error("network down");
    };
    expect(await getAccessToken(storeOver(db), ENV, fetchImpl, () => NOW)).toMatchObject({ ok: false, error: "refresh_failed" });
    expect((await storeOver(db).read())?.revoked_at).toBeNull();
  });

  it("treats a row it cannot decrypt as not connected (WEBHOOK_SECRET rotated)", async () => {
    const db = new FakeD1();
    await connectGoogle(db);
    const rec = recorder();
    const rotated = new GoogleOauthStore(db, "a-different-secret");
    expect(await getAccessToken(rotated, ENV, rec.fetchImpl, () => NOW)).toEqual({ ok: false, error: "not_connected" });
    expect(rec.calls).toHaveLength(0);
  });
});
