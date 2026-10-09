// Directional pixel sorting (PLAN.md 7.13). No DOM: runs in heavy.worker.js (or on the main thread as a fallback).
//
// Lines. For a direction (cos a, sin a) with y pointing down, the picture is partitioned into parallel lines without
// rotating it, the way Bresenham steps: for x-major directions (|cos| >= |sin|) the pixel of line b at column x is
// (x, b + round(slope * x)); every pixel belongs to exactly one line. y-major directions swap the axes.
// Intervals. On every line, runs of pixels are chosen by `intervalMode` and each run is sorted by `key`.
// Cooperative: the job yields every few thousand pixels, so cancelling by jobId works and progress is reported.

import { hash01 } from './rand.js';

export const SORT_KEYS = ['luma', 'hue', 'saturation', 'red', 'green', 'blue'];
export const INTERVAL_MODES = ['threshold', 'edges', 'random', 'full'];
const YIELD_PIXELS = 40000;
const MAX_SPAN_LIMIT = 4000; // positions inside an interval are packed into 12 bits of the sort key

/** 0..1 sort key of every pixel. */
export function sortKeys(rgba, n, key, out = new Float32Array(n)) {
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
    switch (key) {
      case 'red': out[i] = r / 255; break;
      case 'green': out[i] = g / 255; break;
      case 'blue': out[i] = b / 255; break;
      case 'hue': case 'saturation': {
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const d = max - min;
        if (key === 'saturation') { out[i] = max === 0 ? 0 : d / max; break; }
        let h = 0;
        if (d > 0) {
          if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
          else if (max === g) h = ((b - r) / d + 2) / 6;
          else h = ((r - g) / d + 4) / 6;
        }
        out[i] = h;
        break;
      }
      default: out[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }
  }
  return out;
}

/** The lines of a w x h picture for `angleDeg`: { count, fill(lineIndex, into) -> length of the line in pixels }. */
export function lineSet(w, h, angleDeg) {
  const a = (angleDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const xMajor = Math.abs(c) >= Math.abs(s);
  const slope = xMajor ? s / c : c / s;
  const reverse = xMajor ? c < 0 : s < 0;
  const along = xMajor ? w : h; // steps along the line
  const across = xMajor ? h : w;
  let bmin = Infinity;
  let bmax = -Infinity;
  for (let t = 0; t < along; t++) {
    const off = Math.round(slope * t);
    bmin = Math.min(bmin, -off);
    bmax = Math.max(bmax, across - 1 - off);
  }
  const count = bmax - bmin + 1;
  return {
    count,
    fill(li, into) {
      const b = bmin + li;
      let n = 0;
      for (let t = 0; t < along; t++) {
        const u = b + Math.round(slope * t);
        if (u < 0 || u >= across) continue;
        into[n++] = xMajor ? u * w + t : t * w + u;
      }
      if (reverse) for (let i = 0, j = n - 1; i < j; i++, j--) { const tmp = into[i]; into[i] = into[j]; into[j] = tmp; }
      return n;
    },
  };
}

/**
 * Intervals [start, end) of a line of n pixels. `luma` is the 0..1 luma of the picture, `idx` the pixel offsets of the line.
 * Intervals are cut to `maxSpan` and the ones shorter than 2 pixels are dropped.
 */
export function lineIntervals(idx, n, luma, o, lineIndex, out) {
  let m = 0;
  const push = (a, b) => {
    for (let s = a; s < b; s += o.maxSpan) {
      const e = Math.min(b, s + o.maxSpan);
      if (e - s >= 2) { out[m++] = s; out[m++] = e; }
    }
  };
  if (o.intervalMode === 'full') push(0, n);
  else if (o.intervalMode === 'threshold') {
    let start = -1;
    for (let i = 0; i < n; i++) {
      const l = luma[idx[i]];
      const inside = l >= o.lower && l <= o.upper;
      if (inside && start < 0) start = i;
      else if (!inside && start >= 0) { push(start, i); start = -1; }
    }
    if (start >= 0) push(start, n);
  } else if (o.intervalMode === 'edges') {
    let start = 0;
    for (let i = 1; i < n; i++) {
      if (Math.abs(luma[idx[i]] - luma[idx[i - 1]]) > o.lower) { push(start, i); start = i; }
    }
    push(start, n);
  } else { // random run lengths, deterministic for the seed
    let i = 0;
    let k = 0;
    while (i < n) {
      const len = 2 + Math.floor(hash01(o.seed, lineIndex, k++, 17) * Math.max(1, o.maxSpan - 1));
      push(i, Math.min(n, i + len));
      i += len;
    }
  }
  return m;
}

/**
 * @param {object} p
 * @param {Uint8ClampedArray} p.rgba  w*h*4 pixels (not modified)
 * @param {number} p.w @param {number} p.h
 * @param {number} p.angle 0..360 degrees (0: left to right, 90: top to bottom)
 * @param {'threshold'|'edges'|'random'|'full'} p.intervalMode
 * @param {number} p.lower @param {number} p.upper  luma limits (threshold) / edge threshold (edges, `lower`)
 * @param {string} p.key  luma | hue | saturation | red | green | blue
 * @param {'asc'|'desc'} p.order
 * @param {number} p.maxSpan 8..2000
 * @param {number} p.randomness 0..1: chance that an interval is left unsorted
 * @param {number} p.seed
 * @param {number} [p.quantizeLevels] 2..32 posterises after sorting (0 = off)
 * @param {number[][]} [p.palette] snap to this palette after sorting
 * @param {boolean} [p.showMask] return the mask picture instead of the sorted one
 * @param {{ progress?:(v:number)=>void, yield?:()=>Promise<void>, check?:()=>void }} [ctl]
 * @returns {Promise<{ rgba: Uint8ClampedArray, mask: Uint8Array }>}
 */
export async function pixelSort(p, ctl = null) {
  const { rgba, w, h } = p;
  const n = w * h;
  const out = new Uint8ClampedArray(rgba);
  const mask = new Uint8Array(n);
  const maxSpan = Math.max(2, Math.min(MAX_SPAN_LIMIT, Math.round(p.maxSpan)));
  const opts = { intervalMode: p.intervalMode, lower: p.lower, upper: p.upper, maxSpan, seed: p.seed | 0 };
  const luma = sortKeys(rgba, n, 'luma');
  const keys = p.key === 'luma' ? luma : sortKeys(rgba, n, p.key);
  const lines = lineSet(w, h, p.angle);
  const idx = new Int32Array(Math.max(w, h) + 2);
  const iv = new Int32Array(2 * (Math.max(w, h) + 2));
  const packed = new Float64Array(maxSpan);
  const desc = p.order === 'desc';
  let sinceYield = 0;

  for (let li = 0; li < lines.count; li++) {
    const len = lines.fill(li, idx);
    if (len >= 2) {
      const m = lineIntervals(idx, len, luma, opts, li, iv);
      for (let q = 0; q < m; q += 2) {
        const a = iv[q];
        const b = iv[q + 1];
        if (p.randomness > 0 && hash01(opts.seed, li, a, 29) < p.randomness) continue; // this interval stays as it is
        const cnt = b - a;
        for (let j = 0; j < cnt; j++) packed[j] = Math.round(keys[idx[a + j]] * 65535) * 4096 + j;
        const view = packed.subarray(0, cnt);
        view.sort();
        for (let j = 0; j < cnt; j++) {
          const from = view[desc ? cnt - 1 - j : j] % 4096;
          const so = idx[a + from] * 4;
          const dO = idx[a + j] * 4;
          out[dO] = rgba[so]; out[dO + 1] = rgba[so + 1]; out[dO + 2] = rgba[so + 2]; out[dO + 3] = rgba[so + 3];
          mask[idx[a + j]] = 1;
        }
      }
    }
    sinceYield += len;
    if (ctl && sinceYield >= YIELD_PIXELS) {
      sinceYield = 0;
      ctl.progress?.((li + 1) / lines.count);
      await ctl.yield?.();
    }
  }

  const L = Math.round(p.quantizeLevels || 0);
  if (L >= 2) {
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = Math.round((v / 255) * (L - 1)) / (L - 1) * 255;
    for (let i = 0; i < n * 4; i += 4) { out[i] = lut[out[i]]; out[i + 1] = lut[out[i + 1]]; out[i + 2] = lut[out[i + 2]]; }
  }
  if (p.palette && p.palette.length >= 2) {
    const pal = p.palette;
    const cache = new Map();
    for (let i = 0; i < n * 4; i += 4) {
      const key = (out[i] << 16) | (out[i + 1] << 8) | out[i + 2];
      let hit = cache.get(key);
      if (hit === undefined) {
        let best = 0, bd = Infinity;
        for (let k = 0; k < pal.length; k++) {
          const d = (out[i] - pal[k][0]) ** 2 + (out[i + 1] - pal[k][1]) ** 2 + (out[i + 2] - pal[k][2]) ** 2;
          if (d < bd) { bd = d; best = k; }
        }
        hit = best;
        if (cache.size < 65536) cache.set(key, hit);
      }
      out[i] = pal[hit][0]; out[i + 1] = pal[hit][1]; out[i + 2] = pal[hit][2];
    }
  }
  ctl?.progress?.(1);

  if (p.showMask) {
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      const v = mask[i] ? 255 : 24;
      out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255;
    }
  }
  return { rgba: out, mask };
}
