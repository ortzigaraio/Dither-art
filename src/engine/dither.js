// Dithering (PLAN.md 5.3): error diffusion with every kernel of the spec, Bayer ordered matrices,
// void-and-cluster blue noise and random thresholds. Works on grey levels and on RGB palettes.

import { makePaletteMatcher } from './color.js';

export const DITHER_OPTIONS = [
  { value: 'none', label: { es: 'Ninguno', en: 'None' } },
  { value: 'floyd-steinberg', label: { es: 'Floyd–Steinberg', en: 'Floyd–Steinberg' } },
  { value: 'jjn', label: { es: 'Jarvis, Judice y Ninke (JJN)', en: 'Jarvis, Judice & Ninke (JJN)' } },
  { value: 'stucki', label: { es: 'Stucki', en: 'Stucki' } },
  { value: 'atkinson', label: { es: 'Atkinson', en: 'Atkinson' } },
  { value: 'burkes', label: { es: 'Burkes', en: 'Burkes' } },
  { value: 'sierra', label: { es: 'Sierra', en: 'Sierra' } },
  { value: 'sierra2', label: { es: 'Sierra de 2 filas', en: 'Sierra Two-Row' } },
  { value: 'sierra-lite', label: { es: 'Sierra Lite', en: 'Sierra Lite' } },
  { value: 'bayer2', label: { es: 'Bayer 2×2', en: 'Bayer 2×2' } },
  { value: 'bayer4', label: { es: 'Bayer 4×4', en: 'Bayer 4×4' } },
  { value: 'bayer8', label: { es: 'Bayer 8×8', en: 'Bayer 8×8' } },
  { value: 'bayer16', label: { es: 'Bayer 16×16', en: 'Bayer 16×16' } },
  { value: 'blue-noise', label: { es: 'Ruido azul', en: 'Blue noise' } },
  { value: 'random', label: { es: 'Aleatorio', en: 'Random' } },
];

// Kernels as [dx, dy, weight] taps plus the divisor (X = current pixel, dy >= 0).
const KERNELS = {
  'floyd-steinberg': { div: 16, taps: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]] },
  // Atkinson propagates only 6/8 of the error
  atkinson: { div: 8, taps: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]] },
  jjn: {
    div: 48,
    taps: [[1, 0, 7], [2, 0, 5],
      [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3],
      [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]],
  },
  stucki: {
    div: 42,
    taps: [[1, 0, 8], [2, 0, 4],
      [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2],
      [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]],
  },
  burkes: {
    div: 32,
    taps: [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2]],
  },
  sierra: {
    div: 32,
    taps: [[1, 0, 5], [2, 0, 3],
      [-2, 1, 2], [-1, 1, 4], [0, 1, 5], [1, 1, 4], [2, 1, 2],
      [-1, 2, 2], [0, 2, 3], [1, 2, 2]],
  },
  sierra2: {
    div: 16,
    taps: [[1, 0, 4], [2, 0, 3], [-2, 1, 1], [-1, 1, 2], [0, 1, 3], [1, 1, 2], [2, 1, 1]],
  },
  'sierra-lite': { div: 4, taps: [[1, 0, 2], [-1, 1, 1], [0, 1, 1]] },
};

export const ERROR_DIFFUSION_IDS = Object.keys(KERNELS);
/** Raw kernel definition (taps and divisor), exposed for tests and documentation. */
export const getKernel = (name) => KERNELS[name];
export const isErrorDiffusion = (algo) => algo in KERNELS;
export const isOrdered = (algo) => /^bayer\d+$/.test(algo);
export const isThreshold = (algo) => isOrdered(algo) || algo === 'blue-noise' || algo === 'random';

/** Flatten a kernel into typed arrays so the hot loop allocates nothing. */
const compiled = new Map();
function compileKernel(name) {
  let k = compiled.get(name);
  if (!k) {
    const { taps, div } = KERNELS[name];
    k = {
      n: taps.length,
      dx: Int8Array.from(taps, (t) => t[0]),
      dy: Int8Array.from(taps, (t) => t[1]),
      w: Float32Array.from(taps, (t) => t[2] / div),
    };
    compiled.set(name, k);
  }
  return k;
}

// ---------------------------------------------------------------------------
// Threshold maps
// ---------------------------------------------------------------------------

const bayerCache = new Map();

/** Bayer matrix of side n (power of two), recursive: M2n = [[4M, 4M+2], [4M+3, 4M+1]]. */
export function bayerMatrix(n) {
  let m = bayerCache.get(n);
  if (m) return m;
  let cur = new Uint16Array([0]);
  let side = 1;
  while (side < n) {
    const ns = side * 2;
    const next = new Uint16Array(ns * ns);
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const v = cur[y * side + x] * 4;
        next[y * ns + x] = v;
        next[y * ns + x + side] = v + 2;
        next[(y + side) * ns + x] = v + 3;
        next[(y + side) * ns + x + side] = v + 1;
      }
    }
    cur = next;
    side = ns;
  }
  m = { size: n, data: cur };
  bayerCache.set(n, m);
  return m;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let blueNoiseMap = null;

/**
 * 64x64 blue-noise threshold map by void-and-cluster (Ulichney 1993).
 * Deterministic (seeded) and cached after the first call.
 */
export function blueNoise(size = 64) {
  if (blueNoiseMap && blueNoiseMap.size === size) return blueNoiseMap;
  const N = size * size;
  const sigma = 1.5;
  const R = Math.ceil(sigma * 3);
  const kw = 2 * R + 1;
  const kernel = new Float32Array(kw * kw);
  for (let y = -R; y <= R; y++) {
    for (let x = -R; x <= R; x++) kernel[(y + R) * kw + (x + R)] = Math.exp(-(x * x + y * y) / (2 * sigma * sigma));
  }
  let energy = new Float32Array(N);
  let bin = new Uint8Array(N);

  const splat = (idx, sign) => {
    const px = idx % size;
    const py = (idx / size) | 0;
    for (let dy = -R; dy <= R; dy++) {
      const row = ((py + dy + size) % size) * size;
      const krow = (dy + R) * kw;
      for (let dx = -R; dx <= R; dx++) {
        energy[row + ((px + dx + size) % size)] += sign * kernel[krow + dx + R];
      }
    }
  };
  const tightest = () => { // 1-pixel with the highest energy
    let best = -1;
    let be = -Infinity;
    for (let i = 0; i < N; i++) if (bin[i] && energy[i] > be) { be = energy[i]; best = i; }
    return best;
  };
  const largestVoid = () => { // 0-pixel with the lowest energy
    let best = -1;
    let be = Infinity;
    for (let i = 0; i < N; i++) if (!bin[i] && energy[i] < be) { be = energy[i]; best = i; }
    return best;
  };

  // Initial binary pattern: ~10% random ones, relaxed until stable
  const rnd = mulberry32(0xb1e0);
  const ones = Math.round(N * 0.1);
  for (let placed = 0; placed < ones;) {
    const i = Math.floor(rnd() * N);
    if (!bin[i]) { bin[i] = 1; splat(i, 1); placed++; }
  }
  for (let guard = 0; guard < N * 4; guard++) {
    const c = tightest();
    bin[c] = 0; splat(c, -1);
    const v = largestVoid();
    bin[v] = 1; splat(v, 1);
    if (v === c) break;
  }

  const rank = new Uint16Array(N);
  const protoBin = bin.slice();
  const protoEnergy = energy.slice();

  // Phase 1: remove the tightest clusters one by one
  for (let r = ones; r > 0;) {
    const c = tightest();
    bin[c] = 0; splat(c, -1);
    rank[c] = --r;
  }
  // Phases 2 and 3: from the prototype, keep filling the largest voids
  bin = protoBin;
  energy = protoEnergy;
  for (let r = ones; r < N; r++) {
    const v = largestVoid();
    rank[v] = r;
    bin[v] = 1; splat(v, 1);
  }

  const data = new Float32Array(N);
  for (let i = 0; i < N; i++) data[i] = (rank[i] + 0.5) / N;
  blueNoiseMap = { size, data };
  return blueNoiseMap;
}

function hash01(x, y, seed) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Threshold in (0,1) for pixel (x,y) for an ordered/noise algorithm. */
export function thresholdFn(algorithm, seed = 0) {
  if (isOrdered(algorithm)) {
    const n = parseInt(algorithm.slice(5), 10);
    const { data } = bayerMatrix(n);
    const mask = n - 1;
    const nn = n * n;
    return (x, y) => (data[(y & mask) * n + (x & mask)] + 0.5) / nn;
  }
  if (algorithm === 'blue-noise') {
    const { size, data } = blueNoise();
    return (x, y) => data[(y % size) * size + (x % size)];
  }
  if (algorithm === 'random') return (x, y) => hash01(x, y, seed);
  return null;
}

// ---------------------------------------------------------------------------
// Grey quantisation
// ---------------------------------------------------------------------------

/**
 * Quantise a 0..1 buffer to `levels` evenly spaced levels.
 * Returns Uint16Array of level indices (0..levels-1).
 * As in PLAN.md 5.3, `levels` may also be a palette ([[r,g,b], ...]): `buffer` is then an RGBA pixel buffer and
 * the result holds palette indices (see quantizePalette).
 * @param {Float32Array|Uint8ClampedArray|number[]} buffer w*h values (or RGBA bytes for a palette), not modified
 * @param {number|number[][]} levels
 * @param {{ serpentine?: boolean, seed?: number, bias?: number }} [opts]
 */
export function quantize(buffer, w, h, levels, algorithm = 'none', opts = {}) {
  if (Array.isArray(levels)) return quantizePalette(buffer, w, h, levels, algorithm, opts);
  const { serpentine = false, seed = 0, bias = 0 } = opts;
  const out = new Uint16Array(w * h);
  const n = Math.max(1, Math.floor(levels));
  if (n < 2) return out;
  const max = n - 1;
  const total = w * h;

  const thr = thresholdFn(algorithm, seed);
  if (thr) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let v = buffer[i] + bias;
        v = v < 0 ? 0 : v > 1 ? 1 : v;
        const s = v * max;
        const lo = Math.floor(s);
        const idx = lo + (s - lo > thr(x, y) ? 1 : 0);
        out[i] = idx > max ? max : idx;
      }
    }
    return out;
  }

  if (isErrorDiffusion(algorithm)) {
    const k = compileKernel(algorithm);
    const buf = new Float32Array(total);
    for (let i = 0; i < total; i++) buf[i] = buffer[i] + bias;
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
    }
    return out;
  }

  // 'none': plain rounding
  for (let i = 0; i < total; i++) {
    const v = buffer[i] + bias;
    const idx = Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * max);
    out[i] = idx > max ? max : idx;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Palette quantisation (RGB)
// ---------------------------------------------------------------------------

/**
 * Quantise RGBA pixels to the nearest colours of `palette` ([[r,g,b], ...]).
 * Returns Uint16Array of palette indices.
 * @param {{ serpentine?: boolean, seed?: number, metric?: 'lab'|'rgb', spread?: number }} [opts]
 */
export function quantizePalette(rgba, w, h, palette, algorithm = 'none', opts = {}) {
  const { serpentine = false, seed = 0, metric = 'lab', spread = 64 } = opts;
  const out = new Uint16Array(w * h);
  const match = makePaletteMatcher(palette, metric);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

  const thr = thresholdFn(algorithm, seed);
  if (thr) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const off = (thr(x, y) - 0.5) * spread;
        out[i] = match(clamp(rgba[i * 4] + off), clamp(rgba[i * 4 + 1] + off), clamp(rgba[i * 4 + 2] + off));
      }
    }
    return out;
  }

  if (isErrorDiffusion(algorithm)) {
    const k = compileKernel(algorithm);
    const total = w * h;
    const buf = new Float32Array(total * 3);
    for (let i = 0; i < total; i++) {
      buf[i * 3] = rgba[i * 4];
      buf[i * 3 + 1] = rgba[i * 4 + 1];
      buf[i * 3 + 2] = rgba[i * 4 + 2];
    }
    for (let y = 0; y < h; y++) {
      const rev = serpentine && (y & 1) === 1;
      for (let step = 0; step < w; step++) {
        const x = rev ? w - 1 - step : step;
        const i = y * w + x;
        const r = buf[i * 3];
        const g = buf[i * 3 + 1];
        const b = buf[i * 3 + 2];
        const idx = match(clamp(r), clamp(g), clamp(b));
        out[i] = idx;
        const p = palette[idx];
        const er = r - p[0];
        const eg = g - p[1];
        const eb = b - p[2];
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
    }
    return out;
  }

  for (let i = 0; i < w * h; i++) out[i] = match(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  return out;
}
