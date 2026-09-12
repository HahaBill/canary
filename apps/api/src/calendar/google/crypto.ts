/**
 * WebCrypto-only primitives for the Google connection: the signed `state` that
 * makes the OAuth redirect tamper-evident, and the AES-GCM envelope the refresh
 * token sits in while it is at rest in D1.
 *
 * No `node:crypto` — the Worker bundle must stay free of node builtins — and no
 * key management: both keys are derived from `WEBHOOK_SECRET`, which is already
 * the operator secret for every privileged route. Rotating it invalidates every
 * stored token, which is the right behaviour for a secret that has leaked.
 *
 * `crypto.getRandomValues` is the one deliberate exception to the determinism
 * rule (AGENTS.md rule 4): reusing an AES-GCM nonce leaks the keystream, and a
 * predictable OAuth nonce is not a nonce. Neither value touches a financial
 * path, and nothing asserts on their bytes.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** How long a signed `state` stays valid. Long enough for a consent screen, short enough to be useless later. */
export const STATE_TTL_MS = 10 * 60_000;

const AES_IV_BYTES = 12;
const NONCE_BYTES = 16;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Base64url without padding — safe in a query string, which is where `state` lives. */
export function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** SHA-256 of the operator secret, imported as an AES-256-GCM key. */
async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Length-independent compare, same reasoning as `security.ts` — this one is over bytes. */
function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * `<nonce>.<issued-at-ms>.<hmac>`, signed over `<nonce>.<issued-at-ms>`.
 *
 * The nonce alone would prove nothing without server-side storage; the HMAC is
 * what lets a stateless Worker recognise its own redirect coming back.
 */
export async function signState(secret: string, nowMs: number): Promise<string> {
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
  const payload = `${nonce}.${nowMs}`;
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

export type StateVerdict = { ok: true; issued_at_ms: number } | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export async function verifyState(state: string, secret: string, nowMs: number, ttlMs = STATE_TTL_MS): Promise<StateVerdict> {
  const parts = state.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [nonce, issued, signature] = parts as [string, string, string];
  const issuedAt = Number(issued);
  if (!nonce || !signature || !Number.isFinite(issuedAt)) return { ok: false, reason: "malformed" };

  const expected = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(`${nonce}.${issued}`));
  let presented: Uint8Array;
  try {
    presented = fromBase64Url(signature);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  // Signature first: an expired-but-forged state should not be distinguishable from a forged one.
  if (!constantTimeEqualBytes(new Uint8Array(expected), presented)) return { ok: false, reason: "bad_signature" };
  // A state from the future is as wrong as one from last week (clock skew, or a replay of a doctored timestamp).
  if (nowMs - issuedAt > ttlMs || issuedAt - nowMs > ttlMs) return { ok: false, reason: "expired" };
  return { ok: true, issued_at_ms: issuedAt };
}

/** `base64(iv ‖ ciphertext)`. The IV is stored alongside because it is not a secret, only single-use. */
export async function encryptSecret(plaintext: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(AES_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), encoder.encode(plaintext));
  const envelope = new Uint8Array(iv.length + ciphertext.byteLength);
  envelope.set(iv, 0);
  envelope.set(new Uint8Array(ciphertext), iv.length);
  return bytesToBase64(envelope);
}

/**
 * Null on any failure — a token encrypted under a rotated `WEBHOOK_SECRET` is
 * indistinguishable from a corrupt one, and both mean "reconnect", not "crash".
 */
export async function decryptSecret(envelope: string, secret: string): Promise<string | null> {
  try {
    const bytes = base64ToBytes(envelope);
    if (bytes.length <= AES_IV_BYTES) return null;
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, AES_IV_BYTES) },
      await aesKey(secret),
      bytes.slice(AES_IV_BYTES),
    );
    return decoder.decode(plaintext);
  } catch {
    return null;
  }
}
