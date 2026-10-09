// Weighted Voronoi stippling (Secord 2002) for the Voronoi mode (PLAN.md 7.16). No DOM: runs in heavy.worker.js
// (task "stipple") or on the main thread, with identical results.
//
// 1. Initial points by rejection sampling proportional to the weight (darkness, edges or uniform), seeded.
// 2. Lloyd relaxation: every pixel is assigned to its nearest site with Delaunay.find, starting from the site of the
//    previous pixel (so the walk is short), and each site moves to the weighted centroid of its pixels.
// 3. Optionally, a last pass computes the mean colour of every cell (cells / mosaic sub-style).
// The points of every iteration are sent as a partial result, so the viewer animates the relaxation.

import { Delaunay } from '../../vendor/d3-delaunay/6.0.4/index.js';
import { rng } from './rand.js';

/** `count` points in [0, W) x [0, H), density proportional to `weights` (W x H, >= 0). Deterministic for a seed. */
export function initialPoints(weights, W, H, count, seed) {
  const r = rng((seed >>> 0) ^ 0x51ed270b);
  let maxW = 0;
  for (let i = 0; i < weights.length; i++) if (weights[i] > maxW) maxW = weights[i];
  const pts = new Float64Array(count * 2);
  let i = 0;
  if (maxW > 0) {
    const limit = count * 400;
    for (let tries = 0; i < count && tries < limit; tries++) {
      const x = r() * W;
      const y = r() * H;
      if (r() * maxW < weights[(y | 0) * W + (x | 0)]) { pts[i * 2] = x; pts[i * 2 + 1] = y; i++; }
    }
  }
  for (; i < count; i++) { pts[i * 2] = r() * W; pts[i * 2 + 1] = r() * H; } // blank picture: uniform
  return pts;
}

/**
 * @param {{ weights: Float32Array, W: number, H: number, count: number, iterations: number, seed: number,
 *           init?: Float32Array, rgba?: Uint8ClampedArray, partials?: boolean }} p
 * @returns {Promise<{ points: Float32Array, colors: Uint8Array|null, iterations: number }>}
 */
export async function stipple(p, ctl = null) {
  const { weights, W, H, seed = 1, rgba = null, partials = true } = p;
  const count = Math.max(1, Math.floor(p.count));
  const iterations = Math.max(0, Math.floor(p.iterations));
  let pts = p.init && p.init.length === count * 2 ? Float64Array.from(p.init) : initialPoints(weights, W, H, count, seed);
  const sx = new Float64Array(count);
  const sy = new Float64Array(count);
  const sw = new Float64Array(count);
  const rowsPerYield = Math.max(1, Math.floor(60000 / Math.max(1, W)));
  const steps = iterations + (rgba ? 1 : 0);

  for (let it = 0; it < iterations; it++) {
    const del = new Delaunay(pts);
    sx.fill(0); sy.fill(0); sw.fill(0);
    let hint = 0;
    for (let y = 0; y < H; y++) {
      const py = y + 0.5;
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const w = weights[row + x];
        if (w <= 0) continue;
        const px = x + 0.5;
        hint = del.find(px, py, hint);
        sx[hint] += w * px;
        sy[hint] += w * py;
        sw[hint] += w;
      }
      if (ctl && (y + 1) % rowsPerYield === 0) await ctl.yield();
    }
    for (let i = 0; i < count; i++) {
      if (sw[i] > 0) { pts[i * 2] = sx[i] / sw[i]; pts[i * 2 + 1] = sy[i] / sw[i]; }
    }
    if (ctl) {
      const value = (it + 1) / steps;
      if (partials) ctl.progress(value, { points: Float32Array.from(pts), iteration: it + 1 });
      else ctl.progress(value);
    }
  }

  let colors = null;
  if (rgba) {
    const del = new Delaunay(pts);
    const acc = new Float64Array(count * 4);
    let hint = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        hint = del.find(x + 0.5, y + 0.5, hint);
        const o = (y * W + x) * 4;
        acc[hint * 4] += rgba[o];
        acc[hint * 4 + 1] += rgba[o + 1];
        acc[hint * 4 + 2] += rgba[o + 2];
        acc[hint * 4 + 3] += 1;
      }
      if (ctl && (y + 1) % rowsPerYield === 0) await ctl.yield();
    }
    colors = new Uint8Array(count * 3);
    for (let i = 0; i < count; i++) {
      const n = acc[i * 4 + 3];
      if (n > 0) {
        colors[i * 3] = Math.round(acc[i * 4] / n);
        colors[i * 3 + 1] = Math.round(acc[i * 4 + 1] / n);
        colors[i * 3 + 2] = Math.round(acc[i * 4 + 2] / n);
      } else {
        // a site without pixels (cannot happen with Lloyd, but keep the colour defined): sample under it
        const x = Math.min(W - 1, Math.max(0, pts[i * 2] | 0));
        const y = Math.min(H - 1, Math.max(0, pts[i * 2 + 1] | 0));
        const o = (y * W + x) * 4;
        colors[i * 3] = rgba[o]; colors[i * 3 + 1] = rgba[o + 1]; colors[i * 3 + 2] = rgba[o + 2];
      }
    }
    ctl?.progress(1);
  }
  return { points: Float32Array.from(pts), colors, iterations };
}
