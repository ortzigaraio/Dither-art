// Tiny deterministic helpers shared by the pixel modes, the workers and the tests (no dependencies, no DOM).

/** mulberry32: small deterministic generator, the same everywhere (workers, main thread, tests). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash of up to four numbers -> float in [0, 1). */
export function hash01(a, b = 0, c = 0, d = 0) {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b) ^ Math.imul(c | 0, 0xc2b2ae35) ^ Math.imul(d | 0, 0x27d4eb2f);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Combine a user seed and an index into one 32-bit seed. */
export const mixSeed = (seed, n) => (Math.imul((seed | 0) ^ 0x5bd1e995, 0x9e3779b1) + Math.imul(n | 0, 0x85ebca6b)) >>> 0;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
