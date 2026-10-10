// Global image preprocessing (PLAN.md 5.2): crop, mirror, CSS-filter colour adjustments, unsharp mask,
// Sobel edge blend and thresholding. Colour filters use the same semantics as CSS filters, in the
// order brightness -> contrast -> saturate -> hue-rotate -> grayscale -> sepia -> invert.
// Fast path: ctx.filter. Fallback: the Filter Effects matrices in JS (clamped after every step).

import { DITHER_OPTIONS, isErrorDiffusion } from './dither.js';
import { lumaFromRGBA, sobelLuma } from './analysis.js';

const range = (id, min, max, def, label, extra = {}) => ({ id, type: 'range', min, max, step: 1, default: def, label, ...extra });

// Phones start with a lighter default (PLAN.md 18.2: "valores por defecto más bajos" on mobile)
const SMALL_SCREEN = typeof matchMedia === 'function' && matchMedia('(max-width: 699px)').matches;

export const IMAGE_PARAMS = [
  range('cols', 10, 600, SMALL_SCREEN ? 80 : 120, { es: 'Caracteres / Resolución', en: 'Characters / Resolution' }, {
    help: { es: 'Cuántas columnas de caracteres (o celdas) tiene el resultado.', en: 'How many columns of characters (or cells) the result has.' },
  }),
  range('brightness', 0, 200, 100, { es: 'Brillo', en: 'Brightness' }, { unit: '%' }),
  range('contrast', 0, 300, 100, { es: 'Contraste', en: 'Contrast' }, { unit: '%' }),
  range('saturation', 0, 300, 100, { es: 'Saturación', en: 'Saturation' }, { unit: '%' }),
  range('hue', 0, 360, 0, { es: 'Tono', en: 'Hue' }, { unit: '°' }),
  range('grayscale', 0, 100, 0, { es: 'Escala de grises', en: 'Grayscale' }, { unit: '%' }),
  range('sepia', 0, 100, 0, { es: 'Sepia', en: 'Sepia' }, { unit: '%' }),
  range('invert', 0, 100, 0, { es: 'Invertir colores', en: 'Invert Colors' }, { unit: '%' }),
  {
    id: 'thresholdOn', type: 'toggle', default: false,
    label: { es: 'Umbral', en: 'Thresholding' },
    help: { es: 'Convierte la imagen en blanco y negro puro según el nivel de umbral.', en: 'Turns the image into pure black and white around the threshold level.' },
  },
  range('threshold', 0, 255, 128, { es: 'Nivel de umbral', en: 'Threshold level' }, { showIf: (p) => p.thresholdOn }),
  range('sharpness', 0, 20, 0, { es: 'Nitidez', en: 'Sharpness' }, {
    help: { es: 'Máscara de enfoque 3×3: realza los detalles finos.', en: '3×3 unsharp mask: brings out fine detail.' },
  }),
  range('edges', 0, 10, 0, { es: 'Detección de bordes', en: 'Edge Detection' }, {
    help: { es: 'Realza los bordes (Sobel). En ASCII también permite caracteres direccionales.', en: 'Emphasises edges (Sobel). In ASCII it also enables directional characters.' },
  }),
  {
    id: 'dither', type: 'select', default: 'none', options: DITHER_OPTIONS,
    label: { es: 'Mejoras de calidad', en: 'Quality Enhancements' },
    help: { es: 'Tramado: reparte el error de cuantización entre celdas vecinas para suavizar los degradados.', en: 'Dithering: spreads the quantisation error between neighbouring cells to smooth gradients.' },
  },
  {
    id: 'serpentine', type: 'toggle', default: false,
    label: { es: 'Serpentina', en: 'Serpentine' },
    help: { es: 'Recorre las filas alternando el sentido: reduce los artefactos de la difusión de error.', en: 'Scans rows in alternating directions: reduces error-diffusion artifacts.' },
    showIf: (p) => isErrorDiffusion(p.dither),
  },
  range('frame', 0, 100, 0, { es: 'Marco transparente', en: 'Transparent frame' }, {
    unit: 'px',
    help: { es: 'Margen transparente alrededor del resultado mostrado y exportado.', en: 'Transparent margin around the displayed and exported result.' },
  }),
  { id: 'flipX', type: 'toggle', default: false, label: { es: 'Espejo', en: 'Mirror' } },
  range('cropTop', 0, 90, 0, { es: 'Recorte arriba', en: 'Crop top' }, { unit: '%' }),
  range('cropRight', 0, 90, 0, { es: 'Recorte derecha', en: 'Crop right' }, { unit: '%' }),
  range('cropBottom', 0, 90, 0, { es: 'Recorte abajo', en: 'Crop bottom' }, { unit: '%' }),
  range('cropLeft', 0, 90, 0, { es: 'Recorte izquierda', en: 'Crop left' }, { unit: '%' }),
];

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Source rectangle left after cropping (never smaller than 1 px). */
export function cropRect(g, srcW, srcH) {
  const pct = (v) => Math.max(0, Math.min(90, Number(v) || 0)) / 100;
  let x0 = pct(g.cropLeft) * srcW;
  let x1 = srcW - pct(g.cropRight) * srcW;
  let y0 = pct(g.cropTop) * srcH;
  let y1 = srcH - pct(g.cropBottom) * srcH;
  if (x1 - x0 < 1) { const c = (x0 + x1) / 2; x0 = Math.max(0, c - 0.5); x1 = x0 + 1; }
  if (y1 - y0 < 1) { const c = (y0 + y1) / 2; y0 = Math.max(0, c - 0.5); y1 = y0 + 1; }
  return { sx: x0, sy: y0, sw: x1 - x0, sh: y1 - y0 };
}

/** Key of everything in the global params that changes preprocessed pixels. */
export function preprocessKey(g) {
  return [
    g.brightness, g.contrast, g.saturation, g.hue, g.grayscale, g.sepia, g.invert,
    g.thresholdOn ? g.threshold : -1, g.sharpness, g.edges, g.flipX ? 1 : 0,
    g.cropTop, g.cropRight, g.cropBottom, g.cropLeft,
  ].join('|');
}

// ---------------------------------------------------------------------------
// Colour filters
// ---------------------------------------------------------------------------

/** CSS `filter` string for the colour adjustments ('' when everything is neutral). */
export function colorFilterString(g) {
  const parts = [];
  if (g.brightness !== 100) parts.push(`brightness(${g.brightness}%)`);
  if (g.contrast !== 100) parts.push(`contrast(${g.contrast}%)`);
  if (g.saturation !== 100) parts.push(`saturate(${g.saturation}%)`);
  if (g.hue % 360 !== 0) parts.push(`hue-rotate(${g.hue}deg)`);
  if (g.grayscale > 0) parts.push(`grayscale(${g.grayscale}%)`);
  if (g.sepia > 0) parts.push(`sepia(${g.sepia}%)`);
  if (g.invert > 0) parts.push(`invert(${g.invert}%)`);
  return parts.join(' ');
}

let filterSupport = null;

/** Detect ctx.filter by drawing one black pixel through invert(100%) and reading it back. */
export function supportsCtxFilter() {
  if (filterSupport !== null) return filterSupport;
  try {
    const dst = document.createElement('canvas');
    dst.width = dst.height = 1;
    const g = dst.getContext('2d', { willReadFrequently: true });
    if (!('filter' in g)) return (filterSupport = false);
    const src = document.createElement('canvas');
    src.width = src.height = 1;
    const sg = src.getContext('2d');
    sg.fillStyle = '#000';
    sg.fillRect(0, 0, 1, 1);
    g.filter = 'invert(100%)';
    g.drawImage(src, 0, 0);
    g.filter = 'none';
    const px = g.getImageData(0, 0, 1, 1).data;
    filterSupport = px[0] > 250 && px[1] > 250 && px[2] > 250 && px[3] === 255;
  } catch {
    filterSupport = false;
  }
  return filterSupport;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * JS implementation of the CSS filter chain (Filter Effects matrices), in place on RGBA bytes.
 * Every step clamps to [0,1], as browsers do between filter functions.
 */
export function applyColorFiltersJS(data, g) {
  const b = g.brightness / 100;
  const c = g.contrast / 100;
  const s = g.saturation / 100;
  const hr = (g.hue * Math.PI) / 180;
  const cos = Math.cos(hr);
  const sin = Math.sin(hr);
  const gs = 1 - Math.min(1, g.grayscale / 100);
  const sp = 1 - Math.min(1, g.sepia / 100);
  const inv = Math.min(1, g.invert / 100);

  const doB = g.brightness !== 100;
  const doC = g.contrast !== 100;
  const doS = g.saturation !== 100;
  const doH = g.hue % 360 !== 0;
  const doG = g.grayscale > 0;
  const doP = g.sepia > 0;
  const doI = g.invert > 0;

  const n = data.length;
  for (let i = 0; i < n; i += 4) {
    let r = data[i] / 255;
    let gr = data[i + 1] / 255;
    let bl = data[i + 2] / 255;
    let nr;
    let ng;
    let nb;
    if (doB) { r = clamp01(r * b); gr = clamp01(gr * b); bl = clamp01(bl * b); }
    if (doC) { r = clamp01((r - 0.5) * c + 0.5); gr = clamp01((gr - 0.5) * c + 0.5); bl = clamp01((bl - 0.5) * c + 0.5); }
    if (doS) {
      nr = (0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * gr + (0.072 - 0.072 * s) * bl;
      ng = (0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * gr + (0.072 - 0.072 * s) * bl;
      nb = (0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * gr + (0.072 + 0.928 * s) * bl;
      r = clamp01(nr); gr = clamp01(ng); bl = clamp01(nb);
    }
    if (doH) {
      nr = (0.213 + cos * 0.787 - sin * 0.213) * r + (0.715 - cos * 0.715 - sin * 0.715) * gr + (0.072 - cos * 0.072 + sin * 0.928) * bl;
      ng = (0.213 - cos * 0.213 + sin * 0.143) * r + (0.715 + cos * 0.285 + sin * 0.14) * gr + (0.072 - cos * 0.072 - sin * 0.283) * bl;
      nb = (0.213 - cos * 0.213 - sin * 0.787) * r + (0.715 - cos * 0.715 + sin * 0.715) * gr + (0.072 + cos * 0.928 + sin * 0.072) * bl;
      r = clamp01(nr); gr = clamp01(ng); bl = clamp01(nb);
    }
    if (doG) {
      nr = (0.2126 + 0.7874 * gs) * r + (0.7152 - 0.7152 * gs) * gr + (0.0722 - 0.0722 * gs) * bl;
      ng = (0.2126 - 0.2126 * gs) * r + (0.7152 + 0.2848 * gs) * gr + (0.0722 - 0.0722 * gs) * bl;
      nb = (0.2126 - 0.2126 * gs) * r + (0.7152 - 0.7152 * gs) * gr + (0.0722 + 0.9278 * gs) * bl;
      r = clamp01(nr); gr = clamp01(ng); bl = clamp01(nb);
    }
    if (doP) {
      nr = (0.393 + 0.607 * sp) * r + (0.769 - 0.769 * sp) * gr + (0.189 - 0.189 * sp) * bl;
      ng = (0.349 - 0.349 * sp) * r + (0.686 + 0.314 * sp) * gr + (0.168 - 0.168 * sp) * bl;
      nb = (0.272 - 0.272 * sp) * r + (0.534 - 0.534 * sp) * gr + (0.131 + 0.869 * sp) * bl;
      r = clamp01(nr); gr = clamp01(ng); bl = clamp01(nb);
    }
    if (doI) {
      r = r * (1 - 2 * inv) + inv;
      gr = gr * (1 - 2 * inv) + inv;
      bl = bl * (1 - 2 * inv) + inv;
    }
    data[i] = r * 255; // Uint8ClampedArray rounds to nearest
    data[i + 1] = gr * 255;
    data[i + 2] = bl * 255;
  }
  return data;
}

// ---------------------------------------------------------------------------
// CPU passes
// ---------------------------------------------------------------------------

/** Unsharp mask with a 3x3 Gaussian blur; amount = sharpness / 4. */
export function sharpen(data, w, h, sharpness) {
  const amount = sharpness / 4;
  if (amount <= 0) return data;
  const src = new Uint8ClampedArray(data);
  for (let y = 0; y < h; y++) {
    const ym = (y > 0 ? y - 1 : 0) * w;
    const y0 = y * w;
    const yp = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < w - 1 ? x + 1 : w - 1;
      const o = (y0 + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const blur = (
          src[(ym + xm) * 4 + ch] + 2 * src[(ym + x) * 4 + ch] + src[(ym + xp) * 4 + ch] +
          2 * src[(y0 + xm) * 4 + ch] + 4 * src[o + ch] + 2 * src[(y0 + xp) * 4 + ch] +
          src[(yp + xm) * 4 + ch] + 2 * src[(yp + x) * 4 + ch] + src[(yp + xp) * 4 + ch]
        ) / 16;
        data[o + ch] = src[o + ch] + amount * (src[o + ch] - blur);
      }
    }
  }
  return data;
}

/** Blend the Sobel magnitude into the image: toward white ('light') or black ('dark'). */
export function blendEdges(data, w, h, strength, target) {
  if (strength <= 0) return data;
  const luma = lumaFromRGBA(data, w, h);
  const { mag } = sobelLuma(luma, w, h);
  const gain = strength * 0.5;
  const t = target === 'dark' ? 0 : 255;
  for (let i = 0; i < w * h; i++) {
    const k = Math.min(1, mag[i] * gain);
    if (k <= 0) continue;
    const o = i * 4;
    data[o] += (t - data[o]) * k;
    data[o + 1] += (t - data[o + 1]) * k;
    data[o + 2] += (t - data[o + 2]) * k;
  }
  return data;
}

/** luma >= threshold/255 -> white, else black. */
export function applyThreshold(data, threshold) {
  const t = threshold / 255;
  for (let i = 0; i < data.length; i += 4) {
    const l = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    const v = l >= t ? 255 : 0;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Drawing into the work surface
// ---------------------------------------------------------------------------

/**
 * Draw a source rectangle into the work context at dw x dh. Large reductions are done in halving steps
 * so every output pixel is a proper area average (bilinear sampling alone would alias).
 * `scratch` is an array of reusable canvases, one per halving step.
 */
export function drawScaled(ctx, src, sx, sy, sw, sh, dw, dh, scratch) {
  let cur = src;
  let cx = sx;
  let cy = sy;
  let cw = sw;
  let ch = sh;
  let level = 0;
  while (cw >= dw * 2 && ch >= dh * 2) {
    const nw = Math.max(dw, Math.ceil(cw / 2));
    const nh = Math.max(dh, Math.ceil(ch / 2));
    let t = scratch[level];
    if (!t) t = scratch[level] = document.createElement('canvas');
    if (t.width !== nw || t.height !== nh) { t.width = nw; t.height = nh; }
    const tg = t.getContext('2d');
    tg.imageSmoothingEnabled = true;
    tg.imageSmoothingQuality = 'high';
    tg.clearRect(0, 0, nw, nh);
    tg.drawImage(cur, cx, cy, cw, ch, 0, 0, nw, nh);
    cur = t;
    cx = 0;
    cy = 0;
    cw = nw;
    ch = nh;
    level++;
  }
  ctx.drawImage(cur, cx, cy, cw, ch, 0, 0, dw, dh);
  // halving steps this frame did not need (a smaller source or a larger work size): give their memory back
  for (let i = level; i < scratch.length; i++) if (scratch[i]) scratch[i].width = scratch[i].height = 0;
  scratch.length = level;
}

/**
 * Preprocess one frame into `ws` (a work surface `{ canvas, ctx, scratch }` already sized W x H).
 * @param {object} g global params (see IMAGE_PARAMS)
 * @param {{ matte?: string|null, edgeBlend?: 'light'|'dark', forceJS?: boolean }} [opts]
 * @returns {{ imageData: ImageData|null, usedFilterPath: 'ctx'|'js'|'none' }}
 */
export function preprocess(ws, frame, srcW, srcH, g, opts = {}) {
  const { matte = null, edgeBlend = 'light', forceJS = false } = opts;
  const { ctx, canvas } = ws;
  const W = canvas.width;
  const H = canvas.height;
  const crop = cropRect(g, srcW, srcH);
  const css = colorFilterString(g);
  const useCtx = css !== '' && !forceJS && supportsCtxFilter();

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, W, H);
  if (matte) {
    ctx.fillStyle = matte;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (g.flipX) {
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
  }
  if (useCtx) ctx.filter = css;
  drawScaled(ctx, frame, crop.sx, crop.sy, crop.sw, crop.sh, W, H, ws.scratch);
  ctx.filter = 'none';
  ctx.restore();

  const needJS = css !== '' && !useCtx;
  const needCPU = needJS || g.sharpness > 0 || g.edges > 0 || g.thresholdOn;
  if (!needCPU) return { imageData: null, usedFilterPath: css ? 'ctx' : 'none' };

  const id = ctx.getImageData(0, 0, W, H);
  if (needJS) applyColorFiltersJS(id.data, g);
  if (g.sharpness > 0) sharpen(id.data, W, H, g.sharpness);
  if (g.edges > 0) blendEdges(id.data, W, H, g.edges, edgeBlend);
  if (g.thresholdOn) applyThreshold(id.data, g.threshold);
  ctx.putImageData(id, 0, 0);
  return { imageData: id, usedFilterPath: needJS ? 'js' : css ? 'ctx' : 'none' };
}
