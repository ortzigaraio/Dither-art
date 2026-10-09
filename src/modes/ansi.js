// ANSI Art mode (PLAN.md 7.3): half blocks (two image pixels per character: foreground = top, background = bottom),
// classic shading (░▒▓█ mixing a foreground over a background) or a per-cell mix of both. Palettes: VGA 16,
// xterm 256 or truecolor. Drawn procedurally in 8 x 16 cells; exported as UTF-8 text, HTML, ANSI escapes and a
// CP437 .ans file.

import { DITHER_OPTIONS, quantizePalette, isErrorDiffusion } from '../engine/dither.js';
import {
  CH, CELL_CHARS, VGA16, xterm256, buildMixTable, shadeCells, halfBlockCells, projectionCells, shadeToRGB, pickBest,
  shadeErrorTwoPixels, cellMeans,
} from '../engine/ansiart.js';
import { gridToText, gridToANS } from '../io/exportText.js';
import * as heavy from '../engine/heavy.js';
import { LIMITS, config } from '../config.js';

const BASE_CELL_W = 8; // VGA cell: 8 x 16
const HEAVY_PIXELS = 100000; // palette dithering above this runs in the worker
const HEAVY_CELLS = 20000; // shading search above this runs in the worker
const FONT_STACK = '"DejaVu Sans Mono", "Geist Mono", Menlo, Consolas, monospace';

const paletteOf = (id) => (id === 'vga16' ? VGA16 : id === 'xterm256' ? xterm256() : null);

/** Palette indices for every pixel (cols x H RGBA), dithered; the worker takes over for big grids. */
async function quantizeToPalette(src, W, H, palette, algorithm, serpentine) {
  const opts = { serpentine, seed: 5, metric: 'lab' };
  if (isErrorDiffusion(algorithm) && W * H > HEAVY_PIXELS) {
    return heavy.run('quantizePalette', { rgba: src.slice(0, W * H * 4), w: W, h: H, palette, algorithm, opts });
  }
  return quantizePalette(src, W, H, palette, algorithm, opts);
}

async function shade(M, cols, rows, palette, bgCount, algorithm, serpentine) {
  if (cols * rows > HEAVY_CELLS) {
    return heavy.run('ansiShade', { M, cols, rows, palette, bgCount, algorithm, serpentine });
  }
  return shadeCells(M, cols, rows, buildMixTable(palette, bgCount), algorithm, serpentine);
}

/** Build the cell arrays { ch, fg, bg } (3 bytes per colour) for a cols x (2*rows) RGBA picture. */
export async function buildCells(src, cols, rows, { charMode, ansiPalette, dither, serpentine, bg8 }) {
  const W = cols;
  const H = rows * 2;
  const palette = paletteOf(ansiPalette);
  const bgCount = palette ? (bg8 && ansiPalette === 'vga16' ? 8 : palette.length) : 0;
  const needIdx = !!palette && (charMode !== 'shading' || palette.length > 16);
  const idx = needIdx ? await quantizeToPalette(src, W, H, palette, dither, serpentine) : null;

  let half = null;
  if (charMode !== 'shading') half = halfBlockCells(src, idx, palette, cols, rows, bgCount);
  if (charMode === 'halfblocks') return half;

  let shaded;
  if (palette && palette.length <= 16) {
    const M = cellMeans(src, cols, rows);
    const res = await shade(M, cols, rows, palette, bgCount, dither, serpentine);
    shaded = shadeToRGB(res, palette);
    shaded.err = shadeErrorTwoPixels(M, src, cols, rows, res);
  } else {
    let q = src;
    if (idx) {
      q = new Uint8ClampedArray(W * H * 4);
      for (let i = 0; i < W * H; i++) {
        const c = palette[idx[i]];
        q[i * 4] = c[0]; q[i * 4 + 1] = c[1]; q[i * 4 + 2] = c[2]; q[i * 4 + 3] = 255;
      }
    }
    shaded = projectionCells(src, q, cols, rows);
  }
  return charMode === 'shading' ? shaded : pickBest(half, shaded);
}

/** Packed little-endian ABGR pixel. */
const pack = (r, g, b) => (255 << 24) | (b << 16) | (g << 8) | r;

function drawCells(out, cells, cols, rows, cw, scratch) {
  const chh = cw * 2;
  const W = cols * cw;
  const H = rows * chh;
  const canvas = out.canvas;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  if (!scratch.img || scratch.img.width !== W || scratch.img.height !== H) {
    scratch.img = new ImageData(W, H);
    scratch.u32 = new Uint32Array(scratch.img.data.buffer);
  }
  const u32 = scratch.u32;
  const { ch, fg, bg } = cells;
  const cov = [0, 0.25, 0.5, 0.75, 1];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const fr = fg[i * 3], fgc = fg[i * 3 + 1], fb = fg[i * 3 + 2];
      const br = bg[i * 3], bgc = bg[i * 3 + 1], bb = bg[i * 3 + 2];
      const F = pack(fr, fgc, fb);
      const B = pack(br, bgc, bb);
      let top = B, bottom = B;
      const c = ch[i];
      if (c === CH.FULL) { top = F; bottom = F; } else if (c === CH.UPPER) { top = F; } else if (c === CH.LOWER) { bottom = F; } else if (c > 0) {
        const k = cov[c];
        top = bottom = pack(Math.round(br + (fr - br) * k), Math.round(bgc + (fgc - bgc) * k), Math.round(bb + (fb - bb) * k));
      }
      for (let r = 0; r < chh; r++) {
        const start = (y * chh + r) * W + x * cw;
        u32.fill(r < cw ? top : bottom, start, start + cw);
      }
    }
  }
  out.ctx2d.putImageData(scratch.img, 0, 0);
}

export default {
  id: 'ansi',
  category: 'text',
  name: { es: 'ANSI Art', en: 'ANSI Art' },
  blurb: { es: 'Bloques y sombreado estilo BBS, con exportación .ans', en: 'BBS-style blocks and shading, with .ans export' },
  badges: ['TXT'],
  animated: false,
  uses: ['image'],
  exports: ['png', 'txt', 'html', 'ansi', 'ans', 'video'],
  draftScale: 1,
  hide: ['dither', 'serpentine'],

  presets: [
    { id: 'bbs', name: { es: 'BBS clásico', en: 'Classic BBS' }, mode: { charMode: 'shading', ansiPalette: 'vga16', dither: 'bayer4', bg8: true } },
    { id: 'halfblocks', name: { es: 'Medios bloques', en: 'Half blocks' }, mode: { charMode: 'halfblocks', ansiPalette: 'vga16', dither: 'floyd-steinberg' } },
    { id: 'truecolor', name: { es: 'Truecolor', en: 'Truecolor' }, mode: { charMode: 'halfblocks', ansiPalette: 'truecolor' } },
  ],

  params: [
    {
      id: 'charMode', type: 'select', default: 'halfblocks',
      options: [
        { value: 'halfblocks', label: { es: 'Medios bloques', en: 'Half blocks' } },
        { value: 'shading', label: { es: 'Sombreado clásico', en: 'Classic shading' } },
        { value: 'mixed', label: { es: 'Mixto', en: 'Mixed' } },
      ],
      label: { es: 'Caracteres', en: 'Characters' },
      help: {
        es: 'Medios bloques: dos píxeles por carácter. Sombreado: ░▒▓█ mezclan dos colores. Mixto: elige lo mejor en cada celda.',
        en: 'Half blocks: two pixels per character. Shading: ░▒▓█ blend two colors. Mixed: picks the best one in each cell.',
      },
    },
    {
      id: 'ansiPalette', type: 'select', default: 'vga16',
      options: [
        { value: 'vga16', label: { es: 'VGA 16 colores', en: 'VGA 16 colors' } },
        { value: 'xterm256', label: { es: 'xterm 256 colores', en: 'xterm 256 colors' } },
        { value: 'truecolor', label: { es: 'Truecolor', en: 'Truecolor' } },
      ],
      label: { es: 'Paleta', en: 'Palette' },
    },
    {
      id: 'dither', type: 'select', default: 'floyd-steinberg', options: DITHER_OPTIONS,
      label: { es: 'Tramado', en: 'Dithering' },
      help: { es: 'Reparte el error de color entre celdas vecinas (no afecta a Truecolor con medios bloques).', en: 'Spreads the color error between neighbouring cells (no effect on truecolor half blocks).' },
      showIf: (p) => p.ansiPalette !== 'truecolor' || p.charMode !== 'halfblocks',
    },
    {
      id: 'serpentine', type: 'toggle', default: false,
      label: { es: 'Serpentina', en: 'Serpentine' },
      showIf: (p) => isErrorDiffusion(p.dither) && (p.ansiPalette !== 'truecolor' || p.charMode !== 'halfblocks'),
    },
    {
      id: 'bg8', type: 'toggle', default: true,
      label: { es: 'Solo 8 fondos (ANSI.SYS)', en: 'Only 8 backgrounds (ANSI.SYS)' },
      help: { es: 'ANSI.SYS solo admite 8 colores de fondo: los fondos brillantes parpadearían. Así la vista previa coincide con el .ans.', en: 'ANSI.SYS only has 8 background colors: bright backgrounds would blink. This makes the preview match the .ans file.' },
      showIf: (p) => p.ansiPalette === 'vga16',
    },
  ],

  resolution(params, srcW, srcH) {
    const cols = Math.max(1, Math.min(LIMITS.maxCols, Math.round(params.global.cols)));
    const rows = Math.max(1, Math.round((cols * (srcH / srcW)) / 2));
    return { width: cols, height: rows * 2 };
  },

  preOptions() {
    return { matte: '#000000', edgeBlend: 'light' };
  },

  init() {
    return { grid: null, scratch: {} };
  },

  async render(ctx, state) {
    const p = ctx.params.mode;
    const cols = ctx.width;
    const rows = Math.max(1, Math.floor(ctx.height / 2));
    const cells = await buildCells(ctx.rgba, cols, rows, p);

    const cap = ctx.isExport ? LIMITS.maxExportImageSide : 4096;
    const cw = Math.max(1, Math.min(Math.round(BASE_CELL_W * ctx.outScale), Math.floor(cap / cols), Math.floor(cap / (rows * 2))));
    drawCells(ctx.out, cells, cols, rows, cw, state.scratch);

    const n = cols * rows;
    const chars = new Array(n);
    const rgba = new Uint8ClampedArray(n * 4);
    const bgRgba = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      chars[i] = CELL_CHARS[cells.ch[i]];
      rgba[i * 4] = cells.fg[i * 3]; rgba[i * 4 + 1] = cells.fg[i * 3 + 1]; rgba[i * 4 + 2] = cells.fg[i * 3 + 2]; rgba[i * 4 + 3] = 255;
      bgRgba[i * 4] = cells.bg[i * 3]; bgRgba[i * 4 + 1] = cells.bg[i * 3 + 1]; bgRgba[i * 4 + 2] = cells.bg[i * 3 + 2]; bgRgba[i * 4 + 3] = 255;
    }
    state.cells = cells;
    state.grid = {
      cols, rows, chars, rgba, bgRgba, mono: null, bg: null,
      css: { family: FONT_STACK, size: 16, lineHeight: 1, letterSpacing: 0 },
    };
    return { cols, rows, effectiveScale: cw / BASE_CELL_W, cellW: cw, cellH: cw * 2 };
  },

  /** format: 'txt' | 'html' | 'ansi' */
  toText(state, format, opts) {
    if (!state?.grid) return '';
    return gridToText(state.grid, format, { title: `${config.productName} ANSI Art`, ...opts });
  },

  /** format: 'ans' -> Uint8Array of an ANSI.SYS-style file in CP437 */
  toBinary(state, format) {
    if (!state?.grid || format !== 'ans') return new Uint8Array(0);
    return gridToANS(state.grid);
  },

  dispose(state) {
    if (state?.scratch?.img) state.scratch.img = null;
  },
};
