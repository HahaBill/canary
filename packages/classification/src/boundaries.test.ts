/**
 * The Cloudflare Worker imports `@canary/classification/core`, so nothing
 * reachable from `core.ts` may import a `node:` module. `node.ts` (the
 * `node:fs` cache) is reachable only from `index.ts`.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((m) => m[1]!);
}

/** Walks the relative-import graph from `entry`, returning every specifier it reaches. */
async function collectSpecifiers(entry: string): Promise<Map<string, string[]>> {
  const byFile = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (byFile.has(file)) continue;
    const specifiers = importSpecifiers(await readFile(file, "utf8"));
    byFile.set(file, specifiers);
    for (const specifier of specifiers) {
      if (specifier.startsWith(".") && specifier.endsWith(".ts")) queue.push(resolve(dirname(file), specifier));
    }
  }
  return byFile;
}

describe("module boundaries", () => {
  it("core.ts reaches no node: imports", async () => {
    const graph = await collectSpecifiers(resolve(SRC_DIR, "core.ts"));
    const offenders = [...graph]
      .flatMap(([file, specifiers]) => specifiers.filter((s) => s.startsWith("node:")).map((s) => `${file} → ${s}`));

    expect(offenders).toEqual([]);
    expect(graph.size).toBeGreaterThan(5);
  });

  it("index.ts re-exports both halves", async () => {
    const index = await readFile(resolve(SRC_DIR, "index.ts"), "utf8");
    expect(importSpecifiers(index)).toEqual(["./core.ts", "./node.ts"]);
  });

  it("node.ts is where the filesystem lives", async () => {
    const node = await readFile(resolve(SRC_DIR, "node.ts"), "utf8");
    expect(importSpecifiers(node).some((s) => s.startsWith("node:"))).toBe(true);
  });
});
