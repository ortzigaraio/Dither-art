// Shared helpers of the pixel modes (PLAN.md 7.7-7.13): work/output size relations, a small deterministic RNG,
// nearest-neighbour presentation of an RGBA work buffer and a few colour helpers.

import { cropRect } from './preprocess.js';
import { LIMITS } from '../config.js';

const PREVIEW_CAP = 4096;

/**
 * Logical output pixels per work pixel is `unit` at full quality. A draft render (or an automatic quality drop) uses
 * a smaller work buffer, `ratio = ctx.width / fullWidth`, and each work pixel is then drawn proportionally larger so
 * the picture keeps its size.
 */
export function workRatio(mode, ctx) {
  const crop = cropRect(ctx.params.global, ctx.srcWidth, ctx.srcHeight);
  const full = mode.resolution(ctx.params, crop.sw, crop.sh, { isExport: ctx.isExport, isVideo: ctx.isVideo });
  return Math.min(1, Math.max(0.01, ctx.width / full.width));
}

/** Integer block size k (bitmap px per work px) and the effective output scale for `unit` logical px per work px. */
export function blockScale(ctx, ratio, unit, w, h) {
  const cap = ctx.isExport ? LIMITS.maxExportImageSide : PREVIEW_CAP;
  let k = Math.max(1, Math.round((unit * ctx.outScale) / ratio));
  k = Math.max(1, Math.min(k, Math.floor(cap / w), Math.floor(cap / h)));
  return { k, effectiveScale: (k * ratio) / unit };
}

/**
 * Draw a w x h RGBA work buffer on the 2D output surface, each pixel becoming a k x k block (nearest neighbour).
 * `scratch` is an object owned by the mode state (keeps the intermediate canvas).
 */
export function presentPixels(ctx, scratch, rgba, w, h, k) {
  if (!scratch.canvas) scratch.canvas = document.createElement('canvas');
  const sc = scratch.canvas;
  if (sc.width !== w || sc.height !== h) { sc.width = w; sc.height = h; scratch.g = sc.getContext('2d'); scratch.img = null; }
  if (!scratch.img || scratch.img.width !== w || scratch.img.height !== h) scratch.img = new ImageData(w, h);
  scratch.img.data.set(rgba.length === w * h * 4 ? rgba : rgba.subarray(0, w * h * 4));
  scratch.g.putImageData(scratch.img, 0, 0);
  const out = ctx.out.canvas;
  if (out.width !== w * k || out.height !== h * k) { out.width = w * k; out.height = h * k; }
  const g = ctx.out.ctx2d;
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, out.width, out.height);
  g.drawImage(sc, 0, 0, w, h, 0, 0, w * k, h * k);
}

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

/** Base width (work-space reference) of the pixel modes: the source width within a sane cap. */
export function baseWidth(srcW, cap = 1280) {
  return Math.max(1, Math.min(Math.round(srcW), cap));
}
