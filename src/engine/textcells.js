// Character-cell output for the GPU text modes (PLAN.md 7.23, 7.24): a picture rendered on the GPU at one pixel per
// cell (or 2 x 4 per cell for Braille) is read back and drawn with the renderers of the text modes:
// the glyph atlas compositor of ASCII (glyphs.drawGlyphGrid) and the procedural Braille dots (dots.drawBrailleDots).
// The grid kept in the mode state is what the TXT / HTML / ANSI exports serialise (io/exportText.js).

import {
  NO_GLYPH, buildGradient, getAtlas, drawGlyphGrid, cellAspect, cellLayout, fontStack, fontsReady, requestFonts, baseCell, FONTS,
} from './glyphs.js';
import { quantize } from './dither.js';
import { cellColors } from './cellcolor.js';
import { DOT_BIT, drawBrailleDots } from './dots.js';
import { LIMITS } from '../config.js';

export const TEXT_COLOR_MODES = ['mono', 'original', 'gradient', 'palette'];
const MAX_PREVIEW_SIDE = 4096;
const BRAILLE_PITCH = 4;
const BRAILLE_FONT = '"DejaVu Sans Mono", "Segoe UI Symbol", "Apple Braille", "Noto Sans Symbols 2", "Geist Mono", monospace';
const BRAILLE_CHARS = Array.from({ length: 256 }, (_, i) => String.fromCodePoint(0x2800 + i));

/** Rows of a text grid of `cols` columns that keeps the picture aspect with the font's real cell aspect. */
export function textRows(p, cols, srcW, srcH) {
  const fontId = p.font in FONTS ? p.font : 'geist-mono';
  const aspect = cellAspect(fontId, p.cellSize, p.lineHeight, p.letterSpacing);
  return Math.max(1, Math.round(cols * (srcH / Math.max(1, srcW)) * aspect));
}

/** Width / height of one character cell (for the GPU camera aspect). */
export function cellAspectOf(p) {
  const fontId = p.font in FONTS ? p.font : 'geist-mono';
  return cellAspect(fontId, p.cellSize, p.lineHeight, p.letterSpacing);
}

/**
 * Read-back pixels (RGBA, bottom-up as GL returns them) -> per-cell top-down arrays.
 * Alpha > 127 marks a covered cell. With `lightInAlpha` the shader stores the brightness that picks the glyph in
 * alpha (128 + 127 · light) and the colour in RGB; otherwise the brightness is the luma of RGB.
 * @returns {{ lum: Float32Array, mask: Uint8Array, rgb: Uint8ClampedArray }}
 */
export function cellsFromPixels(px, cols, rows, into = {}, lightInAlpha = false) {
  const n = cols * rows;
  const lum = into.lum?.length === n ? into.lum : new Float32Array(n);
  const mask = into.mask?.length === n ? into.mask : new Uint8Array(n);
  const rgb = into.rgb?.length === n * 4 ? into.rgb : new Uint8ClampedArray(n * 4);
  for (let y = 0; y < rows; y++) {
    const src = (rows - 1 - y) * cols; // flip: GL rows start at the bottom
    for (let x = 0; x < cols; x++) {
      const o = (src + x) * 4;
      const i = y * cols + x;
      const a = px[o + 3];
      mask[i] = a > 127 ? 1 : 0;
      rgb[i * 4] = px[o]; rgb[i * 4 + 1] = px[o + 1]; rgb[i * 4 + 2] = px[o + 2]; rgb[i * 4 + 3] = 255;
      lum[i] = lightInAlpha ? (a > 127 ? (a - 128) / 127 : 0) : (0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]) / 255;
    }
  }
  return { lum, mask, rgb };
}

/**
 * Stretch the brightness of the covered cells so the brightest 2 % reach 1 (auto exposure; deterministic).
 * Returns a new array; uncovered cells stay 0.
 */
export function autoLevel(lum, mask, into = null) {
  const n = lum.length;
  const hist = new Uint32Array(256);
  let covered = 0;
  for (let i = 0; i < n; i++) if (mask[i]) { hist[Math.min(255, Math.round(lum[i] * 255))]++; covered++; }
  const out = into && into.length === n ? into : new Float32Array(n);
  if (!covered) { out.fill(0); return out; }
  let acc = 0;
  let hi = 255;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= covered * 0.02) { hi = v; break; } }
  const k = 255 / Math.max(32, hi);
  for (let i = 0; i < n; i++) out[i] = mask[i] ? Math.min(1, lum[i] * k) : 0;
  return out;
}

/**
 * Draw a character grid with the ASCII glyph compositor into ctx.out2d and keep it for the text exports.
 * @param {object} ctx      FrameContext
 * @param {object} state    mode state (gets .grid, .glyph, .cellRGBA, .cache)
 * @param {object} g
 * @param {number} g.cols @param {number} g.rows
 * @param {Float32Array} g.lum   brightness per cell 0..1
 * @param {Uint8Array} g.mask    1 = the surface covers the cell, 0 = background (always blank)
 * @param {Uint8ClampedArray} g.rgb  rendered colour per cell (4 bytes)
 * @param {object} g.p      text params (gradient, customGradient, autoSort, invertGradient, spaceDensity, font, cellSize, lineHeight, letterSpacing)
 * @param {object} g.cr     resolveColors() result
 * @param {boolean} g.dark  dark output background (bright surface = dense glyph)
 * @param {string} [g.gradient]  forced gradient id (e.g. 'blocks')
 * @param {string} g.title
 */
export function drawTextCells(ctx, state, g) {
  const { cols, rows, lum, mask, rgb, p, cr, dark } = g;
  const n = cols * rows;
  const fontId = p.font in FONTS ? p.font : 'geist-mono';
  const glob = ctx.params.global || {};
  const grad = buildGradient({
    gradient: g.gradient || p.gradient, custom: p.customGradient, autoSort: p.autoSort,
    invert: p.invertGradient, spaceDensity: p.spaceDensity, fontId,
  });
  const L = grad.chars.length;
  const atlasChars = Array.from(new Set(grad.chars));
  const text = atlasChars.join('');
  if (!fontsReady(fontId, text)) requestFonts(fontId, text, ctx.invalidate);

  const t = state.tbuf?.length === n ? state.tbuf : (state.tbuf = new Float32Array(n));
  for (let i = 0; i < n; i++) t[i] = mask[i] ? (dark ? lum[i] : 1 - lum[i]) : 0;
  const idx = quantize(t, cols, rows, L, glob.dither || 'none', { serpentine: !!glob.serpentine, seed: 7 });

  const cap = ctx.isExport ? LIMITS.maxExportImageSide : MAX_PREVIEW_SIDE;
  const base = baseCell(fontId, p.cellSize, p.lineHeight, p.letterSpacing);
  let scale = Math.min(ctx.outScale || 1, cap / (cols * base.w), cap / (rows * base.h));
  let layout = cellLayout(fontId, p.cellSize, p.lineHeight, p.letterSpacing, scale);
  for (let guard = 0; guard < 8 && (cols * layout.cellW > cap || rows * layout.cellH > cap) && scale > 0.05; guard++) {
    scale *= 0.95;
    layout = cellLayout(fontId, p.cellSize, p.lineHeight, p.letterSpacing, scale);
  }
  const atlas = getAtlas(atlasChars, fontId, layout);
  const chars = state.chars?.length === n ? state.chars : (state.chars = new Array(n));
  const glyph = state.glyph?.length === n ? state.glyph : (state.glyph = new Uint16Array(n));
  for (let i = 0; i < n; i++) {
    const ch = mask[i] ? grad.chars[idx[i]] : ' ';
    chars[i] = ch;
    glyph[i] = ch === ' ' ? NO_GLYPH : atlas.index.get(ch);
  }
  state.cache = state.cache || {};
  const cellRGBA = cellColors(cr, rgb, lum, state.cache, state.cellRGBA);
  state.cellRGBA = cellRGBA;
  drawGlyphGrid(ctx.out2d, { cols, rows, atlas, glyph, rgba: cellRGBA, ink: cr.ink, bg: cr.bgTransparent ? null : cr.bg }, state.cache);

  state.grid = {
    cols, rows, chars, rgba: cellRGBA,
    mono: cr.mode === 'mono' ? cr.ink : null,
    bg: cr.bgTransparent ? null : cr.bg,
    css: { family: fontStack(fontId), size: p.cellSize, lineHeight: p.lineHeight, letterSpacing: p.letterSpacing },
  };
  return { cols, rows, cellW: atlas.cellW, cellH: atlas.cellH, transparent: cr.bgTransparent, effectiveScale: scale, surface: '2d' };
}

/**
 * Braille output: a picture of 2 cols x 4 rows sub-pixels (top-down luma + mask) thresholded with dithering into
 * U+2800 dots, drawn procedurally, colour per cell from the 2 x 4 block.
 */
export function drawBrailleCells(ctx, state, g) {
  const { cols, rows, lum, mask, rgb, cr, dark, threshold = 0.5, dither = 'atkinson' } = g;
  const W = cols * 2;
  const H = rows * 4;
  const t = state.tbuf?.length === W * H ? state.tbuf : (state.tbuf = new Float32Array(W * H));
  for (let i = 0; i < W * H; i++) t[i] = mask[i] ? (dark ? lum[i] : 1 - lum[i]) : 0;
  const on = quantize(t, W, H, 2, dither, { seed: 11, bias: 0.5 - threshold });
  const n = cols * rows;
  const bits = state.bits?.length === n ? state.bits : (state.bits = new Uint8Array(n));
  const crgb = state.crgb?.length === n * 4 ? state.crgb : (state.crgb = new Uint8ClampedArray(n * 4));
  const clum = state.clum?.length === n ? state.clum : (state.clum = new Float32Array(n));
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let m = 0;
      let r = 0, gg = 0, b = 0, cnt = 0;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const o = (cy * 4 + dy) * W + cx * 2 + dx;
          if (on[o] && mask[o]) m |= DOT_BIT[dy][dx];
          if (mask[o]) { r += rgb[o * 4]; gg += rgb[o * 4 + 1]; b += rgb[o * 4 + 2]; cnt++; }
        }
      }
      const i = cy * cols + cx;
      bits[i] = m;
      const k = cnt ? 1 / cnt : 0;
      crgb[i * 4] = r * k; crgb[i * 4 + 1] = gg * k; crgb[i * 4 + 2] = b * k; crgb[i * 4 + 3] = 255;
      clum[i] = (0.2126 * crgb[i * 4] + 0.7152 * crgb[i * 4 + 1] + 0.0722 * crgb[i * 4 + 2]) / 255;
    }
  }
  state.cache = state.cache || {};
  const cellRGBA = cellColors(cr, crgb, clum, state.cache, state.cellRGBA);
  state.cellRGBA = cellRGBA;
  const cap = ctx.isExport ? LIMITS.maxExportImageSide : MAX_PREVIEW_SIDE;
  const pitch = Math.max(1, Math.min(Math.round(BRAILLE_PITCH * (ctx.outScale || 1)), Math.floor(cap / W), Math.floor(cap / H)));
  state.dots = state.dots || {};
  drawBrailleDots(ctx.out2d, {
    cols, rows, bits, pitch, shape: 'circle', scale: 0.82, showEmpty: false,
    rgba: cellRGBA, ink: cr.ink, bg: cr.bgTransparent ? null : cr.bg,
  }, state.dots);
  const chars = new Array(n);
  for (let i = 0; i < n; i++) chars[i] = BRAILLE_CHARS[bits[i]];
  state.grid = {
    cols, rows, chars, rgba: cellRGBA,
    mono: cr.mode === 'mono' ? cr.ink : null,
    bg: cr.bgTransparent ? null : cr.bg,
    css: { family: BRAILLE_FONT, size: 14, lineHeight: 1.1, letterSpacing: 0 },
  };
  return { cols, rows, transparent: cr.bgTransparent, effectiveScale: pitch / BRAILLE_PITCH, surface: '2d' };
}
