// PETSCII mode (PLAN.md 7.4): a character screen of 8x8 cells, each a glyph from our own ~97-glyph set with one
// foreground colour from a C64-style palette, over ONE global background colour (like the C64's screen colour).
// Matching runs on the main thread up to 40x25 cells and in heavy.worker.js above that.

import {
  GLYPHS, GLYPH_COUNT, GLYPH_BYTES, GLYPH_SETS, PETSCII_PALETTES, PETSCII_PALETTE_IDS, paletteRGB, enabledMask, glyphToUnicode,
} from '../engine/petscii.js';
import { petsciiMatch } from '../engine/petsciiMatch.js';
import { rgbToHex } from '../engine/color.js';
import * as heavy from '../engine/heavy.js';
import { LIMITS, config } from '../config.js';

const WORKER_ABOVE_CELLS = 40 * 25;
const MAX_COLS = 160;
const MAX_ROWS = 200;
const BORDER_PX = 32; // C64 border at scale 1 (4 cells)

const SET_PARAMS = {
  blocks: { id: 'useBlocks', label: { es: 'Bloques y sombras', en: 'Blocks and shades' } },
  lines: { id: 'useLines', label: { es: 'Líneas y cuadrículas', en: 'Lines and grids' } },
  diagonals: { id: 'useDiagonals', label: { es: 'Diagonales y triángulos', en: 'Diagonals and triangles' } },
  rounds: { id: 'useRounds', label: { es: 'Formas redondas', en: 'Rounded shapes' } },
};

const paletteOptionLabel = (i) => ({ es: `Color ${i}`, en: `Color ${i}` });
const bgOptions = [{ value: 'auto', label: { es: 'Automático', en: 'Automatic' } }];
for (let i = 0; i < 16; i++) bgOptions.push({ value: String(i), label: paletteOptionLabel(i) });
const borderOptions = Array.from({ length: 16 }, (_, i) => ({ value: String(i), label: paletteOptionLabel(i) }));

const colsOf = (p, globalCols) => {
  if (p.grid === 'c64') return 40;
  if (p.grid === '80') return 80;
  return Math.max(1, Math.min(MAX_COLS, Math.round(p.customCols ?? globalCols)));
};

export default {
  id: 'petscii',
  category: 'text',
  name: { es: 'PETSCII', en: 'PETSCII' },
  blurb: { es: 'Pantalla de caracteres 8×8 al estilo C64', en: 'C64-style 8×8 character screen' },
  badges: ['TXT'],
  animated: false,
  uses: ['image'],
  exports: ['png', 'txt', 'json', 'video'],
  draftScale: 1,
  hide: ['cols', 'dither', 'serpentine'],

  presets: [
    { id: 'c64', name: { es: 'C64 clásico', en: 'Classic C64' }, mode: { grid: 'c64', paletteSet: 'c64', bgColor: 'auto', border: true } },
    { id: 'hires', name: { es: 'Alta resolución', en: 'High resolution' }, mode: { grid: '80', paletteSet: 'c64' } },
    { id: 'pet', name: { es: 'PET verde', en: 'Green PET' }, mode: { grid: 'c64', paletteSet: 'pet' } },
  ],

  params: [
    {
      id: 'grid', type: 'select', default: 'c64',
      options: [
        { value: 'c64', label: { es: '40 columnas (C64)', en: '40 columns (C64)' } },
        { value: '80', label: { es: '80 columnas', en: '80 columns' } },
        { value: 'custom', label: { es: 'Personalizada', en: 'Custom' } },
      ],
      label: { es: 'Rejilla', en: 'Grid' },
      help: { es: 'Número de columnas de celdas de 8×8. Las filas siguen la proporción de la imagen.', en: 'Number of columns of 8×8 cells. Rows follow the picture aspect.' },
    },
    {
      id: 'customCols', type: 'range', min: 10, max: MAX_COLS, step: 1, default: 40,
      label: { es: 'Columnas', en: 'Columns' },
      showIf: (p) => p.grid === 'custom',
    },
    {
      id: 'paletteSet', type: 'select', default: 'c64',
      options: PETSCII_PALETTE_IDS.map((id) => ({ value: id, label: PETSCII_PALETTES[id].name })),
      label: { es: 'Paleta', en: 'Palette' },
    },
    {
      id: 'bgColor', type: 'select', default: 'auto', options: bgOptions,
      label: { es: 'Color de fondo', en: 'Background color' },
      help: { es: 'Un único color de fondo para toda la pantalla, como en el C64. Automático usa el color más frecuente.', en: 'One background color for the whole screen, like the C64. Automatic uses the most frequent color.' },
    },
    ...GLYPH_SETS.map((set) => ({
      id: SET_PARAMS[set].id, type: 'toggle', default: true, label: SET_PARAMS[set].label,
    })),
    {
      id: 'border', type: 'toggle', default: false,
      label: { es: 'Marco C64', en: 'C64 border' },
      help: { es: 'Añade el marco de color alrededor de la pantalla.', en: 'Adds the colored border around the screen.' },
    },
    {
      id: 'borderColor', type: 'select', default: '14', options: borderOptions,
      label: { es: 'Color del marco', en: 'Border color' },
      showIf: (p) => p.border,
    },
  ],

  resolution(params, srcW, srcH) {
    const cols = colsOf(params.mode, params.global.cols);
    const rows = Math.max(1, Math.min(MAX_ROWS, Math.round(cols * (srcH / srcW))));
    return { width: cols * 8, height: rows * 8 };
  },

  preOptions() {
    return { matte: '#000000', edgeBlend: 'light' };
  },

  init() {
    return { result: null, scratch: {} };
  },

  async render(ctx, state) {
    const p = ctx.params.mode;
    const cols = Math.max(1, Math.floor(ctx.width / 8));
    const rows = Math.max(1, Math.floor(ctx.height / 8));
    const W = cols * 8;
    const H = rows * 8;
    const palette = paletteRGB(p.paletteSet);

    // compact copy (the work canvas may be wider than the cell grid after an automatic quality reduction)
    const src = ctx.rgba;
    const rgba = new Uint8ClampedArray(W * H * 4);
    if (ctx.width === W) rgba.set(src.subarray(0, W * H * 4));
    else for (let y = 0; y < H; y++) rgba.set(src.subarray(y * ctx.width * 4, y * ctx.width * 4 + W * 4), y * W * 4);

    const sets = GLYPH_SETS.filter((s) => p[SET_PARAMS[s].id]);
    const bgWanted = p.bgColor === 'auto' ? -1 : Number(p.bgColor);
    const payload = { rgba, cols, rows, palette, glyphs: GLYPH_BYTES, enabled: enabledMask(sets), bg: bgWanted };
    let res;
    if (cols * rows > WORKER_ABOVE_CELLS) res = await heavy.run('petscii', payload, { transfer: [rgba.buffer] });
    else res = petsciiMatch(payload);

    // ---- draw: every glyph pixel is a s x s block ----
    const border = p.border ? BORDER_PX : 0;
    const cap = ctx.isExport ? LIMITS.maxExportImageSide : 4096;
    const s = Math.max(1, Math.min(Math.round(ctx.outScale), Math.floor(cap / (W + 2 * border)), Math.floor(cap / (H + 2 * border))));
    const OW = (W + 2 * border) * s;
    const OH = (H + 2 * border) * s;
    const canvas = ctx.out.canvas;
    if (canvas.width !== OW || canvas.height !== OH) { canvas.width = OW; canvas.height = OH; }
    const sc = state.scratch;
    if (!sc.img || sc.img.width !== OW || sc.img.height !== OH) {
      sc.img = new ImageData(OW, OH);
      sc.u32 = new Uint32Array(sc.img.data.buffer);
    }
    const u32 = sc.u32;
    const pack = (c) => (255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0];
    const bgPix = pack(palette[res.bg]);
    const borderIdx = Math.min(palette.length - 1, Number(p.borderColor) || 0);
    u32.fill(p.border ? pack(palette[borderIdx]) : bgPix);
    const ox = border * s;
    // screen background
    for (let y = 0; y < H * s; y++) u32.fill(bgPix, (ox + y) * OW + ox, (ox + y) * OW + ox + W * s);
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const cell = cy * cols + cx;
        const g = res.glyph[cell];
        if (g === 0) continue; // the empty glyph: background only
        const fg = pack(palette[res.color[cell]]);
        for (let py = 0; py < 8; py++) {
          const byte = GLYPH_BYTES[g * 8 + py];
          if (!byte) continue;
          for (let px = 0; px < 8; px++) {
            if (!(byte & (0x80 >> px))) continue;
            const x0 = ox + (cx * 8 + px) * s;
            for (let sy = 0; sy < s; sy++) {
              const row = (ox + (cy * 8 + py) * s + sy) * OW + x0;
              u32.fill(fg, row, row + s);
            }
          }
        }
      }
    }
    ctx.out.ctx2d.putImageData(sc.img, 0, 0);

    state.result = {
      cols, rows, glyph: res.glyph, color: res.color, bg: res.bg, paletteSet: p.paletteSet, palette,
      border: p.border ? borderIdx : null,
    };
    return { cols, rows, effectiveScale: s, bg: res.bg };
  },

  /** format: 'txt' -> Unicode approximation (block elements, box drawing and Symbols for Legacy Computing) */
  toText(state, format) {
    const r = state?.result;
    if (!r) return '';
    let out = '';
    for (let y = 0; y < r.rows; y++) {
      let line = '';
      for (let x = 0; x < r.cols; x++) line += glyphToUnicode(r.glyph[y * r.cols + x]);
      out += `${line}\n`;
    }
    return out;
  },

  /** Glyph bitmaps plus the screen: enough to rebuild the picture in any tool. */
  toJSON(state) {
    const r = state?.result;
    if (!r) return '{}';
    return JSON.stringify({
      format: 'dither-petscii',
      version: 1,
      generator: `${config.productName} by Horain`,
      note: 'Original 8x8 glyph set; not the C64 character ROM.',
      cols: r.cols,
      rows: r.rows,
      paletteSet: r.paletteSet,
      palette: r.palette.map((c) => rgbToHex(c[0], c[1], c[2])),
      background: r.bg,
      border: r.border,
      glyphs: GLYPHS.map((g) => ({ index: g.index, id: g.id, set: g.set, rows: Array.from(g.rows) })),
      glyphCount: GLYPH_COUNT,
      cells: Array.from(r.glyph),
      colors: Array.from(r.color),
    });
  },

  dispose(state) {
    if (state?.scratch) state.scratch.img = null;
  },
};
