// Pixel art (PLAN.md 7.9): the picture is reduced to a grid of `pixelSize` blocks (block average or median),
// quantised to a retro palette (or to an automatic k-means palette of N colours, 2-32) with optional dithering,
// stray pixels can be cleaned and the lighter side of every colour boundary gets a darker outline. The output is
// scaled with nearest neighbour: fit (blocks of pixelSize), or exactly 1x / 4x / 8x per art pixel.

import { DITHER_OPTIONS, quantizePalette, isErrorDiffusion } from '../engine/dither.js';
import { getPaletteRGB, luma01 } from '../engine/color.js';
import { PALETTES, PALETTE_IDS } from '../engine/palettes.js';
import { kmeansPalette } from '../engine/kmeans.js';
import { baseWidth, blockScale, presentPixels, workRatio } from '../engine/pixelkit.js';
import * as heavy from '../engine/heavy.js';

const HEAVY_PIXELS = 100000;

/** Mean (or per-channel median) colour of every block. Block size may be fractional (automatic quality drops). */
export function reduceBlocks(rgba, W, H, bw, Aw, Ah, median, into = null) {
  const out = into && into.length === Aw * Ah * 4 ? into : new Uint8ClampedArray(Aw * Ah * 4);
  const tmp = median ? [new Uint8Array(4096), new Uint8Array(4096), new Uint8Array(4096)] : null;
  for (let ay = 0; ay < Ah; ay++) {
    const y0 = Math.min(H - 1, Math.floor(ay * bw));
    const y1 = Math.min(H, Math.max(y0 + 1, Math.floor((ay + 1) * bw)));
    for (let ax = 0; ax < Aw; ax++) {
      const x0 = Math.min(W - 1, Math.floor(ax * bw));
      const x1 = Math.min(W, Math.max(x0 + 1, Math.floor((ax + 1) * bw)));
      const o = (ay * Aw + ax) * 4;
      if (!median) {
        let r = 0, g = 0, b = 0;
        for (let y = y0; y < y1; y++) {
          let i = (y * W + x0) * 4;
          for (let x = x0; x < x1; x++, i += 4) { r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; }
        }
        const cnt = (y1 - y0) * (x1 - x0);
        out[o] = r / cnt; out[o + 1] = g / cnt; out[o + 2] = b / cnt;
      } else {
        let n = 0;
        for (let y = y0; y < y1 && n < 4096; y++) {
          let i = (y * W + x0) * 4;
          for (let x = x0; x < x1 && n < 4096; x++, i += 4, n++) { tmp[0][n] = rgba[i]; tmp[1][n] = rgba[i + 1]; tmp[2][n] = rgba[i + 2]; }
        }
        for (let c = 0; c < 3; c++) { const v = tmp[c].subarray(0, n); v.sort(); out[o + c] = v[n >> 1]; }
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

/** Replace pixels whose four neighbours all share one other colour by that colour. */
export function cleanupStray(idx, w, h) {
  const out = idx.slice();
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const n = idx[i - w];
      if (idx[i + w] === n && idx[i - 1] === n && idx[i + 1] === n && idx[i] !== n) out[i] = n;
    }
  }
  return out;
}

/** Pixels on the lighter side of a colour boundary (ties by index): these are darkened by the outline. */
export function outlineMask(idx, lum, w, h) {
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = idx[i];
      const la = lum[a];
      const edge = (j) => {
        const b = idx[j];
        return b !== a && (la > lum[b] || (la === lum[b] && a > b));
      };
      if ((x > 0 && edge(i - 1)) || (x < w - 1 && edge(i + 1)) || (y > 0 && edge(i - w)) || (y < h - 1 && edge(i + w))) mask[i] = 1;
    }
  }
  return mask;
}

const paletteOptions = [{ value: 'auto', label: { es: 'Automática (k-means)', en: 'Automatic (k-means)' } },
  ...PALETTE_IDS.map((id) => ({ value: id, label: PALETTES[id].name }))];

const MODE = {
  id: 'pixelart',
  category: 'pixel',
  name: { es: 'Pixel art', en: 'Pixel art' },
  blurb: { es: 'Rejilla de píxeles con paleta retro o automática', en: 'Pixel grid with a retro or automatic palette' },
  badges: [],
  animated: false,
  uses: ['image'],
  exports: ['png', 'video'],
  draftScale: 1, // the art grid must not change while dragging a slider
  hide: ['cols', 'dither', 'serpentine'],

  presets: [
    { id: 'snes', name: { es: 'Consola 16 bits', en: '16-bit console' }, mode: { pixelSize: 6, paletteSource: 'auto', colors: 24, dither: 'none', outline: true, outlineStrength: 0.4 } },
    { id: 'gameboy', name: { es: 'Game Boy', en: 'Game Boy' }, mode: { pixelSize: 8, paletteSource: 'gameboy', dither: 'bayer4', outline: false } },
    { id: 'pico', name: { es: 'PICO-8', en: 'PICO-8' }, mode: { pixelSize: 6, paletteSource: 'pico8', dither: 'floyd-steinberg', outline: false } },
  ],

  params: [
    {
      id: 'pixelSize', type: 'range', min: 2, max: 32, step: 1, default: 6, unit: 'px',
      label: { es: 'Tamaño de píxel', en: 'Pixel size' },
      help: { es: 'Lado de cada píxel del arte, medido en la imagen original.', en: 'Side of every art pixel, measured on the original picture.' },
    },
    {
      id: 'reduce', type: 'select', default: 'average',
      options: [{ value: 'average', label: { es: 'Promedio', en: 'Average' } }, { value: 'median', label: { es: 'Mediana', en: 'Median' } }],
      label: { es: 'Reducción por bloque', en: 'Block reduction' },
      help: { es: 'La mediana conserva mejor los bordes duros; el promedio suaviza.', en: 'The median keeps hard edges better; the average smooths.' },
    },
    {
      id: 'paletteSource', type: 'select', default: 'auto', options: paletteOptions,
      label: { es: 'Paleta', en: 'Palette' },
      help: { es: 'Automática calcula los colores de la propia imagen con k-means.', en: 'Automatic computes the colors from the picture itself with k-means.' },
    },
    {
      id: 'colors', type: 'range', min: 2, max: 32, step: 1, default: 8,
      label: { es: 'Colores', en: 'Colors' },
      showIf: (p) => p.paletteSource === 'auto',
    },
    {
      id: 'customColors', type: 'text', default: '#15181e #66696f #c4f169 #f7f8fa',
      label: { es: 'Colores (hex)', en: 'Colors (hex)' },
      help: { es: 'Lista de colores hex separados por espacios.', en: 'Hex colors separated by spaces.' },
      showIf: (p) => p.paletteSource === 'custom',
    },
    {
      id: 'dither', type: 'select', default: 'none', options: DITHER_OPTIONS,
      label: { es: 'Tramado', en: 'Dithering' },
    },
    {
      id: 'serpentine', type: 'toggle', default: false,
      label: { es: 'Serpentina', en: 'Serpentine' },
      showIf: (p) => isErrorDiffusion(p.dither),
    },
    {
      id: 'cleanup', type: 'toggle', default: false,
      label: { es: 'Limpiar píxeles sueltos', en: 'Clean stray pixels' },
      help: { es: 'Funde con su entorno los píxeles aislados.', en: 'Merges isolated pixels into their surroundings.' },
    },
    {
      id: 'outline', type: 'toggle', default: false,
      label: { es: 'Contorno', en: 'Outline' },
      help: { es: 'Oscurece el lado claro de cada borde de color.', en: 'Darkens the lighter side of every color boundary.' },
    },
    {
      id: 'outlineStrength', type: 'range', min: 0, max: 1, step: 0.05, default: 0.5,
      label: { es: 'Fuerza del contorno', en: 'Outline strength' },
      showIf: (p) => p.outline,
    },
    {
      id: 'scaleMode', type: 'select', default: 'fit',
      options: [
        { value: 'fit', label: { es: 'Ajustar (tamaño de píxel)', en: 'Fit (pixel size)' } },
        { value: 'x1', label: { es: 'Nativo 1×', en: 'Native 1×' } },
        { value: 'x4', label: { es: 'Nativo 4×', en: 'Native 4×' } },
        { value: 'x8', label: { es: 'Nativo 8×', en: 'Native 8×' } },
      ],
      label: { es: 'Escala de salida', en: 'Output scale' },
      help: { es: 'Nativo dibuja cada píxel del arte como 1, 4 u 8 píxeles (vecino más cercano), útil para exportar.', en: 'Native draws every art pixel as 1, 4 or 8 pixels (nearest neighbour), handy for exporting.' },
    },
  ],

  resolution(params, srcW, srcH, opts = {}) {
    const W = baseWidth(srcW, opts.isExport ? 2048 : 1280);
    return { width: W, height: Math.max(1, Math.round((W * srcH) / srcW)) };
  },

  preOptions() {
    return { matte: '#ffffff', edgeBlend: 'dark' };
  },

  init() {
    return { scratch: {}, art: null, out: null, palette: null };
  },

  async render(ctx, state) {
    const p = ctx.params.mode;
    const W = ctx.width;
    const H = ctx.height;
    const ratio = workRatio(MODE, ctx);
    const bw = Math.max(1, p.pixelSize * ratio); // work px per art pixel
    const Aw = Math.max(1, Math.floor(W / bw + 1e-6));
    const Ah = Math.max(1, Math.floor(H / bw + 1e-6));
    const n = Aw * Ah;

    const art = reduceBlocks(ctx.rgba, W, H, bw, Aw, Ah, p.reduce === 'median', state.art);
    state.art = art;

    const palette = p.paletteSource === 'auto'
      ? kmeansPalette(art, p.colors, { seed: 1 })
      : getPaletteRGB(p.paletteSource, p.customColors);
    const opts = { serpentine: p.serpentine, metric: 'lab', seed: 5 };
    let idx;
    if (isErrorDiffusion(p.dither) && n > HEAVY_PIXELS) {
      idx = await heavy.run('quantizePalette', { rgba: art.slice(), w: Aw, h: Ah, palette, algorithm: p.dither, opts }, { signal: ctx.signal });
    } else {
      idx = quantizePalette(art, Aw, Ah, palette, p.dither, opts);
    }
    if (p.cleanup) idx = cleanupStray(idx, Aw, Ah);

    const lum = palette.map((c) => luma01(c[0], c[1], c[2]));
    const mask = p.outline ? outlineMask(idx, lum, Aw, Ah) : null;
    const dim = 1 - 0.7 * p.outlineStrength;
    const out = state.out && state.out.length === n * 4 ? state.out : (state.out = new Uint8ClampedArray(n * 4));
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      const c = palette[idx[i]];
      const k = mask && mask[i] ? dim : 1;
      out[o] = c[0] * k; out[o + 1] = c[1] * k; out[o + 2] = c[2] * k; out[o + 3] = 255;
    }
    state.palette = palette;

    const unit = p.scaleMode === 'x1' ? 1 : p.scaleMode === 'x4' ? 4 : p.scaleMode === 'x8' ? 8 : p.pixelSize;
    const { k, effectiveScale } = blockScale(ctx, 1, unit, Aw, Ah);
    presentPixels(ctx, state.scratch, out, Aw, Ah, k);
    return { cols: Aw, rows: Ah, effectiveScale, paletteSize: palette.length };
  },

  dispose(state) {
    if (state?.scratch?.canvas) { state.scratch.canvas.width = state.scratch.canvas.height = 1; state.scratch.canvas = null; }
    if (state) { state.art = null; state.out = null; }
  },
};

export default MODE;
