// ANSI Art cell logic (PLAN.md 7.3). Pure functions (no DOM) so they can also run inside heavy.worker.js.
//
// A cell is one character of 8 x 16 VGA pixels: a foreground colour, a background colour and one of
//   ' ' (background only), '░' '▒' '▓' (foreground over background at 25 / 50 / 75 %), '█' (foreground only),
//   '▀' (top half foreground, bottom half background) and '▄' (the opposite).
// The picture is sampled at cols x (2 * rows) pixels, so a half block carries two image pixels per cell.

import { compileKernel, isErrorDiffusion, thresholdFn } from './dither.js';

export const CH = { SPACE: 0, LIGHT: 1, MEDIUM: 2, DARK: 3, FULL: 4, UPPER: 5, LOWER: 6 };
export const CELL_CHARS = [' ', '░', '▒', '▓', '█', '▀', '▄'];
const COVERAGE = [0, 0.25, 0.5, 0.75, 1];

/** VGA text-mode palette, attribute order (index bit 0 = blue, 1 = green, 2 = red, 3 = bright). */
export const VGA16 = [
  [0, 0, 0], [0, 0, 170], [0, 170, 0], [0, 170, 170], [170, 0, 0], [170, 0, 170], [170, 85, 0], [170, 170, 170],
  [85, 85, 85], [85, 85, 255], [85, 255, 85], [85, 255, 255], [255, 85, 85], [255, 85, 255], [255, 255, 85], [255, 255, 255],
];

let xterm = null;
/** xterm 256-colour palette: 16 system colours (VGA values), a 6x6x6 cube and 24 greys. */
export function xterm256() {
  if (xterm) return xterm;
  const cube = [0, 95, 135, 175, 215, 255];
  xterm = VGA16.map((c) => c.slice());
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) xterm.push([cube[r], cube[g], cube[b]]);
  for (let i = 0; i < 24; i++) xterm.push([8 + i * 10, 8 + i * 10, 8 + i * 10]);
  return xterm;
}

// ---------------------------------------------------------------------------
// Shade mixes for small palettes: every (fg, bg, coverage) triple as one candidate colour
// ---------------------------------------------------------------------------

/**
 * @param {number[][]} palette
 * @param {number} bgCount  only the first `bgCount` colours may be backgrounds (8 for ANSI.SYS)
 */
export function buildMixTable(palette, bgCount) {
  const cand = [];
  palette.forEach((c, i) => cand.push({ r: c[0], g: c[1], b: c[2], ch: CH.FULL, fg: i, bg: Math.min(i, bgCount - 1) }));
  for (let bg = 0; bg < bgCount; bg++) {
    for (let fg = 0; fg < palette.length; fg++) {
      if (fg === bg) continue;
      for (let k = 1; k <= 3; k++) {
        const cov = COVERAGE[k];
        cand.push({
          r: palette[bg][0] + (palette[fg][0] - palette[bg][0]) * cov,
          g: palette[bg][1] + (palette[fg][1] - palette[bg][1]) * cov,
          b: palette[bg][2] + (palette[fg][2] - palette[bg][2]) * cov,
          ch: k, fg, bg,
        });
      }
    }
  }
  const m = cand.length;
  const t = { n: m, r: new Float32Array(m), g: new Float32Array(m), b: new Float32Array(m), ch: new Uint8Array(m), fg: new Uint8Array(m), bg: new Uint8Array(m) };
  cand.forEach((c, i) => { t.r[i] = c.r; t.g[i] = c.g; t.b[i] = c.b; t.ch[i] = c.ch; t.fg[i] = c.fg; t.bg[i] = c.bg; });
  return t;
}

export function nearestMix(table, r, g, b) {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < table.n; i++) {
    const d = (r - table.r[i]) ** 2 + (g - table.g[i]) ** 2 + (b - table.b[i]) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

const SPREAD = 56; // amplitude of ordered / noise thresholds, in colour units

/**
 * Best (character, fg, bg) per cell for the target colours `M` (cols*rows*3 floats), with the dither algorithm
 * spreading the error between cells.
 * @returns {{ ch: Uint8Array, fg: Uint8Array, bg: Uint8Array, err: Float32Array }}
 */
export function shadeCells(M, cols, rows, table, algorithm = 'none', serpentine = false) {
  const n = cols * rows;
  const ch = new Uint8Array(n);
  const fg = new Uint8Array(n);
  const bg = new Uint8Array(n);
  const err = new Float32Array(n);
  const buf = Float32Array.from(M);
  const kernel = isErrorDiffusion(algorithm) ? compileKernel(algorithm) : null;
  const thr = kernel ? null : thresholdFn(algorithm, 5);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let y = 0; y < rows; y++) {
    const rev = kernel && serpentine && (y & 1) === 1;
    for (let step = 0; step < cols; step++) {
      const x = rev ? cols - 1 - step : step;
      const i = y * cols + x;
      let r = buf[i * 3], g = buf[i * 3 + 1], b = buf[i * 3 + 2];
      let qr = r, qg = g, qb = b;
      if (thr) { const off = (thr(x, y) - 0.5) * SPREAD; qr += off; qg += off; qb += off; }
      const k = nearestMix(table, clamp(qr), clamp(qg), clamp(qb));
      ch[i] = table.ch[k]; fg[i] = table.fg[k]; bg[i] = table.bg[k];
      const mr = table.r[k], mg = table.g[k], mb = table.b[k];
      err[i] = (M[i * 3] - mr) ** 2 + (M[i * 3 + 1] - mg) ** 2 + (M[i * 3 + 2] - mb) ** 2;
      if (kernel) {
        r -= mr; g -= mg; b -= mb;
        for (let t = 0; t < kernel.n; t++) {
          const nx = x + (rev ? -kernel.dx[t] : kernel.dx[t]);
          const ny = y + kernel.dy[t];
          if (nx >= 0 && nx < cols && ny < rows) {
            const j = (ny * cols + nx) * 3;
            buf[j] += r * kernel.w[t]; buf[j + 1] += g * kernel.w[t]; buf[j + 2] += b * kernel.w[t];
          }
        }
      }
    }
  }
  return { ch, fg, bg, err };
}

// ---------------------------------------------------------------------------
// Cells from pixels
// ---------------------------------------------------------------------------

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Cell colours as RGB bytes plus character codes.
 * @typedef {{ ch: Uint8Array, fg: Uint8ClampedArray, bg: Uint8ClampedArray, err: Float32Array }} Cells  fg/bg: 3 bytes per cell
 */

/**
 * Half blocks: top pixel = foreground of '▀', bottom pixel = background. With `bgCount` < palette size the
 * background must be one of the first colours, so '▄' (swapped colours) is used when only the top pixel qualifies.
 * @param {Uint8ClampedArray} src   RGBA, cols x (2*rows)
 * @param {Uint16Array|null} idx    palette index per pixel (null = truecolor: colours are used as they are)
 */
export function halfBlockCells(src, idx, palette, cols, rows, bgCount) {
  const n = cols * rows;
  const ch = new Uint8Array(n);
  const fg = new Uint8ClampedArray(n * 3);
  const bg = new Uint8ClampedArray(n * 3);
  const err = new Float32Array(n);
  const colour = (p, out, o) => {
    if (idx) { const c = palette[idx[p]]; out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; } else { out[o] = src[p * 4]; out[o + 1] = src[p * 4 + 1]; out[o + 2] = src[p * 4 + 2]; }
  };
  const limited = idx && bgCount < palette.length;
  const nearestBg = (r, g, b) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < bgCount; i++) { const c = palette[i]; const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2; if (d < bd) { bd = d; best = i; } }
    return palette[best];
  };
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const top = (2 * y) * cols + x;
      const bot = top + cols;
      const tIdx = idx ? idx[top] : -1;
      const bIdx = idx ? idx[bot] : -1;
      const cTop = new Uint8ClampedArray(3);
      const cBot = new Uint8ClampedArray(3);
      colour(top, cTop, 0);
      colour(bot, cBot, 0);
      let c = CH.UPPER;
      let f = cTop, b = cBot;
      if (limited) {
        const topOk = tIdx < bgCount;
        const botOk = bIdx < bgCount;
        if (!botOk && topOk) { c = CH.LOWER; f = cBot; b = cTop; } else if (!botOk && !topOk) { b = nearestBg(cBot[0], cBot[1], cBot[2]); }
      }
      ch[i] = c;
      fg.set(f, i * 3);
      bg.set(b, i * 3);
      // error against the source pixels
      const st = [src[top * 4], src[top * 4 + 1], src[top * 4 + 2]];
      const sb = [src[bot * 4], src[bot * 4 + 1], src[bot * 4 + 2]];
      const t = c === CH.UPPER ? f : b;
      const bo = c === CH.UPPER ? b : f;
      err[i] = (st[0] - t[0]) ** 2 + (st[1] - t[1]) ** 2 + (st[2] - t[2]) ** 2 + (sb[0] - bo[0]) ** 2 + (sb[1] - bo[1]) ** 2 + (sb[2] - bo[2]) ** 2;
    }
  }
  return { ch, fg, bg, err };
}

/**
 * Shading for large palettes (xterm 256 / truecolor): the brighter of the two quantised halves becomes the
 * foreground, the darker the background, and the coverage that best reproduces the mean colour picks the shade.
 * @param {Uint8ClampedArray} src RGBA, cols x (2*rows)
 * @param {Uint8ClampedArray} q   RGBA of the (palette-quantised or original) pixels, same size
 */
export function projectionCells(src, q, cols, rows) {
  const n = cols * rows;
  const ch = new Uint8Array(n);
  const fg = new Uint8ClampedArray(n * 3);
  const bg = new Uint8ClampedArray(n * 3);
  const err = new Float32Array(n);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const a = (2 * y * cols + x) * 4;
      const b = a + cols * 4;
      const mr = (src[a] + src[b]) / 2, mg = (src[a + 1] + src[b + 1]) / 2, mb = (src[a + 2] + src[b + 2]) / 2;
      let hi = a, lo = b;
      if (lum(q[a], q[a + 1], q[a + 2]) < lum(q[b], q[b + 1], q[b + 2])) { hi = b; lo = a; }
      const dr = q[hi] - q[lo], dg = q[hi + 1] - q[lo + 1], db = q[hi + 2] - q[lo + 2];
      const len2 = dr * dr + dg * dg + db * db;
      let k = 4;
      if (len2 >= 1) {
        const t = ((mr - q[lo]) * dr + (mg - q[lo + 1]) * dg + (mb - q[lo + 2]) * db) / len2;
        k = Math.max(0, Math.min(4, Math.round(t * 4)));
      }
      ch[i] = k; // 0..4 map onto SPACE LIGHT MEDIUM DARK FULL
      fg.set([q[hi], q[hi + 1], q[hi + 2]], i * 3);
      bg.set([q[lo], q[lo + 1], q[lo + 2]], i * 3);
      const cov = COVERAGE[k];
      const xr = q[lo] + dr * cov, xg = q[lo + 1] + dg * cov, xb = q[lo + 2] + db * cov;
      err[i] = (src[a] - xr) ** 2 + (src[a + 1] - xg) ** 2 + (src[a + 2] - xb) ** 2 + (src[b] - xr) ** 2 + (src[b + 1] - xg) ** 2 + (src[b + 2] - xb) ** 2;
    }
  }
  return { ch, fg, bg, err };
}

/** Convert palette-index shade results (fg/bg indices) to RGB byte cells. */
export function shadeToRGB(res, palette) {
  const n = res.ch.length;
  const fg = new Uint8ClampedArray(n * 3);
  const bg = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    fg.set(palette[res.fg[i]], i * 3);
    bg.set(palette[res.bg[i]], i * 3);
  }
  return { ch: res.ch, fg, bg, err: res.err };
}

/** Mixed mode: per cell, keep whichever of two candidate encodings reproduces the two source pixels better. */
export function pickBest(a, b) {
  const n = a.ch.length;
  const ch = new Uint8Array(n);
  const fg = new Uint8ClampedArray(n * 3);
  const bg = new Uint8ClampedArray(n * 3);
  const err = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = b.err[i] < a.err[i] ? b : a; // ties keep the half block (a)
    ch[i] = s.ch[i];
    fg.set(s.fg.subarray(i * 3, i * 3 + 3), i * 3);
    bg.set(s.bg.subarray(i * 3, i * 3 + 3), i * 3);
    err[i] = s.err[i];
  }
  return { ch, fg, bg, err };
}

/**
 * Shading-table candidates are measured against the mean colour only; convert to the two-pixel error used by the
 * half-block and projection results so that "mixed" compares like with like.
 */
export function shadeErrorTwoPixels(M, src, cols, rows, res) {
  const out = new Float32Array(res.err.length);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const a = (2 * y * cols + x) * 4;
      const b = a + cols * 4;
      const dm = res.err[i]; // |M - mix|^2
      const dt = (src[a] - src[b]) ** 2 + (src[a + 1] - src[b + 1]) ** 2 + (src[a + 2] - src[b + 2]) ** 2;
      out[i] = 2 * dm + dt / 2;
    }
  }
  return out;
}

/** Mean colours of the two pixels of every cell: input to shading. */
export function cellMeans(src, cols, rows) {
  const M = new Float32Array(cols * rows * 3);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const a = (2 * y * cols + x) * 4;
      const b = a + cols * 4;
      M[i * 3] = (src[a] + src[b]) / 2;
      M[i * 3 + 1] = (src[a + 1] + src[b + 1]) / 2;
      M[i * 3 + 2] = (src[a + 2] + src[b + 2]) / 2;
    }
  }
  return M;
}
