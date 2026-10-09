// Schematic brutalism / blueprint CAD (PLAN.md 7.18).
// Edges: Sobel on the smoothed picture, threshold, Zhang-Suen thinning, then the one-pixel skeleton is traced into
// polylines (simplified with Ramer-Douglas-Peucker, smoothed with Chaikin). 45 deg hatching in the dark areas
// (cross-hatched in the darkest), automatic dimension lines with arrows and sizes in mm over the bounding boxes of the
// largest edge figures, centre marks with dash-dot centre lines, a drawing frame with zone letters and an editable
// title block (title, scale, date, sheet, drawn by: every value is escaped in the SVG, never parsed as markup).
// Variants: Blueprint (white on #0F3B73), Brutalist (black on paper with a red accent), CAD screen (AutoCAD-like
// coloured layers on black). Every part is its own layer in the SVG.

import { simplify, chaikin, clipPolylineByField, hatchLines, sampleSegment, polylineLength } from '../engine/geometry.js';
import {
  logicalSize, workResolution, prepareOutput, fieldSampler, blurField, drawScene, fieldHash, hashed, ensureFont,
} from '../engine/vector.js';
import { sobelLuma } from '../engine/analysis.js';
import { getLang } from '../i18n/i18n.js';
import { sceneToSVG } from '../io/exportSVG.js';
import { config } from '../config.js';

const WORK_LONG = 520;
const INSET = 14; // frame inset, logical px
const PX_TO_MM = 25.4 / 96;

export const VARIANTS = {
  blueprint: {
    bg: '#0f3b73', grid: ['#ffffff', 0.07], major: ['#ffffff', 0.15], edges: '#ffffff', hatch: ['#ffffff', 0.5],
    dims: '#bfe3ff', center: '#bfe3ff', frame: '#ffffff', text: '#ffffff', accent: '#bfe3ff',
  },
  brutalist: {
    bg: '#d9d6cf', grid: ['#111111', 0.06], major: ['#111111', 0.13], edges: '#111111', hatch: ['#111111', 0.72],
    dims: '#d7261e', center: '#d7261e', frame: '#111111', text: '#111111', accent: '#d7261e',
  },
  cad: {
    bg: '#0a0a0a', grid: ['#2c2c2c', 1], major: ['#444444', 1], edges: '#00e5ff', hatch: ['#2bd13b', 0.85],
    dims: '#ffe600', center: '#ff3b3b', frame: '#d0d0d0', text: '#ffffff', accent: '#ffe600',
  },
};

const CAPTIONS = {
  es: { title: 'TÍTULO', scale: 'ESCALA', date: 'FECHA', sheet: 'HOJA', drawn: 'DIBUJÓ' },
  en: { title: 'TITLE', scale: 'SCALE', date: 'DATE', sheet: 'SHEET', drawn: 'DRAWN BY' },
};

/** Zhang-Suen thinning of a binary image (1 = on), in place. */
export function thin(img, W, H) {
  const del = [];
  let changed = true;
  for (let pass = 0; changed && pass < 60; pass++) {
    changed = false;
    for (let sub = 0; sub < 2; sub++) {
      del.length = 0;
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const i = y * W + x;
          if (!img[i]) continue;
          const p2 = img[i - W], p3 = img[i - W + 1], p4 = img[i + 1], p5 = img[i + W + 1];
          const p6 = img[i + W], p7 = img[i + W - 1], p8 = img[i - 1], p9 = img[i - W - 1];
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const a = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
          if (a !== 1) continue;
          if (sub === 0 ? (p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0) : (p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0)) del.push(i);
        }
      }
      if (del.length) { changed = true; for (const i of del) img[i] = 0; }
    }
  }
  return img;
}

const NB = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];

/** Trace a one-pixel skeleton into pixel chains (endpoints first, then the remaining loops). */
export function traceSkeleton(sk, W, H) {
  const seen = new Uint8Array(W * H);
  const deg = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (!sk[y * W + x]) continue;
      let d = 0;
      for (const [dx, dy] of NB) d += sk[(y + dy) * W + x + dx];
      deg[y * W + x] = d;
    }
  }
  const chains = [];
  const walk = (x, y) => {
    const pts = [x, y];
    seen[y * W + x] = 1;
    for (;;) {
      let nx = -1, ny = -1;
      for (const [dx, dy] of NB) {
        const j = (y + dy) * W + x + dx;
        if (sk[j] && !seen[j]) { nx = x + dx; ny = y + dy; break; }
      }
      if (nx < 0) break;
      x = nx; y = ny;
      seen[y * W + x] = 1;
      pts.push(x, y);
    }
    return pts;
  };
  for (const wantEnd of [true, false]) {
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (!sk[i] || seen[i] || (wantEnd && deg[i] !== 1)) continue;
        const pts = walk(x, y);
        if (pts.length >= 4) chains.push(pts);
      }
    }
  }
  return chains;
}

const bboxOf = (pts) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < x0) x0 = pts[i]; if (pts[i] > x1) x1 = pts[i];
    if (pts[i + 1] < y0) y0 = pts[i + 1]; if (pts[i + 1] > y1) y1 = pts[i + 1];
  }
  return { x0, y0, x1, y1 };
};

const fit = (text, maxChars) => (text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 1))}…` : text);

const MODE = {
  id: 'blueprint',
  category: 'vector',
  name: { es: 'Blueprint CAD', en: 'Blueprint CAD' },
  blurb: { es: 'Plano técnico: bordes vectorizados, sombreado, cotas y cajetín', en: 'Technical drawing: vector edges, hatching, dimensions and title block' },
  badges: ['SVG'],
  animated: false,
  uses: ['image'],
  exports: ['png', 'svg', 'video'],
  svgOptions: true,
  draftScale: 0.5,
  hide: ['cols', 'dither', 'serpentine'],

  presets: [
    { id: 'blueprint', name: { es: 'Plano azul', en: 'Blueprint' }, mode: { variant: 'blueprint', hatch: true, dimensions: true, gridSize: 16 } },
    { id: 'brutalist', name: { es: 'Brutalista', en: 'Brutalist' }, mode: { variant: 'brutalist', hatchSpacing: 5, hatchThreshold: 0.5, lineWeight: 1.4 } },
    { id: 'cad', name: { es: 'Pantalla CAD', en: 'CAD screen' }, mode: { variant: 'cad', gridSize: 20, hatchSpacing: 7, lineWeight: 0.9 } },
  ],

  params: [
    {
      id: 'variant', type: 'select', default: 'blueprint',
      options: [
        { value: 'blueprint', label: { es: 'Blueprint', en: 'Blueprint' } },
        { value: 'brutalist', label: { es: 'Brutalista', en: 'Brutalist' } },
        { value: 'cad', label: { es: 'Pantalla CAD', en: 'CAD screen' } },
      ],
      label: { es: 'Variante', en: 'Variant' },
    },
    {
      id: 'edgeThreshold', type: 'range', min: 0.03, max: 0.9, step: 0.01, default: 0.14,
      label: { es: 'Umbral de bordes', en: 'Edge threshold' },
      help: { es: 'Fuerza mínima del borde (Sobel) para trazarlo.', en: 'Minimum edge strength (Sobel) to draw it.' },
    },
    { id: 'smooth', type: 'range', min: 0, max: 4, step: 0.1, default: 1.2, label: { es: 'Suavizado', en: 'Smoothing' } },
    { id: 'minEdge', type: 'range', min: 2, max: 60, step: 1, default: 10, unit: 'px', label: { es: 'Borde mínimo', en: 'Minimum edge' } },
    { id: 'gridSize', type: 'range', min: 4, max: 64, step: 1, default: 16, unit: 'px', label: { es: 'Cuadrícula', en: 'Grid size' } },
    { id: 'hatch', type: 'toggle', default: true, label: { es: 'Sombreado a 45°', en: '45° hatching' } },
    {
      id: 'hatchSpacing', type: 'range', min: 3, max: 20, step: 0.5, default: 6, unit: 'px',
      label: { es: 'Densidad del sombreado', en: 'Hatch spacing' },
      showIf: (p) => p.hatch,
    },
    {
      id: 'hatchThreshold', type: 'range', min: 0.1, max: 0.9, step: 0.01, default: 0.45,
      label: { es: 'Umbral del sombreado', en: 'Hatch threshold' },
      showIf: (p) => p.hatch,
    },
    { id: 'dimensions', type: 'toggle', default: true, label: { es: 'Cotas', en: 'Dimensions' } },
    {
      id: 'dimCount', type: 'range', min: 1, max: 6, step: 1, default: 4,
      label: { es: 'Número de cotas', en: 'Dimension count' },
      showIf: (p) => p.dimensions,
    },
    { id: 'centerMarks', type: 'toggle', default: true, label: { es: 'Marcas de centro', en: 'Centre marks' } },
    { id: 'titleBlock', type: 'toggle', default: true, label: { es: 'Cajetín', en: 'Title block' } },
    { id: 'title', type: 'text', default: 'DITHER', maxLength: 60, label: { es: 'Título', en: 'Title' }, showIf: (p) => p.titleBlock },
    { id: 'scaleText', type: 'text', default: '1:1', maxLength: 20, label: { es: 'Escala', en: 'Scale' }, showIf: (p) => p.titleBlock },
    {
      id: 'date', type: 'text', default: '', maxLength: 24,
      label: { es: 'Fecha', en: 'Date' },
      help: { es: 'Vacío = la fecha de hoy.', en: 'Empty = today’s date.' },
      showIf: (p) => p.titleBlock,
    },
    { id: 'sheet', type: 'text', default: '1/1', maxLength: 12, label: { es: 'Hoja', en: 'Sheet' }, showIf: (p) => p.titleBlock },
    { id: 'drawnBy', type: 'text', default: 'HORAIN', maxLength: 40, label: { es: 'Dibujó', en: 'Drawn by' }, showIf: (p) => p.titleBlock },
    { id: 'lineWeight', type: 'range', min: 0.3, max: 3, step: 0.05, default: 1, label: { es: 'Grosor de línea', en: 'Line weight' } },
  ],

  resolution(params, srcW, srcH) {
    return workResolution(srcW, srcH, WORK_LONG);
  },

  preOptions(params) {
    return { matte: (VARIANTS[params.mode.variant] || VARIANTS.blueprint).bg, edgeBlend: 'dark' };
  },

  init() {
    return { scene: null, key: '' };
  },

  render(ctx, state) {
    const p = ctx.params.mode;
    const { LW, LH } = logicalSize(ctx);
    const W = ctx.width;
    const H = ctx.height;
    const luma = ctx.luma();
    const lang = getLang() === 'es' ? 'es' : 'en';
    const fontReady = ensureFont('500 10px "Geist Mono"', ctx.invalidate);
    const today = new Date();
    const dateText = p.date || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const key = hashed([fieldHash(luma), W, H, LW, LH, p, lang, fontReady, dateText]);
    if (key !== state.key || !state.scene) {
      state.scene = buildScene(p, luma, W, H, LW, LH, lang, dateText);
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

function buildScene(p, luma, W, H, LW, LH, lang, dateText) {
  const V = VARIANTS[p.variant] || VARIANTS.blueprint;
  const lw = p.lineWeight;
  const kx = LW / W;
  const ky = LH / H;
  const layers = [];
  const fx0 = INSET, fy0 = INSET, fx1 = LW - INSET, fy1 = LH - INSET;

  // ---- title block rectangle (everything else keeps clear of it) ----
  let block = null;
  if (p.titleBlock) {
    const bw = Math.min(LW * 0.46, 340);
    const bh = 66;
    block = { x0: fx1 - bw, y0: fy1 - bh, x1: fx1, y1: fy1 };
  }
  const free = (x, y) => x > fx0 + 1 && x < fx1 - 1 && y > fy0 + 1 && y < fy1 - 1
    && !(block && x > block.x0 - 4 && y > block.y0 - 4);

  // ---- grid ----
  const gs = Math.max(4, p.gridSize);
  const minor = [];
  const major = [];
  for (let x = 0, i = 0; x <= LW; x += gs, i++) (i % 5 === 0 ? major : minor).push({ points: new Float32Array([x, 0, x, LH]) });
  for (let y = 0, i = 0; y <= LH; y += gs, i++) (i % 5 === 0 ? major : minor).push({ points: new Float32Array([0, y, LW, y]) });
  layers.push({ id: 'grid', label: 'Grid', color: V.grid[0], opacity: V.grid[1], width: 0.5, paths: minor, plotter: 'skip' });
  layers.push({ id: 'grid-major', label: 'Grid (major)', color: V.major[0], opacity: V.major[1], width: 0.8, paths: major, plotter: 'skip' });

  // ---- hatching in the dark areas ----
  const sm = blurField(luma, W, H, Math.max(0.5, p.smooth * 2));
  const D = fieldSampler(sm, W, H, LW, LH);
  if (p.hatch) {
    const paths = [];
    const t1 = 1 - p.hatchThreshold;
    const t2 = t1 * 0.55;
    for (const [angle, limit] of [[Math.PI / 4, t1], [-Math.PI / 4, t2]]) {
      for (const [x0, y0, x1, y1] of hatchLines(LW, LH, angle, p.hatchSpacing, 0)) {
        for (const run of clipPolylineByField(sampleSegment(x0, y0, x1, y1, 1.5), (x, y) => free(x, y) && D(x, y) < limit, { minLength: 3, refine: 4 })) {
          paths.push({ points: simplify(run, 0.05) });
        }
      }
    }
    layers.push({ id: 'hatch', label: 'Hatch', color: V.hatch[0], opacity: V.hatch[1], width: 0.6 * lw, paths });
  }

  // ---- edges: Sobel, threshold, thinning, skeleton tracing ----
  const { mag } = sobelLuma(blurField(luma, W, H, p.smooth), W, H);
  let max = 1e-6;
  for (let i = 0; i < mag.length; i++) if (mag[i] > max) max = mag[i];
  const bin = new Uint8Array(W * H);
  const thr = p.edgeThreshold * max;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (mag[y * W + x] >= thr) bin[y * W + x] = 1;
  thin(bin, W, H);
  const edgePaths = [];
  const figures = [];
  for (const chain of traceSkeleton(bin, W, H)) {
    const pts = new Float32Array(chain.length);
    for (let i = 0; i < chain.length; i += 2) { pts[i] = (chain[i] + 0.5) * kx; pts[i + 1] = (chain[i + 1] + 0.5) * ky; }
    const smooth = chaikin(simplify(pts, 0.9 * kx), false, 1);
    if (polylineLength(smooth) < p.minEdge) continue;
    for (const run of clipPolylineByField(smooth, free, { refine: 4 })) {
      edgePaths.push({ points: run });
      figures.push({ ...bboxOf(run), len: polylineLength(run) });
    }
  }
  layers.push({ id: 'edges', label: 'Edges', color: V.edges, width: 1.2 * lw, paths: edgePaths });

  // ---- dimensions and centre marks on the largest figures ----
  const chosen = [];
  if (p.dimensions || p.centerMarks) {
    figures.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
    for (const f of figures) {
      if (chosen.length >= Math.round(p.dimCount)) break;
      if (f.x1 - f.x0 < 40 || f.y1 - f.y0 < 30) continue;
      const overlaps = chosen.some((c) => {
        const ix = Math.max(0, Math.min(c.x1, f.x1) - Math.max(c.x0, f.x0));
        const iy = Math.max(0, Math.min(c.y1, f.y1) - Math.max(c.y0, f.y0));
        return ix * iy > 0.35 * Math.min((c.x1 - c.x0) * (c.y1 - c.y0), (f.x1 - f.x0) * (f.y1 - f.y0));
      });
      if (!overlaps) chosen.push(f);
    }
  }
  if (p.dimensions && chosen.length) {
    const paths = [];
    const texts = [];
    const arrow = (x, y, dx, dy) => {
      // open arrowhead (two strokes) pointing along (dx, dy): plotter friendly
      const a = Math.atan2(dy, dx);
      const L = 7;
      for (const s of [-0.38, 0.38]) paths.push({ points: new Float32Array([x, y, x - L * Math.cos(a + s), y - L * Math.sin(a + s)]) });
    };
    chosen.forEach((f, i) => {
      const off = 16 + 9 * i;
      // horizontal dimension above the figure (below it when there is no room)
      let yd = f.y0 - off;
      const above = yd > fy0 + 12;
      if (!above) yd = Math.min(fy1 - 6, f.y1 + off);
      const ext = above ? -3 : 3;
      paths.push({ points: new Float32Array([f.x0, above ? f.y0 - 3 : f.y1 + 3, f.x0, yd + ext]) });
      paths.push({ points: new Float32Array([f.x1, above ? f.y0 - 3 : f.y1 + 3, f.x1, yd + ext]) });
      paths.push({ points: new Float32Array([f.x0, yd, f.x1, yd]) });
      arrow(f.x0, yd, -1, 0);
      arrow(f.x1, yd, 1, 0);
      texts.push({ x: (f.x0 + f.x1) / 2, y: yd - 3, text: ((f.x1 - f.x0) * PX_TO_MM).toFixed(1), size: 8, anchor: 'middle', weight: 500 });
      // vertical dimension to the right (left when there is no room)
      let xd = f.x1 + off;
      const right = xd < fx1 - 12 && !(block && xd > block.x0 && f.y1 > block.y0);
      if (!right) xd = Math.max(fx0 + 12, f.x0 - off);
      const ex = right ? 3 : -3;
      paths.push({ points: new Float32Array([right ? f.x1 + 3 : f.x0 - 3, f.y0, xd + ex, f.y0]) });
      paths.push({ points: new Float32Array([right ? f.x1 + 3 : f.x0 - 3, f.y1, xd + ex, f.y1]) });
      paths.push({ points: new Float32Array([xd, f.y0, xd, f.y1]) });
      arrow(xd, f.y0, 0, -1);
      arrow(xd, f.y1, 0, 1);
      texts.push({ x: xd - 3, y: (f.y0 + f.y1) / 2, text: ((f.y1 - f.y0) * PX_TO_MM).toFixed(1), size: 8, anchor: 'middle', angle: -90, weight: 500 });
    });
    layers.push({ id: 'dimensions', label: 'Dimensions', color: V.dims, width: 0.7 * lw, paths, texts });
  }
  if (p.centerMarks && chosen.length) {
    const marks = [];
    const lines = [];
    for (const f of chosen) {
      const cx = (f.x0 + f.x1) / 2;
      const cy = (f.y0 + f.y1) / 2;
      marks.push({ points: new Float32Array([cx - 6, cy, cx + 6, cy]) }, { points: new Float32Array([cx, cy - 6, cx, cy + 6]) });
      lines.push({ points: new Float32Array([f.x0 - 6, cy, cx - 9, cy]) }, { points: new Float32Array([cx + 9, cy, f.x1 + 6, cy]) });
      lines.push({ points: new Float32Array([cx, f.y0 - 6, cx, cy - 9]) }, { points: new Float32Array([cx, cy + 9, cx, f.y1 + 6]) });
    }
    layers.push({ id: 'center-lines', label: 'Centre lines', color: V.center, width: 0.5 * lw, dash: [10, 3, 2, 3], paths: lines });
    layers.push({ id: 'center-marks', label: 'Centre marks', color: V.center, width: 0.7 * lw, paths: marks });
  }

  // ---- frame with zone markers ----
  const frame = [{ points: new Float32Array([fx0, fy0, fx1, fy0, fx1, fy1, fx0, fy1]), closed: true }];
  const zoneTexts = [];
  const zx = 6;
  const zy = 4;
  for (let i = 1; i < zx; i++) {
    const x = fx0 + ((fx1 - fx0) * i) / zx;
    frame.push({ points: new Float32Array([x, fy0 - 5, x, fy0]) }, { points: new Float32Array([x, fy1, x, fy1 + 5]) });
  }
  for (let i = 0; i < zx; i++) {
    const x = fx0 + ((fx1 - fx0) * (i + 0.5)) / zx;
    zoneTexts.push({ x, y: fy0 - 4, text: String(i + 1), size: 7, anchor: 'middle' }, { x, y: fy1 + 10, text: String(i + 1), size: 7, anchor: 'middle' });
  }
  for (let j = 1; j < zy; j++) {
    const y = fy0 + ((fy1 - fy0) * j) / zy;
    frame.push({ points: new Float32Array([fx0 - 5, y, fx0, y]) }, { points: new Float32Array([fx1, y, fx1 + 5, y]) });
  }
  for (let j = 0; j < zy; j++) {
    const y = fy0 + ((fy1 - fy0) * (j + 0.5)) / zy + 2.5;
    const letter = String.fromCharCode(65 + j);
    zoneTexts.push({ x: fx0 - 7, y, text: letter, size: 7, anchor: 'middle' }, { x: fx1 + 7, y, text: letter, size: 7, anchor: 'middle' });
  }
  layers.push({ id: 'frame', label: 'Frame', color: V.frame, width: 1.6 * lw, paths: frame, texts: zoneTexts });

  // ---- title block ----
  if (block) {
    const C = CAPTIONS[lang];
    const { x0, y0, x1, y1 } = block;
    const bw = x1 - x0;
    const r1 = y0 + 28;
    const r2 = y0 + 47;
    const mid = x0 + bw / 2;
    const lines = [
      { points: new Float32Array([x0, y0, x1, y0, x1, y1, x0, y1]), closed: true },
      { points: new Float32Array([x0, r1, x1, r1]) },
      { points: new Float32Array([x0, r2, x1, r2]) },
      { points: new Float32Array([mid, r1, mid, y1]) },
    ];
    const cap = (x, y, text) => ({ x: x + 4, y: y + 7, text, size: 5.5, color: V.accent, weight: 600 });
    const val = (x, y, text, w, size = 8.5) => ({ x: x + 4, y, text: fit(text, Math.floor((w - 8) / (size * 0.62))), size, weight: 500 });
    const texts = [
      cap(x0, y0, C.title), val(x0, y0 + 23, String(p.title || '').toUpperCase(), bw, 13),
      cap(x0, r1, C.scale), val(x0, r1 + 16, String(p.scaleText || ''), bw / 2),
      cap(mid, r1, C.date), val(mid, r1 + 16, dateText, bw / 2),
      cap(x0, r2, C.sheet), val(x0, r2 + 16, String(p.sheet || ''), bw / 2),
      cap(mid, r2, C.drawn), val(mid, r2 + 16, String(p.drawnBy || ''), bw / 2),
    ];
    if (p.variant === 'brutalist') texts[1].color = V.accent;
    layers.push({
      id: 'title-block', label: 'Title block', color: V.text, width: 1.1 * lw, paths: lines, texts,
      shapes: [{ rings: [new Float32Array([x0, y0, x1, y0, x1, y1, x0, y1])], fill: V.bg }],
    });
  }

  return {
    width: LW, height: LH, background: V.bg, layers,
    title: `${config.productName} blueprint: ${String(p.title || '')}`, desc: `${p.variant}, ${edgePaths.length} edges`,
  };
}

export default MODE;
