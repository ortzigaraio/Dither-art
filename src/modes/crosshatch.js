// Vector engraving / crosshatching / pen plotter (PLAN.md 7.14). Three styles over the same tone field
// (how much ink each place wants, from the picture and the ink/paper polarity):
//  - Crosshatch: `layers` families of parallel lines, family i at baseAngle + i*angleStep, drawn only where the tone
//    exceeds its threshold (i+1)/(layers+1): lines are sampled every px and clipped against the field
//    (geometry.clipPolylineByField), with hand-drawn wobble from simplex noise.
//  - Engraving (banknote): parallel lines bent by a smooth wave and by the picture, whose width follows the tone
//    (ribbons; in plotter SVG, 1-4 side-by-side pen strokes instead), plus cross-engraving in the deep shadows.
//  - Scribble: short curly strokes whose density follows the tone.
// The polylines stay in memory as a scene: the preview draws it with Canvas2D and the SVG export serialises it.

import { createNoise } from '../engine/noise.js';
import { clipPolylineByField, hatchLines, sampleSegment, simplify, simplifyRibbon, polylineLength } from '../engine/geometry.js';
import {
  logicalSize, workResolution, prepareOutput, fieldSampler, blurField, toneField, drawScene, fieldHash, hashed,
} from '../engine/vector.js';
import { hash01 } from '../engine/rand.js';
import { normalizeHex } from '../engine/color.js';
import { sceneToSVG } from '../io/exportSVG.js';
import { config } from '../config.js';

const WORK_LONG = 400;
const DEG = Math.PI / 180;

function buildHatch(p, T, LW, LH, noise) {
  const layers = [];
  const n = Math.max(1, Math.min(6, Math.round(p.layers)));
  const wob = p.wobble;
  for (let i = 0; i < n; i++) {
    const level = (i + 1) / (n + 1);
    const angle = (p.baseAngle + i * p.angleStep) * DEG;
    const nx = -Math.sin(angle);
    const ny = Math.cos(angle);
    const paths = [];
    for (const [x0, y0, x1, y1] of hatchLines(LW, LH, angle, p.spacing, i * p.spacing * 0.37)) {
      const pts = sampleSegment(x0, y0, x1, y1, 1);
      if (wob > 0) {
        for (let k = 0; k < pts.length; k += 2) {
          const x = pts[k];
          const y = pts[k + 1];
          const d = wob * (p.spacing * 0.45 * noise.noise2(x * 0.011, y * 0.011 + i * 17.3) + 0.55 * noise.noise2(x * 0.09 + i * 5.1, y * 0.09));
          pts[k] = x + nx * d;
          pts[k + 1] = y + ny * d;
        }
      }
      for (const run of clipPolylineByField(pts, (x, y) => x >= 0 && y >= 0 && x <= LW && y <= LH && T(x, y) > level, { minLength: p.minSegment, refine: 4 })) {
        paths.push({ points: simplify(run, wob > 0 ? 0.12 : 0.02), closed: false });
      }
    }
    layers.push({ id: `hatch-${i + 1}`, label: `Hatch ${i + 1} (${Math.round(((p.baseAngle + i * p.angleStep) % 180 + 180) % 180)}°)`, paths });
  }
  return layers;
}

function buildEngraving(p, T, LW, LH, noise) {
  const angle = p.baseAngle * DEG;
  const tx = Math.cos(angle);
  const ty = Math.sin(angle);
  const nx = -ty;
  const ny = tx;
  const maxW = p.spacing * 0.9;
  const minW = Math.min(maxW, Math.max(0.12, p.strokeWidth * 0.35));
  const ribbons = [];
  for (const [x0, y0, x1, y1] of hatchLines(LW, LH, angle, p.spacing, 0)) {
    const pts = sampleSegment(x0, y0, x1, y1, 1);
    const n = pts.length >> 1;
    const ws = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const x = pts[k * 2];
      const y = pts[k * 2 + 1];
      // smooth guilloche-like wave + bending by the picture (lines swell around features, like banknote engraving)
      const wave = p.wobble * p.spacing * 1.4 * noise.noise2(x * 0.0045, y * 0.0045);
      const bend = p.bend * p.spacing * 0.9 * (T(x, y) - 0.5);
      const d = wave + bend;
      const X = x + nx * d;
      const Y = y + ny * d;
      pts[k * 2] = X;
      pts[k * 2 + 1] = Y;
      const t = T(X, Y);
      ws[k] = t < 0.035 || X < 0 || Y < 0 || X > LW || Y > LH ? 0 : minW + (maxW - minW) * t;
    }
    // split where the width falls to zero (paper shows through)
    let s = -1;
    for (let k = 0; k <= n; k++) {
      const on = k < n && ws[k] > 0;
      if (on && s < 0) s = k;
      if (!on && s >= 0) {
        if (k - s >= 2) {
          const sp = pts.slice(s * 2, k * 2);
          if (polylineLength(sp) >= Math.max(1, p.minSegment)) ribbons.push(simplifyRibbon(sp, ws.slice(s, k), 0.12));
        }
        s = -1;
      }
    }
  }
  const layers = [{ id: 'engraving', label: 'Engraving', ribbons }];
  const extra = Math.max(0, Math.min(2, Math.round(p.layers) - 1));
  for (let i = 0; i < extra; i++) {
    const level = 0.62 + i * 0.16;
    const a = (p.baseAngle + (i + 1) * p.angleStep) * DEG;
    const paths = [];
    for (const [x0, y0, x1, y1] of hatchLines(LW, LH, a, p.spacing * 1.15, p.spacing * 0.5)) {
      for (const run of clipPolylineByField(sampleSegment(x0, y0, x1, y1, 1), (x, y) => T(x, y) > level, { minLength: Math.max(2, p.minSegment), refine: 4 })) {
        paths.push({ points: simplify(run, 0.05), closed: false });
      }
    }
    layers.push({ id: `cross-${i + 1}`, label: `Cross engraving ${i + 1}`, paths, widthMul: 0.7 });
  }
  return layers;
}

function buildScribble(p, T, LW, LH, noise, seed) {
  const cell = Math.max(3, p.spacing * 1.6);
  const cols = Math.ceil(LW / cell);
  const rows = Math.ceil(LH / cell);
  const paths = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x = (cx + 0.5) * cell;
      const y = (cy + 0.5) * cell;
      const t = T(Math.min(LW - 0.5, x), Math.min(LH - 0.5, y));
      const count = Math.floor(t * t * 3 + hash01(seed, cx, cy, 1) * 0.999);
      for (let s = 0; s < count; s++) {
        let px = x + (hash01(seed, cx, cy, 10 + s) - 0.5) * cell;
        let py = y + (hash01(seed, cx, cy, 20 + s) - 0.5) * cell;
        let th = hash01(seed, cx, cy, 30 + s) * Math.PI * 2;
        const dir = hash01(seed, cx, cy, 40 + s) < 0.5 ? -1 : 1;
        const len = p.spacing * (3 + 4 * hash01(seed, cx, cy, 50 + s));
        const step = 1.4;
        const steps = Math.max(3, Math.round(len / step));
        const pts = new Float32Array((steps + 1) * 2);
        pts[0] = px; pts[1] = py;
        for (let k = 1; k <= steps; k++) {
          const turn = dir * (0.07 + 0.2 * t) + p.wobble * 0.5 * noise.noise2(px * 0.04, py * 0.04);
          th += turn;
          px += Math.cos(th) * step;
          py += Math.sin(th) * step;
          pts[k * 2] = px;
          pts[k * 2 + 1] = py;
        }
        // keep the parts inside the drawing
        for (const run of clipPolylineByField(pts, (a, b) => a >= 0 && b >= 0 && a <= LW && b <= LH, { refine: 0, minLength: p.minSegment })) {
          paths.push({ points: simplify(run, 0.2), closed: false });
        }
      }
    }
  }
  return [{ id: 'scribble', label: 'Scribble', paths }];
}

const MODE = {
  id: 'crosshatch',
  category: 'vector',
  name: { es: 'Grabado / Crosshatch', en: 'Engraving / Crosshatch' },
  blurb: { es: 'Sombreado cruzado, grabado de billete y garabato para plotter', en: 'Crosshatching, banknote engraving and scribble for pen plotters' },
  badges: ['SVG'],
  animated: false,
  uses: ['image'],
  exports: ['png', 'svg', 'video'],
  svgOptions: true,
  draftScale: 0.5,
  hide: ['cols', 'dither', 'serpentine'],

  presets: [
    { id: 'pen', name: { es: 'Pluma', en: 'Pen and ink' }, mode: { style: 'hatch', layers: 4, spacing: 6, baseAngle: 45, angleStep: 45, wobble: 0.15, ink: '#15181e', paper: '#f3efe4' } },
    { id: 'banknote', name: { es: 'Billete', en: 'Banknote' }, mode: { style: 'engraving', spacing: 5, baseAngle: 20, wobble: 0.6, bend: 0.6, layers: 2, ink: '#1d3b2a', paper: '#efe8d2' } },
    { id: 'biro', name: { es: 'Bolígrafo', en: 'Biro scribble' }, mode: { style: 'scribble', spacing: 5, wobble: 0.4, strokeWidth: 0.6, ink: '#1f3a8a', paper: '#f7f8fa' } },
  ],

  params: [
    {
      id: 'style', type: 'select', default: 'hatch',
      options: [
        { value: 'hatch', label: { es: 'Sombreado cruzado', en: 'Crosshatch' } },
        { value: 'engraving', label: { es: 'Grabado (billete)', en: 'Engraving (banknote)' } },
        { value: 'scribble', label: { es: 'Garabato', en: 'Scribble' } },
      ],
      label: { es: 'Estilo', en: 'Style' },
    },
    {
      id: 'layers', type: 'range', min: 1, max: 6, step: 1, default: 4,
      label: { es: 'Capas', en: 'Layers' },
      help: { es: 'Familias de líneas; cada una aparece en un tono más oscuro. En grabado, direcciones extra en las sombras.', en: 'Line families; each one appears at a darker tone. In engraving, extra directions in the shadows.' },
      showIf: (p) => p.style !== 'scribble',
    },
    {
      id: 'spacing', type: 'range', min: 2, max: 20, step: 0.5, default: 6, unit: 'px',
      label: { es: 'Separación', en: 'Spacing' },
    },
    {
      id: 'baseAngle', type: 'range', min: 0, max: 180, step: 1, default: 45, unit: '°',
      label: { es: 'Ángulo base', en: 'Base angle' },
      showIf: (p) => p.style !== 'scribble',
    },
    {
      id: 'angleStep', type: 'range', min: 15, max: 90, step: 1, default: 45, unit: '°',
      label: { es: 'Paso de ángulo', en: 'Angle step' },
      showIf: (p) => p.style !== 'scribble',
    },
    {
      id: 'strokeWidth', type: 'range', min: 0.2, max: 3, step: 0.05, default: 0.8, unit: 'px',
      label: { es: 'Grosor del trazo', en: 'Stroke width' },
      help: { es: 'Grosor de la pluma. En grabado es el trazo mínimo y el ancho de pluma del SVG para plotter.', en: 'Pen width. In engraving it is the thinnest stroke and the pen width of the plotter SVG.' },
    },
    {
      id: 'minSegment', type: 'range', min: 0, max: 20, step: 0.5, default: 2, unit: 'px',
      label: { es: 'Tramo mínimo', en: 'Minimum segment' },
      help: { es: 'Descarta trazos más cortos (menos movimientos de pluma).', en: 'Drops shorter strokes (fewer pen lifts).' },
    },
    {
      id: 'wobble', type: 'range', min: 0, max: 1, step: 0.05, default: 0.1,
      label: { es: 'Temblor', en: 'Wobble' },
      help: { es: 'Ruido en las líneas: aspecto dibujado a mano.', en: 'Noise on the lines: a hand-drawn look.' },
    },
    {
      id: 'bend', type: 'range', min: 0, max: 1, step: 0.05, default: 0.5,
      label: { es: 'Curvatura por la imagen', en: 'Bend by the picture' },
      showIf: (p) => p.style === 'engraving',
    },
    {
      id: 'gamma', type: 'range', min: 0.4, max: 2.5, step: 0.05, default: 1,
      label: { es: 'Respuesta tonal', en: 'Tone response' },
      help: { es: 'Por encima de 1, menos tinta en los medios tonos; por debajo, más.', en: 'Above 1, less ink in the midtones; below 1, more.' },
    },
    {
      id: 'invert', type: 'toggle', default: false,
      label: { es: 'Invertir', en: 'Invert' },
    },
    { id: 'ink', type: 'color', default: '#15181e', label: { es: 'Tinta', en: 'Ink' } },
    { id: 'paper', type: 'color', default: '#f3efe4', label: { es: 'Papel', en: 'Paper' } },
    {
      id: 'seed', type: 'seed', default: 7,
      label: { es: 'Semilla', en: 'Seed' },
      showIf: (p) => p.wobble > 0 || p.style === 'scribble',
    },
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

  render(ctx, state) {
    const p = ctx.params.mode;
    const { LW, LH } = logicalSize(ctx);
    const W = ctx.width;
    const H = ctx.height;
    const ink = normalizeHex(p.ink) || '#15181e';
    const paper = normalizeHex(p.paper) || '#f3efe4';
    const luma = ctx.luma();
    const key = hashed([fieldHash(luma), W, H, LW, LH, p]);
    if (key !== state.key || !state.scene) {
      const tone = toneField(blurField(luma, W, H, 1.2), ink, paper, p.gamma, p.invert);
      const T = fieldSampler(tone, W, H, LW, LH);
      const noise = createNoise(p.seed);
      let layers;
      if (p.style === 'engraving') layers = buildEngraving(p, T, LW, LH, noise);
      else if (p.style === 'scribble') layers = buildScribble(p, T, LW, LH, noise, p.seed | 0);
      else layers = buildHatch(p, T, LW, LH, noise);
      for (const L of layers) {
        L.color = ink;
        L.width = p.strokeWidth * (L.widthMul || 1);
      }
      state.scene = {
        width: LW, height: LH, background: paper, layers,
        title: `${config.productName} ${p.style}`, desc: `crosshatch ${p.style}, spacing ${p.spacing}px`,
      };
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

export default MODE;
