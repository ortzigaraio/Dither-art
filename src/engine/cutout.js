// Smart cut-out and noise reduction (CPU, on the work-size RGBA frame, so it is cheap enough for video).
//  - denoise(): 3x3 edge-preserving (bilateral) smoothing, so flat areas lose grain but outlines stay sharp.
//  - cutoutMask(): learns the background colours from the image border, flood-fills inwards through similar
//    colours (a soft gradient or vignette is followed step by step) and keeps what the fill could not reach.
//  - applyCutout(): cleans specks, feathers the edge and paints everything else with a flat fill colour.
// Fail-safe: when the cut would leave (almost) nothing or (almost) everything, the frame is left untouched.

import { boxBlur } from './analysis.js';
import { hexToRgb } from './color.js';

export const CUTOUT_MODES = [
  { value: 'off', label: { es: 'Desactivado', en: 'Off' } },
  { value: 'auto', label: { es: 'Automático (fondo del borde)', en: 'Auto (edge background)' } },
  { value: 'light', label: { es: 'Quitar zonas claras', en: 'Remove light areas' } },
  { value: 'dark', label: { es: 'Quitar zonas oscuras', en: 'Remove dark areas' } },
];

export const CUTOUT_FILLS = [
  { value: 'auto', label: { es: 'El del modo (vacío)', en: 'Mode background (empty)' } },
  { value: 'white', label: { es: 'Blanco', en: 'White' } },
  { value: 'black', label: { es: 'Negro', en: 'Black' } },
];

/** Redmean colour distance, 0..~765 scaled to roughly 0..100 for white vs black. */
function dist(r1, g1, b1, r2, g2, b2) {
  const rm = (r1 + r2) / 2;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db) / 7.65;
}

/** 3x3 bilateral filter on RGBA bytes, in place. strength 0..10 (0 = off). */
export function denoise(data, w, h, strength) {
  if (!(strength > 0) || w < 3 || h < 3) return data;
  const sigma = 4 + strength * 5; // range sigma in 0..255 units of luma
  const inv2 = 1 / (2 * sigma * sigma);
  const passes = strength >= 6 ? 2 : 1;
  const spatial = [0.7, 1, 0.7, 1, 1, 1, 0.7, 1, 0.7];
  // exp(-d^2 / 2s^2) for integer luma differences
  const lut = new Float32Array(256);
  for (let d = 0; d < 256; d++) lut[d] = Math.exp(-d * d * inv2);
  let src = new Uint8ClampedArray(data);
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const lc = (src[o] * 54 + src[o + 1] * 183 + src[o + 2] * 19) >> 8;
        let sr = 0, sg = 0, sb = 0, sw = 0, k = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy;
          for (let dx = -1; dx <= 1; dx++, k++) {
            const xx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx;
            const p = (yy * w + xx) * 4;
            const l = (src[p] * 54 + src[p + 1] * 183 + src[p + 2] * 19) >> 8;
            const wt = spatial[k] * lut[Math.abs(l - lc)];
            sr += src[p] * wt; sg += src[p + 1] * wt; sb += src[p + 2] * wt; sw += wt;
          }
        }
        data[o] = sr / sw; data[o + 1] = sg / sw; data[o + 2] = sb / sw;
      }
    }
    if (pass + 1 < passes) src = new Uint8ClampedArray(data);
  }
  return data;
}

/** Background colour clusters from the border pixels: up to 3 buckets that hold at least 8% of the border. */
function borderModel(data, w, h) {
  const bins = new Map();
  let total = 0;
  const add = (x, y) => {
    const o = (y * w + x) * 4;
    const key = ((data[o] >> 4) << 8) | ((data[o + 1] >> 4) << 4) | (data[o + 2] >> 4);
    let b = bins.get(key);
    if (!b) bins.set(key, (b = { n: 0, r: 0, g: 0, b: 0 }));
    b.n++; b.r += data[o]; b.g += data[o + 1]; b.b += data[o + 2];
    total++;
  };
  for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { add(0, y); add(w - 1, y); }
  const list = [...bins.values()].sort((a, b) => b.n - a.n).slice(0, 3).filter((b, i) => i === 0 || b.n >= total * 0.08);
  return list.map((b) => [b.r / b.n, b.g / b.n, b.b / b.n]);
}

/**
 * Foreground mask (1 = keep) for a work-size frame, or null when the cut is not trustworthy.
 * @param {{ mode: string, tolerance: number, connected: boolean, clean: number, soft: number, invert: boolean }} o
 */
export function cutoutMask(data, w, h, o) {
  const n = w * h;
  if (n < 16 || w < 3 || h < 3) return null;
  const tol = Math.max(1, Math.min(100, o.tolerance)) * 0.6; // distance units (0..~60)
  let model;
  if (o.mode === 'light') model = [[255, 255, 255]];
  else if (o.mode === 'dark') model = [[0, 0, 0]];
  else model = borderModel(data, w, h);
  if (!model.length) return null;

  const dm = new Float32Array(n); // distance to the nearest background colour
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    let best = 1e9;
    for (const m of model) {
      const d = dist(data[p], data[p + 1], data[p + 2], m[0], m[1], m[2]);
      if (d < best) best = d;
    }
    dm[i] = best;
  }

  const bg = new Uint8Array(n); // 1 = background
  if (o.connected) {
    const stack = new Int32Array(n);
    let sp = 0;
    const seed = (i) => { if (!bg[i] && dm[i] <= tol) { bg[i] = 1; stack[sp++] = i; } };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    const step = tol * 0.3;
    const reach = tol * 2.2;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w;
      const p = i * 4;
      const tryN = (j) => {
        if (bg[j]) return;
        const q = j * 4;
        if (dm[j] <= tol || (dm[j] <= reach && dist(data[p], data[p + 1], data[p + 2], data[q], data[q + 1], data[q + 2]) <= step)) {
          bg[j] = 1; stack[sp++] = j;
        }
      };
      if (x > 0) tryN(i - 1);
      if (x < w - 1) tryN(i + 1);
      if (i >= w) tryN(i - w);
      if (i < n - w) tryN(i + w);
    }
  } else {
    for (let i = 0; i < n; i++) bg[i] = dm[i] <= tol ? 1 : 0;
  }

  // drop foreground specks smaller than `clean` (0..100 -> up to 1% of the frame)
  const minArea = Math.round((Math.max(0, o.clean) / 100) * 0.01 * n);
  if (minArea > 1) {
    const seen = new Uint8Array(n);
    const stack = new Int32Array(n);
    const comp = [];
    for (let s = 0; s < n; s++) {
      if (bg[s] || seen[s]) continue;
      let sp = 0, cnt = 0;
      comp.length = 0;
      stack[sp++] = s; seen[s] = 1;
      while (sp > 0) {
        const i = stack[--sp];
        comp.push(i); cnt++;
        const x = i % w;
        if (x > 0 && !bg[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[sp++] = i - 1; }
        if (x < w - 1 && !bg[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[sp++] = i + 1; }
        if (i >= w && !bg[i - w] && !seen[i - w]) { seen[i - w] = 1; stack[sp++] = i - w; }
        if (i < n - w && !bg[i + w] && !seen[i + w]) { seen[i + w] = 1; stack[sp++] = i + w; }
      }
      if (cnt < minArea) for (const i of comp) bg[i] = 1;
    }
  }

  let fg = 0;
  for (let i = 0; i < n; i++) if (!bg[i]) fg++;
  if (fg < n * 0.002 || fg > n * 0.995) return null; // nothing to cut, or nothing left

  let mask = new Float32Array(n);
  const keep = o.invert ? 1 : 0;
  for (let i = 0; i < n; i++) mask[i] = bg[i] === keep ? 1 : 0;
  const r = Math.round(o.soft);
  if (r > 0) { mask = boxBlur(mask, w, h, r); mask = boxBlur(mask, w, h, Math.max(1, Math.round(r / 2))); }
  return mask;
}

/** Paint everything outside the mask with `fill` ([r,g,b]). Returns true when the frame was changed. */
export function applyCutout(data, w, h, g, matteHex) {
  const mask = cutoutMask(data, w, h, {
    mode: g.cutout, tolerance: g.cutoutTol, connected: !!g.cutoutConnected, clean: g.cutoutClean, soft: g.cutoutSoft, invert: !!g.cutoutInvert,
  });
  if (!mask) return false;
  let fill = [255, 255, 255];
  if (g.cutoutFill === 'black') fill = [0, 0, 0];
  else if (g.cutoutFill === 'auto' && matteHex) fill = hexToRgb(matteHex) || fill;
  const n = w * h;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const m = mask[i];
    if (m >= 1) continue;
    data[p] = fill[0] + (data[p] - fill[0]) * m;
    data[p + 1] = fill[1] + (data[p + 1] - fill[1]) * m;
    data[p + 2] = fill[2] + (data[p + 2] - fill[2]) * m;
    data[p + 3] = 255;
  }
  return true;
}
