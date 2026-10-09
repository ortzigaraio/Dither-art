// Per-cell colour for character-grid modes (Braille, Matrix, typographic portrait): block averages of the work
// buffer and the four COLOR modes of PLAN.md 5.4 (mono / original / gradient / palette).

import { boostSaturation, buildGradientLUT, makePaletteMatcher } from './color.js';

/**
 * Mean colour and luma of every bw x bh block of an RGBA buffer that is `W` pixels wide.
 * @returns {{ rgb: Uint8ClampedArray, luma: Float32Array }} rgb has 4 bytes per cell (alpha 255)
 */
export function blockAverages(rgba, W, cols, rows, bw, bh) {
  const n = cols * rows;
  const rgb = new Uint8ClampedArray(n * 4);
  const luma = new Float32Array(n);
  const area = bw * bh;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let r = 0, g = 0, b = 0;
      for (let y = 0; y < bh; y++) {
        let o = ((cy * bh + y) * W + cx * bw) * 4;
        for (let x = 0; x < bw; x++, o += 4) { r += rgba[o]; g += rgba[o + 1]; b += rgba[o + 2]; }
      }
      r /= area; g /= area; b /= area;
      const i = cy * cols + cx;
      rgb[i * 4] = r; rgb[i * 4 + 1] = g; rgb[i * 4 + 2] = b; rgb[i * 4 + 3] = 255;
      luma[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }
  }
  return { rgb, luma };
}

/**
 * Colour per cell, or null in mono mode (the caller then uses the single ink colour).
 * @param {object} cr      resolveColors() result
 * @param {Uint8ClampedArray} rgb  per-cell mean colour (4 bytes per cell)
 * @param {Float32Array} luma      per-cell luma 0..1
 * @param {object} cache   reusable store owned by the mode (keeps the gradient LUT and palette matcher)
 * @param {Uint8ClampedArray|null} [into] buffer to reuse
 */
export function cellColors(cr, rgb, luma, cache, into = null) {
  if (cr.mode === 'mono') return null;
  const n = luma.length;
  const out = into && into.length === n * 4 ? into : new Uint8ClampedArray(n * 4);
  if (cr.mode === 'original') {
    for (let i = 0; i < n; i++) {
      const c = boostSaturation(rgb[i * 4], rgb[i * 4 + 1], rgb[i * 4 + 2], cr.boost);
      out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = 255;
    }
  } else if (cr.mode === 'gradient') {
    const key = cr.stops.join(',');
    if (cache.gradKey !== key) { cache.gradKey = key; cache.lut = buildGradientLUT(cr.stops); }
    const lut = cache.lut;
    for (let i = 0; i < n; i++) {
      const li = Math.round(luma[i] * 255) * 3;
      out[i * 4] = lut[li]; out[i * 4 + 1] = lut[li + 1]; out[i * 4 + 2] = lut[li + 2]; out[i * 4 + 3] = 255;
    }
  } else { // palette
    const key = cr.palette.map((c) => c.join('.')).join(',');
    if (cache.palKey !== key) { cache.palKey = key; cache.match = makePaletteMatcher(cr.palette, 'lab'); }
    for (let i = 0; i < n; i++) {
      const c = boostSaturation(rgb[i * 4], rgb[i * 4 + 1], rgb[i * 4 + 2], cr.boost);
      const pc = cr.palette[cache.match(c[0], c[1], c[2])];
      out[i * 4] = pc[0]; out[i * 4 + 1] = pc[1]; out[i * 4 + 2] = pc[2]; out[i * 4 + 3] = 255;
    }
  }
  return out;
}
