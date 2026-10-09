// Contour lines and generative topography (PLAN.md 7.15).
// The picture (luminance, or depth) is treated as a height map: Gaussian-like blur `smooth`, normalised to its range,
// then marching squares at `levels` evenly spaced heights, segments joined into polylines and smoothed with Chaikin.
// Every `indexEvery`-th line is an index contour: thicker, and labelled with its height (the line is broken where the
// label sits, like on a printed map, so labels also work on a pen plotter). Optional hypsometric bands (filled
// regions field >= level, from closed iso-lines, even-odd) and hillshade (Lambert lighting of the height map from
// the north-west, multiplied over the paper).

import { marchingSquares, chaikin, polylineLength, simplify } from '../engine/geometry.js';
import {
  logicalSize, workResolution, prepareOutput, blurField, drawScene, fieldHash, hashed, ensureFont,
} from '../engine/vector.js';
import { buildGradientLUT, hexToRgb, normalizeHex, rgbToHex } from '../engine/color.js';
import { sceneToSVG } from '../io/exportSVG.js';
import { config } from '../config.js';

const WORK_LONG = 480;
const LABEL_SIZE = 10;

export const BAND_PALETTES = {
  topo: { name: { es: 'Topográfica', en: 'Topographic' }, stops: ['#3d6b4f', '#7da35d', '#c9c27c', '#d9a86a', '#a8724c', '#ece6dc'] },
  horain: { name: { es: 'Horain', en: 'Horain' }, stops: ['#15181e', '#66696f', '#c4f169', '#edfad1', '#f7f8fa'] },
  ocean: { name: { es: 'Océano', en: 'Ocean' }, stops: ['#0b1d3a', '#1f4e79', '#3f88c5', '#9fd3e6', '#f1f8fb'] },
  magma: { name: { es: 'Magma', en: 'Magma' }, stops: ['#000004', '#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf'] },
  paper: { name: { es: 'Tinta y papel', en: 'Ink and paper' }, stops: null }, // from the ink to the paper colour
};

/** Map work-grid coordinates (0..W-1) onto the logical drawing (0..LW), so padded border lines sit on the edge. */
function toLogical(pl, kx, ky) {
  const p = pl.points;
  for (let i = 0; i < p.length; i += 2) { p[i] *= kx; p[i + 1] *= ky; }
  return pl;
}

/** Point and tangent angle at arc length `s` along a polyline. */
function pointAt(pts, s) {
  let acc = 0;
  const n = pts.length >> 1;
  for (let i = 1; i < n; i++) {
    const dx = pts[i * 2] - pts[i * 2 - 2];
    const dy = pts[i * 2 + 1] - pts[i * 2 - 1];
    const l = Math.hypot(dx, dy);
    if (acc + l >= s && l > 0) {
      const t = (s - acc) / l;
      return { x: pts[i * 2 - 2] + dx * t, y: pts[i * 2 - 1] + dy * t, a: Math.atan2(dy, dx) };
    }
    acc += l;
  }
  return { x: pts[(n - 1) * 2], y: pts[(n - 1) * 2 + 1], a: 0 };
}

/** Remove the arc-length intervals `gaps` ([s0, s1], sorted, disjoint) from a polyline; returns the pieces left. */
function cutGaps(pts, closed, gaps) {
  if (!gaps.length) return [{ points: pts, closed }];
  const src = closed ? Float32Array.from([...pts, pts[0], pts[1]]) : pts;
  const m = src.length >> 1;
  const inGap = (s) => gaps.some(([g0, g1]) => s > g0 && s < g1);
  const marks = gaps.flatMap(([g0, g1]) => [{ s: g0, enter: true }, { s: g1, enter: false }]).sort((a, b) => a.s - b.s);
  const pieces = [];
  let cur = inGap(0) ? null : [src[0], src[1]];
  let acc = 0;
  for (let i = 1; i < m; i++) {
    const ax = src[i * 2 - 2], ay = src[i * 2 - 1], bx = src[i * 2], by = src[i * 2 + 1];
    const l = Math.hypot(bx - ax, by - ay);
    for (const mk of marks) {
      if (mk.s <= acc || mk.s >= acc + l) continue;
      const t = (mk.s - acc) / l;
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      if (mk.enter) { if (cur) { cur.push(x, y); pieces.push(cur); cur = null; } } else cur = [x, y];
    }
    acc += l;
    if (cur && !inGap(acc)) cur.push(bx, by);
  }
  if (cur) pieces.push(cur);
  // on a closed line the last piece continues into the first one
  if (closed && pieces.length > 1 && !inGap(0)) {
    const last = pieces.pop();
    pieces[0] = [...last, ...pieces[0].slice(2)];
  }
  return pieces.filter((q) => q.length >= 4).map((q) => ({ points: Float32Array.from(q), closed: false }));
}

/** Hillshade (Lambert, light from azimuth 315 deg, altitude 45 deg) of a 0..1 height field, as a multiply layer. */
function hillshadeCanvas(f, W, H, strength, relief) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const img = new ImageData(W, H);
  const d = img.data;
  const az = (315 * Math.PI) / 180;
  const alt = (45 * Math.PI) / 180;
  const lx = Math.cos(alt) * Math.cos(az);
  const ly = Math.cos(alt) * Math.sin(az);
  const lz = Math.sin(alt);
  const z = relief * W * 0.08;
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - 1), y1 = Math.min(H - 1, y + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - 1), x1 = Math.min(W - 1, x + 1);
      const dzdx = ((f[y * W + x1] - f[y * W + x0]) * z) / (x1 - x0 || 1);
      const dzdy = ((f[y1 * W + x] - f[y0 * W + x]) * z) / (y1 - y0 || 1);
      // normal (-dzdx, -dzdy, 1); the light comes from the top-left of the picture (y grows downwards)
      const nl = Math.hypot(dzdx, dzdy, 1);
      let sh = (-dzdx * lx + dzdy * ly + lz) / nl;
      sh = sh < 0 ? 0 : sh;
      const v = 1 - strength * (1 - Math.min(1, sh / lz));
      const o = (y * W + x) * 4;
      d[o] = d[o + 1] = d[o + 2] = Math.round(255 * Math.max(0, Math.min(1, v)));
      d[o + 3] = 255;
    }
  }
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}

const MODE = {
  id: 'contours',
  category: 'vector',
  name: { es: 'Isolíneas / Topografía', en: 'Contour lines' },
  blurb: { es: 'Curvas de nivel con cotas, bandas hipsométricas y sombreado', en: 'Contour lines with labels, hypsometric bands and hillshade' },
  badges: ['SVG'],
  animated: false,
  uses: ['image'],
  exports: ['png', 'svg', 'video'],
  svgOptions: true,
  draftScale: 0.5,
  hide: ['cols', 'dither', 'serpentine'],

  presets: [
    { id: 'survey', name: { es: 'Mapa topográfico', en: 'Survey map' }, mode: { levels: 20, indexEvery: 5, labels: true, fillBands: false, hillshade: true, ink: '#7a4a22', paper: '#f4efe2' } },
    { id: 'relief', name: { es: 'Relieve en color', en: 'Colour relief' }, mode: { levels: 14, fillBands: true, bandPalette: 'topo', hillshade: true, hillshadeStrength: 0.5, ink: '#3b2a1a' } },
    { id: 'night', name: { es: 'Isolíneas nocturnas', en: 'Night lines' }, mode: { levels: 30, smooth: 6, labels: false, fillBands: false, hillshade: false, ink: '#c4f169', paper: '#15181e', strokeWidth: 0.7 } },
  ],

  params: [
    {
      id: 'fieldSource', type: 'select', default: 'luma',
      options: [
        { value: 'luma', label: { es: 'Luminancia', en: 'Luminance' } },
        { value: 'depth', label: { es: 'Profundidad', en: 'Depth' } },
      ],
      label: { es: 'Altura desde', en: 'Height from' },
      help: { es: 'Qué valor de la imagen se usa como altura. La profundidad usa el ajuste PROFUNDIDAD (por ahora, el brillo).', en: 'Which value of the picture is used as height. Depth uses the DEPTH setting (brightness for now).' },
    },
    { id: 'invert', type: 'toggle', default: false, label: { es: 'Invertir alturas', en: 'Invert heights' } },
    {
      id: 'smooth', type: 'range', min: 0, max: 20, step: 0.5, default: 4,
      label: { es: 'Suavizado', en: 'Smoothing' },
      help: { es: 'Desenfoque del campo antes de trazar: curvas más limpias.', en: 'Blur of the field before tracing: cleaner lines.' },
    },
    { id: 'levels', type: 'range', min: 2, max: 60, step: 1, default: 16, label: { es: 'Niveles', en: 'Levels' } },
    {
      id: 'smoothIter', type: 'range', min: 0, max: 4, step: 1, default: 2,
      label: { es: 'Suavizado de curvas', en: 'Curve smoothing' },
      help: { es: 'Iteraciones de Chaikin sobre cada curva.', en: 'Chaikin iterations on every line.' },
    },
    { id: 'indexEvery', type: 'range', min: 2, max: 10, step: 1, default: 5, label: { es: 'Curva maestra cada', en: 'Index line every' } },
    {
      id: 'minLength', type: 'range', min: 0, max: 200, step: 1, default: 20, unit: 'px',
      label: { es: 'Longitud mínima', en: 'Minimum length' },
      help: { es: 'Descarta curvas cortas (ruido).', en: 'Drops short lines (noise).' },
    },
    { id: 'strokeWidth', type: 'range', min: 0.2, max: 3, step: 0.05, default: 0.8, unit: 'px', label: { es: 'Grosor', en: 'Stroke width' } },
    { id: 'labels', type: 'toggle', default: true, label: { es: 'Cotas', en: 'Labels' } },
    {
      id: 'labelStep', type: 'range', min: 1, max: 100, step: 1, default: 10,
      label: { es: 'Equidistancia', en: 'Contour interval' },
      help: { es: 'Valor entre dos curvas consecutivas, para los números de cota.', en: 'Height between two consecutive lines, for the labels.' },
      showIf: (p) => p.labels,
    },
    { id: 'fillBands', type: 'toggle', default: false, label: { es: 'Bandas hipsométricas', en: 'Hypsometric bands' } },
    {
      id: 'bandPalette', type: 'select', default: 'topo',
      options: Object.entries(BAND_PALETTES).map(([value, v]) => ({ value, label: v.name })),
      label: { es: 'Paleta de bandas', en: 'Band palette' },
      showIf: (p) => p.fillBands,
    },
    { id: 'hillshade', type: 'toggle', default: true, label: { es: 'Sombreado de relieve', en: 'Hillshade' } },
    {
      id: 'hillshadeStrength', type: 'range', min: 0, max: 1, step: 0.05, default: 0.45,
      label: { es: 'Intensidad del sombreado', en: 'Hillshade strength' },
      showIf: (p) => p.hillshade,
    },
    { id: 'ink', type: 'color', default: '#7a4a22', label: { es: 'Tinta', en: 'Ink' } },
    { id: 'paper', type: 'color', default: '#f4efe2', label: { es: 'Papel', en: 'Paper' } },
  ],

  resolution(params, srcW, srcH) {
    return workResolution(srcW, srcH, WORK_LONG);
  },

  preOptions(params) {
    return { matte: params.mode.paper, edgeBlend: 'dark' };
  },

  init() {
    return { scene: null, key: '' };
  },

  async render(ctx, state) {
    const p = ctx.params.mode;
    const { LW, LH } = logicalSize(ctx);
    const W = ctx.width;
    const H = ctx.height;
    const ink = normalizeHex(p.ink) || '#7a4a22';
    const paper = normalizeHex(p.paper) || '#f4efe2';
    const raw = p.fieldSource === 'depth' ? await ctx.depth() : ctx.luma();
    const fontReady = !p.labels || ensureFont(`500 ${LABEL_SIZE}px "Geist Mono"`, ctx.invalidate);
    const key = hashed([fieldHash(raw), W, H, LW, LH, p, fontReady]);
    if (key !== state.key || !state.scene) {
      state.scene = buildScene(p, raw, W, H, LW, LH, ink, paper);
      state.key = key;
    }
    const { g, s } = prepareOutput(ctx, LW, LH);
    drawScene(g, state.scene, s);
    return { cols: LW, rows: LH, effectiveScale: s };
  },

  toSVG(state, opts = {}) {
    return state?.scene ? sceneToSVG(state.scene, opts) : '';
  },

  dispose(state) {
    if (state) { state.scene = null; state.key = ''; }
  },
};

function buildScene(p, raw, W, H, LW, LH, ink, paper) {
  // height field: blurred, normalised to 0..1
  const f = blurField(raw, W, H, p.smooth);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < f.length; i++) { if (f[i] < lo) lo = f[i]; if (f[i] > hi) hi = f[i]; }
  const span = hi - lo > 1e-6 ? hi - lo : 1;
  for (let i = 0; i < f.length; i++) { const v = (f[i] - lo) / span; f[i] = p.invert ? 1 - v : v; }
  const kx = LW / (W - 1);
  const ky = LH / (H - 1);
  const levels = Math.max(2, Math.round(p.levels));
  const iter = Math.max(0, Math.min(4, Math.round(p.smoothIter)));
  const layers = [];

  // hypsometric bands: region field >= k/levels, painted from low to high
  if (p.fillBands) {
    const pal = BAND_PALETTES[p.bandPalette] || BAND_PALETTES.topo;
    const stops = (pal.stops || [rgbToHex(...(hexToRgb(ink) || [0, 0, 0]).map((v, i) => (v + 2 * (hexToRgb(paper) || [255, 255, 255])[i]) / 3)), paper]).map(hexToRgb);
    const lut = buildGradientLUT(stops, 256);
    const colorAt = (t) => { const i = Math.round(Math.max(0, Math.min(1, t)) * 255) * 3; return rgbToHex(lut[i], lut[i + 1], lut[i + 2]); };
    const shapes = [{ rings: [new Float32Array([0, 0, LW, 0, LW, LH, 0, LH])], fill: colorAt(0.5 / levels) }];
    for (let k = 1; k < levels; k++) {
      const rings = marchingSquares(f, W, H, k / levels, { closed: true })
        .map((pl) => simplify(chaikin(toLogical(pl, kx, ky).points, true, iter), 0.12));
      if (rings.length) shapes.push({ rings, fill: colorAt((k + 0.5) / levels) });
    }
    layers.push({ id: 'bands', label: 'Hypsometric bands', color: paper, shapes, plotter: 'skip' });
  }
  if (p.hillshade && p.hillshadeStrength > 0) {
    layers.push({
      id: 'hillshade', label: 'Hillshade', color: '#000000', blend: 'multiply', plotter: 'skip',
      image: { canvas: hillshadeCanvas(f, W, H, p.hillshadeStrength, 1), x: 0, y: 0, width: LW, height: LH },
    });
  }

  const minor = [];
  const index = [];
  const texts = [];
  const labelW = (txt) => txt.length * LABEL_SIZE * 0.62;
  for (let k = 1; k < levels; k++) {
    const isIndex = k % p.indexEvery === 0;
    for (const pl of marchingSquares(f, W, H, k / levels)) {
      toLogical(pl, kx, ky);
      const pts = simplify(iter ? chaikin(pl.points, pl.closed, iter) : pl.points, 0.08);
      const len = polylineLength(pts, pl.closed);
      if (len < p.minLength) continue;
      if (!isIndex) { minor.push({ points: pts, closed: pl.closed }); continue; }
      const gaps = [];
      if (p.labels) {
        const text = String(Math.round(k * p.labelStep));
        const lw = labelW(text);
        const count = len > lw * 5 ? Math.max(1, Math.min(6, Math.floor(len / 320))) : 0;
        for (let j = 0; j < count; j++) {
          const sPos = ((j + 0.5) * len) / count;
          const pt = pointAt(pl.closed ? Float32Array.from([...pts, pts[0], pts[1]]) : pts, sPos);
          // keep the text upright and centred on the line
          let a = pt.a;
          if (a > Math.PI / 2) a -= Math.PI; else if (a < -Math.PI / 2) a += Math.PI;
          const off = LABEL_SIZE * 0.35;
          const x = pt.x - Math.sin(a) * off;
          const y = pt.y + Math.cos(a) * off;
          if (x < lw / 2 || y < LABEL_SIZE || x > LW - lw / 2 || y > LH - 2) continue;
          if (texts.some((o) => Math.hypot(o.x - x, o.y - y) < 48)) continue; // keep labels apart where lines bunch
          texts.push({ x, y, text, size: LABEL_SIZE, anchor: 'middle', angle: (a * 180) / Math.PI, weight: 500 });
          gaps.push([sPos - lw / 2 - 3, sPos + lw / 2 + 3]);
        }
      }
      gaps.sort((a, b) => a[0] - b[0]);
      for (const piece of cutGaps(pts, pl.closed, gaps)) index.push(piece);
    }
  }
  const lineOpacity = p.fillBands ? 0.85 : 1;
  layers.push({ id: 'contours', label: 'Contours', color: ink, width: p.strokeWidth, opacity: lineOpacity, paths: minor });
  layers.push({ id: 'index', label: 'Index contours', color: ink, width: p.strokeWidth * 2.2, opacity: lineOpacity, paths: index });
  if (texts.length) layers.push({ id: 'labels', label: 'Labels', color: ink, texts });
  return {
    width: LW, height: LH, background: paper, layers,
    title: `${config.productName} contours`, desc: `${levels} levels, index every ${p.indexEvery}`,
  };
}

export default MODE;
