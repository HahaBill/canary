/** Length-independent, timing-safe string comparison (no Node crypto in Workers). */
export function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Shared-secret check for privileged routes. Accepts `sb-signing-secret`
 * (what Sendblue sends for its Global Secret) or `x-canary-secret` (manual /
 * demo triggers). The secret is never accepted from the query string so it
 * cannot end up in request logs.
 */
export function requestAuthorized(headers: { get(name: string): string | null }, expected: string | undefined): "ok" | "unauthorized" | "unconfigured" {
  if (!expected) return "unconfigured";
  const candidates = [headers.get("sb-signing-secret"), headers.get("x-canary-secret")];
  return candidates.some((c) => c !== null && constantTimeEqual(c, expected)) ? "ok" : "unauthorized";
}
