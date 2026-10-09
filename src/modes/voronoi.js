// Voronoi, stippling and cellular tessellation (PLAN.md 7.16), with d3-delaunay.
// Weighted Voronoi stippling (Secord 2002) runs in the heavy worker (engine/stipple.js): points are seeded by
// rejection sampling on the weight (darkness, edges or uniform), then Lloyd-relaxed; every iteration comes back as a
// partial result and the viewer redraws it, so the relaxation is animated. The final points feed four sub-styles:
//  - Stipple: dots, radius from the tone under each point (minDot..maxDot)
//  - Cells: every Voronoi cell filled with its mean colour (mosaic / stained glass), optional borders
//  - Low-poly: Delaunay triangles filled with the colour under their centroid
//  - Constellation: points joined by their short Delaunay edges
// Video: each new frame runs a couple of Lloyd iterations from the previous points (temporal coherence); exports
// always run to completion, so a still export is deterministic for a seed.

import { Delaunay } from '../../vendor/d3-delaunay/6.0.4/index.js';
import * as heavy from '../engine/heavy.js';
import { initialPoints } from '../engine/stipple.js';
import {
  logicalSize, prepareOutput, fieldSampler, blurField, toneField, drawScene, fieldHash, hashed,
} from '../engine/vector.js';
import { normalizeHex, rgbToHex } from '../engine/color.js';
import { sceneToSVG } from '../io/exportSVG.js';
import { LIMITS, config } from '../config.js';

/** Work pixels for `count` points: ~40 px per point, within sane bounds. */
export function stippleWorkSize(count, srcW, srcH) {
  const px = Math.max(120000, Math.min(1000000, count * 40));
  const a = srcW / Math.max(1, srcH);
  const W = Math.max(8, Math.round(Math.sqrt(px * a)));
  return { width: W, height: Math.max(8, Math.round(W / a)) };
}

/** d3-delaunay render() target that collects polylines instead of drawing. */
function collector() {
  const lines = [];
  let cur = null;
  return {
    lines,
    moveTo(x, y) { cur = [x, y]; lines.push(cur); },
    lineTo(x, y) { cur?.push(x, y); },
    closePath() { if (cur) cur.closed = true; },
  };
}
const toPaths = (lines) => lines.filter((l) => l.length >= 4).map((l) => ({ points: Float32Array.from(l), closed: !!l.closed }));

function weightsFor(ctx, p, ink, paper) {
  const W = ctx.width;
  const H = ctx.height;
  if (p.weighting === 'uniform') return new Float32Array(W * H).fill(1);
  if (p.weighting === 'edges') {
    const { mag } = ctx.sobel();
    let max = 1e-6;
    for (let i = 0; i < mag.length; i++) if (mag[i] > max) max = mag[i];
    const w = new Float32Array(W * H);
    const sm = blurField(mag, W, H, 1.5);
    for (let i = 0; i < w.length; i++) w[i] = 0.04 + Math.pow(Math.min(1, sm[i] / (max * 0.6)), p.gamma);
    return w;
  }
  return toneField(ctx.luma(), ink, paper, p.gamma, p.invert);
}

const MODE = {
  id: 'voronoi',
  category: 'vector',
  name: { es: 'Voronoi / Stipple', en: 'Voronoi / Stipple' },
  blurb: { es: 'Punteado de Voronoi ponderado, celdas, low-poly y constelación', en: 'Weighted Voronoi stippling, cells, low-poly and constellation' },
  badges: ['SVG'],
  animated: false,
  uses: ['image'],
  exports: ['png', 'svg', 'video'],
  svgOptions: true,
  draftScale: 1,
  hide: ['cols', 'dither', 'serpentine'],

  presets: [
    { id: 'stipple', name: { es: 'Punteado', en: 'Stippling' }, mode: { style: 'stipple', points: 8000, iterations: 20, weighting: 'tone', minDot: 0.6, maxDot: 2.4, ink: '#15181e', paper: '#f3efe4' } },
    { id: 'glass', name: { es: 'Vitral', en: 'Stained glass' }, mode: { style: 'cells', points: 1500, iterations: 12, weighting: 'uniform', border: true, borderWidth: 1.6, ink: '#15181e' } },
    { id: 'lowpoly', name: { es: 'Low-poly', en: 'Low-poly' }, mode: { style: 'lowpoly', points: 1800, iterations: 4, weighting: 'edges', border: false } },
    { id: 'stars', name: { es: 'Constelación', en: 'Constellation' }, mode: { style: 'constellation', points: 2500, iterations: 10, weighting: 'tone', edgeLength: 40, ink: '#cfe8ff', paper: '#0b0d12' } },
  ],

  params: [
    {
      id: 'style', type: 'select', default: 'stipple',
      options: [
        { value: 'stipple', label: { es: 'Punteado', en: 'Stipple' } },
        { value: 'cells', label: { es: 'Celdas', en: 'Cells' } },
        { value: 'lowpoly', label: { es: 'Low-poly', en: 'Low-poly' } },
        { value: 'constellation', label: { es: 'Constelación', en: 'Constellation' } },
      ],
      label: { es: 'Estilo', en: 'Style' },
    },
    {
      id: 'points', type: 'range', min: 500, max: 50000, step: 100, default: 5000,
      label: { es: 'Puntos', en: 'Points' },
    },
    {
      id: 'iterations', type: 'range', min: 0, max: 50, step: 1, default: 15,
      label: { es: 'Iteraciones de Lloyd', en: 'Lloyd iterations' },
      help: { es: 'Cada iteración mueve cada punto al centroide ponderado de su celda: el reparto se vuelve uniforme y suave.', en: 'Every iteration moves each point to the weighted centroid of its cell: the distribution becomes even and smooth.' },
    },
    {
      id: 'weighting', type: 'select', default: 'tone',
      options: [
        { value: 'tone', label: { es: 'Tono', en: 'Tone' } },
        { value: 'edges', label: { es: 'Bordes', en: 'Edges' } },
        { value: 'uniform', label: { es: 'Uniforme', en: 'Uniform' } },
      ],
      label: { es: 'Densidad según', en: 'Density from' },
    },
    {
      id: 'gamma', type: 'range', min: 0.5, max: 3, step: 0.05, default: 1.3,
      label: { es: 'Contraste de densidad', en: 'Density contrast' },
      showIf: (p) => p.weighting !== 'uniform',
    },
    {
      id: 'minDot', type: 'range', min: 0.2, max: 4, step: 0.1, default: 0.6, unit: 'px',
      label: { es: 'Punto mínimo', en: 'Minimum dot' },
      showIf: (p) => p.style === 'stipple' || p.style === 'constellation',
    },
    {
      id: 'maxDot', type: 'range', min: 0.5, max: 8, step: 0.1, default: 2.2, unit: 'px',
      label: { es: 'Punto máximo', en: 'Maximum dot' },
      showIf: (p) => p.style === 'stipple' || p.style === 'constellation',
    },
    {
      id: 'edgeLength', type: 'range', min: 5, max: 120, step: 1, default: 32, unit: 'px',
      label: { es: 'Arista máxima', en: 'Maximum edge' },
      showIf: (p) => p.style === 'constellation',
    },
    {
      id: 'border', type: 'toggle', default: true,
      label: { es: 'Bordes', en: 'Borders' },
      showIf: (p) => p.style === 'cells' || p.style === 'lowpoly',
    },
    {
      id: 'borderWidth', type: 'range', min: 0.2, max: 4, step: 0.1, default: 1,
      label: { es: 'Grosor del borde', en: 'Border width' },
      showIf: (p) => (p.style === 'cells' || p.style === 'lowpoly') && p.border,
    },
    {
      id: 'colorFrom', type: 'select', default: 'ink',
      options: [
        { value: 'ink', label: { es: 'Tinta', en: 'Ink' } },
        { value: 'image', label: { es: 'Imagen', en: 'Picture' } },
      ],
      label: { es: 'Color de los puntos', en: 'Dot colour' },
      showIf: (p) => p.style === 'stipple' || p.style === 'constellation',
    },
    { id: 'invert', type: 'toggle', default: false, label: { es: 'Invertir', en: 'Invert' }, showIf: (p) => p.weighting === 'tone' },
    { id: 'ink', type: 'color', default: '#15181e', label: { es: 'Tinta', en: 'Ink' } },
    { id: 'paper', type: 'color', default: '#f3efe4', label: { es: 'Papel', en: 'Paper' } },
    {
      id: 'seed', type: 'seed', default: 11,
      label: { es: 'Semilla', en: 'Seed' },
      help: { es: 'La misma semilla da siempre los mismos puntos.', en: 'The same seed always gives the same points.' },
    },
  ],

  resolution(params, srcW, srcH) {
    return stippleWorkSize(Math.min(LIMITS.maxVoronoiPoints, params.mode.points), srcW, srcH);
  },

  preOptions(params) {
    return { matte: params.mode.paper, edgeBlend: 'dark' };
  },

  init() {
    return { key: '', points: null, colors: null, job: null, scene: null, sceneFor: null, iteration: 0, done: false, cancelled: 0 };
  },

  async render(ctx, state) {
    const p = ctx.params.mode;
    const { LW, LH } = logicalSize(ctx);
    const W = ctx.width;
    const H = ctx.height;
    const ink = normalizeHex(p.ink) || '#15181e';
    const paper = normalizeHex(p.paper) || '#f3efe4';
    const count = Math.max(1, Math.min(LIMITS.maxVoronoiPoints, Math.round(p.points)));
    const iterations = Math.max(0, Math.min(50, Math.round(p.iterations)));
    const needColors = p.style === 'cells';
    const weights = weightsFor(ctx, p, ink, paper);
    const wkey = fieldHash(weights);
    const cfgKey = hashed([W, H, count, p.seed, p.weighting, p.gamma, p.invert && p.weighting === 'tone', ink, paper, needColors]);
    const key = `${cfgKey}#${wkey}#${iterations}`;
    const rgba = needColors ? ctx.rgba : null;
    const payload = (init, its) => ({
      weights, W, H, count, iterations: its, seed: p.seed | 0, init: init || undefined,
      rgba: rgba || undefined, partials: !init,
    });
    const apply = (res) => { state.points = res.points; state.colors = res.colors; state.iteration = res.iterations; state.done = true; };

    if (key !== state.key) {
      const coherent = ctx.isVideo && state.points && state.cfgKey === cfgKey && state.points.length === count * 2 && iterations > 0;
      if (state.job) { state.job.abort(); state.job = null; state.cancelled++; }
      state.key = key;
      state.cfgKey = cfgKey;
      if (coherent) {
        // video: a few iterations from the previous frame's points keep the pattern stable
        apply(await heavy.run('stipple', payload(state.points, Math.min(2, iterations)), { signal: ctx.signal, background: true }));
      } else {
        state.points = Float32Array.from(initialPoints(weights, W, H, count, p.seed | 0));
        state.colors = null;
        state.iteration = 0;
        state.done = iterations === 0 && !needColors;
        if (!state.done) {
          const ac = new AbortController();
          state.job = ac;
          const job = heavy.run('stipple', payload(null, iterations), {
            signal: ac.signal,
            background: true,
            onPartial: (part) => {
              if (state.key !== key) return;
              state.points = part.points;
              state.iteration = part.iteration;
              ctx.invalidate();
            },
          });
          if (!ctx.progressive) {
            apply(await job);
            state.job = null;
          } else {
            job.then((res) => {
              if (state.key !== key) return;
              apply(res);
              state.job = null;
              ctx.invalidate();
            }).catch((err) => { if (!heavy.isAbort(err)) console.warn('[dither] voronoi job failed', err); });
          }
        }
      }
    }

    const sceneKey = hashed([state.key, p.style, p.minDot, p.maxDot, p.edgeLength, p.border, p.borderWidth, p.colorFrom, LW, LH]);
    if (state.sceneFor !== state.points || state.sceneKey !== sceneKey) {
      state.scene = buildScene(ctx, p, state, LW, LH, ink, paper);
      state.sceneFor = state.points;
      state.sceneKey = sceneKey;
    }
    const { g, s } = prepareOutput(ctx, LW, LH);
    drawScene(g, state.scene, s);
    return { cols: count, rows: state.iteration, effectiveScale: s };
  },

  toSVG(state, opts = {}) {
    return state?.scene ? sceneToSVG(state.scene, opts) : '';
  },

  dispose(state) {
    if (state?.job) { state.job.abort(); state.job = null; }
    if (state) { state.points = null; state.scene = null; state.colors = null; state.key = ''; }
  },
};

function buildScene(ctx, p, state, LW, LH, ink, paper) {
  const W = ctx.width;
  const H = ctx.height;
  const kx = LW / W;
  const ky = LH / H;
  const src = state.points;
  const n = src.length >> 1;
  const pts = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) { pts[i * 2] = src[i * 2] * kx; pts[i * 2 + 1] = src[i * 2 + 1] * ky; }
  const rgba = ctx.rgba;
  const colorAt = (x, y) => {
    // mean of a 3 x 3 neighbourhood of work pixels under a logical point
    const cx = Math.min(W - 1, Math.max(0, Math.floor(x / kx)));
    const cy = Math.min(H - 1, Math.max(0, Math.floor(y / ky)));
    let r = 0, g = 0, b = 0, m = 0;
    for (let yy = Math.max(0, cy - 1); yy <= Math.min(H - 1, cy + 1); yy++) {
      for (let xx = Math.max(0, cx - 1); xx <= Math.min(W - 1, cx + 1); xx++) {
        const o = (yy * W + xx) * 4;
        r += rgba[o]; g += rgba[o + 1]; b += rgba[o + 2]; m++;
      }
    }
    return rgbToHex(Math.round(r / m), Math.round(g / m), Math.round(b / m));
  };
  const layers = [];
  const title = `${config.productName} voronoi ${p.style}`;

  if (p.style === 'stipple' || p.style === 'constellation') {
    const tone = toneField(blurField(ctx.luma(), W, H, 1), ink, paper, 1, p.invert);
    const T = fieldSampler(tone, W, H, LW, LH);
    const lo = Math.min(p.minDot, p.maxDot);
    const hi = Math.max(p.minDot, p.maxDot);
    const scale = p.style === 'constellation' ? 0.6 : 1;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    const r = new Float32Array(n);
    const colors = p.colorFrom === 'image' ? new Array(n) : null;
    for (let i = 0; i < n; i++) {
      x[i] = pts[i * 2];
      y[i] = pts[i * 2 + 1];
      const t = p.weighting === 'tone' ? T(x[i], y[i]) : 0.5 + 0.5 * T(x[i], y[i]);
      r[i] = (lo + (hi - lo) * Math.sqrt(Math.max(0, Math.min(1, t)))) * scale;
      if (colors) colors[i] = colorAt(x[i], y[i]);
    }
    if (p.style === 'constellation' && n >= 3) {
      const del = new Delaunay(pts);
      const { triangles, halfedges } = del;
      const buckets = [[], [], [], []];
      const maxL = p.edgeLength;
      for (let e = 0; e < triangles.length; e++) {
        if (e < halfedges[e]) continue; // each edge once (hull edges have halfedges[e] === -1)
        const a = triangles[e];
        const b = triangles[e % 3 === 2 ? e - 2 : e + 1];
        const l = Math.hypot(pts[a * 2] - pts[b * 2], pts[a * 2 + 1] - pts[b * 2 + 1]);
        if (l > maxL) continue;
        const q = Math.min(3, Math.floor((l / maxL) * 4));
        buckets[q].push({ points: new Float32Array([pts[a * 2], pts[a * 2 + 1], pts[b * 2], pts[b * 2 + 1]]), closed: false, opacity: [0.9, 0.65, 0.42, 0.24][q] });
      }
      layers.push({ id: 'edges', label: 'Edges', color: ink, width: 0.6, paths: buckets.flat() });
    }
    layers.push({ id: 'dots', label: p.style === 'stipple' ? 'Stipple' : 'Stars', color: ink, width: 0.3, dots: { x, y, r, count: n, colors } });
  } else if (p.style === 'cells' && n >= 1) {
    const del = new Delaunay(pts);
    const vor = del.voronoi([0, 0, LW, LH]);
    const shapes = [];
    for (let i = 0; i < n; i++) {
      const poly = vor.cellPolygon(i);
      if (!poly || poly.length < 4) continue;
      const ring = new Float32Array((poly.length - 1) * 2);
      for (let k = 0; k < poly.length - 1; k++) { ring[k * 2] = poly[k][0]; ring[k * 2 + 1] = poly[k][1]; }
      const c = state.colors && state.colors.length === n * 3
        ? rgbToHex(state.colors[i * 3], state.colors[i * 3 + 1], state.colors[i * 3 + 2])
        : colorAt(pts[i * 2], pts[i * 2 + 1]);
      shapes.push({ rings: [ring], fill: c });
    }
    layers.push({ id: 'cells', label: 'Cells', color: ink, width: 0.5, seal: 0.6, shapes, plotter: p.border ? 'skip' : 'outline' });
    if (p.border) {
      const col = collector();
      vor.render(col);
      layers.push({ id: 'borders', label: 'Borders', color: ink, width: p.borderWidth, paths: toPaths(col.lines) });
    }
  } else if (p.style === 'lowpoly' && n >= 3) {
    // frame points (corners and along the edges) so the triangulation covers the whole picture
    const step = Math.max(8, Math.sqrt((LW * LH) / n) * 1.3);
    const frame = [];
    const nx = Math.max(1, Math.round(LW / step));
    const ny = Math.max(1, Math.round(LH / step));
    for (let i = 0; i <= nx; i++) frame.push((i * LW) / nx, 0, (i * LW) / nx, LH);
    for (let j = 1; j < ny; j++) frame.push(0, (j * LH) / ny, LW, (j * LH) / ny);
    const all = new Float64Array(pts.length + frame.length);
    all.set(pts);
    all.set(frame, pts.length);
    const del = new Delaunay(all);
    const pts2 = all;
    const t = del.triangles;
    const shapes = [];
    for (let k = 0; k < t.length; k += 3) {
      const a = t[k], b = t[k + 1], c = t[k + 2];
      const ring = new Float32Array([pts2[a * 2], pts2[a * 2 + 1], pts2[b * 2], pts2[b * 2 + 1], pts2[c * 2], pts2[c * 2 + 1]]);
      const cx = (ring[0] + ring[2] + ring[4]) / 3;
      const cy = (ring[1] + ring[3] + ring[5]) / 3;
      shapes.push({ rings: [ring], fill: colorAt(cx, cy) });
    }
    layers.push({ id: 'triangles', label: 'Triangles', color: ink, width: 0.5, seal: 0.6, shapes, plotter: p.border ? 'skip' : 'outline' });
    if (p.border) {
      const col = collector();
      del.render(col);
      layers.push({ id: 'edges', label: 'Edges', color: ink, width: p.borderWidth, paths: toPaths(col.lines) });
    }
  }
  return { width: LW, height: LH, background: paper, layers, title, desc: `${n} points, ${state.iteration} Lloyd iterations` };
}

export default MODE;
