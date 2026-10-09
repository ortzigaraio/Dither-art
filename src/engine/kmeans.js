// Automatic palette by k-means (PLAN.md 7.9): k-means++ seeding with a seeded generator and a few Lloyd iterations
// in RGB. Deterministic for a given input and seed, and independent of the DOM.

import { rng } from './rand.js';

/**
 * @param {Uint8ClampedArray|Uint8Array} rgba  pixels (alpha ignored)
 * @param {number} k       colours wanted (2..64)
 * @param {{ seed?: number, maxSamples?: number, iterations?: number }} [opts]
 * @returns {number[][]} up to k colours [[r,g,b]], darkest first (fewer when the picture has fewer distinct colours)
 */
export function kmeansPalette(rgba, k, { seed = 1, maxSamples = 8192, iterations = 12 } = {}) {
  const total = rgba.length >> 2;
  const want = Math.max(1, Math.min(64, Math.round(k)));
  const step = Math.max(1, Math.floor(total / maxSamples));
  const m = Math.floor((total + step - 1) / step);
  const px = new Float32Array(m * 3);
  for (let s = 0, i = 0; i < total; i += step, s++) {
    px[s * 3] = rgba[i * 4]; px[s * 3 + 1] = rgba[i * 4 + 1]; px[s * 3 + 2] = rgba[i * 4 + 2];
  }

  // distinct colours first: a picture with fewer than k of them is returned as it is
  const seen = new Map();
  for (let s = 0; s < m && seen.size <= want; s++) {
    const key = (px[s * 3] << 16) | (px[s * 3 + 1] << 8) | px[s * 3 + 2];
    if (!seen.has(key)) seen.set(key, s);
  }
  if (seen.size <= want) {
    return [...seen.values()].map((s) => [px[s * 3], px[s * 3 + 1], px[s * 3 + 2]]).sort(byLuma);
  }

  const rand = rng(seed);
  const cen = new Float32Array(want * 3);
  const d2 = new Float32Array(m).fill(Infinity);
  let first = Math.floor(rand() * m);
  for (let c = 0; c < want; c++) {
    if (c > 0) { // k-means++: next centre drawn proportionally to the squared distance to the closest centre
      let sum = 0;
      for (let s = 0; s < m; s++) sum += d2[s];
      let r = rand() * sum;
      first = m - 1;
      for (let s = 0; s < m; s++) { r -= d2[s]; if (r <= 0) { first = s; break; } }
    }
    cen[c * 3] = px[first * 3]; cen[c * 3 + 1] = px[first * 3 + 1]; cen[c * 3 + 2] = px[first * 3 + 2];
    for (let s = 0; s < m; s++) {
      const d = (px[s * 3] - cen[c * 3]) ** 2 + (px[s * 3 + 1] - cen[c * 3 + 1]) ** 2 + (px[s * 3 + 2] - cen[c * 3 + 2]) ** 2;
      if (d < d2[s]) d2[s] = d;
    }
  }

  const label = new Uint8Array(m);
  const sum = new Float64Array(want * 3);
  const cnt = new Uint32Array(want);
  for (let it = 0; it < iterations; it++) {
    sum.fill(0); cnt.fill(0);
    let moved = 0;
    for (let s = 0; s < m; s++) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < want; c++) {
        const d = (px[s * 3] - cen[c * 3]) ** 2 + (px[s * 3 + 1] - cen[c * 3 + 1]) ** 2 + (px[s * 3 + 2] - cen[c * 3 + 2]) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      if (label[s] !== best) { label[s] = best; moved++; }
      sum[best * 3] += px[s * 3]; sum[best * 3 + 1] += px[s * 3 + 1]; sum[best * 3 + 2] += px[s * 3 + 2];
      cnt[best]++;
    }
    for (let c = 0; c < want; c++) {
      if (cnt[c] === 0) continue; // an empty cluster keeps its centre
      cen[c * 3] = sum[c * 3] / cnt[c]; cen[c * 3 + 1] = sum[c * 3 + 1] / cnt[c]; cen[c * 3 + 2] = sum[c * 3 + 2] / cnt[c];
    }
    if (moved === 0 && it > 0) break;
  }
  const out = [];
  for (let c = 0; c < want; c++) out.push([Math.round(cen[c * 3]), Math.round(cen[c * 3 + 1]), Math.round(cen[c * 3 + 2])]);
  // merge centres that rounded to the same colour (keeps the palette free of duplicates)
  const uniq = new Map(out.map((c) => [(c[0] << 16) | (c[1] << 8) | c[2], c]));
  return [...uniq.values()].sort(byLuma);
}

const byLuma = (a, b) => (0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]) - (0.2126 * b[0] + 0.7152 * b[1] + 0.0722 * b[2]);
