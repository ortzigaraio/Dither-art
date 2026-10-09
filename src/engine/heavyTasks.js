// CPU-heavy tasks that run inside heavy.worker.js (or on the main thread when workers are unavailable).
// This file has no DOM access. Every task is `async (payload, ctl) => result` where `ctl` is:
//   ctl.progress(p)  report 0..1
//   ctl.check()      throws a cancellation error when the job was cancelled
//   ctl.yield()      let the event loop run (so a cancel message can arrive), then check()
// Tasks are cooperative: they yield every few thousand pixels, which is what makes cancel-by-jobId work.

import { getKernel, isErrorDiffusion, quantize, quantizePalette } from './dither.js';
import { makePaletteMatcher } from './color.js';
import { matchRows, autoBackground } from './petsciiMatch.js';
import { buildMixTable, shadeCells } from './ansiart.js';
import { pixelSort } from './pixelsort.js';
import { stipple } from './stipple.js';

const CHUNK_PIXELS = 60000;

// ---------------------------------------------------------------------------
// Error diffusion with yields (same arithmetic as dither.js, so results are identical)
// ---------------------------------------------------------------------------

function compile(name) {
  const { taps, div } = getKernel(name);
  return {
    n: taps.length,
    dx: Int8Array.from(taps, (t) => t[0]),
    dy: Int8Array.from(taps, (t) => t[1]),
    w: Float32Array.from(taps, (t) => t[2] / div),
  };
}

/** Grey-level quantisation to `levels` levels; error diffusion runs in cooperative chunks of rows. */
export async function quantizeAsync(buffer, w, h, levels, algorithm, opts = {}, ctl = null) {
  const n = Math.max(1, Math.floor(levels));
  if (n < 2 || !isErrorDiffusion(algorithm)) return quantize(buffer, w, h, levels, algorithm, opts);
  const { serpentine = false, bias = 0 } = opts;
  const out = new Uint16Array(w * h);
  const max = n - 1;
  const k = compile(algorithm);
  const buf = new Float32Array(w * h);
  for (let i = 0; i < buf.length; i++) buf[i] = buffer[i] + bias;
  const rowsPerChunk = Math.max(1, Math.floor(CHUNK_PIXELS / Math.max(1, w)));
  for (let y = 0; y < h; y++) {
    const rev = serpentine && (y & 1) === 1;
    for (let step = 0; step < w; step++) {
      const x = rev ? w - 1 - step : step;
      const i = y * w + x;
      const v = buf[i];
      let idx = Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * max);
      if (idx > max) idx = max;
      out[i] = idx;
      const err = v - idx / max;
      if (err === 0) continue;
      for (let t = 0; t < k.n; t++) {
        const nx = x + (rev ? -k.dx[t] : k.dx[t]);
        const ny = y + k.dy[t];
        if (nx >= 0 && nx < w && ny < h) buf[ny * w + nx] += err * k.w[t];
      }
    }
    if (ctl && (y + 1) % rowsPerChunk === 0) {
      ctl.progress((y + 1) / h);
      await ctl.yield();
    }
  }
  return out;
}

/** Palette quantisation (RGBA in, palette indices out) with cooperative chunks for error diffusion. */
export async function quantizePaletteAsync(rgba, w, h, palette, algorithm, opts = {}, ctl = null) {
  if (!isErrorDiffusion(algorithm)) return quantizePalette(rgba, w, h, palette, algorithm, opts);
  const { serpentine = false, metric = 'lab' } = opts;
  const out = new Uint16Array(w * h);
  const match = makePaletteMatcher(palette, metric);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  const k = compile(algorithm);
  const buf = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    buf[i * 3] = rgba[i * 4];
    buf[i * 3 + 1] = rgba[i * 4 + 1];
    buf[i * 3 + 2] = rgba[i * 4 + 2];
  }
  const rowsPerChunk = Math.max(1, Math.floor(CHUNK_PIXELS / 4 / Math.max(1, w)));
  for (let y = 0; y < h; y++) {
    const rev = serpentine && (y & 1) === 1;
    for (let step = 0; step < w; step++) {
      const x = rev ? w - 1 - step : step;
      const i = y * w + x;
      const r = buf[i * 3], g = buf[i * 3 + 1], b = buf[i * 3 + 2];
      const idx = match(clamp(r), clamp(g), clamp(b));
      out[i] = idx;
      const p = palette[idx];
      const er = r - p[0], eg = g - p[1], eb = b - p[2];
      for (let t = 0; t < k.n; t++) {
        const nx = x + (rev ? -k.dx[t] : k.dx[t]);
        const ny = y + k.dy[t];
        if (nx >= 0 && nx < w && ny < h) {
          const j = (ny * w + nx) * 3;
          buf[j] += er * k.w[t];
          buf[j + 1] += eg * k.w[t];
          buf[j + 2] += eb * k.w[t];
        }
      }
    }
    if (ctl && (y + 1) % rowsPerChunk === 0) {
      ctl.progress((y + 1) / h);
      await ctl.yield();
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PETSCII glyph matching
// ---------------------------------------------------------------------------

/**
 * @param {{ rgba: Uint8ClampedArray, cols: number, rows: number, palette: number[][], glyphs: Uint8Array,
 *           enabled: Uint8Array, bg: number }} p   rgba is (cols*8) x (rows*8); bg -1 = automatic
 */
export async function petsciiAsync(p, ctl = null) {
  const { cols, rows } = p;
  const bg = p.bg >= 0 && p.bg < p.palette.length ? p.bg : autoBackground(p.rgba, cols * 8, rows * 8, p.palette);
  const glyph = new Uint16Array(cols * rows);
  const color = new Uint8Array(cols * rows);
  const rowsPerChunk = Math.max(1, Math.floor(400 / Math.max(1, cols)));
  for (let y = 0; y < rows; y += rowsPerChunk) {
    matchRows(p, bg, y, Math.min(rows, y + rowsPerChunk), glyph, color);
    if (ctl) {
      ctl.progress(Math.min(1, (y + rowsPerChunk) / rows));
      await ctl.yield();
    }
  }
  return { glyph, color, bg };
}

// ---------------------------------------------------------------------------
// Task table
// ---------------------------------------------------------------------------

const busyWait = (ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms); };

export const TASKS = {
  quantize: (p, ctl) => quantizeAsync(p.buffer, p.w, p.h, p.levels, p.algorithm, p.opts, ctl),
  quantizePalette: (p, ctl) => quantizePaletteAsync(p.rgba, p.w, p.h, p.palette, p.algorithm, p.opts, ctl),
  petscii: (p, ctl) => petsciiAsync(p, ctl),
  pixelSort: (p, ctl) => pixelSort(p, ctl),
  stipple: (p, ctl) => stipple(p, ctl),
  ansiShade: async (p, ctl) => {
    ctl.check();
    return shadeCells(p.M, p.cols, p.rows, buildMixTable(p.palette, p.bgCount), p.algorithm, p.serpentine);
  },

  // Diagnostics used by the tests (cancellation, progress and the watchdog)
  'debug.sleep': async (p, ctl) => {
    const steps = Math.max(1, p.steps || 20);
    for (let i = 0; i < steps; i++) {
      busyWait(p.ms / steps);
      ctl.progress((i + 1) / steps);
      await ctl.yield();
    }
    return { slept: p.ms, echo: p.echo ?? null };
  },
  'debug.block': async (p) => { busyWait(p.ms); return { blocked: p.ms }; }, // never yields: only terminate() stops it
  'debug.fail': async () => { throw new Error('debug failure'); },
};

export class CancelledError extends Error {
  constructor() { super('cancelled'); this.name = 'AbortError'; }
}
