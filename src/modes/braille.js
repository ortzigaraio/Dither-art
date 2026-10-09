// Braille mode (PLAN.md 7.2): every character is a 2x4 block of dots. The picture is thresholded (with optional
// dithering) at 2x4 sub-pixels per cell; dots are drawn procedurally and exported as U+2800..U+28FF characters.

import { DITHER_OPTIONS, quantize, isErrorDiffusion } from '../engine/dither.js';
import { resolveColors, isDarkBackground, rgbToHex } from '../engine/color.js';
import { blockAverages, cellColors } from '../engine/cellcolor.js';
import { DOT_BIT, drawBrailleDots } from '../engine/dots.js';
import { gridToText } from '../io/exportText.js';
import * as heavy from '../engine/heavy.js';
import { LIMITS, config } from '../config.js';

const COLOR_MODES = ['mono', 'original', 'gradient', 'palette'];
const BASE_PITCH = 4; // output pixels between dots at scale 1
const HEAVY_SUBPIXELS = 250000; // error diffusion above this runs in the worker
const FONT_STACK = '"DejaVu Sans Mono", "Segoe UI Symbol", "Apple Braille", "Noto Sans Symbols 2", "Geist Mono", monospace';

const BRAILLE_CHARS = Array.from({ length: 256 }, (_, i) => String.fromCodePoint(0x2800 + i));

/**
 * Pack on/off sub-pixels (row-major, `stride` pixels per row) into Braille bit masks, one per 2x4 cell.
 * Bit layout: (0,0)=0x01 (0,1)=0x02 (0,2)=0x04 (1,0)=0x08 (1,1)=0x10 (1,2)=0x20 (0,3)=0x40 (1,3)=0x80
 */
export function packBraille(on, stride, cols, rows, into = null) {
  const bits = into && into.length === cols * rows ? into : new Uint8Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let m = 0;
      for (let dy = 0; dy < 4; dy++) {
        const o = (cy * 4 + dy) * stride + cx * 2;
        if (on[o]) m |= DOT_BIT[dy][0];
        if (on[o + 1]) m |= DOT_BIT[dy][1];
      }
      bits[cy * cols + cx] = m;
    }
  }
  return bits;
}

const hexOf = (rgb) => rgbToHex(rgb[0], rgb[1], rgb[2]);

export default {
  id: 'braille',
  category: 'text',
  name: { es: 'Braille', en: 'Braille Pattern Art' },
  blurb: { es: 'Puntos Braille 2×4 por carácter', en: '2×4 Braille dots per character' },
  badges: ['TXT'],
  animated: false,
  uses: ['image', 'color'],
  colorModes: COLOR_MODES,
  exports: ['png', 'txt', 'html', 'ansi', 'video'],
  draftScale: 1,
  hide: ['dither', 'serpentine'], // Braille has its own dithering (default Atkinson)

  presets: [
    { id: 'classic', name: { es: 'Clásico', en: 'Classic' }, mode: { threshold: 128, dither: 'atkinson' } },
    { id: 'soft', name: { es: 'Suave', en: 'Soft' }, mode: { dither: 'floyd-steinberg', dotScale: 0.9, showEmpty: true } },
    { id: 'graphic', name: { es: 'Gráfico', en: 'Graphic' }, mode: { dither: 'none', threshold: 110, dotShape: 'square', dotScale: 1 } },
  ],

  params: [
    {
      id: 'threshold', type: 'range', min: 0, max: 255, step: 1, default: 128,
      label: { es: 'Umbral', en: 'Threshold' },
      help: { es: 'Nivel de luminosidad a partir del cual se enciende un punto.', en: 'Brightness level at which a dot switches on.' },
    },
    {
      id: 'dither', type: 'select', default: 'atkinson', options: DITHER_OPTIONS,
      label: { es: 'Tramado', en: 'Dithering' },
      help: { es: 'Reparte el error entre puntos vecinos para simular grises.', en: 'Spreads the error between neighbouring dots to simulate greys.' },
    },
    {
      id: 'serpentine', type: 'toggle', default: false,
      label: { es: 'Serpentina', en: 'Serpentine' },
      showIf: (p) => isErrorDiffusion(p.dither),
    },
    {
      id: 'invert', type: 'toggle', default: false,
      label: { es: 'Invertir puntos', en: 'Invert dots' },
      help: { es: 'Enciende los puntos donde antes estaban apagados.', en: 'Switches on the dots that were off.' },
    },
    {
      id: 'dotShape', type: 'select', default: 'circle',
      options: [
        { value: 'circle', label: { es: 'Círculo', en: 'Circle' } },
        { value: 'square', label: { es: 'Cuadrado', en: 'Square' } },
      ],
      label: { es: 'Forma del punto', en: 'Dot shape' },
    },
    {
      id: 'dotScale', type: 'range', min: 0.3, max: 1, step: 0.05, default: 0.8,
      label: { es: 'Tamaño del punto', en: 'Dot size' },
    },
    {
      id: 'showEmpty', type: 'toggle', default: false,
      label: { es: 'Mostrar puntos vacíos', en: 'Show empty dots' },
      help: { es: 'Dibuja los puntos apagados al 15 % de opacidad.', en: 'Draws the switched-off dots at 15 % opacity.' },
    },
    {
      id: 'blankAsSpace', type: 'toggle', default: false,
      label: { es: 'Vacío como espacio', en: 'Blank as space' },
      help: { es: 'En la exportación de texto, las celdas sin puntos (U+2800) salen como espacio.', en: 'In the text export, cells without dots (U+2800) come out as a space.' },
    },
  ],

  resolution(params, srcW, srcH) {
    const cols = Math.max(1, Math.min(LIMITS.maxCols, Math.round(params.global.cols)));
    const W = cols * 2;
    const rows = Math.max(1, Math.round((W * (srcH / srcW)) / 4));
    return { width: W, height: rows * 4 };
  },

  preOptions(params, theme) {
    const cr = resolveColors(params.color, theme, COLOR_MODES);
    const dark = isDarkBackground(cr);
    return {
      matte: cr.bgTransparent ? (dark ? '#000000' : '#ffffff') : hexOf(cr.bg),
      edgeBlend: dark ? 'light' : 'dark',
    };
  },

  init() {
    return { grid: null, cache: {}, scratch: {} };
  },

  async render(ctx, state) {
    const p = ctx.params.mode;
    const g = ctx.params.global;
    const cr = resolveColors(ctx.params.color, ctx.theme, COLOR_MODES);
    const dark = isDarkBackground(cr);
    const W = ctx.width;
    const cols = Math.max(1, Math.floor(W / 2));
    const rows = Math.max(1, Math.floor(ctx.height / 4));
    const H = rows * 4;
    const n = cols * rows;

    // ---- sub-pixel levels: "on" where the picture is bright on a dark background, dark on a light one ----
    const luma = ctx.luma();
    const brightIsOn = dark !== !!p.invert;
    const tau = brightIsOn ? p.threshold / 255 : 1 - p.threshold / 255;
    const t = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      if (brightIsOn) for (let x = 0; x < W; x++) t[row + x] = luma[row + x];
      else for (let x = 0; x < W; x++) t[row + x] = 1 - luma[row + x];
    }
    const opts = { serpentine: p.serpentine, seed: 11, bias: 0.5 - tau };
    let on;
    if (isErrorDiffusion(p.dither) && W * H > HEAVY_SUBPIXELS) {
      on = await heavy.run('quantize', { buffer: t, w: W, h: H, levels: 2, algorithm: p.dither, opts });
    } else {
      on = quantize(t, W, H, 2, p.dither, opts);
    }

    const bits = packBraille(on, W, cols, rows, state.bits);
    state.bits = bits;

    // ---- colour ----
    let rgba = null;
    if (cr.mode !== 'mono') {
      const avg = blockAverages(ctx.rgba, W, cols, rows, 2, 4);
      rgba = cellColors(cr, avg.rgb, avg.luma, state.cache, state.cellRGBA);
      state.cellRGBA = rgba;
    }

    // ---- draw ----
    const cap = ctx.isExport ? LIMITS.maxExportImageSide : 4096;
    const pitch = Math.max(1, Math.min(Math.round(BASE_PITCH * ctx.outScale), Math.floor(cap / (cols * 2)), Math.floor(cap / (rows * 4))));
    drawBrailleDots(ctx.out, {
      cols, rows, bits, pitch, shape: p.dotShape, scale: p.dotScale, showEmpty: p.showEmpty,
      rgba, ink: cr.ink, bg: cr.bgTransparent ? null : cr.bg,
    }, state.scratch);

    const chars = new Array(n);
    const blank = p.blankAsSpace ? ' ' : BRAILLE_CHARS[0];
    for (let i = 0; i < n; i++) chars[i] = bits[i] === 0 ? blank : BRAILLE_CHARS[bits[i]];
    state.grid = {
      cols, rows, chars, rgba,
      mono: cr.mode === 'mono' ? cr.ink : null,
      bg: cr.bgTransparent ? null : cr.bg,
      css: { family: FONT_STACK, size: 14, lineHeight: 1.1, letterSpacing: 0 },
    };
    return { cols, rows, transparent: cr.bgTransparent, effectiveScale: pitch / BASE_PITCH, pitch };
  },

  /** format: 'txt' | 'html' | 'ansi' */
  toText(state, format, opts) {
    if (!state?.grid) return '';
    return gridToText(state.grid, format, { title: `${config.productName} Braille`, ...opts });
  },

  dispose(state) {
    if (state?.scratch?.img) state.scratch.img = null;
  },
};
