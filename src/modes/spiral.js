// Single-line spiral / squiggle (PLAN.md 7.20): one continuous line, ideal for pen plotters.
// Spiral: an Archimedean spiral from the centre; along it, a wave whose amplitude (and optionally frequency) follows
// the tone of the picture. Squiggle: the same wave on horizontal lines, joined end to end by U-turns (boustrophedon),
// so it is still a single stroke. The line is sampled by arc length (several samples per wave) and simplified.

import { simplify, clipPolylineByField } from '../engine/geometry.js';
import {
  logicalSize, workResolution, prepareOutput, fieldSampler, blurField, toneField, drawScene, fieldHash, hashed,
} from '../engine/vector.js';
import { normalizeHex } from '../engine/color.js';
import { sceneToSVG } from '../io/exportSVG.js';
import { config } from '../config.js';

const WORK_LONG = 400;
const TAU = Math.PI * 2;

function waveParams(p, t) {
  const amp = p.modulate === 'frequency' ? 0.7 : t;
  const freq = p.modulate === 'amplitude' ? 1 : 0.35 + 1.3 * t;
  return { amp, freq };
}

/** Archimedean spiral with a tone-driven wave; returns one point array (the whole line). */
export function spiralLine(p, T, LW, LH) {
  const cx = LW / 2;
  const cy = LH / 2;
  const R = p.cover ? Math.hypot(LW, LH) / 2 : Math.min(LW, LH) / 2 - 2;
  const turns = Math.max(2, Math.round(p.lines));
  const spacing = R / turns;
  const wavelength = spacing / p.frequency;
  const ds = Math.max(0.25, Math.min(1, wavelength / 10));
  const pts = [];
  let theta = 0;
  let phase = 0;
  const thetaMax = turns * TAU;
  while (theta <= thetaMax) {
    const r = (spacing * theta) / TAU;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const bx = cx + r * c;
    const by = cy + r * s;
    const t = bx >= 0 && by >= 0 && bx <= LW && by <= LH ? T(bx, by) : 0;
    const { amp, freq } = waveParams(p, t);
    const off = p.maxAmplitude * (spacing / 2) * amp * Math.sin(phase);
    pts.push(cx + (r + off) * c, cy + (r + off) * s);
    theta += ds / Math.max(r, spacing * 0.5);
    phase += (TAU * ds * freq) / wavelength;
  }
  return Float32Array.from(pts);
}

/** Horizontal squiggle lines joined by U-turns into one line. */
export function squiggleLine(p, T, LW, LH) {
  const rows = Math.max(2, Math.round(p.lines));
  const spacing = LH / rows;
  const m = spacing / 2;
  const wavelength = spacing / p.frequency;
  const ds = Math.max(0.25, Math.min(1, wavelength / 10));
  const pts = [];
  let phase = 0;
  for (let k = 0; k < rows; k++) {
    const y = (k + 0.5) * spacing;
    const ltr = k % 2 === 0;
    const n = Math.ceil((LW - 2 * m) / ds);
    for (let i = 0; i <= n; i++) {
      const x = ltr ? m + i * ds : LW - m - i * ds;
      const xx = Math.max(m, Math.min(LW - m, x));
      const { amp, freq } = waveParams(p, T(xx, y));
      pts.push(xx, y + p.maxAmplitude * (spacing / 2) * amp * Math.sin(phase));
      phase += (TAU * ds * freq) / wavelength;
    }
    if (k < rows - 1) {
      // U-turn to the next row (half circle of radius spacing / 2 at the edge)
      const ex = ltr ? LW - m : m;
      for (let a = 1; a < 12; a++) {
        const ang = (a / 12) * Math.PI;
        const dx = Math.sin(ang) * m * (ltr ? 1 : -1);
        pts.push(ex + dx, y + m - Math.cos(ang) * m);
      }
    }
  }
  return Float32Array.from(pts);
}

const MODE = {
  id: 'spiral',
  category: 'vector',
  name: { es: 'Espiral / Squiggle', en: 'Spiral / Squiggle' },
  blurb: { es: 'Una sola línea continua que ondula con la imagen', en: 'One continuous line that waves with the picture' },
  badges: ['SVG'],
  animated: false,
  uses: ['image'],
  exports: ['png', 'svg', 'video'],
  svgOptions: true,
  draftScale: 0.5,
  hide: ['cols', 'dither', 'serpentine'],

  presets: [
    { id: 'spiral', name: { es: 'Espiral', en: 'Spiral' }, mode: { style: 'spiral', lines: 70, maxAmplitude: 0.95, frequency: 1.6, modulate: 'amplitude' } },
    { id: 'squiggle', name: { es: 'Squiggle', en: 'Squiggle' }, mode: { style: 'squiggle', lines: 80, maxAmplitude: 0.9, frequency: 1.2, modulate: 'both' } },
    { id: 'vinyl', name: { es: 'Vinilo', en: 'Vinyl' }, mode: { style: 'spiral', lines: 140, maxAmplitude: 0.8, frequency: 2.5, strokeWidth: 0.5, ink: '#e8e4d8', paper: '#0b0b0a', cover: true } },
  ],

  params: [
    {
      id: 'style', type: 'select', default: 'spiral',
      options: [
        { value: 'spiral', label: { es: 'Espiral', en: 'Spiral' } },
        { value: 'squiggle', label: { es: 'Squiggle', en: 'Squiggle' } },
      ],
      label: { es: 'Estilo', en: 'Style' },
    },
    { id: 'lines', type: 'range', min: 20, max: 200, step: 1, default: 60, label: { es: 'Vueltas / líneas', en: 'Turns / lines' } },
    {
      id: 'maxAmplitude', type: 'range', min: 0, max: 1, step: 0.05, default: 0.9,
      label: { es: 'Amplitud máxima', en: 'Maximum amplitude' },
      help: { es: 'Fracción de la separación entre vueltas que puede ocupar la onda.', en: 'Fraction of the gap between turns the wave may use.' },
    },
    {
      id: 'frequency', type: 'range', min: 0.2, max: 4, step: 0.05, default: 1.5,
      label: { es: 'Frecuencia', en: 'Frequency' },
      help: { es: 'Ondas por cada separación entre vueltas.', en: 'Waves per gap between turns.' },
    },
    {
      id: 'modulate', type: 'select', default: 'amplitude',
      options: [
        { value: 'amplitude', label: { es: 'Amplitud', en: 'Amplitude' } },
        { value: 'frequency', label: { es: 'Frecuencia', en: 'Frequency' } },
        { value: 'both', label: { es: 'Ambas', en: 'Both' } },
      ],
      label: { es: 'La imagen modula', en: 'The picture modulates' },
    },
    { id: 'strokeWidth', type: 'range', min: 0.2, max: 3, step: 0.05, default: 0.8, unit: 'px', label: { es: 'Grosor', en: 'Stroke width' } },
    { id: 'gamma', type: 'range', min: 0.4, max: 2.5, step: 0.05, default: 1, label: { es: 'Respuesta tonal', en: 'Tone response' } },
    {
      id: 'cover', type: 'toggle', default: false,
      label: { es: 'Cubrir todo', en: 'Cover everything' },
      help: { es: 'La espiral llega a las esquinas (se corta en los bordes).', en: 'The spiral reaches the corners (cut at the edges).' },
      showIf: (p) => p.style === 'spiral',
    },
    { id: 'invert', type: 'toggle', default: false, label: { es: 'Invertir', en: 'Invert' } },
    { id: 'ink', type: 'color', default: '#15181e', label: { es: 'Tinta', en: 'Ink' } },
    { id: 'paper', type: 'color', default: '#f3efe4', label: { es: 'Papel', en: 'Paper' } },
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
      const T = fieldSampler(toneField(blurField(luma, W, H, 1), ink, paper, p.gamma, p.invert), W, H, LW, LH);
      let line = p.style === 'squiggle' ? squiggleLine(p, T, LW, LH) : spiralLine(p, T, LW, LH);
      let paths;
      if (p.style === 'spiral' && p.cover) {
        paths = clipPolylineByField(line, (x, y) => x >= 0 && y >= 0 && x <= LW && y <= LH, { refine: 6 })
          .map((pts) => ({ points: simplify(pts, 0.1) }));
      } else {
        line = simplify(line, 0.1);
        paths = [{ points: line }];
      }
      state.scene = {
        width: LW, height: LH, background: paper,
        layers: [{ id: 'line', label: p.style === 'squiggle' ? 'Squiggle' : 'Spiral', color: ink, width: p.strokeWidth, paths }],
        title: `${config.productName} ${p.style}`, desc: `${paths.length} stroke(s), ${Math.round(p.lines)} ${p.style === 'spiral' ? 'turns' : 'lines'}`,
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
