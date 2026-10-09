// Glitch effects (PLAN.md 7.12) on an RGBA buffer. Every effect has an intensity 0..1 and is a pure function of the
// pixels, the parameters and the seed: no state survives between calls, so a frame depends only on (seed, time).
// Order: band shift, block corruption, RGB split, DCT artefacts, bit crush, interlace, scanlines, noise.

import { rng, mixSeed, clamp8 } from './rand.js';

export const GLITCH_DEFAULTS = {
  rgbSplit: 0, bandShift: 0, blockCorrupt: 0, blockSize: 16, bitCrush: 0, dct: 0, scanlines: 0, noise: 0, interlace: 0,
};

// DCT-II basis for 8-point blocks: C[u * 8 + x] = a(u) cos((2x + 1) u pi / 16)
const COS = (() => {
  const c = new Float32Array(64);
  for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) c[u * 8 + x] = (u === 0 ? Math.SQRT1_2 : 1) * 0.5 * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  return c;
})();

function bandShift(buf, w, h, amount, seed, row) {
  const r = rng(mixSeed(seed, 1));
  const bands = 3 + Math.floor(amount * 24);
  for (let b = 0; b < bands; b++) {
    const y0 = Math.floor(r() * h);
    const bh = 1 + Math.floor(r() * h * 0.12 * (0.3 + amount));
    const off = Math.round((r() * 2 - 1) * amount * 0.2 * w);
    if (off === 0) continue;
    for (let y = y0; y < Math.min(h, y0 + bh); y++) {
      const base = y * w * 4;
      row.set(buf.subarray(base, base + w * 4));
      for (let x = 0; x < w; x++) {
        const sx = (((x - off) % w) + w) % w;
        const o = base + x * 4;
        const s = sx * 4;
        buf[o] = row[s]; buf[o + 1] = row[s + 1]; buf[o + 2] = row[s + 2]; buf[o + 3] = row[s + 3];
      }
    }
  }
}

function copyBlock(dst, src, w, h, sx, sy, dx, dy, bs) {
  for (let y = 0; y < bs; y++) {
    const yy = dy + y;
    const ys = sy + y;
    if (yy < 0 || yy >= h || ys < 0 || ys >= h) continue;
    for (let x = 0; x < bs; x++) {
      const xx = dx + x;
      const xs = sx + x;
      if (xx < 0 || xx >= w || xs < 0 || xs >= w) continue;
      const o = (yy * w + xx) * 4;
      const s = (ys * w + xs) * 4;
      dst[o] = src[s]; dst[o + 1] = src[s + 1]; dst[o + 2] = src[s + 2]; dst[o + 3] = src[s + 3];
    }
  }
}

/** Datamosh-like macroblocks: some are replaced by a displaced block, some by the block to their left repeated. */
function blockCorrupt(buf, snap, w, h, amount, bs, seed) {
  snap.set(buf);
  const r = rng(mixSeed(seed, 2));
  const bx = Math.ceil(w / bs);
  const by = Math.ceil(h / bs);
  const count = Math.max(1, Math.floor(amount * bx * by * 0.08));
  for (let n = 0; n < count; n++) {
    const cx = Math.floor(r() * bx);
    const cy = Math.floor(r() * by);
    if (r() < 0.5) { // displaced block
      let dx = Math.round((r() * 2 - 1) * 5) * bs;
      const dy = Math.round((r() * 2 - 1) * 3) * bs;
      if (dx === 0 && dy === 0) dx = bs; // a displacement of zero would leave the block as it is
      copyBlock(buf, snap, w, h, cx * bs + dx, cy * bs + dy, cx * bs, cy * bs, bs);
    } else { // a run of blocks stuck on the colour of the block before the run
      const run = 1 + Math.floor(r() * 6);
      const from = (cx > 0 ? cx - 1 : cx + 1) * bs;
      for (let k = 0; k < run; k++) copyBlock(buf, snap, w, h, from, cy * bs, (cx + k) * bs, cy * bs, bs);
    }
  }
}

function rgbSplit(buf, snap, w, h, amount, seed) {
  snap.set(buf);
  const flip = rng(mixSeed(seed, 3))() < 0.5 ? -1 : 1;
  const dx = Math.max(1, Math.round(amount * 0.04 * w));
  const dy = Math.round(amount * 0.012 * h) * flip;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const rx = Math.min(w - 1, x + dx);
      const ry = Math.min(h - 1, Math.max(0, y + dy));
      const bx = Math.max(0, x - dx);
      const by = Math.min(h - 1, Math.max(0, y - dy));
      buf[o] = snap[(ry * w + rx) * 4];
      buf[o + 2] = snap[(by * w + bx) * 4 + 2];
    }
  }
}

/** 1-D DCT-II of 8 samples (stride `as`) using the even/odd symmetry c[u][7-n] = (-1)^u c[u][n]: 32 products, not 64. */
export function fdct8(a, ao, as, d, dof, ds) {
  const x0 = a[ao], x1 = a[ao + as], x2 = a[ao + 2 * as], x3 = a[ao + 3 * as];
  const x4 = a[ao + 4 * as], x5 = a[ao + 5 * as], x6 = a[ao + 6 * as], x7 = a[ao + 7 * as];
  const s0 = x0 + x7, s1 = x1 + x6, s2 = x2 + x5, s3 = x3 + x4;
  const t0 = x0 - x7, t1 = x1 - x6, t2 = x2 - x5, t3 = x3 - x4;
  for (let u = 0; u < 8; u += 2) d[dof + u * ds] = s0 * COS[u * 8] + s1 * COS[u * 8 + 1] + s2 * COS[u * 8 + 2] + s3 * COS[u * 8 + 3];
  for (let u = 1; u < 8; u += 2) d[dof + u * ds] = t0 * COS[u * 8] + t1 * COS[u * 8 + 1] + t2 * COS[u * 8 + 2] + t3 * COS[u * 8 + 3];
}

/** Inverse of fdct8. */
export function idct8(X, xo, xs, d, dof, ds) {
  const X0 = X[xo], X1 = X[xo + xs], X2 = X[xo + 2 * xs], X3 = X[xo + 3 * xs];
  const X4 = X[xo + 4 * xs], X5 = X[xo + 5 * xs], X6 = X[xo + 6 * xs], X7 = X[xo + 7 * xs];
  for (let n = 0; n < 4; n++) {
    const e = X0 * COS[n] + X2 * COS[16 + n] + X4 * COS[32 + n] + X6 * COS[48 + n];
    const o = X1 * COS[8 + n] + X3 * COS[24 + n] + X5 * COS[40 + n] + X7 * COS[56 + n];
    d[dof + n * ds] = e + o;
    d[dof + (7 - n) * ds] = e - o;
  }
}

/** JPEG-like blocking: 8x8 DCT of Y, Cb and Cr, coefficients rounded to a step that grows with frequency. */
function dctArtifacts(buf, w, h, amount) {
  const Q = 4 + amount * 120;
  const blk = new Float32Array(64);
  const tmp = new Float32Array(64);
  const planes = [new Float32Array(64), new Float32Array(64), new Float32Array(64)];
  const steps = [new Float32Array(64), new Float32Array(64)]; // quantisation step per coefficient: luma, chroma
  for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) { steps[0][v * 8 + u] = Q * (1 + (u + v) * 0.5); steps[1][v * 8 + u] = Q * 1.6 * (1 + (u + v) * 0.5); }
  for (let by = 0; by + 8 <= h; by += 8) {
    for (let bx = 0; bx + 8 <= w; bx += 8) {
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const o = ((by + y) * w + bx + x) * 4;
          const r = buf[o], g = buf[o + 1], b = buf[o + 2];
          const i = y * 8 + x;
          planes[0][i] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
          planes[1][i] = -0.168736 * r - 0.331264 * g + 0.5 * b;
          planes[2][i] = 0.5 * r - 0.418688 * g - 0.081312 * b;
        }
      }
      for (let c = 0; c < 3; c++) {
        const pl = planes[c];
        const st = steps[c === 0 ? 0 : 1];
        for (let y = 0; y < 8; y++) fdct8(pl, y * 8, 1, tmp, y * 8, 1); // rows, then columns
        for (let u = 0; u < 8; u++) fdct8(tmp, u, 8, blk, u, 8);
        for (let i = 0; i < 64; i++) blk[i] = Math.round(blk[i] / st[i]) * st[i];
        for (let v = 0; v < 8; v++) idct8(blk, v * 8, 1, tmp, v * 8, 1);
        for (let x = 0; x < 8; x++) idct8(tmp, x, 8, pl, x, 8);
      }
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const o = ((by + y) * w + bx + x) * 4;
          const i = y * 8 + x;
          const Y = planes[0][i] + 128, Cb = planes[1][i], Cr = planes[2][i];
          buf[o] = clamp8(Y + 1.402 * Cr);
          buf[o + 1] = clamp8(Y - 0.344136 * Cb - 0.714136 * Cr);
          buf[o + 2] = clamp8(Y + 1.772 * Cb);
        }
      }
    }
  }
}

function bitCrush(buf, w, h, amount) {
  const bits = 8 - Math.round(amount * 7);
  const L = (1 << bits) - 1;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round((v / 255) * L) / L * 255;
  for (let i = 0; i < w * h * 4; i += 4) { buf[i] = lut[buf[i]]; buf[i + 1] = lut[buf[i + 1]]; buf[i + 2] = lut[buf[i + 2]]; }
}

/** Odd rows slide sideways (wrapping) and dim a little, like the second field of an interlaced frame. */
function interlace(buf, w, h, amount, row) {
  const off = Math.round(amount * 0.03 * w);
  const k = 1 - amount * 0.25;
  for (let y = 1; y < h; y += 2) {
    const base = y * w * 4;
    row.set(buf.subarray(base, base + w * 4));
    for (let x = 0; x < w; x++) {
      const s = (((x - off) % w) + w) % w * 4;
      const o = base + x * 4;
      buf[o] = row[s] * k; buf[o + 1] = row[s + 1] * k; buf[o + 2] = row[s + 2] * k;
    }
  }
}

function scanlines(buf, w, h, amount) {
  const k = 1 - amount * 0.6;
  for (let y = 1; y < h; y += 2) {
    for (let i = y * w * 4, e = i + w * 4; i < e; i += 4) { buf[i] *= k; buf[i + 1] *= k; buf[i + 2] *= k; }
  }
}

function noise(buf, w, h, amount, seed) {
  const amp = amount * 90;
  const s = mixSeed(seed, 8);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      let hh = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 2147483647)) | 0;
      hh = Math.imul(hh ^ (hh >>> 13), 1274126177);
      hh ^= hh >>> 16;
      const l = ((hh & 255) / 255 - 0.5) * 2 * amp;
      const cr = (((hh >>> 8) & 255) / 255 - 0.5) * 0.6 * amp;
      const cb = (((hh >>> 16) & 255) / 255 - 0.5) * 0.6 * amp;
      buf[i] = clamp8(buf[i] + l + cr); buf[i + 1] = clamp8(buf[i + 1] + l); buf[i + 2] = clamp8(buf[i + 2] + l + cb);
    }
  }
}

/**
 * @param {Uint8ClampedArray} src  RGBA pixels (not modified)
 * @param {number} w @param {number} h
 * @param {object} p      intensities and blockSize (see GLITCH_DEFAULTS)
 * @param {number} seed   32-bit seed: the same seed gives the same pixels
 * @param {{ out?: Uint8ClampedArray, snap?: Uint8ClampedArray, row?: Uint8ClampedArray }} [scratch] reusable buffers
 * @returns {Uint8ClampedArray} the glitched pixels (scratch.out when given)
 */
export function applyGlitch(src, w, h, p, seed, scratch = {}) {
  const q = { ...GLITCH_DEFAULTS, ...p };
  const out = scratch.out && scratch.out.length === src.length ? scratch.out : (scratch.out = new Uint8ClampedArray(src.length));
  const snap = scratch.snap && scratch.snap.length === src.length ? scratch.snap : (scratch.snap = new Uint8ClampedArray(src.length));
  const row = scratch.row && scratch.row.length === w * 4 ? scratch.row : (scratch.row = new Uint8ClampedArray(w * 4));
  out.set(src);
  if (q.bandShift > 0) bandShift(out, w, h, q.bandShift, seed, row);
  if (q.blockCorrupt > 0) blockCorrupt(out, snap, w, h, q.blockCorrupt, q.blockSize === 8 ? 8 : 16, seed);
  if (q.rgbSplit > 0) rgbSplit(out, snap, w, h, q.rgbSplit, seed);
  if (q.dct > 0) dctArtifacts(out, w, h, q.dct);
  if (q.bitCrush > 0) bitCrush(out, w, h, q.bitCrush);
  if (q.interlace > 0) interlace(out, w, h, q.interlace, row);
  if (q.scanlines > 0) scanlines(out, w, h, q.scanlines);
  if (q.noise > 0) noise(out, w, h, q.noise, seed);
  return out;
}
