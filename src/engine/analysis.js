// Lazy, cached analysis buffers for one preprocessed frame: rgba, luma, sobel; engine/depth.js caches the depth
// field of the frame here as well (_depth / _depthKey, cleared on reset).
// The pipeline resets one Analysis per frame/params key; modes pull only what they need.

export const luma709 = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Rec.709 luma (0..1) of an RGBA buffer into `out` (allocated when missing or wrong size). */
export function lumaFromRGBA(rgba, w, h, out) {
  const n = w * h;
  const buf = out && out.length === n ? out : new Float32Array(n);
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    buf[i] = (0.2126 * rgba[o] + 0.7152 * rgba[o + 1] + 0.0722 * rgba[o + 2]) / 255;
  }
  return buf;
}

/**
 * Sobel gradient of a 0..1 luma buffer. `mag` is normalised so that a full black/white step is 1
 * (clamped); `angle` is the gradient direction in radians (atan2(gy, gx), y pointing down).
 */
export function sobelLuma(luma, w, h, out) {
  const n = w * h;
  const mag = out && out.mag.length === n ? out.mag : new Float32Array(n);
  const angle = out && out.angle.length === n ? out.angle : new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const y0 = (y > 0 ? y - 1 : 0) * w;
    const y1 = y * w;
    const y2 = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const xl = x > 0 ? x - 1 : 0;
      const xr = x < w - 1 ? x + 1 : w - 1;
      const tl = luma[y0 + xl], tc = luma[y0 + x], tr = luma[y0 + xr];
      const ml = luma[y1 + xl], mr = luma[y1 + xr];
      const bl = luma[y2 + xl], bc = luma[y2 + x], br = luma[y2 + xr];
      const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
      const gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
      const i = y * w + x;
      const m = Math.sqrt(gx * gx + gy * gy) / 4;
      mag[i] = m > 1 ? 1 : m;
      angle[i] = Math.atan2(gy, gx);
    }
  }
  return { mag, angle };
}

/** Separable box blur (radius in px) of a 0..1 buffer, edge-clamped. */
export function boxBlur(src, w, h, radius) {
  const r = Math.max(0, Math.floor(radius));
  if (r === 0) return Float32Array.from(src);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * inv;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc * inv;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

export class Analysis {
  constructor() {
    this.width = 0;
    this.height = 0;
    this._canvas = null;
    this._rgba = null;
    this._luma = null;
    this._sobel = null;
    this._depth = null;
    this._depthKey = '';
    this._lumaValid = false;
    this._sobelValid = false;
  }

  /** Start a new frame. `rgba` may be null: it is then read lazily from `canvas`. */
  reset(width, height, canvas, rgba = null) {
    this.width = width;
    this.height = height;
    this._canvas = canvas;
    this._rgba = rgba;
    this._lumaValid = false;
    this._sobelValid = false;
    this._depthKey = '';
  }

  rgba() {
    if (!this._rgba) {
      const g = this._canvas.getContext('2d', { willReadFrequently: true });
      this._rgba = g.getImageData(0, 0, this.width, this.height).data;
    }
    return this._rgba;
  }

  luma() {
    if (!this._lumaValid) {
      this._luma = lumaFromRGBA(this.rgba(), this.width, this.height, this._luma);
      this._lumaValid = true;
    }
    return this._luma;
  }

  sobel() {
    if (!this._sobelValid) {
      this._sobel = sobelLuma(this.luma(), this.width, this.height, this._sobel);
      this._sobelValid = true;
    }
    return this._sobel;
  }
}
