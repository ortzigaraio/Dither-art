// Shared plumbing of the VECTOR modes (PLAN.md 7.14-7.20): logical drawing size, field sampling, the Canvas2D
// renderer of a scene (the same data io/exportSVG.js serialises) and a few helpers.
//
// Every vector mode draws on a logical canvas whose longest side is LOGICAL_LONG px, whatever the source size, so
// parameters in px (spacing, stroke width...) mean the same on any picture, and preview, PNG and SVG share geometry.
// The work buffer (ctx.width x ctx.height, the analysed picture) is only sampled; a draft render (half size while a
// slider is dragged) samples a coarser field but keeps the logical size.

import { cropRect } from './preprocess.js';
import { boxBlur } from './analysis.js';
import { hexToRgb } from './color.js';
import { LIMITS } from '../config.js';
import { ribbonOutline } from '../io/exportSVG.js';

export const LOGICAL_LONG = 1000;
const PREVIEW_CAP = 4096;

/** Logical drawing size for the cropped source. */
export function logicalSize(ctx) {
  const crop = cropRect(ctx.params.global, ctx.srcWidth, ctx.srcHeight);
  const k = LOGICAL_LONG / Math.max(1, crop.sw, crop.sh);
  return { LW: Math.max(1, Math.round(crop.sw * k)), LH: Math.max(1, Math.round(crop.sh * k)) };
}

/** Work resolution whose longest side is `long` (the picture keeps its aspect). */
export function workResolution(srcW, srcH, long) {
  const k = long / Math.max(1, srcW, srcH);
  return { width: Math.max(2, Math.round(srcW * k)), height: Math.max(2, Math.round(srcH * k)) };
}

/** Size the output canvas for a LW x LH logical drawing and return the context with its px-per-logical scale. */
export function prepareOutput(ctx, LW, LH) {
  const cap = ctx.isExport ? LIMITS.maxExportImageSide : PREVIEW_CAP;
  const s = Math.max(0.05, Math.min(ctx.outScale || 1, cap / LW, cap / LH));
  const CW = Math.max(1, Math.round(LW * s));
  const CH = Math.max(1, Math.round(LH * s));
  const canvas = ctx.out.canvas;
  if (canvas.width !== CW || canvas.height !== CH) { canvas.width = CW; canvas.height = CH; }
  const g = ctx.out.ctx2d;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  g.filter = 'none';
  return { g, s, CW, CH };
}

/** Bilinear sampler of a W x H field in logical coordinates (LW x LH). */
export function fieldSampler(field, W, H, LW, LH) {
  const kx = W / LW;
  const ky = H / LH;
  return (x, y) => {
    let fx = x * kx - 0.5;
    let fy = y * ky - 0.5;
    fx = fx < 0 ? 0 : fx > W - 1 ? W - 1 : fx;
    fy = fy < 0 ? 0 : fy > H - 1 ? H - 1 : fy;
    const x0 = fx | 0;
    const y0 = fy | 0;
    const x1 = x0 + 1 < W ? x0 + 1 : x0;
    const y1 = y0 + 1 < H ? y0 + 1 : y0;
    const tx = fx - x0;
    const ty = fy - y0;
    const a = field[y0 * W + x0] + (field[y0 * W + x1] - field[y0 * W + x0]) * tx;
    const b = field[y1 * W + x0] + (field[y1 * W + x1] - field[y1 * W + x0]) * tx;
    return a + (b - a) * ty;
  };
}

/** Approximate Gaussian blur (three box passes) of a 0..1 field; radius in work px. */
export function blurField(field, W, H, radius) {
  if (radius <= 0) return Float32Array.from(field);
  const r = Math.max(1, Math.round(radius / 1.7));
  return boxBlur(boxBlur(boxBlur(field, W, H, r), W, H, r), W, H, r);
}

/** Relative luminance of a hex colour (0..1). */
export function hexLuma(hex) {
  const c = hexToRgb(hex) || [0, 0, 0];
  return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
}

/**
 * "Tone" field for drawing modes: how much ink a place wants, 0..1. Dark ink on light paper puts ink in the
 * shadows (1 - luma); light ink on dark paper puts it in the lights (luma). `gamma` shapes the response.
 */
export function toneField(luma, inkHex, paperHex, gamma = 1, invert = false) {
  const darkInk = hexLuma(inkHex) <= hexLuma(paperHex);
  const flip = darkInk !== invert;
  const out = new Float32Array(luma.length);
  for (let i = 0; i < luma.length; i++) {
    const v = flip ? 1 - luma[i] : luma[i];
    out[i] = gamma === 1 ? v : Math.pow(v < 0 ? 0 : v, gamma);
  }
  return out;
}

/** Load a font face once and re-render when it arrives (vector modes draw labels with Geist Mono). */
const fontState = new Map();
export function ensureFont(css, invalidate) {
  if (typeof document === 'undefined' || !document.fonts) return true;
  try {
    if (document.fonts.check(css)) return true;
  } catch { return true; }
  if (!fontState.has(css)) {
    fontState.set(css, document.fonts.load(css).then(() => invalidate?.()).catch(() => {}));
  } else {
    fontState.get(css).then(() => invalidate?.());
  }
  return false;
}

export const MONO = '"Geist Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace';

// ---------------------------------------------------------------------------
// Canvas renderer of a scene
// ---------------------------------------------------------------------------

function tracePolyline(path, pts, closed) {
  const n = pts.length >> 1;
  if (!n) return;
  path.moveTo(pts[0], pts[1]);
  for (let i = 1; i < n; i++) path.lineTo(pts[i * 2], pts[i * 2 + 1]);
  if (closed) path.closePath();
}

/**
 * Draw a scene (see io/exportSVG.js) at `s` output px per logical px.
 * @param {object} [o]
 * @param {number} [o.widthMul=1]   multiply every stroke width (glow passes)
 * @param {number} [o.alpha=1]
 * @param {boolean} [o.background=true]
 * @param {string} [o.only]        draw only this layer id
 */
export function drawScene(g, scene, s, o = {}) {
  const widthMul = o.widthMul ?? 1;
  const alpha = o.alpha ?? 1;
  g.save();
  g.setTransform(s, 0, 0, s, 0, 0);
  if (o.background !== false && scene.background) {
    g.globalAlpha = 1;
    g.fillStyle = scene.background;
    g.fillRect(0, 0, scene.width, scene.height);
  }
  g.lineJoin = 'round';
  g.lineCap = 'round';
  for (const L of scene.layers) {
    if (o.only && L.id !== o.only) continue;
    if (o.skip && o.skip.includes(L.id)) continue;
    g.globalAlpha = alpha * (L.opacity ?? 1);
    g.globalCompositeOperation = o.composite || (L.blend === 'multiply' ? 'multiply' : L.blend === 'screen' ? 'screen' : 'source-over');
    g.setLineDash(L.dash ? L.dash : []);
    if (L.image?.canvas) {
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(L.image.canvas, L.image.x, L.image.y, L.image.width, L.image.height);
    }
    if (L.shapes?.length) {
      for (const sh of L.shapes) {
        const p = new Path2D();
        for (const r of sh.rings) tracePolyline(p, r, true);
        g.fillStyle = sh.fill || L.color;
        g.fill(p, 'evenodd');
      }
    }
    if (L.ribbons?.length) {
      const p = new Path2D();
      for (const r of L.ribbons) tracePolyline(p, ribbonOutline(r.points, r.widths), true);
      g.fillStyle = L.color;
      g.fill(p, 'nonzero');
    }
    if (L.paths?.length) {
      // batch consecutive paths of the same style into one Path2D
      let p = null;
      let key = '';
      let style = null;
      const flush = () => {
        if (!p) return;
        g.strokeStyle = style.color;
        g.lineWidth = style.width * widthMul;
        g.globalAlpha = alpha * (L.opacity ?? 1) * style.opacity;
        g.stroke(p);
        p = null;
      };
      for (const path of L.paths) {
        const color = path.color || L.color;
        const width = path.width ?? L.width ?? 1;
        const op = path.opacity ?? 1;
        const k = `${color}|${width}|${op}`;
        if (k !== key) { flush(); key = k; style = { color, width, opacity: op }; p = new Path2D(); }
        tracePolyline(p, path.points, !!path.closed);
      }
      flush();
      g.globalAlpha = alpha * (L.opacity ?? 1);
    }
    if (L.dots?.count) {
      const D = L.dots;
      const byColor = new Map();
      for (let i = 0; i < D.count; i++) {
        const c = D.colors ? D.colors[i] : L.color;
        let p = byColor.get(c);
        if (!p) byColor.set(c, (p = new Path2D()));
        p.moveTo(D.x[i] + D.r[i], D.y[i]);
        p.arc(D.x[i], D.y[i], D.r[i], 0, Math.PI * 2);
      }
      for (const [c, p] of byColor) { g.fillStyle = c; g.fill(p); }
    }
    if (L.texts?.length) {
      g.setLineDash([]);
      for (const tx of L.texts) {
        g.save();
        g.translate(tx.x, tx.y);
        if (tx.angle) g.rotate((tx.angle * Math.PI) / 180);
        g.font = `${tx.weight || 400} ${tx.size || 10}px ${tx.font || MONO}`;
        g.textAlign = tx.anchor === 'middle' ? 'center' : tx.anchor === 'end' ? 'right' : 'left';
        g.textBaseline = 'alphabetic';
        g.fillStyle = tx.color || L.color;
        g.fillText(tx.text, 0, 0);
        g.restore();
      }
    }
  }
  g.restore();
}

/** A tiny hash of a field (sampled), to notice when the analysed picture changed. */
export function fieldHash(field, stride = 7) {
  let h = 2166136261;
  for (let i = 0; i < field.length; i += stride) h = Math.imul(h ^ Math.round(field[i] * 4096), 16777619);
  return (h >>> 0).toString(36) + field.length;
}

/** Cache key of a list of plain values (numbers, strings, flat parameter objects). */
export const hashed = (values) => JSON.stringify(values);
