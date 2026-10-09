// Halftone (PLAN.md 7.8): a screen of dots on a rotated grid per ink, dot area proportional to the ink coverage
// (circles use the exact union area, so a 50 % grey really prints half ink).
// Mono and duotone use the luma; CMYK separates the picture with a simple UCR (K = 1 - max(r,g,b)) and screens it at
// C 15 deg, M 75 deg, Y 0 deg, K 45 deg composed with `multiply`; RGB is additive (black paper, `lighter`).
// Every dot is kept (position and coverage) so the SVG export can write one layer per ink.

import { hexToRgb, rgbToHex } from '../engine/color.js';
import { baseWidth, clamp, hash01, workRatio } from '../engine/pixelkit.js';
import { svgDocument, layer, rectEl, circleEl, ellipseEl, polyEl } from '../io/svgkit.js';
import { LIMITS, config } from '../config.js';

const SQRT_HALF = Math.SQRT1_2;
const PREVIEW_CAP = 4096;

export const CMYK_INKS = [
  { id: 'cyan', label: 'Cyan', color: '#00aeef', angle: 15 },
  { id: 'magenta', label: 'Magenta', color: '#ec008c', angle: 75 },
  { id: 'yellow', label: 'Yellow', color: '#fff200', angle: 0 },
  { id: 'black', label: 'Black', color: '#231f20', angle: 45 },
];
const RGB_INKS = [
  { id: 'red', label: 'Red', color: '#ff0000', angle: 15 },
  { id: 'green', label: 'Green', color: '#00ff00', angle: 75 },
  { id: 'blue', label: 'Blue', color: '#0000ff', angle: 0 },
];
// misregistration: each plate slips in its own direction (unit vectors scaled by the parameter)
const SLIP = { cyan: [0.9, 0.1], magenta: [-0.5, 0.8], yellow: [-0.4, -0.9], black: [0, 0], red: [0.9, 0.1], green: [-0.5, 0.8], blue: [-0.4, -0.9], ink: [0, 0], ink2: [0.6, -0.5] };

const sampleUnit = (cell) => clamp(Math.round(cell / 3), 1, 12);

/** Bilinear sample of a W x H plane at fractional work coordinates. */
function bilinear(plane, W, H, fx, fy) {
  const x = clamp(fx, 0, W - 1);
  const y = clamp(fy, 0, H - 1);
  const x0 = x | 0;
  const y0 = y | 0;
  const x1 = x0 + 1 < W ? x0 + 1 : x0;
  const y1 = y0 + 1 < H ? y0 + 1 : y0;
  const tx = x - x0;
  const ty = y - y0;
  const a = plane[y0 * W + x0] * (1 - tx) + plane[y0 * W + x1] * tx;
  const b = plane[y1 * W + x0] * (1 - tx) + plane[y1 * W + x1] * tx;
  return a * (1 - ty) + b * ty;
}

// Radius (in cells) of a circle whose union with its neighbours on a square lattice covers a fraction `a` of the cell.
// Up to pi/4 the circles do not touch: a = pi r^2. Beyond that they overlap and a(r) = pi r^2 - 4 * segment(r), which
// is inverted once with a table (a(1/sqrt 2) = 1: the circles then cover the whole cell).
const R_TABLE = (() => {
  const area = (r) => (r <= 0.5 ? Math.PI * r * r : Math.PI * r * r - 4 * (r * r * Math.acos(0.5 / r) - 0.5 * Math.sqrt(r * r - 0.25)));
  const N = 512;
  const t = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const target = i / N;
    let lo = 0;
    let hi = SQRT_HALF;
    for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (area(mid) < target) lo = mid; else hi = mid; }
    t[i] = (lo + hi) / 2;
  }
  return t;
})();
export function circleRadius(a) {
  if (a <= Math.PI / 4) return Math.sqrt(a / Math.PI);
  const x = clamp(a, 0, 1) * 512;
  const i = Math.min(511, x | 0);
  return R_TABLE[i] + (R_TABLE[i + 1] - R_TABLE[i]) * (x - i);
}

/** Geometry of one dot of coverage a on a cell of size c: circle/ellipse radii or the polygon in lattice axes. */
export function dotGeometry(shape, a, c) {
  const s = Math.sqrt(a);
  switch (shape) {
    case 'square': { const h = (c * s) / 2; return { poly: [[-h, -h], [h, -h], [h, h], [-h, h]] }; }
    case 'diamond': { const d = c * (a <= 0.5 ? Math.sqrt(a / 2) : 1 - Math.sqrt((1 - a) / 2)); return { poly: [[0, -d], [d, 0], [0, d], [-d, 0]] }; }
    case 'line': { const t = (c * a) / 2; const l = (c * 1.02) / 2; return { poly: [[-l, -t], [l, -t], [l, t], [-l, t]] }; }
    case 'cross': {
      const t = (c * (1 - Math.sqrt(1 - a))) / 2;
      const l = c / 2;
      return { poly: [[-l, -t], [-t, -t], [-t, -l], [t, -l], [t, -t], [l, -t], [l, t], [t, t], [t, l], [-t, l], [-t, t], [-l, t]] };
    }
    case 'ellipse': { const r = c * circleRadius(a); return { rx: r * 1.35, ry: r / 1.35 }; }
    default: return { r: c * circleRadius(a) };
  }
}

/** Dots of one ink: positions (x, y), coverage a (after dot gain) and a per-dot size factor (jitter). */
export function screenDots({ OW, OH, c, theta, plane, W, H, f, gain, jitter, seed, plate }) {
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const [x, y] of [[0, 0], [OW, 0], [0, OH], [OW, OH]]) {
    const u = x * cos + y * sin;
    const v = -x * sin + y * cos;
    uMin = Math.min(uMin, u); uMax = Math.max(uMax, u); vMin = Math.min(vMin, v); vMax = Math.max(vMax, v);
  }
  const i0 = Math.floor(uMin / c) - 1;
  const i1 = Math.ceil(uMax / c) + 1;
  const j0 = Math.floor(vMin / c) - 1;
  const j1 = Math.ceil(vMax / c) + 1;
  const xs = [];
  const ys = [];
  const as = [];
  const ks = [];
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const uu = (i + 0.5) * c;
      const vv = (j + 0.5) * c;
      let x = uu * cos - vv * sin;
      let y = uu * sin + vv * cos;
      if (x < -c * 0.5 || x > OW + c * 0.5 || y < -c * 0.5 || y > OH + c * 0.5) continue;
      let a = bilinear(plane, W, H, x * f - 0.5, y * f - 0.5) * gain;
      a = a > 1 ? 1 : a;
      if (a < 0.01) continue;
      let k = 1;
      if (jitter > 0) {
        x += (hash01(seed, i, j, plate * 2) - 0.5) * jitter * c * 0.4;
        y += (hash01(seed, i, j, plate * 2 + 1) - 0.5) * jitter * c * 0.4;
        k = 1 + (hash01(seed, i, j, 99 + plate) - 0.5) * jitter * 0.3;
      }
      xs.push(x); ys.push(y); as.push(a); ks.push(k);
    }
  }
  return { x: xs, y: ys, a: as, k: ks, count: xs.length, theta, c };
}

/** Add one dot to a canvas path. */
function pathDot(g, geo, x, y, cos, sin, k) {
  if (geo.poly) {
    const p = geo.poly;
    for (let n = 0; n < p.length; n++) {
      const px = x + (p[n][0] * cos - p[n][1] * sin) * k;
      const py = y + (p[n][0] * sin + p[n][1] * cos) * k;
      if (n === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.closePath();
  } else if (geo.rx) {
    g.moveTo(x + geo.rx * k * cos, y + geo.rx * k * sin);
    g.ellipse(x, y, geo.rx * k, geo.ry * k, Math.atan2(sin, cos), 0, Math.PI * 2);
  } else {
    g.moveTo(x + geo.r * k, y);
    g.arc(x, y, geo.r * k, 0, Math.PI * 2);
  }
}

/** SVG elements (one per dot) of an ink. */
function dotsToSVG(dots, shape, offset) {
  const cos = Math.cos(dots.theta);
  const sin = Math.sin(dots.theta);
  const deg = (dots.theta * 180) / Math.PI;
  const out = new Array(dots.count);
  for (let n = 0; n < dots.count; n++) {
    const geo = dotGeometry(shape, dots.a[n], dots.c);
    const x = dots.x[n] + offset[0];
    const y = dots.y[n] + offset[1];
    const k = dots.k[n];
    if (geo.poly) out[n] = polyEl(geo.poly.map((p) => [x + (p[0] * cos - p[1] * sin) * k, y + (p[0] * sin + p[1] * cos) * k]));
    else if (geo.rx) out[n] = ellipseEl(x, y, geo.rx * k, geo.ry * k, deg);
    else out[n] = circleEl(x, y, geo.r * k);
  }
  return out.join('\n');
}

const SHAPES = [
  ['circle', 'Círculo', 'Circle'], ['square', 'Cuadrado', 'Square'], ['diamond', 'Diamante', 'Diamond'],
  ['line', 'Línea', 'Line'], ['cross', 'Cruz', 'Cross'], ['ellipse', 'Elipse', 'Ellipse'],
];

const MODE = {
  id: 'halftone',
  category: 'pixel',
  name: { es: 'Halftone / Semitono', en: 'Halftone' },
  blurb: { es: 'Puntos de impresión en mono, CMYK, RGB o duotono', en: 'Print dots in mono, CMYK, RGB or duotone' },
  badges: ['SVG'],
  animated: false,
  uses: ['image'],
  exports: ['png', 'svg', 'video'],
  draftScale: 1,
  hide: ['cols', 'dither', 'serpentine'],

  presets: [
    { id: 'newsprint', name: { es: 'Periódico', en: 'Newsprint' }, mode: { halftoneMode: 'mono', cellSize: 7, angle: 45, shape: 'circle', paper: '#efe9da', ink: '#1b1b1b', jitter: 0.15 } },
    { id: 'cmyk', name: { es: 'CMYK impreso', en: 'CMYK print' }, mode: { halftoneMode: 'cmyk', cellSize: 9, shape: 'circle', misregistration: 1.5, jitter: 0.1 } },
    { id: 'pop', name: { es: 'Duotono pop', en: 'Pop duotone' }, mode: { halftoneMode: 'duotone', cellSize: 10, angle: 30, ink: '#1f2a6b', ink2: '#ff3d7f', paper: '#fff4d6' } },
  ],

  params: [
    {
      id: 'halftoneMode', type: 'select', default: 'mono',
      options: [
        { value: 'mono', label: { es: 'Mono', en: 'Mono' } },
        { value: 'cmyk', label: { es: 'CMYK', en: 'CMYK' } },
        { value: 'rgb', label: { es: 'RGB aditivo', en: 'Additive RGB' } },
        { value: 'duotone', label: { es: 'Duotono', en: 'Duotone' } },
      ],
      label: { es: 'Modo', en: 'Mode' },
      help: { es: 'Mono usa una tinta; CMYK separa en cuatro tintas; RGB suma luz sobre negro; Duotono usa dos tintas.', en: 'Mono uses one ink; CMYK separates four inks; RGB adds light on black; Duotone uses two inks.' },
    },
    {
      id: 'cellSize', type: 'range', min: 3, max: 40, step: 1, default: 8, unit: 'px',
      label: { es: 'Tamaño de celda', en: 'Cell size' },
    },
    {
      id: 'angle', type: 'range', min: 0, max: 90, step: 1, default: 45, unit: '°',
      label: { es: 'Ángulo', en: 'Angle' },
      help: { es: 'Ángulo de la trama en mono y duotono (CMYK y RGB usan los ángulos clásicos).', en: 'Screen angle for mono and duotone (CMYK and RGB use the classic angles).' },
      showIf: (p) => p.halftoneMode === 'mono' || p.halftoneMode === 'duotone',
    },
    {
      id: 'shape', type: 'select', default: 'circle',
      options: SHAPES.map(([value, es, en]) => ({ value, label: { es, en } })),
      label: { es: 'Forma del punto', en: 'Dot shape' },
    },
    {
      id: 'dotGain', type: 'range', min: 0.5, max: 1.5, step: 0.05, default: 1,
      label: { es: 'Ganancia de punto', en: 'Dot gain' },
      help: { es: 'Multiplica el área de cada punto: por encima de 1 la impresión sale más cargada.', en: 'Multiplies the area of each dot: above 1 the print is heavier.' },
    },
    {
      id: 'invert', type: 'toggle', default: false,
      label: { es: 'Invertir', en: 'Invert' },
      help: { es: 'Los puntos crecen donde la imagen es clara.', en: 'Dots grow where the picture is bright.' },
      showIf: (p) => p.halftoneMode === 'mono' || p.halftoneMode === 'duotone',
    },
    {
      id: 'jitter', type: 'range', min: 0, max: 1, step: 0.05, default: 0,
      label: { es: 'Irregularidad', en: 'Jitter' },
      help: { es: 'Desplaza y varía ligeramente cada punto: aspecto impreso.', en: 'Slightly moves and varies every dot: a printed look.' },
    },
    {
      id: 'misregistration', type: 'range', min: 0, max: 4, step: 0.1, default: 0, unit: 'px',
      label: { es: 'Desregistro', en: 'Misregistration' },
      help: { es: 'Desplaza cada plancha de tinta, como una impresión mal alineada.', en: 'Offsets every ink plate, like a badly aligned print.' },
      showIf: (p) => p.halftoneMode !== 'mono',
    },
    {
      id: 'paper', type: 'color', default: '#f3efe4',
      label: { es: 'Papel', en: 'Paper' },
      showIf: (p) => p.halftoneMode !== 'rgb',
    },
    {
      id: 'ink', type: 'color', default: '#15181e',
      label: { es: 'Tinta', en: 'Ink' },
      showIf: (p) => p.halftoneMode === 'mono' || p.halftoneMode === 'duotone',
    },
    {
      id: 'ink2', type: 'color', default: '#d8362b',
      label: { es: 'Segunda tinta', en: 'Second ink' },
      showIf: (p) => p.halftoneMode === 'duotone',
    },
    {
      id: 'seed', type: 'seed', default: 3,
      label: { es: 'Semilla', en: 'Seed' },
      showIf: (p) => p.jitter > 0,
    },
  ],

  resolution(params, srcW, srcH, opts = {}) {
    const s = sampleUnit(params.mode.cellSize);
    const base = baseWidth(srcW, opts.isExport ? 2048 : 1280);
    const W = Math.max(1, Math.round(base / s));
    return { width: W, height: Math.max(1, Math.round((W * srcH) / srcW)) };
  },

  preOptions() {
    return { matte: '#ffffff', edgeBlend: 'dark' };
  },

  init() {
    return { layers: null, cfg: null };
  },

  render(ctx, state) {
    const p = ctx.params.mode;
    const W = ctx.width;
    const H = ctx.height;
    const n = W * H;
    const s = sampleUnit(p.cellSize);
    const ratio = workRatio(MODE, ctx);
    const OW = Math.max(1, Math.round((W / ratio) * s));
    const OH = Math.max(1, Math.round((H / ratio) * s));
    const f = ratio / s; // work px per logical px
    const c = p.cellSize;
    const cap = ctx.isExport ? LIMITS.maxExportImageSide : PREVIEW_CAP;
    const es = Math.max(0.05, Math.min(ctx.outScale, cap / OW, cap / OH));
    const CW = Math.max(1, Math.round(OW * es));
    const CH = Math.max(1, Math.round(OH * es));
    const rgba = ctx.rgba;
    const gain = p.dotGain;
    const mode = p.halftoneMode;
    const paper = hexToRgb(p.paper) || [243, 239, 228];

    // ---- ink plates: coverage plane, colour, angle, how it is composed ----
    const plates = [];
    const plane = () => new Float32Array(n);
    if (mode === 'cmyk') {
      const pc = plane(), pm = plane(), py = plane(), pk = plane();
      for (let i = 0, o = 0; i < n; i++, o += 4) {
        const r = rgba[o] / 255, g = rgba[o + 1] / 255, b = rgba[o + 2] / 255;
        const k = 1 - Math.max(r, g, b);
        const d = 1 - k;
        pk[i] = k;
        if (d > 1e-6) { pc[i] = (1 - r - k) / d; pm[i] = (1 - g - k) / d; py[i] = (1 - b - k) / d; }
      }
      [pc, pm, py, pk].forEach((pl, i) => plates.push({ ...CMYK_INKS[i], plane: pl }));
    } else if (mode === 'rgb') {
      const pr = plane(), pg = plane(), pb = plane();
      for (let i = 0, o = 0; i < n; i++, o += 4) { pr[i] = rgba[o] / 255; pg[i] = rgba[o + 1] / 255; pb[i] = rgba[o + 2] / 255; }
      [pr, pg, pb].forEach((pl, i) => plates.push({ ...RGB_INKS[i], plane: pl }));
    } else {
      const luma = ctx.luma();
      const cov = plane();
      for (let i = 0; i < n; i++) cov[i] = p.invert ? luma[i] : 1 - luma[i];
      if (mode === 'duotone') {
        const light = plane();
        for (let i = 0; i < n; i++) light[i] = cov[i] * cov[i]; // the dark ink takes the shadows only
        plates.push({ id: 'ink2', label: 'Ink 2', color: rgbToHex(...(hexToRgb(p.ink2) || [216, 54, 43])), angle: p.angle + 30, plane: cov });
        plates.push({ id: 'ink', label: 'Ink 1', color: rgbToHex(...(hexToRgb(p.ink) || [21, 24, 30])), angle: p.angle, plane: light });
      } else {
        plates.push({ id: 'ink', label: 'Ink', color: rgbToHex(...(hexToRgb(p.ink) || [21, 24, 30])), angle: p.angle, plane: cov });
      }
    }

    // ---- dots ----
    const seed = p.seed | 0;
    const layers = plates.map((pl, idx) => {
      const dots = screenDots({
        OW, OH, c, theta: (pl.angle * Math.PI) / 180, plane: pl.plane, W, H, f, gain, jitter: p.jitter, seed, plate: idx,
      });
      const slip = SLIP[pl.id] || [0, 0];
      return { id: pl.id, label: pl.label, color: pl.color, dots, offset: [slip[0] * p.misregistration, slip[1] * p.misregistration] };
    });

    // ---- draw ----
    const canvas = ctx.out.canvas;
    if (canvas.width !== CW || canvas.height !== CH) { canvas.width = CW; canvas.height = CH; }
    const g = ctx.out.ctx2d;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.fillStyle = mode === 'rgb' ? '#000000' : rgbToHex(...paper);
    g.fillRect(0, 0, CW, CH);
    g.setTransform(CW / OW, 0, 0, CH / OH, 0, 0);
    g.globalCompositeOperation = mode === 'rgb' ? 'lighter' : 'multiply';
    for (const L of layers) {
      const d = L.dots;
      const cos = Math.cos(d.theta);
      const sin = Math.sin(d.theta);
      g.beginPath();
      for (let i = 0; i < d.count; i++) {
        pathDot(g, dotGeometry(p.shape, d.a[i], c), d.x[i] + L.offset[0], d.y[i] + L.offset[1], cos, sin, d.k[i]);
      }
      g.fillStyle = L.color;
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    g.setTransform(1, 0, 0, 1, 0, 0);

    state.layers = layers;
    state.cfg = { OW, OH, shape: p.shape, mode, paper: rgbToHex(...paper) };
    return { cols: Math.round(OW / c), rows: Math.round(OH / c), effectiveScale: CW / OW };
  },

  /** One Inkscape layer per ink, over a paper (or black, for RGB) layer; dots as individual shapes. */
  toSVG(state, opts = {}) {
    if (!state?.layers) return '';
    const { OW, OH, shape, mode, paper } = state.cfg;
    const blend = mode === 'rgb' ? 'screen' : 'multiply';
    const out = [layer(mode === 'rgb' ? 'Background' : 'Paper', mode === 'rgb' ? '#000000' : paper, rectEl(0, 0, OW, OH), { id: 'paper' })];
    for (const L of state.layers) out.push(layer(L.label, L.color, dotsToSVG(L.dots, shape, L.offset), { blend, id: `ink-${L.id}` }));
    return svgDocument({ width: OW, height: OH, title: opts.title ?? `${config.productName} halftone`, desc: `halftone ${mode}` }, out);
  },

  dispose(state) {
    if (state) { state.layers = null; state.cfg = null; }
  },
};

export default MODE;
