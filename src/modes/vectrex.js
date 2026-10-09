// Vectrex-style vector wireframe (PLAN.md 7.19): bright lines on black with phosphor glow, animated.
// Sub-styles:
//  - Terrain: N horizontal lines lifted by the picture's brightness, with "Unknown Pleasures" hidden-line removal
//    done geometrically (a horizon kept from the front line to the back one), so it also holds in SVG / plotter.
//  - Contours: a few iso-lines of the smoothed picture.
//  - Mesh: the picture as a height map, a wire grid seen in perspective.
// Motion (`wave`: a travelling ripple, or a slow camera sway for the mesh), `jitter` and `flicker` are functions of
// (seed, time). Phosphor persistence redraws the frames of the previous instants (t - k/30 s) with alpha
// persistence^k, so the trail is also a pure function of time: exports and tests are deterministic.
// Glow: the lines are added ('lighter') over black, plus two blurred copies (quarter and eighth size) for the bloom.

import { marchingSquares, chaikin, simplify } from '../engine/geometry.js';
import { hash01 } from '../engine/rand.js';
import {
  logicalSize, workResolution, prepareOutput, fieldSampler, blurField, fieldHash, hashed,
} from '../engine/vector.js';
import { normalizeHex } from '../engine/color.js';
import { sceneToSVG } from '../io/exportSVG.js';
import { config } from '../config.js';

const WORK_LONG = 360;
const TICKS = 30; // phosphor / jitter ticks per second
const BG = '#020308';

export const PHOSPHORS = {
  white: { hex: '#cfe8ff', name: { es: 'Blanco azulado', en: 'Blue white' } },
  green: { hex: '#39ff6a', name: { es: 'Verde', en: 'Green' } },
  amber: { hex: '#ffb000', name: { es: 'Ámbar', en: 'Amber' } },
  red: { hex: '#ff5a4a', name: { es: 'Rojo', en: 'Red' } },
};

/** Picture-dependent data, cached: the height field sampler, and contour lines for the contour style. */
function basis(ctx, p, LW, LH, cache) {
  const W = ctx.width;
  const H = ctx.height;
  const luma = ctx.luma();
  const key = hashed([fieldHash(luma, 3), W, H, LW, LH, p.smooth, p.style, p.style === 'contours' ? p.lines : 0]);
  if (cache.key === key) return cache;
  const f = blurField(luma, W, H, p.smooth);
  cache.h = fieldSampler(f, W, H, LW, LH);
  cache.contours = null;
  if (p.style === 'contours') {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < f.length; i++) { if (f[i] < lo) lo = f[i]; if (f[i] > hi) hi = f[i]; }
    const span = hi - lo > 1e-6 ? hi - lo : 1;
    const levels = Math.max(3, Math.min(24, Math.round(p.lines / 5)));
    const kx = LW / (W - 1);
    const ky = LH / (H - 1);
    const out = [];
    for (let k = 1; k <= levels; k++) {
      const lv = lo + (span * (k - 0.5)) / levels;
      for (const pl of marchingSquares(f, W, H, lv)) {
        const pts = pl.points;
        for (let i = 0; i < pts.length; i += 2) { pts[i] *= kx; pts[i + 1] *= ky; }
        if (pts.length < 8) continue;
        out.push({ points: simplify(chaikin(pts, pl.closed, 1), 0.25), closed: pl.closed, level: k });
      }
    }
    cache.contours = out;
  }
  cache.key = key;
  return cache;
}

/** Terrain lines at time t, with hidden-line removal (front to back, keeping the horizon). */
function terrain(p, B, LW, LH, t) {
  const N = Math.max(2, Math.round(p.lines));
  const step = 4;
  const nx = Math.ceil(LW / step) + 1;
  const top = Math.min(LH * 0.35, p.displacement * 0.55 + 12);
  const horizon = new Float32Array(nx).fill(Infinity);
  const ys = new Float32Array(nx);
  const out = [];
  for (let k = N - 1; k >= 0; k--) {
    const base = top + ((LH - top - 8) * k) / (N - 1);
    const row = (LH * k) / (N - 1);
    for (let i = 0; i < nx; i++) {
      const x = Math.min(LW, i * step);
      let h = B.h(x, row);
      if (p.wave > 0) h += p.wave * 0.18 * Math.sin((x / LW) * 9.4 + k * 0.21 - t * 2.3) * (0.4 + h);
      ys[i] = base - p.displacement * h;
    }
    if (!p.occlusion) {
      const pts = new Float32Array(nx * 2);
      for (let i = 0; i < nx; i++) { pts[i * 2] = Math.min(LW, i * step); pts[i * 2 + 1] = ys[i]; }
      out.push({ points: pts, closed: false, line: k });
      continue;
    }
    // visible where the line is above the horizon of the lines in front (smaller y = higher on screen); after the
    // front line the horizon is finite everywhere, so every change of visibility has a crossing to interpolate
    let cur = null;
    let prev = false;
    const flush = () => { if (cur && cur.length >= 4) out.push({ points: Float32Array.from(cur), closed: false, line: k }); cur = null; };
    for (let i = 0; i < nx; i++) {
      const x = Math.min(LW, i * step);
      const vis = ys[i] < horizon[i] - 0.01;
      if (i > 0 && vis !== prev && Number.isFinite(horizon[i]) && Number.isFinite(horizon[i - 1])) {
        const da = horizon[i - 1] - ys[i - 1];
        const db = horizon[i] - ys[i];
        const u = Math.max(0, Math.min(1, da / (da - db || 1e-9)));
        const cx = Math.min(LW, (i - 1 + u) * step);
        const cy = ys[i - 1] + (ys[i] - ys[i - 1]) * u;
        if (vis) cur = [cx, cy]; else { if (cur) cur.push(cx, cy); flush(); }
      } else if (!vis && prev) flush();
      if (vis) { if (!cur) cur = []; cur.push(x, ys[i]); }
      prev = vis;
    }
    flush();
    for (let i = 0; i < nx; i++) if (ys[i] < horizon[i]) horizon[i] = ys[i];
  }
  return out.filter((l) => l.points.length >= 4);
}

/** Wire mesh in perspective at time t (the camera sways with `wave`). */
function mesh(p, B, LW, LH, t) {
  const rows = Math.max(4, Math.round(p.lines / 2));
  const cols = Math.max(4, Math.round((rows * LW) / LH));
  const aspect = LW / LH;
  const tilt = (p.tilt * Math.PI) / 180;
  const yaw = p.wave * 0.35 * Math.sin(t * 0.5);
  const ct = Math.cos(tilt), st = Math.sin(tilt), cy = Math.cos(yaw), sy = Math.sin(yaw);
  const amp = (p.displacement / LH) * 3;
  const dist = 3.4;
  const scale = Math.min(LW / (2 * aspect), LH / 2) * 0.86;
  const P = new Float32Array((rows + 1) * (cols + 1) * 2);
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const u = i / cols;
      const v = j / rows;
      let X = (u * 2 - 1) * aspect;
      let Z = v * 2 - 1;
      const Y = amp * B.h(u * LW, v * LH);
      // yaw around the vertical axis, then tilt the ground plane towards the viewer
      const x1 = X * cy - Z * sy;
      const z1 = X * sy + Z * cy;
      X = x1;
      Z = z1;
      const y2 = Y * ct + Z * st;
      const z2 = -Y * st + Z * ct;
      const w = dist + z2;
      const k = (j * (cols + 1) + i) * 2;
      P[k] = LW / 2 + (X / w) * scale * dist;
      P[k + 1] = LH * 0.53 - (y2 / w) * scale * dist * 1.1;
    }
  }
  const out = [];
  for (let j = 0; j <= rows; j++) {
    const pts = new Float32Array((cols + 1) * 2);
    for (let i = 0; i <= cols; i++) { const k = (j * (cols + 1) + i) * 2; pts[i * 2] = P[k]; pts[i * 2 + 1] = P[k + 1]; }
    out.push({ points: pts, closed: false, line: j });
  }
  for (let i = 0; i <= cols; i++) {
    const pts = new Float32Array((rows + 1) * 2);
    for (let j = 0; j <= rows; j++) { const k = (j * (cols + 1) + i) * 2; pts[j * 2] = P[k]; pts[j * 2 + 1] = P[k + 1]; }
    out.push({ points: pts, closed: false, line: rows + 1 + i });
  }
  return out;
}

/** Contours with a travelling ripple at time t. */
function contours(p, B, LW, LH, t) {
  const amp = p.wave * 7;
  if (amp === 0) return B.contours;
  return B.contours.map((l) => {
    const pts = new Float32Array(l.points.length);
    for (let i = 0; i < pts.length; i += 2) {
      const x = l.points[i];
      const y = l.points[i + 1];
      pts[i] = x;
      pts[i + 1] = y + amp * Math.sin(x * 0.018 + y * 0.006 - t * 2.4 + l.level * 0.5);
    }
    return { ...l, points: pts };
  });
}

/** All lines at time t, with the jitter of that tick. */
function linesAt(p, B, LW, LH, t) {
  const lines = p.style === 'mesh' ? mesh(p, B, LW, LH, t) : p.style === 'contours' ? contours(p, B, LW, LH, t) : terrain(p, B, LW, LH, t);
  if (!(p.jitter > 0)) return lines;
  const tick = Math.floor(t * TICKS + 1e-6);
  const seed = p.seed | 0;
  return lines.map((l) => {
    const dx = (hash01(seed, l.line ?? 0, tick, 1) - 0.5) * 2 * p.jitter;
    const dy = (hash01(seed, l.line ?? 0, tick, 2) - 0.5) * 2 * p.jitter;
    const pts = new Float32Array(l.points.length);
    for (let i = 0; i < pts.length; i += 2) { pts[i] = l.points[i] + dx; pts[i + 1] = l.points[i + 1] + dy; }
    return { ...l, points: pts };
  });
}

const MODE = {
  id: 'vectrex',
  category: 'vector',
  name: { es: 'Vectrex', en: 'Vectrex' },
  blurb: { es: 'Líneas vectoriales brillantes con fósforo persistente', en: 'Glowing vector lines with phosphor persistence' },
  badges: ['SVG', 'ANIM'],
  animated: true,
  uses: ['image'],
  exports: ['png', 'svg', 'video'],
  svgOptions: true,
  draftScale: 1,
  hide: ['cols', 'dither', 'serpentine'],

  presets: [
    { id: 'pleasures', name: { es: 'Unknown Pleasures', en: 'Unknown Pleasures' }, mode: { style: 'terrain', lines: 70, displacement: 70, phosphor: 'white', occlusion: true, glow: 0.5, persistence: 0.5 } },
    { id: 'radar', name: { es: 'Radar verde', en: 'Green radar' }, mode: { style: 'contours', lines: 50, phosphor: 'green', glow: 0.8, persistence: 0.75, wave: 0.4 } },
    { id: 'grid', name: { es: 'Rejilla arcade', en: 'Arcade grid' }, mode: { style: 'mesh', lines: 60, displacement: 90, tilt: 58, phosphor: 'white', overlay: true, glow: 0.7 } },
  ],

  params: [
    {
      id: 'style', type: 'select', default: 'terrain',
      options: [
        { value: 'terrain', label: { es: 'Terreno', en: 'Terrain' } },
        { value: 'contours', label: { es: 'Contornos', en: 'Contours' } },
        { value: 'mesh', label: { es: 'Malla', en: 'Mesh' } },
      ],
      label: { es: 'Estilo', en: 'Style' },
    },
    {
      id: 'lines', type: 'range', min: 10, max: 200, step: 1, default: 60,
      label: { es: 'Líneas', en: 'Lines' },
      help: { es: 'Líneas del terreno, filas de la malla o (÷5) niveles de contorno.', en: 'Terrain lines, mesh rows or (÷5) contour levels.' },
    },
    {
      id: 'displacement', type: 'range', min: 0, max: 200, step: 1, default: 60, unit: 'px',
      label: { es: 'Desplazamiento', en: 'Displacement' },
      showIf: (p) => p.style !== 'contours',
    },
    {
      id: 'tilt', type: 'range', min: 0, max: 80, step: 1, default: 55, unit: '°',
      label: { es: 'Inclinación', en: 'Tilt' },
      showIf: (p) => p.style === 'mesh',
    },
    {
      id: 'occlusion', type: 'toggle', default: true,
      label: { es: 'Ocultar líneas', en: 'Hidden lines' },
      help: { es: 'Cada línea tapa las de detrás (como la portada de Unknown Pleasures).', en: 'Each line hides the ones behind it (like the Unknown Pleasures cover).' },
      showIf: (p) => p.style === 'terrain',
    },
    {
      id: 'smooth', type: 'range', min: 0, max: 10, step: 0.5, default: 2,
      label: { es: 'Suavizado', en: 'Smoothing' },
    },
    { id: 'lineWidth', type: 'range', min: 0.5, max: 4, step: 0.1, default: 1.4, unit: 'px', label: { es: 'Grosor', en: 'Line width' } },
    { id: 'glow', type: 'range', min: 0, max: 1, step: 0.05, default: 0.6, label: { es: 'Resplandor', en: 'Glow' } },
    {
      id: 'phosphor', type: 'select', default: 'white',
      options: [...Object.entries(PHOSPHORS).map(([value, v]) => ({ value, label: v.name })), { value: 'custom', label: { es: 'Personalizado', en: 'Custom' } }],
      label: { es: 'Fósforo', en: 'Phosphor' },
    },
    { id: 'ink', type: 'color', default: '#cfe8ff', label: { es: 'Color', en: 'Colour' }, showIf: (p) => p.phosphor === 'custom' },
    {
      id: 'persistence', type: 'range', min: 0, max: 0.95, step: 0.05, default: 0.6,
      label: { es: 'Persistencia', en: 'Persistence' },
      help: { es: 'Estela de fósforo: los instantes anteriores siguen brillando un poco.', en: 'Phosphor trail: the previous instants keep glowing for a while.' },
    },
    {
      id: 'wave', type: 'range', min: 0, max: 1, step: 0.05, default: 0.3,
      label: { es: 'Ondulación', en: 'Wave' },
      help: { es: 'Movimiento: una onda que recorre las líneas (en la malla, la cámara se balancea).', en: 'Motion: a wave running through the lines (the mesh camera sways).' },
    },
    { id: 'jitter', type: 'range', min: 0, max: 2, step: 0.05, default: 0.4, unit: 'px', label: { es: 'Temblor', en: 'Jitter' } },
    { id: 'flicker', type: 'range', min: 0, max: 1, step: 0.05, default: 0.15, label: { es: 'Parpadeo', en: 'Flicker' } },
    {
      id: 'overlay', type: 'toggle', default: false,
      label: { es: 'Lámina de color', en: 'Colour overlay' },
      help: { es: 'Degradado de color sobre la pantalla, como las láminas de plástico de la Vectrex.', en: 'A colour gradient over the screen, like the plastic Vectrex overlays.' },
    },
    { id: 'seed', type: 'seed', default: 5, label: { es: 'Semilla', en: 'Seed' } },
  ],

  resolution(params, srcW, srcH) {
    return workResolution(srcW, srcH, WORK_LONG);
  },

  preOptions() {
    return { matte: '#000000', edgeBlend: 'light' };
  },

  init() {
    return { cache: {}, core: null, small: null, large: null, scene: null };
  },

  render(ctx, state) {
    const p = ctx.params.mode;
    const { LW, LH } = logicalSize(ctx);
    const ink = p.phosphor === 'custom' ? normalizeHex(p.ink) || '#cfe8ff' : PHOSPHORS[p.phosphor]?.hex || PHOSPHORS.white.hex;
    const B = basis(ctx, p, LW, LH, state.cache);
    const t = ctx.time || 0;
    const seed = p.seed | 0;
    const now = linesAt(p, B, LW, LH, t);

    const { g, s, CW, CH } = prepareOutput(ctx, LW, LH);
    // lines are added on their own canvas (black), so glow and overlay only touch the light
    if (!state.core) state.core = document.createElement('canvas');
    const core = state.core;
    if (core.width !== CW || core.height !== CH) { core.width = CW; core.height = CH; }
    const cg = core.getContext('2d');
    cg.setTransform(1, 0, 0, 1, 0, 0);
    cg.globalCompositeOperation = 'source-over';
    cg.globalAlpha = 1;
    cg.fillStyle = '#000000';
    cg.fillRect(0, 0, CW, CH);
    cg.setTransform(s, 0, 0, s, 0, 0);
    cg.globalCompositeOperation = 'lighter';
    cg.lineCap = 'round';
    cg.lineJoin = 'round';
    cg.strokeStyle = ink;
    const stroke = (target, lines, alpha, width) => {
      const path = new Path2D();
      for (const l of lines) {
        const q = l.points;
        path.moveTo(q[0], q[1]);
        for (let i = 2; i < q.length; i += 2) path.lineTo(q[i], q[i + 1]);
        if (l.closed) path.closePath();
      }
      target.globalAlpha = Math.max(0, Math.min(1, alpha));
      target.lineWidth = width;
      target.stroke(path);
    };
    // phosphor persistence: earlier instants, oldest first, on a half-size canvas (they are dim and soft anyway)
    const ghosts = p.persistence > 0 ? Math.min(5, Math.floor(Math.log(0.06) / Math.log(p.persistence))) : 0;
    if (ghosts > 0) {
      if (!state.ghost) state.ghost = document.createElement('canvas');
      const gc = state.ghost;
      const gw = Math.max(1, Math.round(CW / 2));
      const gh = Math.max(1, Math.round(CH / 2));
      if (gc.width !== gw || gc.height !== gh) { gc.width = gw; gc.height = gh; }
      const gg = gc.getContext('2d');
      gg.setTransform(1, 0, 0, 1, 0, 0);
      gg.globalCompositeOperation = 'source-over';
      gg.globalAlpha = 1;
      gg.fillStyle = '#000000';
      gg.fillRect(0, 0, gw, gh);
      gg.setTransform(s / 2, 0, 0, s / 2, 0, 0);
      gg.globalCompositeOperation = 'lighter';
      gg.lineCap = 'round';
      gg.lineJoin = 'round';
      gg.strokeStyle = ink;
      for (let k = ghosts; k >= 1; k--) {
        const tk = t - k / TICKS;
        stroke(gg, linesAt(p, B, LW, LH, tk), 0.85 * p.persistence ** k * intensity(p, seed, tk), p.lineWidth);
      }
      cg.save();
      cg.setTransform(1, 0, 0, 1, 0, 0);
      cg.globalAlpha = 1;
      cg.imageSmoothingEnabled = true;
      cg.drawImage(gc, 0, 0, CW, CH);
      cg.restore();
    }
    const I = intensity(p, seed, t);
    stroke(cg, now, 0.9 * I, p.lineWidth);
    stroke(cg, now, 0.3 * I, p.lineWidth * 0.45); // hot core

    g.fillStyle = BG;
    g.fillRect(0, 0, CW, CH);
    g.globalCompositeOperation = 'lighter';
    g.drawImage(core, 0, 0);
    if (p.glow > 0) {
      for (const [div, amount, slot] of [[4, 1.3, 'small'], [10, 1.6, 'large']]) {
        if (!state[slot]) state[slot] = document.createElement('canvas');
        const c = state[slot];
        const w = Math.max(1, Math.round(CW / div));
        const h = Math.max(1, Math.round(CH / div));
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        const sg = c.getContext('2d');
        sg.imageSmoothingEnabled = true;
        sg.imageSmoothingQuality = 'high';
        sg.globalCompositeOperation = 'source-over';
        sg.clearRect(0, 0, w, h);
        sg.drawImage(core, 0, 0, w, h);
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        // more than full strength = the blurred copy added twice
        for (let left = p.glow * amount; left > 0.001; left -= 1) {
          g.globalAlpha = Math.min(1, left);
          g.drawImage(c, 0, 0, CW, CH);
        }
      }
      g.globalAlpha = 1;
    }
    if (p.overlay) {
      g.globalCompositeOperation = 'multiply';
      const grad = g.createLinearGradient(0, 0, 0, CH);
      grad.addColorStop(0, '#ff5adc');
      grad.addColorStop(0.5, '#5ae8ff');
      grad.addColorStop(1, '#c4f169');
      g.fillStyle = grad;
      g.fillRect(0, 0, CW, CH);
    }
    g.globalCompositeOperation = 'source-over';

    state.scene = {
      width: LW, height: LH, background: BG,
      layers: [{ id: 'vectors', label: `Vectors (${p.style})`, color: ink, width: p.lineWidth, paths: now.map((l) => ({ points: l.points, closed: !!l.closed })) }],
      title: `${config.productName} vectrex ${p.style}`, desc: `t = ${t.toFixed(3)} s`,
    };
    return { cols: now.length, rows: Math.floor(t * TICKS + 1e-6), effectiveScale: s };
  },

  toSVG(state, opts = {}) {
    return state?.scene ? sceneToSVG(state.scene, opts) : '';
  },

  dispose(state) {
    for (const k of ['core', 'ghost', 'small', 'large']) if (state?.[k]) { state[k].width = state[k].height = 1; state[k] = null; }
    if (state) { state.cache = {}; state.scene = null; }
  },
};

/** Beam intensity of a tick: 1 minus a random dip (flicker). */
function intensity(p, seed, t) {
  if (!(p.flicker > 0)) return 1;
  const tick = Math.floor(t * TICKS + 1e-6);
  return 1 - p.flicker * 0.55 * hash01(seed, tick, 3, 9);
}

export default MODE;
