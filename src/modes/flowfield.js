// Vector fields and particle flow (PLAN.md 7.17), animated.
// The velocity at a point mixes curl noise (the curl of a seeded 3D simplex potential over x, y and time: smooth and
// divergence-free) with the direction of the picture's contours (perpendicular to the luminance gradient, sign
// aligned with the noise), weighted by `imageFollow` and by how strong the gradient is there. Particles are born with
// a probability proportional to the "presence" of the picture (dark areas on light paper, bright areas on dark
// paper), slow down where it is present (so strokes gather there) and are more opaque there.
//
// Deterministic by construction: particle slot i lives successive lives of ~`lifespan` steps (30 steps per second);
// the life and age at time t, the birth position (seeded rejection sampling) and the path (integrated from birth in
// the field of time t) are pure functions of (seed, time, parameters, picture). The trail fades like a persistent
// canvas with `fade` (alpha (1 - fade)^age of each point), so the look of accumulated strokes is reproduced without
// keeping pixels between frames: exports at the frame time and the tests give identical pictures.
// SVG: the trajectories of the first `svgParticles` particles followed for `svgSteps` steps from where they are.

import { createNoise } from '../engine/noise.js';
import { hash01 } from '../engine/rand.js';
import { simplify } from '../engine/geometry.js';
import {
  logicalSize, workResolution, prepareOutput, fieldSampler, blurField, hexLuma, fieldHash,
} from '../engine/vector.js';
import { PALETTES } from '../engine/palettes.js';
import { normalizeHex, rgbToHex } from '../engine/color.js';
import { sceneToSVG } from '../io/exportSVG.js';
import { LIMITS, config } from '../config.js';

const STEPS_PER_SECOND = 30;
const GRID = 4; // logical px per field cell
const WORK_LONG = 360;
const ALPHA_LEVELS = 8;
const PREVIEW_BUDGET = 2.2e6; // particle steps per preview frame

/** The velocity field of one instant: unit directions (fx, fy) and speed on a grid of GRID logical px. */
function buildField(p, ctx, LW, LH, time, cache) {
  const W = ctx.width;
  const H = ctx.height;
  const luma = ctx.luma();
  const darkPaper = hexLuma(normalizeHex(p.paper) || '#0e1014') < 0.5;
  // picture-dependent parts are cached per frame (they do not depend on time)
  const pkey = `${W}x${H}|${LW}x${LH}|${darkPaper}|${fieldHash(luma, 3)}`;
  if (cache.pkey !== pkey) {
    const presence = new Float32Array(W * H);
    for (let i = 0; i < presence.length; i++) presence[i] = darkPaper ? luma[i] : 1 - luma[i];
    const sm = blurField(luma, W, H, 3);
    const cx = new Float32Array(W * H);
    const cy = new Float32Array(W * H);
    const mag = new Float32Array(W * H);
    let max = 1e-6;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const gx = sm[y * W + Math.min(W - 1, x + 1)] - sm[y * W + Math.max(0, x - 1)];
        const gy = sm[Math.min(H - 1, y + 1) * W + x] - sm[Math.max(0, y - 1) * W + x];
        const m = Math.hypot(gx, gy);
        const i = y * W + x;
        mag[i] = m;
        if (m > max) max = m;
        if (m > 1e-9) { cx[i] = -gy / m; cy[i] = gx / m; }
      }
    }
    for (let i = 0; i < mag.length; i++) mag[i] = Math.min(1, mag[i] / (max * 0.35));
    cache.P = fieldSampler(presence, W, H, LW, LH);
    cache.CX = fieldSampler(cx, W, H, LW, LH);
    cache.CY = fieldSampler(cy, W, H, LW, LH);
    cache.M = fieldSampler(mag, W, H, LW, LH);
    cache.pkey = pkey;
  }
  const gw = Math.ceil(LW / GRID) + 1;
  const gh = Math.ceil(LH / GRID) + 1;
  // picture terms on the grid (contour direction, its strength, presence), once per picture
  const gkey = `${pkey}|${gw}x${gh}`;
  if (cache.gkey !== gkey) {
    cache.gCX = new Float32Array(gw * gh);
    cache.gCY = new Float32Array(gw * gh);
    cache.gM = new Float32Array(gw * gh);
    cache.gP = new Float32Array(gw * gh);
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const x = Math.min(LW, i * GRID);
        const y = Math.min(LH, j * GRID);
        const k = j * gw + i;
        cache.gCX[k] = cache.CX(x, y);
        cache.gCY[k] = cache.CY(x, y);
        cache.gM[k] = cache.M(x, y);
        cache.gP[k] = cache.P(x, y);
      }
    }
    cache.gkey = gkey;
  }
  const fx = new Float32Array(gw * gh);
  const fy = new Float32Array(gw * gh);
  const sp = new Float32Array(gw * gh);
  const noise = cache.noiseSeed === p.seed && cache.noise ? cache.noise : (cache.noise = createNoise(p.seed), cache.noiseSeed = p.seed, cache.noise);
  // curl noise: the velocity is the curl of a scalar noise potential, so it is divergence-free (no sinks where all
  // particles would pile up) and swirls smoothly; the potential lives on the grid nodes plus a one-cell border
  const ns = p.noiseScale;
  const z = time * p.zSpeed;
  const pw = gw + 2;
  const pot = new Float32Array(pw * (gh + 2));
  for (let j = 0; j < gh + 2; j++) {
    for (let i = 0; i < pw; i++) pot[j * pw + i] = noise.noise3((i - 1) * GRID * ns, (j - 1) * GRID * ns, z);
  }
  const follow = p.imageFollow;
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const q = (j + 1) * pw + (i + 1);
      let vx = pot[q + pw] - pot[q - pw];
      let vy = pot[q - 1] - pot[q + 1];
      const l0 = Math.hypot(vx, vy);
      if (l0 > 1e-12) { vx /= l0; vy /= l0; } else { vx = 1; vy = 0; }
      const k = j * gw + i;
      const m = follow * cache.gM[k];
      if (m > 0) {
        let ux = cache.gCX[k];
        let uy = cache.gCY[k];
        if (ux * vx + uy * vy < 0) { ux = -ux; uy = -uy; }
        vx = vx * (1 - m) + ux * m;
        vy = vy * (1 - m) + uy * m;
        const l = Math.hypot(vx, vy) || 1;
        vx /= l; vy /= l;
      }
      fx[k] = vx;
      fy[k] = vy;
      // particles linger where the picture is present (denser strokes there), and hurry through the rest
      sp[k] = p.speed * (1.15 - 0.75 * cache.gP[k]);
    }
  }
  return { fx, fy, sp, gw, gh, LW, LH, P: cache.P };
}

/** Bilinear sample of the field grid at logical (x, y) into out[0..2] (direction x, direction y, speed). */
function sampleField(F, x, y, out) {
  let gx = x / GRID;
  let gy = y / GRID;
  gx = gx < 0 ? 0 : gx > F.gw - 1.001 ? F.gw - 1.001 : gx;
  gy = gy < 0 ? 0 : gy > F.gh - 1.001 ? F.gh - 1.001 : gy;
  const x0 = gx | 0;
  const y0 = gy | 0;
  const tx = gx - x0;
  const ty = gy - y0;
  const i = y0 * F.gw + x0;
  const j = i + F.gw;
  const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
  out[0] = F.fx[i] * w00 + F.fx[i + 1] * w10 + F.fx[j] * w01 + F.fx[j + 1] * w11;
  out[1] = F.fy[i] * w00 + F.fy[i + 1] * w10 + F.fy[j] * w01 + F.fy[j + 1] * w11;
  out[2] = F.sp[i] * w00 + F.sp[i + 1] * w10 + F.sp[j] * w01 + F.sp[j + 1] * w11;
}

/** Life of particle slot i at simulation step n: { life, age, length }. */
export function particleLife(seed, i, n, lifespan) {
  const L = Math.max(4, Math.round(lifespan * (0.6 + 0.8 * hash01(seed, i, 1))));
  const u = n + Math.floor(hash01(seed, i, 2) * L);
  const life = Math.floor(u / L);
  return { life, age: u - life * L, length: L };
}

/** Birth position of (slot, life): rejection sampling on the presence field, seeded. */
function birth(seed, i, life, F) {
  let x = 0;
  let y = 0;
  for (let k = 0; k < 8; k++) {
    x = hash01(seed, i, life, 10 + 2 * k) * F.LW;
    y = hash01(seed, i, life, 11 + 2 * k) * F.LH;
    if (hash01(seed, i, life, 40 + k) < 0.08 + 0.92 * F.P(x, y)) break;
  }
  return [x, y];
}

/** Integrate `steps` steps from (x, y); writes points into buf, returns the number of points (stops at the border). */
function trace(F, x, y, steps, buf, tmp) {
  buf[0] = x;
  buf[1] = y;
  let n = 1;
  for (let s = 0; s < steps; s++) {
    sampleField(F, x, y, tmp);
    x += tmp[0] * tmp[2];
    y += tmp[1] * tmp[2];
    if (x < 0 || y < 0 || x > F.LW || y > F.LH) break;
    buf[n * 2] = x;
    buf[n * 2 + 1] = y;
    n++;
  }
  return n;
}

const PALETTE_IDS = Object.keys(PALETTES);

const MODE = {
  id: 'flowfield',
  category: 'vector',
  name: { es: 'Campos de flujo', en: 'Flow field' },
  blurb: { es: 'Partículas que fluyen por un campo de ruido y por los contornos de la imagen', en: 'Particles flowing through a noise field and the contours of the picture' },
  badges: ['SVG', 'ANIM'],
  animated: true,
  uses: ['image'],
  exports: ['png', 'svg', 'video'],
  svgOptions: true,
  draftScale: 1,
  hide: ['cols', 'dither', 'serpentine'],

  presets: [
    { id: 'silk', name: { es: 'Seda', en: 'Silk' }, mode: { particles: 8000, imageFollow: 0.85, speed: 1.2, lifespan: 160, fade: 0.015, strokeWidth: 0.8, colorFrom: 'image', paper: '#0e1014' } },
    { id: 'ink', name: { es: 'Tinta', en: 'Ink drawing' }, mode: { particles: 5000, imageFollow: 0.6, speed: 1.6, lifespan: 120, fade: 0.01, colorFrom: 'ink', ink: '#15181e', paper: '#f3efe4', strokeWidth: 0.7 } },
    { id: 'storm', name: { es: 'Tormenta', en: 'Storm' }, mode: { particles: 12000, noiseScale: 0.012, imageFollow: 0.3, speed: 3, lifespan: 60, fade: 0.06, colorFrom: 'palette', palette: 'sweetie16', zSpeed: 0.8 } },
  ],

  params: [
    { id: 'particles', type: 'range', min: 500, max: 50000, step: 100, default: 6000, label: { es: 'Partículas', en: 'Particles' } },
    {
      id: 'noiseScale', type: 'range', min: 0.001, max: 0.05, step: 0.001, default: 0.005,
      label: { es: 'Escala del ruido', en: 'Noise scale' },
      help: { es: 'Frecuencia del campo de ruido: valores bajos, remolinos grandes.', en: 'Frequency of the noise field: low values, large swirls.' },
    },
    {
      id: 'imageFollow', type: 'range', min: 0, max: 1, step: 0.05, default: 0.7,
      label: { es: 'Seguir la imagen', en: 'Follow the picture' },
      help: { es: 'Cuánto siguen las partículas los contornos de la imagen en lugar del ruido.', en: 'How much the particles follow the contours of the picture instead of the noise.' },
    },
    { id: 'speed', type: 'range', min: 0.2, max: 5, step: 0.1, default: 1.5, label: { es: 'Velocidad', en: 'Speed' } },
    { id: 'lifespan', type: 'range', min: 20, max: 500, step: 5, default: 120, label: { es: 'Vida', en: 'Lifespan' } },
    {
      id: 'fade', type: 'range', min: 0, max: 0.2, step: 0.005, default: 0.02,
      label: { es: 'Desvanecimiento', en: 'Fade' },
      help: { es: 'Cuánto se borran las estelas en cada paso; 0 = la estela entera de cada vida.', en: 'How much the trails fade at every step; 0 = the whole trail of each life.' },
    },
    { id: 'strokeWidth', type: 'range', min: 0.3, max: 3, step: 0.05, default: 1, unit: 'px', label: { es: 'Grosor', en: 'Stroke width' } },
    {
      id: 'zSpeed', type: 'range', min: 0, max: 2, step: 0.05, default: 0.25,
      label: { es: 'Evolución del ruido', en: 'Noise evolution' },
    },
    {
      id: 'colorFrom', type: 'select', default: 'image',
      options: [
        { value: 'image', label: { es: 'Imagen', en: 'Picture' } },
        { value: 'palette', label: { es: 'Paleta', en: 'Palette' } },
        { value: 'ink', label: { es: 'Tinta', en: 'Ink' } },
      ],
      label: { es: 'Color', en: 'Colour' },
    },
    {
      id: 'palette', type: 'select', default: 'sweetie16',
      options: PALETTE_IDS.map((value) => ({ value, label: PALETTES[value].name })),
      label: { es: 'Paleta', en: 'Palette' },
      showIf: (p) => p.colorFrom === 'palette',
    },
    { id: 'ink', type: 'color', default: '#c4f169', label: { es: 'Tinta', en: 'Ink' }, showIf: (p) => p.colorFrom === 'ink' },
    { id: 'paper', type: 'color', default: '#0e1014', label: { es: 'Fondo', en: 'Background' } },
    {
      id: 'svgParticles', type: 'range', min: 100, max: 3000, step: 50, default: 1500,
      label: { es: 'Trayectorias en el SVG', en: 'SVG trajectories' },
    },
    {
      id: 'svgSteps', type: 'range', min: 20, max: 500, step: 10, default: 160,
      label: { es: 'Pasos por trayectoria (SVG)', en: 'Steps per trajectory (SVG)' },
    },
    {
      id: 'seed', type: 'seed', default: 21,
      label: { es: 'Semilla', en: 'Seed' },
      help: { es: 'La misma semilla y el mismo instante dan siempre el mismo fotograma.', en: 'The same seed and time always give the same frame.' },
    },
  ],

  resolution(params, srcW, srcH) {
    return workResolution(srcW, srcH, WORK_LONG);
  },

  preOptions(params) {
    return { matte: params.mode.paper, edgeBlend: 'light' };
  },

  init() {
    return { cache: {}, mask: null, last: null };
  },

  render(ctx, state) {
    const p = ctx.params.mode;
    const { LW, LH } = logicalSize(ctx);
    const paper = normalizeHex(p.paper) || '#0e1014';
    const ink = normalizeHex(p.ink) || '#c4f169';
    const time = ctx.time || 0;
    const F = buildField(p, ctx, LW, LH, time, state.cache);
    const seed = p.seed | 0;
    const step = Math.floor(time * STEPS_PER_SECOND + 1e-6);
    let count = Math.max(1, Math.min(LIMITS.maxParticles, Math.round(p.particles)));
    if (!ctx.isExport) {
      if (ctx.quality === 'draft') count = Math.ceil(count / 3);
      count = Math.max(1, Math.min(count, Math.floor(PREVIEW_BUDGET / (p.lifespan * 0.7))));
    }
    const decay = 1 - p.fade;
    const visible = p.fade > 0 ? Math.ceil(Math.log(0.03) / Math.log(decay)) : Infinity;
    const palette = p.colorFrom === 'palette' ? (PALETTES[p.palette] || PALETTES.sweetie16).colors.map((c) => normalizeHex(c) || '#ffffff') : null;

    // ---- trails, bucketed by alpha (and colour for palettes) ----
    const maxLen = Math.ceil(p.lifespan * 1.4) + 2;
    const buf = state.buf && state.buf.length >= maxLen * 2 ? state.buf : (state.buf = new Float32Array(maxLen * 2));
    const tmp = new Float32Array(3);
    const buckets = new Map(); // key -> Path2D
    const bucket = (ci, b) => {
      const k = ci * 64 + b;
      let path = buckets.get(k);
      if (!path) buckets.set(k, (path = new Path2D()));
      return path;
    };
    for (let i = 0; i < count; i++) {
      const { life, age, length } = particleLife(seed, i, step, p.lifespan);
      const [bx, by] = birth(seed, i, life, F);
      const n = trace(F, bx, by, age, buf, tmp);
      if (n < 2) continue;
      const ci = palette ? Math.floor(hash01(seed, i, life, 77) * palette.length) : 0;
      const first = Math.max(1, n - Math.min(n, visible === Infinity ? n : visible));
      let curB = -1;
      let path = null;
      for (let k = first; k < n; k++) {
        // the point laid at step k fades with the steps elapsed since; fade in after birth and out before death
        const since = age - k;
        let a = (decay === 1 ? 1 : decay ** since) * Math.min(1, k / 6) * Math.min(1, (length - age) / 6);
        const pr = F.P(buf[k * 2], buf[k * 2 + 1]);
        a *= 0.04 + 0.96 * pr * Math.sqrt(pr);
        const b = Math.round(a * ALPHA_LEVELS);
        if (b <= 0) { curB = -1; continue; }
        if (b !== curB) {
          path = bucket(ci, b);
          path.moveTo(buf[k * 2 - 2], buf[k * 2 - 1]);
          curB = b;
        }
        path.lineTo(buf[k * 2], buf[k * 2 + 1]);
      }
    }

    const { g, s, CW, CH } = prepareOutput(ctx, LW, LH);
    g.fillStyle = paper;
    g.fillRect(0, 0, CW, CH);
    let target = g;
    if (p.colorFrom === 'image') {
      if (!state.mask) state.mask = document.createElement('canvas');
      const m = state.mask;
      if (m.width !== CW || m.height !== CH) { m.width = CW; m.height = CH; }
      target = m.getContext('2d');
      target.setTransform(1, 0, 0, 1, 0, 0);
      target.globalCompositeOperation = 'source-over';
      target.clearRect(0, 0, CW, CH);
    }
    target.save();
    target.setTransform(s, 0, 0, s, 0, 0);
    target.lineWidth = p.strokeWidth;
    target.lineCap = 'round';
    target.lineJoin = 'round';
    for (const [k, path] of buckets) {
      const ci = Math.floor(k / 64);
      const b = k % 64;
      target.globalAlpha = b / ALPHA_LEVELS;
      target.strokeStyle = palette ? palette[ci] : p.colorFrom === 'image' ? '#ffffff' : ink;
      target.stroke(path);
    }
    target.restore();
    if (p.colorFrom === 'image') {
      // colour the trails with the picture under them
      target.save();
      target.globalAlpha = 1;
      target.globalCompositeOperation = 'source-in';
      target.imageSmoothingEnabled = true;
      target.imageSmoothingQuality = 'high';
      target.drawImage(ctx.source, 0, 0, CW, CH);
      target.restore();
      g.drawImage(state.mask, 0, 0);
    }

    state.last = { F, p: { ...p }, step, seed, LW, LH, paper, ink, palette, rgba: ctx.rgba, W: ctx.width, H: ctx.height, count };
    return { cols: count, rows: step, effectiveScale: s };
  },

  /** Trajectories of the first `svgParticles` particles, followed for `svgSteps` steps from where they are now. */
  toSVG(state, opts = {}) {
    const L = state?.last;
    if (!L) return '';
    const { F, p, step, seed, LW, LH, paper, ink, palette, rgba, W, H } = L;
    const n = Math.min(L.count, Math.max(1, Math.round(p.svgParticles)));
    const steps = Math.max(2, Math.round(p.svgSteps));
    const buf = new Float32Array((steps + 2) * 2);
    const tmp = new Float32Array(3);
    const groups = new Map();
    for (let i = 0; i < n; i++) {
      const { life, age } = particleLife(seed, i, step, p.lifespan);
      const [bx, by] = birth(seed, i, life, F);
      const head = new Float32Array((age + 2) * 2);
      const m0 = trace(F, bx, by, age, head, tmp);
      const sx = head[(m0 - 1) * 2];
      const sy = head[(m0 - 1) * 2 + 1];
      const m = trace(F, sx, sy, steps, buf, tmp);
      if (m < 2) continue;
      let color;
      if (palette) color = palette[Math.floor(hash01(seed, i, life, 77) * palette.length)];
      else if (p.colorFrom === 'image') {
        const x = Math.min(W - 1, Math.max(0, Math.floor((sx / LW) * W)));
        const y = Math.min(H - 1, Math.max(0, Math.floor((sy / LH) * H)));
        const o = (y * W + x) * 4;
        // quantised so the file groups into a manageable number of pens
        color = rgbToHex(...[rgba[o], rgba[o + 1], rgba[o + 2]].map((v) => Math.min(255, Math.round(v / 32) * 32)));
      } else color = ink;
      let list = groups.get(color);
      if (!list) groups.set(color, (list = []));
      list.push({ points: simplify(buf.slice(0, m * 2), 0.15), closed: false });
    }
    const layers = [...groups.entries()].map(([color, paths], k) => ({
      id: `pen-${k + 1}`, label: `Pen ${k + 1} ${color}`, color, width: p.strokeWidth, paths,
    }));
    return sceneToSVG({
      width: LW, height: LH, background: paper, layers,
      title: `${config.productName} flow field`, desc: `${n} trajectories of ${steps} steps, t = ${(step / STEPS_PER_SECOND).toFixed(2)} s`,
    }, opts);
  },

  dispose(state) {
    if (state?.mask) { state.mask.width = state.mask.height = 1; state.mask = null; }
    if (state) { state.last = null; state.cache = {}; state.buf = null; }
  },
};

export default MODE;
