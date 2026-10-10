// Tone shaping for a 0..1 luma grid before it is turned into glyph levels. This is most of why a good ASCII
// portrait reads well: the tonal range is stretched to use every character, mid-tones get a gamma curve and
// local contrast keeps faces and edges from melting into one grey.

import { boxBlur } from './analysis.js';

/** Percentile stretch: the darkest `clip` and lightest `clip` fractions become 0 and 1. Returns the range used. */
export function autoLevels(l, clip = 0.015) {
  const n = l.length;
  if (n < 4) return null;
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[Math.min(255, Math.max(0, Math.round(l[i] * 255)))]++;
  const cut = n * clip;
  let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > cut) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > cut) { hi = v; break; } }
  if (hi - lo < 8) return null; // flat image: stretching would only amplify noise
  const a = lo / 255;
  const k = 255 / (hi - lo);
  for (let i = 0; i < n; i++) { const v = (l[i] - a) * k; l[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
  return { lo: a, hi: hi / 255 };
}

/** out = in^(1/gamma): gamma > 1 lifts the mid-tones, < 1 darkens them. */
export function applyGamma(l, gamma) {
  if (!(gamma > 0) || Math.abs(gamma - 1) < 1e-3) return;
  const e = 1 / gamma;
  for (let i = 0; i < l.length; i++) l[i] = Math.pow(l[i], e);
}

/** Unsharp mask on the luma grid: amount 0..1, radius in cells. */
export function localContrast(l, w, h, amount, radius = 2) {
  if (!(amount > 0)) return;
  const blur = boxBlur(l, w, h, radius);
  for (let i = 0; i < l.length; i++) {
    const v = l[i] + amount * 1.6 * (l[i] - blur[i]);
    l[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
}
