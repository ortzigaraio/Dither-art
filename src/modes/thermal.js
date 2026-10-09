// Thermography and image gradients (PLAN.md 7.11). A scalar (luminance, gradient magnitude, depth or "heat") is mapped
// through a 256-colour look-up table; the Gradients sub-mode instead paints the gradient direction as hue and the
// magnitude as value. Optional sensor simulation (coarse grid, smooth upscale, noise), an isotherm band and a HUD.
// Depth is brightness for now (the AI depth source arrives in phase 5). Canvas2D on the CPU (see PLAN.md 19).

import { hexToRgb } from '../engine/color.js';
import { THERMAL_PALETTES, THERMAL_IDS, thermalLUT, hsvToRgb, formatTemp } from '../engine/thermal.js';
import { baseWidth, hash01 } from '../engine/pixelkit.js';
import { cropRect } from '../engine/preprocess.js';
import { t } from '../i18n/i18n.js';
import { LIMITS } from '../config.js';

const PREVIEW_CAP = 4096;
const SENSORS = { '80': 80, '160': 160, '320': 320 };

/** Level bounds [lo, hi] of a 0..1 scalar: the 1 % / 99 % percentiles (auto level) or the manual range. */
export function levelBounds(values, autoLevel, minPct, maxPct) {
  if (!autoLevel) return [minPct / 100, Math.max(minPct / 100 + 0.001, maxPct / 100)];
  const BINS = 1024;
  const hist = new Uint32Array(BINS);
  for (let i = 0; i < values.length; i++) hist[Math.min(BINS - 1, Math.max(0, (values[i] * BINS) | 0))]++;
  const n = values.length;
  let acc = 0;
  let lo = 0;
  let hi = 1;
  for (let b = 0; b < BINS; b++) { acc += hist[b]; if (acc >= n * 0.01) { lo = b / BINS; break; } }
  acc = 0;
  for (let b = 0; b < BINS; b++) { acc += hist[b]; if (acc >= n * 0.99) { hi = (b + 1) / BINS; break; } }
  return [lo, Math.max(hi, lo + 0.02)];
}

const clock = (s) => {
  const v = Math.max(0, Math.floor(s));
  const p = (x) => String(x).padStart(2, '0');
  return `${p(Math.floor(v / 3600))}:${p(Math.floor(v / 60) % 60)}:${p(v % 60)}`;
};

const MODE = {
  id: 'thermal',
  category: 'pixel',
  name: { es: 'Termografía', en: 'Thermography' },
  blurb: { es: 'Cámara térmica: paletas de calor y gradientes', en: 'Thermal camera: heat palettes and image gradients' },
  badges: [],
  animated: false,
  uses: ['image'],
  exports: ['png', 'video'],
  hide: ['cols', 'dither', 'serpentine'],

  presets: [
    { id: 'ironbow', name: { es: 'Cámara Ironbow', en: 'Ironbow camera' }, mode: { submode: 'thermal', thermalPalette: 'ironbow', sensorRes: '160', hud: true, noise: 0.15 } },
    { id: 'predator', name: { es: 'Visión de calor', en: 'Heat vision' }, mode: { source: 'heat', thermalPalette: 'turbo', sensorRes: '80', isotherm: false } },
    { id: 'gradients', name: { es: 'Gradientes', en: 'Gradients' }, mode: { submode: 'gradients', sensorRes: 'full' } },
  ],

  params: [
    {
      id: 'submode', type: 'select', default: 'thermal',
      options: [{ value: 'thermal', label: { es: 'Térmico', en: 'Thermal' } }, { value: 'gradients', label: { es: 'Gradientes', en: 'Gradients' } }],
      label: { es: 'Sub-modo', en: 'Sub-mode' },
      help: { es: 'Gradientes pinta la dirección del gradiente como tono y su magnitud como valor.', en: 'Gradients paints the gradient direction as hue and its magnitude as value.' },
    },
    {
      id: 'source', type: 'select', default: 'luma',
      options: [
        { value: 'luma', label: { es: 'Luminancia', en: 'Luminance' } },
        { value: 'gradient', label: { es: 'Magnitud de gradiente', en: 'Gradient magnitude' } },
        { value: 'depth', label: { es: 'Profundidad (brillo)', en: 'Depth (brightness)' } },
        { value: 'heat', label: { es: 'Calor (más peso al rojo)', en: 'Heat (extra weight on red)' } },
      ],
      label: { es: 'Fuente del escalar', en: 'Scalar source' },
      showIf: (p) => p.submode === 'thermal',
    },
    {
      id: 'thermalPalette', type: 'select', default: 'ironbow',
      options: THERMAL_IDS.map((id) => ({ value: id, label: THERMAL_PALETTES[id].name })),
      label: { es: 'Paleta', en: 'Palette' },
      showIf: (p) => p.submode === 'thermal',
    },
    {
      id: 'customStops', type: 'colors', default: ['#000000', '#ff3300', '#ffffff'], min: 2, max: 5,
      label: { es: 'Paradas del gradiente', en: 'Gradient stops' },
      showIf: (p) => p.submode === 'thermal' && p.thermalPalette === 'custom',
    },
    {
      id: 'autoLevel', type: 'toggle', default: true,
      label: { es: 'Nivel automático', en: 'Auto level' },
      help: { es: 'Estira el rango entre los percentiles 1 y 99 de la imagen.', en: 'Stretches the range between the 1st and 99th percentile of the picture.' },
    },
    {
      id: 'rangeMin', type: 'range', min: 0, max: 100, step: 1, default: 0, unit: '%',
      label: { es: 'Rango mínimo', en: 'Range minimum' },
      showIf: (p) => !p.autoLevel,
    },
    {
      id: 'rangeMax', type: 'range', min: 0, max: 100, step: 1, default: 100, unit: '%',
      label: { es: 'Rango máximo', en: 'Range maximum' },
      showIf: (p) => !p.autoLevel,
    },
    {
      id: 'sensorRes', type: 'select', default: '160',
      options: [
        { value: '80', label: { es: '80×60', en: '80×60' } },
        { value: '160', label: { es: '160×120', en: '160×120' } },
        { value: '320', label: { es: '320×240', en: '320×240' } },
        { value: 'full', label: { es: 'Completa', en: 'Full' } },
      ],
      label: { es: 'Resolución del sensor', en: 'Sensor resolution' },
      help: { es: 'Simula un sensor pequeño: la imagen se reduce y se amplía con suavizado bilineal.', en: 'Simulates a small sensor: the picture is reduced and enlarged with bilinear smoothing.' },
    },
    {
      id: 'noise', type: 'range', min: 0, max: 1, step: 0.05, default: 0,
      label: { es: 'Ruido', en: 'Noise' },
    },
    {
      id: 'seed', type: 'seed', default: 11,
      label: { es: 'Semilla', en: 'Seed' },
      showIf: (p) => p.noise > 0,
    },
    {
      id: 'isotherm', type: 'toggle', default: false,
      label: { es: 'Isoterma', en: 'Isotherm' },
      help: { es: 'Resalta un rango de temperaturas con un color.', en: 'Highlights a temperature range with one color.' },
      showIf: (p) => p.submode === 'thermal',
    },
    {
      id: 'isoMin', type: 'range', min: 0, max: 100, step: 1, default: 60, unit: '%',
      label: { es: 'Isoterma desde', en: 'Isotherm from' },
      showIf: (p) => p.submode === 'thermal' && p.isotherm,
    },
    {
      id: 'isoMax', type: 'range', min: 0, max: 100, step: 1, default: 75, unit: '%',
      label: { es: 'Isoterma hasta', en: 'Isotherm to' },
      showIf: (p) => p.submode === 'thermal' && p.isotherm,
    },
    {
      id: 'isoColor', type: 'color', default: '#ff00ff',
      label: { es: 'Color de la isoterma', en: 'Isotherm color' },
      showIf: (p) => p.submode === 'thermal' && p.isotherm,
    },
    {
      id: 'hud', type: 'toggle', default: false,
      label: { es: 'HUD', en: 'HUD' },
      help: { es: 'Cruz central, lectura de temperatura ficticia, barra de escala y marca de tiempo.', en: 'Center cross, fictional temperature readout, scale bar and timestamp.' },
      showIf: (p) => p.submode === 'thermal',
    },
    {
      id: 'tempMin', type: 'range', min: -40, max: 100, step: 1, default: 18, unit: '°C',
      label: { es: 'Temperatura mínima', en: 'Minimum temperature' },
      showIf: (p) => p.submode === 'thermal' && p.hud,
    },
    {
      id: 'tempMax', type: 'range', min: -40, max: 400, step: 1, default: 42, unit: '°C',
      label: { es: 'Temperatura máxima', en: 'Maximum temperature' },
      showIf: (p) => p.submode === 'thermal' && p.hud,
    },
  ],

  /** Work buffer = the sensor grid; the output is always the picture size (up to 1024 px wide). */
  resolution(params, srcW, srcH) {
    const full = baseWidth(srcW, 1024);
    const W = SENSORS[params.mode.sensorRes] ? Math.min(SENSORS[params.mode.sensorRes], full) : full;
    return { width: W, height: Math.max(1, Math.round((W * srcH) / srcW)) };
  },

  preOptions() {
    return { matte: '#000000', edgeBlend: 'light' };
  },

  init() {
    return { scratch: null, img: null, scalar: null };
  },

  async render(ctx, state) {
    const p = ctx.params.mode;
    const W = ctx.width;
    const H = ctx.height;
    const n = W * H;
    const gradients = p.submode === 'gradients';
    const rgba = ctx.rgba;

    // ---- scalar field ----
    let s;
    if (gradients) s = ctx.sobel().mag;
    else if (p.source === 'gradient') s = ctx.sobel().mag;
    else if (p.source === 'depth') s = await ctx.depth();
    else if (p.source === 'heat') {
      s = state.scalar && state.scalar.length === n ? state.scalar : (state.scalar = new Float32Array(n));
      for (let i = 0, o = 0; i < n; i++, o += 4) s[i] = (0.5 * rgba[o] + 0.35 * rgba[o + 1] + 0.15 * rgba[o + 2]) / 255;
    } else s = ctx.luma();

    const [lo, hi] = levelBounds(s, p.autoLevel, p.rangeMin, p.rangeMax);
    const span = hi - lo;
    const img = state.img && state.img.width === W && state.img.height === H ? state.img : (state.img = new ImageData(W, H));
    const d = img.data;
    const seed = p.seed | 0;
    const noise = p.noise;
    const vOf = (i) => {
      let v = (s[i] - lo) / span;
      if (noise > 0) v += (hash01(seed, i, 7) - 0.5) * noise * 0.3;
      return v < 0 ? 0 : v > 1 ? 1 : v;
    };

    if (gradients) {
      const ang = ctx.sobel().angle;
      for (let i = 0, o = 0; i < n; i++, o += 4) {
        const c = hsvToRgb((ang[i] + Math.PI) / (2 * Math.PI), 1, vOf(i));
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
      }
    } else {
      const lut = thermalLUT(p.thermalPalette, p.customStops);
      const iso = p.isotherm ? { lo: Math.min(p.isoMin, p.isoMax) / 100, hi: Math.max(p.isoMin, p.isoMax) / 100, rgb: hexToRgb(p.isoColor) || [255, 0, 255] } : null;
      for (let i = 0, o = 0; i < n; i++, o += 4) {
        const v = vOf(i);
        if (iso && v >= iso.lo && v <= iso.hi) {
          d[o] = iso.rgb[0]; d[o + 1] = iso.rgb[1]; d[o + 2] = iso.rgb[2];
        } else {
          const k = Math.round(v * 255) * 3;
          d[o] = lut[k]; d[o + 1] = lut[k + 1]; d[o + 2] = lut[k + 2];
        }
        d[o + 3] = 255;
      }
    }

    // ---- upscale the sensor grid to the output (bilinear, like a small sensor on a big screen) ----
    const logicalW = baseWidth(cropRect(ctx.params.global, ctx.srcWidth, ctx.srcHeight).sw, 1024);
    const logicalH = Math.max(1, Math.round((logicalW * H) / W));
    const cap = ctx.isExport ? LIMITS.maxExportImageSide : PREVIEW_CAP;
    const es = Math.max(0.05, Math.min(ctx.outScale, cap / logicalW, cap / logicalH));
    const OW = Math.max(1, Math.round(logicalW * es));
    const OH = Math.max(1, Math.round(logicalH * es));
    if (!state.scratch) state.scratch = document.createElement('canvas');
    const sc = state.scratch;
    if (sc.width !== W || sc.height !== H) { sc.width = W; sc.height = H; }
    sc.getContext('2d').putImageData(img, 0, 0);
    const out = ctx.out.canvas;
    if (out.width !== OW || out.height !== OH) { out.width = OW; out.height = OH; }
    const g = ctx.out.ctx2d;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.imageSmoothingEnabled = OW !== W || OH !== H;
    g.imageSmoothingQuality = 'low'; // bilinear
    g.clearRect(0, 0, OW, OH);
    g.drawImage(sc, 0, 0, W, H, 0, 0, OW, OH);

    // ---- HUD ----
    const meta = { cols: W, rows: H, effectiveScale: OW / logicalW };
    if (p.hud && !gradients) {
      const cx = Math.min(W - 1, W >> 1);
      const cy = Math.min(H - 1, H >> 1);
      const vc = vOf(cy * W + cx);
      meta.hud = {
        center: formatTemp(vc, p.tempMin, p.tempMax),
        max: formatTemp(1, p.tempMin, p.tempMax),
        min: formatTemp(0, p.tempMin, p.tempMax),
        stamp: `${t('thermal.hud.rec')} ${clock(ctx.time)}`,
      };
      drawHud(g, OW, OH, meta.hud, thermalLUT(p.thermalPalette, p.customStops));
    }
    return meta;
  },

  dispose(state) {
    if (state?.scratch) { state.scratch.width = state.scratch.height = 1; state.scratch = null; }
    if (state) { state.img = null; state.scalar = null; }
  },
};

/** Cross, readout, scale bar and clock, in white with a dark outline so they read on any palette. */
function drawHud(g, OW, OH, hud, lut) {
  const u = Math.max(8, Math.round(OH / 30));
  g.save();
  g.lineJoin = 'round';
  g.font = `600 ${u}px "Geist Mono", "DejaVu Sans Mono", monospace`;
  g.textBaseline = 'top';
  const text = (str, x, y, align = 'left') => {
    g.textAlign = align;
    g.lineWidth = Math.max(2, u / 4);
    g.strokeStyle = 'rgba(0,0,0,.75)';
    g.strokeText(str, x, y);
    g.fillStyle = '#ffffff';
    g.fillText(str, x, y);
  };
  const stroke = (draw) => {
    g.strokeStyle = 'rgba(0,0,0,.75)'; g.lineWidth = Math.max(3, u / 3); draw();
    g.strokeStyle = '#ffffff'; g.lineWidth = Math.max(1, u / 8); draw();
  };
  // crosshair
  const cx = OW / 2;
  const cy = OH / 2;
  const a = u * 0.5;
  const b = u * 1.6;
  stroke(() => {
    g.beginPath();
    g.moveTo(cx - b, cy); g.lineTo(cx - a, cy); g.moveTo(cx + a, cy); g.lineTo(cx + b, cy);
    g.moveTo(cx, cy - b); g.lineTo(cx, cy - a); g.moveTo(cx, cy + a); g.lineTo(cx, cy + b);
    g.stroke();
  });
  text(hud.center, cx + b + u * 0.4, cy - u * 0.5);
  // timestamp
  text(hud.stamp, u, u);
  // scale bar on the right
  const bw = Math.max(6, u * 0.8);
  const bh = OH * 0.5;
  const bx = OW - u * 1.2 - bw;
  const by = (OH - bh) / 2;
  for (let i = 0; i < Math.ceil(bh); i++) {
    const k = Math.round((1 - i / Math.max(1, bh - 1)) * 255) * 3;
    g.fillStyle = `rgb(${lut[k]},${lut[k + 1]},${lut[k + 2]})`;
    g.fillRect(bx, by + i, bw, 1);
  }
  g.strokeStyle = '#ffffff';
  g.lineWidth = 1;
  g.strokeRect(bx - 0.5, by - 0.5, bw + 1, bh + 1);
  text(`${t('thermal.hud.max')} ${hud.max}`, bx + bw, by - u * 1.4, 'right');
  text(`${t('thermal.hud.min')} ${hud.min}`, bx + bw, by + bh + u * 0.4, 'right');
  g.restore();
}

export default MODE;
