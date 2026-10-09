// ASCII mode (PLAN.md 7.1): each cell takes the average luma of its area, mapped onto a gradient of
// characters sorted by measured ink density. Error diffusion / ordered dithering spreads the quantisation
// error between gradient levels. Optional directional characters follow Sobel edges.

import {
  GRADIENT_OPTIONS, FONT_OPTIONS, FONTS, EDGE_CHARS, NO_GLYPH, buildGradient, getAtlas, drawGlyphGrid, cellAspect, cellLayout,
  fontStack, fontsReady, requestFonts, baseCell,
} from '../engine/glyphs.js';
import { quantize } from '../engine/dither.js';
import {
  resolveColors, isDarkBackground, buildGradientLUT, makePaletteMatcher, boostSaturation, rgbToHex,
} from '../engine/color.js';
import { gridToText } from '../io/exportText.js';
import { LIMITS, config } from '../config.js';

const COLOR_MODES = ['mono', 'original', 'gradient', 'palette'];
const MAX_PREVIEW_SIDE = 4096;

function edgeIndex(angle) {
  // The edge runs perpendicular to the gradient. Image y points down, so +45 deg reads as '\'.
  let deg = (angle * 180) / Math.PI + 90;
  deg = ((deg % 180) + 180) % 180;
  if (deg < 22.5 || deg >= 157.5) return 0; // '-'
  if (deg < 67.5) return 1; // '\'
  if (deg < 112.5) return 2; // '|'
  return 3; // '/'
}

const hexOf = (rgb) => rgbToHex(rgb[0], rgb[1], rgb[2]);

function ensureCanvas(holder, key, w, h) {
  let c = holder[key];
  if (!c) c = holder[key] = document.createElement('canvas');
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return c;
}

export default {
  id: 'ascii',
  category: 'text',
  name: { es: 'ASCII', en: 'ASCII Art' },
  blurb: {
    es: 'Caracteres cuya densidad dibuja la imagen',
    en: 'Characters whose density draws the picture',
  },
  badges: ['TXT'],
  animated: false,
  uses: ['image', 'color'],
  colorModes: COLOR_MODES,
  exports: ['png', 'txt', 'html', 'ansi', 'video'],
  draftScale: 1, // cheap enough to render at full quality while dragging

  params: [
    {
      id: 'gradient', type: 'select', default: 'standard', options: GRADIENT_OPTIONS,
      label: { es: 'Gradiente de caracteres', en: 'ASCII gradient' },
      help: { es: 'Conjunto de caracteres, de claro a oscuro.', en: 'Character set, from light to dark.' },
    },
    {
      id: 'customGradient', type: 'text', default: ' .:-=+*#%@', maxLength: 120,
      label: { es: 'Caracteres personalizados', en: 'Custom characters' },
      help: { es: 'Escribe tus caracteres; con "Ordenar por densidad" se ordenan solos.', en: 'Type your characters; with "Sort by density" they sort themselves.' },
      showIf: (p) => p.gradient === 'custom',
    },
    {
      id: 'autoSort', type: 'toggle', default: true,
      label: { es: 'Ordenar por densidad', en: 'Sort by density' },
      help: { es: 'Mide la tinta de cada carácter con la fuente activa y los ordena de claro a oscuro.', en: 'Measures each character\'s ink with the active font and sorts them from light to dark.' },
    },
    {
      id: 'invertGradient', type: 'toggle', default: false,
      label: { es: 'Invertir gradiente', en: 'Invert gradient' },
    },
    {
      id: 'spaceDensity', type: 'range', min: 0, max: 20, step: 1, default: 1,
      label: { es: 'Densidad de espacio', en: 'Space Density' },
      help: { es: 'Repite el espacio al inicio del gradiente: más zonas vacías en las luces.', en: 'Repeats the space at the start of the gradient: more empty areas in the highlights.' },
    },
    {
      id: 'edgeChars', type: 'toggle', default: true,
      label: { es: 'Caracteres de borde', en: 'Edge characters' },
      help: { es: 'Con la detección de bordes activa, usa | / - \\ según la dirección del borde.', en: 'With edge detection on, uses | / - \\ following the edge direction.' },
      showIf: (p, all) => all.global.edges > 0,
    },
    {
      id: 'edgeThreshold', type: 'range', min: 0, max: 1, step: 0.05, default: 0.3,
      label: { es: 'Umbral de borde', en: 'Edge threshold' },
      showIf: (p, all) => all.global.edges > 0 && p.edgeChars,
    },
    {
      id: 'font', type: 'select', default: 'geist-mono', options: FONT_OPTIONS,
      label: { es: 'Fuente', en: 'Font' },
    },
    {
      id: 'cellSize', type: 'range', min: 6, max: 32, step: 1, default: 12, unit: 'px',
      label: { es: 'Tamaño de celda', en: 'Cell size' },
      help: { es: 'Tamaño de la fuente en píxeles (no cambia el número de columnas).', en: 'Font size in pixels (does not change the number of columns).' },
    },
    {
      id: 'lineHeight', type: 'range', min: 0.8, max: 1.4, step: 0.05, default: 1,
      label: { es: 'Altura de línea', en: 'Line height' },
    },
    {
      id: 'letterSpacing', type: 'range', min: -2, max: 4, step: 0.5, default: 0, unit: 'px',
      label: { es: 'Espaciado de letras', en: 'Letter spacing' },
    },
  ],

  /** Working resolution = characters grid; rows follow the real glyph aspect (PLAN.md 5.1). */
  resolution(params, srcW, srcH) {
    const p = params.mode;
    const cols = Math.max(1, Math.min(LIMITS.maxCols, Math.round(params.global.cols)));
    const aspect = cellAspect(p.font, p.cellSize, p.lineHeight, p.letterSpacing);
    const rows = Math.max(1, Math.round(cols * (srcH / srcW) * aspect));
    return { width: cols, height: rows };
  },

  /** Matte for transparent source pixels and which way detected edges push the image. */
  preOptions(params, theme) {
    const cr = resolveColors(params.color, theme, COLOR_MODES);
    const dark = isDarkBackground(cr);
    return {
      matte: cr.bgTransparent ? (dark ? '#000000' : '#ffffff') : hexOf(cr.bg),
      edgeBlend: dark ? 'light' : 'dark',
    };
  },

  init() {
    return { grid: null, cache: {} };
  },

  render(ctx, state) {
    const { width: cols, height: rows, params, outScale } = ctx;
    const p = params.mode;
    const g = params.global;
    const cr = resolveColors(params.color, ctx.theme, COLOR_MODES);
    const dark = isDarkBackground(cr);
    const fontId = p.font in FONTS ? p.font : 'geist-mono';
    const n = cols * rows;
    const t0 = performance.now();

    // ---- characters, sorted by measured density ----
    const grad = buildGradient({
      gradient: p.gradient, custom: p.customGradient, autoSort: p.autoSort,
      invert: p.invertGradient, spaceDensity: p.spaceDensity, fontId,
    });
    const L = grad.chars.length;
    const atlasChars = Array.from(new Set([...grad.chars, ...EDGE_CHARS]));
    const text = atlasChars.join('');
    if (!fontsReady(fontId, text)) requestFonts(fontId, text, ctx.invalidate);

    // ---- levels: luma -> darkness (bright pixels get dense glyphs on dark backgrounds) ----
    const luma = ctx.luma();
    const t = state.t && state.t.length === n ? state.t : (state.t = new Float32Array(n));
    if (dark) for (let i = 0; i < n; i++) t[i] = luma[i];
    else for (let i = 0; i < n; i++) t[i] = 1 - luma[i];
    const idx = quantize(t, cols, rows, L, g.dither, { serpentine: g.serpentine, seed: 7 });

    const t1 = performance.now();
    // ---- glyph per cell (+ directional characters on strong edges) ----
    const chars = state.chars && state.chars.length === n ? state.chars : (state.chars = new Array(n));
    const edgeOn = p.edgeChars && g.edges > 0;
    const sob = edgeOn ? ctx.sobel() : null;
    for (let i = 0; i < n; i++) {
      chars[i] = sob && sob.mag[i] >= p.edgeThreshold ? EDGE_CHARS[edgeIndex(sob.angle[i])] : grad.chars[idx[i]];
    }

    const t2 = performance.now();
    // ---- atlas (scale reduced when the output would exceed the size cap: PLAN.md 18.2) ----
    const cap = ctx.isExport ? LIMITS.maxExportImageSide : MAX_PREVIEW_SIDE;
    const base = baseCell(fontId, p.cellSize, p.lineHeight, p.letterSpacing);
    let scale = Math.min(outScale, cap / (cols * base.w), cap / (rows * base.h));
    let layout = cellLayout(fontId, p.cellSize, p.lineHeight, p.letterSpacing, scale);
    for (let guard = 0; guard < 8 && (cols * layout.cellW > cap || rows * layout.cellH > cap) && scale > 0.05; guard++) {
      scale *= 0.95; // cells are whole pixels, so rounding can still overshoot
      layout = cellLayout(fontId, p.cellSize, p.lineHeight, p.letterSpacing, scale);
    }
    const atlas = getAtlas(atlasChars, fontId, layout);
    const { cellW, cellH } = atlas;
    const glyph = state.glyph && state.glyph.length === n ? state.glyph : (state.glyph = new Uint16Array(n));
    const index = atlas.index;
    for (let i = 0; i < n; i++) glyph[i] = chars[i] === ' ' ? NO_GLYPH : index.get(chars[i]);

    // ---- colour ----
    let cellRGBA = null;
    if (cr.mode !== 'mono') {
      cellRGBA = state.cellRGBA && state.cellRGBA.length === n * 4 ? state.cellRGBA : (state.cellRGBA = new Uint8ClampedArray(n * 4));
      const rgba = ctx.rgba;
      if (cr.mode === 'original') {
        for (let i = 0; i < n; i++) {
          const c = boostSaturation(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], cr.boost);
          cellRGBA[i * 4] = c[0]; cellRGBA[i * 4 + 1] = c[1]; cellRGBA[i * 4 + 2] = c[2]; cellRGBA[i * 4 + 3] = 255;
        }
      } else if (cr.mode === 'gradient') {
        const gk = cr.stops.join(',');
        if (state.cache.gradKey !== gk) { state.cache.gradKey = gk; state.cache.lut = buildGradientLUT(cr.stops); }
        const lut = state.cache.lut;
        for (let i = 0; i < n; i++) {
          const li = Math.round(luma[i] * 255) * 3;
          cellRGBA[i * 4] = lut[li]; cellRGBA[i * 4 + 1] = lut[li + 1]; cellRGBA[i * 4 + 2] = lut[li + 2]; cellRGBA[i * 4 + 3] = 255;
        }
      } else { // palette
        const pk = cr.palette.map((c) => c.join('.')).join(',');
        if (state.cache.palKey !== pk) { state.cache.palKey = pk; state.cache.match = makePaletteMatcher(cr.palette, 'lab'); }
        const match = state.cache.match;
        for (let i = 0; i < n; i++) {
          const c = boostSaturation(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], cr.boost);
          const pc = cr.palette[match(c[0], c[1], c[2])];
          cellRGBA[i * 4] = pc[0]; cellRGBA[i * 4 + 1] = pc[1]; cellRGBA[i * 4 + 2] = pc[2]; cellRGBA[i * 4 + 3] = 255;
        }
      }
    }

    // ---- composite ----
    const t3 = performance.now();
    drawGlyphGrid(ctx.out, {
      cols, rows, atlas, glyph, rgba: cellRGBA, ink: cr.ink, bg: cr.bgTransparent ? null : cr.bg,
    }, state.cache);

    // ---- data for exports ----
    state.grid = {
      cols,
      rows,
      chars,
      rgba: cellRGBA,
      mono: cr.mode === 'mono' ? cr.ink : null,
      bg: cr.bgTransparent ? null : cr.bg,
      css: {
        family: fontStack(fontId),
        size: p.cellSize,
        lineHeight: p.lineHeight,
        letterSpacing: p.letterSpacing,
      },
    };

    const t4 = performance.now();
    return {
      cols, rows, cellW, cellH, transparent: cr.bgTransparent, effectiveScale: scale,
      timings: { levels: t1 - t0, glyphs: t2 - t1, colors: t3 - t2, composite: t4 - t3 },
    };
  },

  /** format: 'txt' | 'html' | 'ansi' */
  toText(state, format, opts) {
    if (!state?.grid) return '';
    return gridToText(state.grid, format, { title: `${config.productName} ASCII`, ...opts });
  },

  dispose(state) {
    if (state?.cache) {
      for (const k of ['mask', 'colors']) {
        if (state.cache[k]) { state.cache[k].width = 1; state.cache[k].height = 1; }
      }
    }
  },
};
