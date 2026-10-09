// Linear halftone (engraved line screen): parallel lines whose thickness follows the tone, the look of a banknote or of
// a steel engraving. Each line is a ribbon (a stroke of varying width) sampled every logical px:
//  - the width is spacing * (minWidth + (maxWidth - minWidth) * tone), so the ink coverage of a band follows the tone;
//    where it falls under a hairline the ribbon is cut and the paper shows through;
//  - `wave` bends the lines with a sine along their length (guilloche);
//  - `follow` displaces the lines along their normal by a heavily blurred copy of the tone, so they bulge around the
//    forms of the picture instead of running dead straight (contour-following engraving);
//  - `pattern: circles` draws concentric rings around a centre instead of straight lines.
// The scene is drawn with Canvas2D for the preview and serialised by io/exportSVG.js (filled ribbons; in plotter mode
// 1-4 side-by-side pen strokes per ribbon).

import { hatchLines, sampleSegment, simplifyRibbon, polylineLength } from '../engine/geometry.js';
import {
  logicalSize, workResolution, prepareOutput, fieldSampler, blurField, toneField, drawScene, fieldHash, hashed,
} from '../engine/vector.js';
import { normalizeHex } from '../engine/color.js';
import { sceneToSVG } from '../io/exportSVG.js';
import { config } from '../config.js';

const WORK_LONG = 480;
const DEG = Math.PI / 180;
const HAIRLINE = 0.08; // logical px: thinner than this is paper
const TAU = Math.PI * 2;

/**
 * Simplify a ribbon. A whole ring starts and ends on the same point, which Douglas-Peucker cannot handle (the chord
 * has no length): such a run is simplified as two halves that share their middle point.
 */
function simplifyRun(pts, ws) {
  const n = pts.length >> 1;
  const closed = n > 8 && Math.hypot(pts[0] - pts[(n - 1) * 2], pts[1] - pts[(n - 1) * 2 + 1]) < 1e-3;
  if (!closed) return simplifyRibbon(pts, ws, 0.08);
  const m = n >> 1;
  const a = simplifyRibbon(pts.slice(0, (m + 1) * 2), ws.slice(0, m + 1), 0.08);
  const b = simplifyRibbon(pts.slice(m * 2), ws.slice(m), 0.08);
  const points = new Float32Array(a.points.length + b.points.length - 2);
  points.set(a.points);
  points.set(b.points.subarray(2), a.points.length);
  const widths = new Float32Array(a.widths.length + b.widths.length - 1);
  widths.set(a.widths);
  widths.set(b.widths.subarray(1), a.widths.length);
  return { points, widths };
}

/**
 * Turn a sampled line (already displaced) into ribbons: width from the tone at each point, split where it vanishes.
 * @param {Float32Array} pts  x,y pairs
 * @param {(x: number, y: number) => number} T  tone sampler
 * @param {object} o
 * @param {Array} out  ribbons are pushed here
 */
function ribbonsOf(pts, T, o, out) {
  const n = pts.length >> 1;
  const ws = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const x = pts[k * 2];
    const y = pts[k * 2 + 1];
    if (x < 0 || y < 0 || x > o.LW || y > o.LH) { ws[k] = 0; continue; }
    const t = T(x, y);
    const w = o.spacing * (o.minW + (o.maxW - o.minW) * (t < 0 ? 0 : t > 1 ? 1 : t));
    ws[k] = w < HAIRLINE || t < o.cut ? 0 : w;
  }
  let s = -1;
  for (let k = 0; k <= n; k++) {
    const on = k < n && ws[k] > 0;
    if (on && s < 0) s = k;
    if (!on && s >= 0) {
      if (k - s >= 2) {
        const sp = pts.slice(s * 2, k * 2);
        if (polylineLength(sp) >= o.minSegment) out.push(simplifyRun(sp, ws.slice(s, k)));
      }
      s = -1;
    }
  }
}

function buildLines(p, T, S, LW, LH, o) {
  const angle = p.angle * DEG;
  const tx = Math.cos(angle);
  const ty = Math.sin(angle);
  const nx = -ty;
  const ny = tx;
  const amp = p.wave * p.spacing * 0.9;
  const k = TAU / Math.max(4, p.waveLength);
  const push = p.follow * p.spacing * 2.6;
  const ribbons = [];
  // lines are generated a little beyond the frame so that displaced lines still cover the edges
  const pad = Math.ceil((amp + push) / p.spacing) + 1;
  const lines = hatchLines(LW, LH, angle, p.spacing, 0);
  // extra lines outside the rect (hatchLines clips to it): offset copies of the first and last
  const extra = [];
  if (pad > 0 && lines.length) {
    const first = lines[0];
    const last = lines[lines.length - 1];
    for (let i = 1; i <= pad; i++) {
      extra.push(first.map((v, j) => v - (j % 2 ? ny : nx) * p.spacing * i));
      extra.push(last.map((v, j) => v + (j % 2 ? ny : nx) * p.spacing * i));
    }
  }
  for (const [x0, y0, x1, y1] of lines.concat(extra)) {
    // extend each segment so the bent line still reaches the borders
    const ext = amp + push + 2;
    const pts = sampleSegment(x0 - tx * ext, y0 - ty * ext, x1 + tx * ext, y1 + ty * ext, 1);
    const n = pts.length >> 1;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2];
      const y = pts[i * 2 + 1];
      const along = x * tx + y * ty;
      let d = 0;
      if (amp > 0) d += amp * Math.sin(along * k + p.phase * DEG);
      if (push > 0) d += push * (S(x, y) - 0.5);
      pts[i * 2] = x + nx * d;
      pts[i * 2 + 1] = y + ny * d;
    }
    ribbonsOf(pts, T, o, ribbons);
  }
  return ribbons;
}

function buildCircles(p, T, S, LW, LH, o) {
  const cx = p.centerX * LW;
  const cy = p.centerY * LH;
  const amp = p.wave * p.spacing * 0.9;
  const k = TAU / Math.max(4, p.waveLength);
  const push = p.follow * p.spacing * 2.6;
  const rMax = Math.hypot(Math.max(cx, LW - cx), Math.max(cy, LH - cy)) + amp + push + p.spacing;
  const ribbons = [];
  for (let r = p.spacing * 0.5; r <= rMax; r += p.spacing) {
    const n = Math.max(8, Math.ceil((TAU * r) / 1));
    const pts = new Float32Array((n + 1) * 2);
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * TAU;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      let rr = r;
      if (amp > 0) rr += amp * Math.sin(r * a * k + p.phase * DEG);
      if (push > 0) rr += push * (S(cx + ux * r, cy + uy * r) - 0.5);
      pts[i * 2] = cx + ux * rr;
      pts[i * 2 + 1] = cy + uy * rr;
    }
    ribbonsOf(pts, T, o, ribbons);
  }
  return ribbons;
}

const MODE = {
  id: 'linehalftone',
  category: 'vector',
  name: { es: 'Halftone lineal', en: 'Linear halftone' },
  blurb: { es: 'Líneas paralelas que engordan con el tono: grabado, billete y anillos', en: 'Parallel lines that thicken with tone: engraving, banknote and rings' },
  badges: ['SVG'],
  animated: false,
  uses: ['image'],
  exports: ['png', 'svg', 'video'],
  svgOptions: true,
  draftScale: 0.5,
  hide: ['cols', 'dither', 'serpentine'],

  presets: [
    { id: 'electric', name: { es: 'Azul eléctrico', en: 'Electric blue' }, mode: { pattern: 'lines', angle: 0, spacing: 6, wave: 0.15, waveLength: 140, follow: 0.55, minWidth: 0.04, maxWidth: 0.95, ink: '#f4f2ec', paper: '#1e1eff' } },
    { id: 'engraving', name: { es: 'Grabado', en: 'Steel engraving' }, mode: { pattern: 'lines', angle: 35, spacing: 5, wave: 0, follow: 0.8, minWidth: 0, maxWidth: 1, gamma: 1.15, ink: '#141414', paper: '#f2eee4' } },
    { id: 'banknote', name: { es: 'Billete', en: 'Banknote' }, mode: { pattern: 'lines', angle: 20, spacing: 4.5, wave: 0.6, waveLength: 60, follow: 0.4, minWidth: 0.08, maxWidth: 0.9, ink: '#1d3b2a', paper: '#efe8d2' } },
    { id: 'rings', name: { es: 'Anillos', en: 'Rings' }, mode: { pattern: 'circles', spacing: 7, wave: 0, follow: 0.3, minWidth: 0, maxWidth: 1, ink: '#0a0a0a', paper: '#ffffff' } },
  ],

  params: [
    {
      id: 'pattern', type: 'select', default: 'lines',
      options: [
        { value: 'lines', label: { es: 'Líneas paralelas', en: 'Parallel lines' } },
        { value: 'circles', label: { es: 'Anillos concéntricos', en: 'Concentric rings' } },
      ],
      label: { es: 'Patrón', en: 'Pattern' },
    },
    {
      id: 'spacing', type: 'range', min: 2, max: 24, step: 0.5, default: 6, unit: 'px',
      label: { es: 'Separación', en: 'Spacing' },
      help: { es: 'Distancia entre líneas en un dibujo de 1000 px de lado mayor.', en: 'Distance between lines on a drawing 1000 px on its long side.' },
    },
    {
      id: 'angle', type: 'range', min: 0, max: 180, step: 1, default: 0, unit: '°',
      label: { es: 'Ángulo', en: 'Angle' },
      showIf: (p) => p.pattern === 'lines',
    },
    {
      id: 'centerX', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5,
      label: { es: 'Centro X', en: 'Centre X' },
      showIf: (p) => p.pattern === 'circles',
    },
    {
      id: 'centerY', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5,
      label: { es: 'Centro Y', en: 'Centre Y' },
      showIf: (p) => p.pattern === 'circles',
    },
    {
      id: 'minWidth', type: 'range', min: 0, max: 0.5, step: 0.01, default: 0.04,
      label: { es: 'Grosor mínimo', en: 'Minimum width' },
      help: { es: 'Fracción de la separación en las zonas sin tinta. 0 corta la línea y deja ver el papel.', en: 'Fraction of the spacing where there is no ink. 0 breaks the line and lets the paper show.' },
    },
    {
      id: 'maxWidth', type: 'range', min: 0.2, max: 1, step: 0.01, default: 0.95,
      label: { es: 'Grosor máximo', en: 'Maximum width' },
      help: { es: 'Fracción de la separación con tinta plena. 1 junta las líneas en las sombras.', en: 'Fraction of the spacing at full ink. 1 merges the lines in the shadows.' },
    },
    {
      id: 'wave', type: 'range', min: 0, max: 1, step: 0.05, default: 0,
      label: { es: 'Onda', en: 'Wave' },
      help: { es: 'Ondula las líneas a lo largo de su recorrido (guilloché).', en: 'Bends the lines along their length (guilloche).' },
    },
    {
      id: 'waveLength', type: 'range', min: 10, max: 400, step: 5, default: 120, unit: 'px',
      label: { es: 'Longitud de onda', en: 'Wavelength' },
      showIf: (p) => p.wave > 0,
    },
    {
      id: 'phase', type: 'range', min: 0, max: 360, step: 5, default: 0, unit: '°',
      label: { es: 'Fase', en: 'Phase' },
      showIf: (p) => p.wave > 0,
    },
    {
      id: 'follow', type: 'range', min: 0, max: 1, step: 0.05, default: 0.5,
      label: { es: 'Seguir el contorno', en: 'Follow contours' },
      help: { es: 'Desplaza las líneas con el volumen de la imagen: se curvan alrededor de las formas.', en: 'Displaces the lines with the volume of the picture: they curve around the forms.' },
    },
    {
      id: 'smooth', type: 'range', min: 0, max: 6, step: 0.5, default: 1,
      label: { es: 'Suavizado', en: 'Smoothing' },
      help: { es: 'Desenfoque del tono antes de trazar: líneas más limpias.', en: 'Blur of the tone before drawing: cleaner lines.' },
    },
    {
      id: 'gamma', type: 'range', min: 0.4, max: 2.5, step: 0.05, default: 1,
      label: { es: 'Respuesta tonal', en: 'Tone response' },
      help: { es: 'Por encima de 1, líneas más finas en los medios tonos; por debajo, más gruesas.', en: 'Above 1, thinner lines in the midtones; below 1, thicker.' },
    },
    {
      id: 'invert', type: 'toggle', default: false,
      label: { es: 'Invertir', en: 'Invert' },
    },
    { id: 'ink', type: 'color', default: '#f4f2ec', label: { es: 'Tinta', en: 'Ink' } },
    { id: 'paper', type: 'color', default: '#1e1eff', label: { es: 'Papel', en: 'Paper' } },
    {
      id: 'penWidth', type: 'range', min: 0.2, max: 3, step: 0.05, default: 0.6, unit: 'px',
      label: { es: 'Pluma (SVG plotter)', en: 'Pen (plotter SVG)' },
      help: { es: 'En el SVG para plotter cada línea gruesa se dibuja con 1–4 trazos de esta pluma.', en: 'In the plotter SVG each thick line is drawn with 1-4 strokes of this pen.' },
    },
  ],

  resolution(params, srcW, srcH) {
    return workResolution(srcW, srcH, WORK_LONG);
  },

  preOptions(params) {
    // transparent areas (cut-outs) become paper: no lines on the background
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
    const ink = normalizeHex(p.ink) || '#f4f2ec';
    const paper = normalizeHex(p.paper) || '#1e1eff';
    const luma = ctx.luma();
    const key = hashed([fieldHash(luma), W, H, LW, LH, p]);
    if (key !== state.key || !state.scene) {
      const tone = toneField(blurField(luma, W, H, p.smooth), ink, paper, p.gamma, p.invert);
      const T = fieldSampler(tone, W, H, LW, LH);
      // the contour field: a much smoother copy (radius ~ 3 % of the long side) so the lines bend with the volumes
      const S = p.follow > 0 ? fieldSampler(blurField(tone, W, H, Math.max(W, H) * 0.03), W, H, LW, LH) : null;
      const minW = Math.min(p.minWidth, p.maxWidth);
      const o = { LW, LH, spacing: p.spacing, minW, maxW: p.maxWidth, cut: minW > 0 ? -1 : 0.015, minSegment: 1 };
      const ribbons = p.pattern === 'circles' ? buildCircles(p, T, S, LW, LH, o) : buildLines(p, T, S, LW, LH, o);
      state.scene = {
        width: LW,
        height: LH,
        background: paper,
        layers: [{ id: 'lines', label: p.pattern === 'circles' ? 'Rings' : 'Lines', color: ink, width: p.penWidth, ribbons }],
        title: `${config.productName} linear halftone`,
        desc: `linear halftone, ${p.pattern}, spacing ${p.spacing}px`,
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
