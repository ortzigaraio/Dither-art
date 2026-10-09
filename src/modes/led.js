// LED panel / dot matrix (PLAN.md 7.10): every cell of the work grid is one LED. Brightness is quantised to `levels`
// steps; a switched-off LED still shows at 8 % so the grid stays visible. Single-colour panels (red, amber, green,
// blue, white) quantise the luma; the RGB panel quantises each channel. Optional glow. PNG and SVG exports.

import { hexToRgb, rgbToHex } from '../engine/color.js';
import { clamp } from '../engine/pixelkit.js';
import { svgDocument, layer, rectEl, num } from '../io/svgkit.js';
import { LIMITS, config } from '../config.js';

const PITCH = 8; // logical px per LED
const OFF = 0.08; // brightness of a switched-off LED
const PREVIEW_CAP = 4096;
const SVG_FULL_MAX = 60000; // above this many LEDs the SVG leaves out the switched-off ones

export const LED_COLORS = {
  red: { hex: '#ff2a1a', name: { es: 'Rojo', en: 'Red' } },
  amber: { hex: '#ffb000', name: { es: 'Ámbar', en: 'Amber' } },
  green: { hex: '#39ff6a', name: { es: 'Verde', en: 'Green' } },
  blue: { hex: '#3a8cff', name: { es: 'Azul', en: 'Blue' } },
  white: { hex: '#ffffff', name: { es: 'Blanco', en: 'White' } },
};

/** Brightness 0..1 -> `levels` evenly spaced steps -> intensity from OFF (level 0) to 1 (top level). */
export const ledIntensity = (v, levels) => OFF + (1 - OFF) * (Math.round(clamp(v, 0, 1) * (levels - 1)) / (levels - 1));

function spriteFor(P, size, shape, cache) {
  const key = `${P}|${size}|${shape}`;
  if (cache.key === key) return cache.sprite;
  const sprite = new Float32Array(P * P);
  const c = P / 2;
  const R = (size * P) / 2;
  for (let y = 0; y < P; y++) {
    for (let x = 0; x < P; x++) {
      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      sprite[y * P + x] = shape === 'square'
        ? clamp(R - Math.abs(dx) + 0.5, 0, 1) * clamp(R - Math.abs(dy) + 0.5, 0, 1)
        : clamp(R - Math.sqrt(dx * dx + dy * dy) + 0.5, 0, 1);
    }
  }
  cache.key = key;
  cache.sprite = sprite;
  return sprite;
}

const MODE = {
  id: 'led',
  category: 'pixel',
  name: { es: 'Panel LED', en: 'LED panel' },
  blurb: { es: 'Matriz de LEDs con brillo cuantizado y resplandor', en: 'LED matrix with quantised brightness and glow' },
  badges: ['SVG'],
  animated: false,
  uses: ['image'],
  exports: ['png', 'svg', 'video'],
  draftScale: 1,
  hide: ['dither', 'serpentine'],

  presets: [
    { id: 'amber', name: { es: 'Marquesina ámbar', en: 'Amber sign' }, mode: { ledColor: 'amber', ledSize: 0.8, levels: 4, glow: 0.5 } },
    { id: 'rgb', name: { es: 'Pantalla RGB', en: 'RGB screen' }, mode: { ledColor: 'rgb', ledSize: 0.75, levels: 8, glow: 0.3 } },
    { id: 'red', name: { es: 'Reloj rojo', en: 'Red clock' }, mode: { ledColor: 'red', ledSize: 0.6, levels: 2, glow: 0.7, shape: 'round' } },
  ],

  params: [
    {
      id: 'ledColor', type: 'select', default: 'amber',
      options: [...Object.entries(LED_COLORS).map(([value, v]) => ({ value, label: v.name })), { value: 'rgb', label: { es: 'RGB completo', en: 'Full RGB' } }],
      label: { es: 'Color del LED', en: 'LED color' },
    },
    {
      id: 'ledSize', type: 'range', min: 0.4, max: 1, step: 0.05, default: 0.8,
      label: { es: 'Tamaño del LED', en: 'LED size' },
      help: { es: 'Diámetro del LED respecto a su celda; el resto es la separación entre LEDs.', en: 'LED diameter relative to its cell; the rest is the gap between LEDs.' },
    },
    {
      id: 'shape', type: 'select', default: 'round',
      options: [{ value: 'round', label: { es: 'Redondo', en: 'Round' } }, { value: 'square', label: { es: 'Cuadrado', en: 'Square' } }],
      label: { es: 'Forma', en: 'Shape' },
    },
    {
      id: 'levels', type: 'range', min: 2, max: 16, step: 1, default: 6,
      label: { es: 'Niveles de brillo', en: 'Brightness levels' },
    },
    {
      id: 'glow', type: 'range', min: 0, max: 1, step: 0.05, default: 0.4,
      label: { es: 'Resplandor', en: 'Glow' },
    },
    {
      id: 'panel', type: 'color', default: '#08090b',
      label: { es: 'Color del panel', en: 'Panel color' },
    },
  ],

  resolution(params, srcW, srcH) {
    const cols = Math.max(1, Math.min(LIMITS.maxCols, Math.round(params.global.cols)));
    return { width: cols, height: Math.max(1, Math.round((cols * srcH) / srcW)) };
  },

  preOptions() {
    return { matte: '#000000', edgeBlend: 'light' };
  },

  init() {
    return { cache: {}, scratch: null, led: null };
  },

  render(ctx, state) {
    const p = ctx.params.mode;
    const cols = ctx.width;
    const rows = ctx.height;
    const n = cols * rows;
    const levels = Math.max(2, Math.min(16, Math.round(p.levels)));
    const cap = ctx.isExport ? LIMITS.maxExportImageSide : PREVIEW_CAP;
    const P = Math.max(2, Math.min(Math.round(PITCH * ctx.outScale), Math.floor(cap / cols), Math.floor(cap / rows)));
    const rgb = p.ledColor === 'rgb';
    const base = hexToRgb(LED_COLORS[p.ledColor]?.hex || LED_COLORS.amber.hex);
    const bg = hexToRgb(p.panel) || [8, 9, 11];

    // colour of every LED
    const led = state.led && state.led.length === n * 3 ? state.led : (state.led = new Uint8ClampedArray(n * 3));
    const rgba = ctx.rgba;
    if (rgb) {
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < 3; c++) led[i * 3 + c] = 255 * ledIntensity(rgba[i * 4 + c] / 255, levels);
      }
    } else {
      const luma = ctx.luma();
      for (let i = 0; i < n; i++) {
        const k = ledIntensity(luma[i], levels);
        led[i * 3] = base[0] * k; led[i * 3 + 1] = base[1] * k; led[i * 3 + 2] = base[2] * k;
      }
    }

    // draw: the sprite (coverage of the LED inside its cell) blends the LED colour over the panel colour
    const sprite = spriteFor(P, p.ledSize, p.shape, state.cache);
    const OW = cols * P;
    const OH = rows * P;
    const img = state.img && state.img.width === OW && state.img.height === OH ? state.img : (state.img = new ImageData(OW, OH));
    const d = img.data;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const i = (cy * cols + cx) * 3;
        const lr = led[i], lg = led[i + 1], lb = led[i + 2];
        for (let sy = 0; sy < P; sy++) {
          let o = ((cy * P + sy) * OW + cx * P) * 4;
          const so = sy * P;
          for (let sx = 0; sx < P; sx++, o += 4) {
            const a = sprite[so + sx];
            d[o] = bg[0] + (lr - bg[0]) * a;
            d[o + 1] = bg[1] + (lg - bg[1]) * a;
            d[o + 2] = bg[2] + (lb - bg[2]) * a;
            d[o + 3] = 255;
          }
        }
      }
    }
    const canvas = ctx.out.canvas;
    if (canvas.width !== OW || canvas.height !== OH) { canvas.width = OW; canvas.height = OH; }
    const g = ctx.out.ctx2d;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.putImageData(img, 0, 0);

    // glow: a quarter-size smoothed copy added on top
    if (p.glow > 0) {
      if (!state.scratch) state.scratch = document.createElement('canvas');
      const sm = state.scratch;
      sm.width = Math.max(1, Math.round(OW / 4));
      sm.height = Math.max(1, Math.round(OH / 4));
      const sg = sm.getContext('2d');
      sg.imageSmoothingEnabled = true;
      sg.imageSmoothingQuality = 'high';
      sg.clearRect(0, 0, sm.width, sm.height);
      sg.drawImage(canvas, 0, 0, sm.width, sm.height);
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = Math.min(1, p.glow * 0.8);
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(sm, 0, 0, OW, OH);
      g.restore();
    }

    state.cfg = { cols, rows, levels, rgb, size: p.ledSize, shape: p.shape, bg: rgbToHex(...bg) };
    return { cols, rows, effectiveScale: P / PITCH };
  },

  /** One layer per brightness level (single-colour panels) or one layer with per-LED fills (RGB). */
  toSVG(state, opts = {}) {
    if (!state?.led || !state.cfg) return '';
    const { cols, rows, levels, rgb, size, shape, bg } = state.cfg;
    const led = state.led;
    const n = cols * rows;
    const skipOff = n > SVG_FULL_MAX;
    const r = (size * PITCH) / 2;
    const el = (x, y, fill) => {
      const cx = (x + 0.5) * PITCH;
      const cy = (y + 0.5) * PITCH;
      const f = fill ? ` fill="${fill}"` : '';
      return shape === 'square'
        ? `<rect x="${num(cx - r)}" y="${num(cy - r)}" width="${num(2 * r)}" height="${num(2 * r)}"${f}/>`
        : `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}"${f}/>`;
    };
    const layers = [layer('Panel', bg, rectEl(0, 0, cols * PITCH, rows * PITCH), { id: 'panel' })];
    if (rgb) {
      const out = [];
      for (let i = 0; i < n; i++) {
        const o = i * 3;
        if (skipOff && led[o] <= 21 && led[o + 1] <= 21 && led[o + 2] <= 21) continue;
        out.push(el(i % cols, Math.floor(i / cols), rgbToHex(led[o], led[o + 1], led[o + 2])));
      }
      layers.push(layer('LEDs', '#ffffff', out.join('\n'), { id: 'leds' }));
    } else {
      const byColor = new Map();
      for (let i = 0; i < n; i++) {
        const o = i * 3;
        const hex = rgbToHex(led[o], led[o + 1], led[o + 2]);
        let list = byColor.get(hex);
        if (!list) byColor.set(hex, (list = { lum: led[o] + led[o + 1] + led[o + 2], items: [] }));
        list.items.push(el(i % cols, Math.floor(i / cols)));
      }
      const sorted = [...byColor.entries()].sort((a, b) => a[1].lum - b[1].lum);
      sorted.forEach(([hex, { items }], k) => {
        if (skipOff && k === 0 && sorted.length > 1) return;
        layers.push(layer(`Level ${k}`, hex, items.join('\n'), { id: `level-${k}` }));
      });
    }
    return svgDocument({ width: cols * PITCH, height: rows * PITCH, title: opts.title ?? `${config.productName} LED panel`, desc: `${cols}x${rows} LEDs, ${levels} levels` }, layers);
  },

  dispose(state) {
    if (state?.scratch) { state.scratch.width = state.scratch.height = 1; state.scratch = null; }
    if (state) { state.img = null; state.led = null; }
  },
};

export default MODE;
