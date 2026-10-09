// Matrix rain (PLAN.md 7.5): columns of falling glyphs with a trail; the brightness of each glyph is modulated by the
// luma of the picture under it, so the image "appears" in the rain.
//
// The animation is a pure function of (seed, time): every column derives its speed, phase and drops from integer
// hashes, so a frame never depends on the frames before it. That makes exports deterministic (the exporter feeds
// frame times, PLAN.md 9.2), allows scrubbing video, and gives identical pixels for the same seed and time.

import {
  FONTS, NO_GLYPH, getAtlas, drawGlyphGrid, cellAspect, cellLayout, baseCell, fontsReady, requestFonts,
} from '../engine/glyphs.js';
import { hexToRgb } from '../engine/color.js';
import { LIMITS } from '../config.js';

const FONT_ID = 'geist-mono';
const BASE_SPEED = 9; // rows per second at speed 1
const MAX_PREVIEW_SIDE = 4096;

export const GLYPH_SETS = {
  katakana: 'ｦｧｨｩｪｫｬｭｮｯｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789',
  digits: '0123456789',
  binary: '01',
  latin: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  symbols: '+-*/=<>:.|\\^~%#@&$',
};

/** Integer hash of up to four numbers -> float in [0, 1). */
export function hash01(a, b, c = 0, d = 0) {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b) ^ Math.imul(c | 0, 0xc2b2ae35) ^ Math.imul(d | 0, 0x27d4eb2f);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * State of the rain at time `t`.
 * @returns {{ glyph: Int16Array, level: Float32Array, head: Uint8Array }} per cell: glyph index (-1 = none),
 *   brightness 0..1 along the trail, and 1 where the head of a drop is.
 */
export function rainField({ cols, rows, glyphCount, seed, time, speed, density, trail, changeRate }) {
  const n = cols * rows;
  const glyph = new Int16Array(n).fill(-1);
  const level = new Float32Array(n);
  const head = new Uint8Array(n);
  for (let x = 0; x < cols; x++) {
    const v = BASE_SPEED * speed * (0.55 + 0.9 * hash01(seed, x, 1));
    const gap = Math.round(rows * (0.15 + 1.1 * hash01(seed, x, 2)));
    const cycleLen = rows + trail + gap;
    const pos = time * v + hash01(seed, x, 3) * cycleLen;
    const cycle = Math.floor(pos / cycleLen);
    if (hash01(seed, x, 4, cycle) >= density) continue; // this drop does not fall (density)
    const headRow = pos - cycle * cycleLen;
    const y0 = Math.max(0, Math.ceil(headRow - trail));
    const y1 = Math.min(rows - 1, Math.floor(headRow));
    for (let y = y0; y <= y1; y++) {
      const d = headRow - y;
      const i = y * cols + x;
      level[i] = (1 - d / trail) ** 1.4;
      head[i] = d < 1 ? 1 : 0;
      const tick = Math.floor(time * changeRate * 20 + hash01(seed, x, y, 5) * 64);
      glyph[i] = Math.floor(hash01(seed, x * 7919 + y, tick, 6) * glyphCount);
    }
  }
  return { glyph, level, head };
}

const mix = (a, b, t) => a + (b - a) * t;

export default {
  id: 'matrix',
  category: 'text',
  name: { es: 'Lluvia Matrix', en: 'Matrix rain' },
  blurb: { es: 'Glifos que caen y dibujan la imagen', en: 'Falling glyphs that reveal the picture' },
  badges: ['ANIM'],
  animated: true,
  uses: ['image'],
  exports: ['png', 'video'],
  draftScale: 1,
  hide: ['dither', 'serpentine'],

  presets: [
    { id: 'classic', name: { es: 'Clásico', en: 'Classic' }, mode: { inkColor: '#00ff41', glyphSet: 'katakana', imageInfluence: 0.8 } },
    { id: 'storm', name: { es: 'Tormenta', en: 'Storm' }, mode: { speed: 2.5, density: 0.9, trail: 34, glow: 0.7 } },
    { id: 'cyan', name: { es: 'Cian binario', en: 'Binary cyan' }, mode: { inkColor: '#35e8ff', glyphSet: 'binary', imageInfluence: 0.9 } },
  ],

  params: [
    {
      id: 'speed', type: 'range', min: 0.1, max: 5, step: 0.1, default: 1,
      label: { es: 'Velocidad', en: 'Speed' },
    },
    {
      id: 'density', type: 'range', min: 0, max: 1, step: 0.05, default: 0.6,
      label: { es: 'Densidad', en: 'Density' },
      help: { es: 'Probabilidad de que una columna tenga una gota cayendo.', en: 'Chance that a column has a falling drop.' },
    },
    {
      id: 'trail', type: 'range', min: 4, max: 60, step: 1, default: 20,
      label: { es: 'Longitud de la estela', en: 'Trail length' },
    },
    {
      id: 'imageInfluence', type: 'range', min: 0, max: 1, step: 0.05, default: 0.8,
      label: { es: 'Influencia de la imagen', en: 'Image influence' },
      help: { es: 'Cuánto modula la luminosidad de la imagen el brillo de los glifos.', en: 'How much the picture brightness modulates the glyphs.' },
    },
    {
      id: 'glyphSet', type: 'select', default: 'katakana',
      options: [
        { value: 'katakana', label: { es: 'Katakana y dígitos', en: 'Katakana and digits' } },
        { value: 'digits', label: { es: 'Dígitos', en: 'Digits' } },
        { value: 'binary', label: { es: 'Binario', en: 'Binary' } },
        { value: 'latin', label: { es: 'Letras y dígitos', en: 'Letters and digits' } },
        { value: 'symbols', label: { es: 'Símbolos', en: 'Symbols' } },
      ],
      label: { es: 'Glifos', en: 'Glyphs' },
    },
    {
      id: 'inkColor', type: 'color', default: '#00ff41',
      label: { es: 'Color de la lluvia', en: 'Rain color' },
    },
    {
      id: 'bgColor', type: 'color', default: '#010a03',
      label: { es: 'Color de fondo', en: 'Background color' },
    },
    {
      id: 'glow', type: 'range', min: 0, max: 1, step: 0.05, default: 0.5,
      label: { es: 'Resplandor', en: 'Glow' },
    },
    {
      id: 'charChangeRate', type: 'range', min: 0, max: 1, step: 0.01, default: 0.05,
      label: { es: 'Cambio de caracteres', en: 'Character change rate' },
      help: { es: 'Con qué frecuencia cambia cada glifo mientras cae.', en: 'How often each glyph changes while it falls.' },
    },
    {
      id: 'cellSize', type: 'range', min: 8, max: 32, step: 1, default: 14, unit: 'px',
      label: { es: 'Tamaño de celda', en: 'Cell size' },
    },
    {
      id: 'seed', type: 'seed', default: 42,
      label: { es: 'Semilla', en: 'Seed' },
      help: { es: 'La misma semilla y el mismo instante dan siempre el mismo fotograma.', en: 'The same seed and time always give the same frame.' },
    },
  ],

  resolution(params, srcW, srcH) {
    const p = params.mode;
    const cols = Math.max(1, Math.min(LIMITS.maxCols, Math.round(params.global.cols)));
    const aspect = cellAspect(FONT_ID, p.cellSize, 1, 0);
    return { width: cols, height: Math.max(1, Math.round(cols * (srcH / srcW) * aspect)) };
  },

  preOptions(params) {
    return { matte: params.mode.bgColor, edgeBlend: 'light' };
  },

  init() {
    return { cache: {}, scratch: null };
  },

  render(ctx, state) {
    const p = ctx.params.mode;
    const { width: cols, height: rows } = ctx;
    const n = cols * rows;
    const chars = Array.from(new Set(Array.from(GLYPH_SETS[p.glyphSet] || GLYPH_SETS.katakana)));
    const text = chars.join('');
    if (!fontsReady(FONT_ID, text)) requestFonts(FONT_ID, text, ctx.invalidate);

    const field = rainField({
      cols, rows, glyphCount: chars.length, seed: p.seed, time: ctx.time, speed: p.speed, density: p.density,
      trail: p.trail, changeRate: p.charChangeRate,
    });

    // ---- atlas, with the size cap of PLAN.md 18.2 ----
    const cap = ctx.isExport ? LIMITS.maxExportImageSide : MAX_PREVIEW_SIDE;
    const base = baseCell(FONT_ID, p.cellSize, 1, 0);
    let scale = Math.min(ctx.outScale, cap / (cols * base.w), cap / (rows * base.h));
    let layout = cellLayout(FONT_ID, p.cellSize, 1, 0, scale);
    for (let guard = 0; guard < 8 && (cols * layout.cellW > cap || rows * layout.cellH > cap) && scale > 0.05; guard++) {
      scale *= 0.95;
      layout = cellLayout(FONT_ID, p.cellSize, 1, 0, scale);
    }
    const atlas = getAtlas(chars, FONT_ID, layout);

    // ---- colour of every lit cell: ink along the trail, whiter at the head, modulated by the picture ----
    const ink = hexToRgb(p.inkColor) || [0, 255, 65];
    const bg = hexToRgb(p.bgColor) || [1, 10, 3];
    const luma = ctx.luma();
    const infl = p.imageInfluence;
    const glyph = state.glyph && state.glyph.length === n ? state.glyph : (state.glyph = new Uint16Array(n));
    const rgba = state.rgba && state.rgba.length === n * 4 ? state.rgba : (state.rgba = new Uint8ClampedArray(n * 4));
    const ghostTick = Math.floor(ctx.time * 0.5);
    for (let i = 0; i < n; i++) {
      let g = field.glyph[i];
      let k;
      let w = 0;
      if (g >= 0) {
        k = field.level[i] * (1 - infl + infl * luma[i]);
        w = field.head[i] ? 0.7 : 0;
      } else {
        // a faint ghost of the picture between the drops, so the image stays readable at low density
        k = 0.3 * infl * luma[i] * luma[i];
        if (k >= 0.01) g = Math.floor(hash01(p.seed, i, ghostTick, 9) * chars.length);
      }
      if (g < 0 || k < 0.01) { glyph[i] = NO_GLYPH; continue; }
      glyph[i] = atlas.index.get(chars[g]);
      rgba[i * 4] = mix(ink[0], 255, w) * k;
      rgba[i * 4 + 1] = mix(ink[1], 255, w) * k;
      rgba[i * 4 + 2] = mix(ink[2], 255, w) * k;
      rgba[i * 4 + 3] = 255;
    }
    if (!state.draw) state.draw = {};
    drawGlyphGrid(ctx.out, { cols, rows, atlas, glyph, rgba, ink, bg }, state.draw);

    // ---- glow: a blurred copy (quarter size, smoothed back up) added on top ----
    if (p.glow > 0) {
      const W = ctx.out.canvas.width;
      const H = ctx.out.canvas.height;
      if (!state.scratch) state.scratch = document.createElement('canvas');
      const sm = state.scratch;
      sm.width = Math.max(1, Math.round(W / 4));
      sm.height = Math.max(1, Math.round(H / 4));
      const sg = sm.getContext('2d');
      sg.imageSmoothingEnabled = true;
      sg.imageSmoothingQuality = 'high';
      sg.clearRect(0, 0, sm.width, sm.height);
      sg.drawImage(ctx.out.canvas, 0, 0, sm.width, sm.height);
      const g2 = ctx.out.ctx2d;
      g2.save();
      g2.globalCompositeOperation = 'lighter';
      g2.globalAlpha = Math.min(1, p.glow * 0.9);
      g2.imageSmoothingEnabled = true;
      g2.imageSmoothingQuality = 'high';
      g2.drawImage(sm, 0, 0, W, H);
      g2.restore();
    }
    return { cols, rows, effectiveScale: scale };
  },

  dispose(state) {
    if (state?.scratch) { state.scratch.width = state.scratch.height = 1; state.scratch = null; }
  },
};
