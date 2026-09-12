/**
 * @canary/classification — deterministic rules → OpenAI → Tavily corroboration
 * → Needs Review (PRD §10, contract §13).
 *
 * Node consumers import this. The Worker imports `@canary/classification/core`,
 * which excludes the `node:fs` pieces re-exported below.
 */
export * from "./core.ts";
export * from "./node.ts";
