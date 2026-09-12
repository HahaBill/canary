/** The signed `state` and the at-rest token envelope: the two things that make the OAuth flow safe to expose. */
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, signState, STATE_TTL_MS, verifyState } from "./crypto.ts";

const SECRET = "test-webhook-secret";
const NOW_MS = new Date("2026-09-14T12:00:00.000Z").getTime();

describe("state", () => {
  it("round-trips a state it signed itself", async () => {
    const state = await signState(SECRET, NOW_MS);
    expect(await verifyState(state, SECRET, NOW_MS)).toEqual({ ok: true, issued_at_ms: NOW_MS });
  });

  it("carries the nonce and the issue time, and nothing else", async () => {
    const state = await signState(SECRET, NOW_MS);
    const parts = state.split(".");
    expect(parts).toHaveLength(3);
    expect(Number(parts[1])).toBe(NOW_MS);
    expect(state).not.toContain(SECRET);
  });

  it("is a different value every time, so a state cannot be replayed from a screenshot", async () => {
    const first = await signState(SECRET, NOW_MS);
    const second = await signState(SECRET, NOW_MS);
    expect(first).not.toBe(second);
  });

  it("rejects a state signed with a different secret", async () => {
    const state = await signState("some-other-secret", NOW_MS);
    expect(await verifyState(state, SECRET, NOW_MS)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered timestamp — the signature covers it", async () => {
    const [nonce, , signature] = (await signState(SECRET, NOW_MS)).split(".") as [string, string, string];
    const forged = `${nonce}.${NOW_MS + 1}.${signature}`;
    expect(await verifyState(forged, SECRET, NOW_MS)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it.each([
    ["empty", ""],
    ["two parts", "abc.123"],
    ["four parts", "a.1.b.c"],
    ["a non-numeric timestamp", "abc.later.sig"],
  ])("rejects a malformed state (%s)", async (_label, state) => {
    expect(await verifyState(state, SECRET, NOW_MS)).toEqual({ ok: false, reason: "malformed" });
  });

  it("expires after ten minutes", async () => {
    const state = await signState(SECRET, NOW_MS);
    expect(await verifyState(state, SECRET, NOW_MS + STATE_TTL_MS - 1_000)).toMatchObject({ ok: true });
    expect(await verifyState(state, SECRET, NOW_MS + STATE_TTL_MS + 1_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a state from the far future as firmly as one from last week", async () => {
    const state = await signState(SECRET, NOW_MS + 4 * STATE_TTL_MS);
    expect(await verifyState(state, SECRET, NOW_MS)).toEqual({ ok: false, reason: "expired" });
  });
});

describe("token envelope", () => {
  const TOKEN = "1//0gRefreshTokenLookingThing_abcdEFGH";

  it("stores ciphertext, not the token", async () => {
    const envelope = await encryptSecret(TOKEN, SECRET);
    expect(envelope).not.toContain(TOKEN);
    expect(envelope).not.toContain("Refresh");
    expect(await decryptSecret(envelope, SECRET)).toBe(TOKEN);
  });

  it("encrypts the same token differently every time (fresh IV)", async () => {
    expect(await encryptSecret(TOKEN, SECRET)).not.toBe(await encryptSecret(TOKEN, SECRET));
  });

  it("will not decrypt under a rotated secret — it returns null instead of throwing", async () => {
    const envelope = await encryptSecret(TOKEN, SECRET);
    expect(await decryptSecret(envelope, "rotated-secret")).toBeNull();
  });

  it("returns null for a corrupt or truncated envelope", async () => {
    expect(await decryptSecret("", SECRET)).toBeNull();
    expect(await decryptSecret("bm90LWFuLWVudmVsb3Bl", SECRET)).toBeNull();
    expect(await decryptSecret("!!!not base64!!!", SECRET)).toBeNull();
  });

  it("survives a token with unicode in it", async () => {
    const envelope = await encryptSecret("naïve—token✓", SECRET);
    expect(await decryptSecret(envelope, SECRET)).toBe("naïve—token✓");
  });
});
