/**
 * Runtime-agnostic classification surface. MUST NOT import `node:*` — the
 * Cloudflare Worker imports this module (`@canary/classification/core`).
 * Node-only pieces live in `./node.ts`; `boundaries.test.ts` enforces the split.
 */
export * from "./normalize.ts";
export * from "./rules.ts";
export * from "./business-type.ts";
export * from "./http.ts";
export * from "./providers/openai.ts";
export * from "./providers/tavily.ts";
export * from "./providers/tavily-scout.ts";
export * from "./cache.ts";
export * from "./classify.ts";
