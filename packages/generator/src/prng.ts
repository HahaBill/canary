/**
 * Deterministic PRNG. No dependencies, no global state, no `Math.random()`.
 *
 * Every random draw comes from a *named sub-stream* (`makeRng(seed, label)`) so that
 * adding a vendor or moving a schedule never shifts another vendor's noise. That keeps
 * the fixture stable across generator edits, which is what the demo depends on.
 */

/** FNV-1a over `label`, mixed with the numeric seed. */
export function hashSeed(seed: number, label: string): number {
  let h = (0x811c9dc5 ^ (seed >>> 0)) >>> 0;
  for (let i = 0; i < label.length; i++) {
    h = (h ^ label.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Final avalanche so adjacent labels ("week-8" / "week-9") start far apart.
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [lo, hi). */
  uniform(lo: number, hi: number): number;
  /** Uniform in [-amplitude, +amplitude]. */
  signed(amplitude: number): number;
  /** Integer in [lo, hi). */
  int(lo: number, hi: number): number;
  /** Deterministic Fisher–Yates copy. */
  shuffled<T>(items: readonly T[]): T[];
}

/** mulberry32 — 32-bit state, good enough for fixtures, trivially portable. */
export function makeRng(seed: number, label = ""): Rng {
  let a = hashSeed(seed, label);
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    uniform: (lo, hi) => lo + next() * (hi - lo),
    signed: (amplitude) => (next() * 2 - 1) * amplitude,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo)),
    shuffled: (items) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = out[i]!;
        out[i] = out[j]!;
        out[j] = tmp;
      }
      return out;
    },
  };
  return rng;
}

/** Apply a relative wobble to an integer-cent base amount. Result is integer cents ≥ 1. */
export function jitterCents(rng: Rng, baseCents: number, relative: number): number {
  const scaled = Math.round(baseCents * (1 + rng.signed(relative)));
  return Math.max(1, scaled);
}
