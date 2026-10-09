// Typographic portrait (PLAN.md 7.6): a text of the user's repeats along rows and fills the picture; every letter
// takes the picture's colour, or its size, weight or opacity follows the luma under it. Exports: PNG, SVG (one
// <text> per row with a <tspan> per letter) and HTML (the same SVG inline). All user text is escaped (PLAN.md 18.3).

import { resolveColors, isDarkBackground, rgbToHex } from '../engine/color.js';
import { cellColors } from '../engine/cellcolor.js';
import { escapeXml } from '../io/exportText.js';
import { LIMITS, config } from '../config.js';

// Archivo and Silkscreen (named in the plan) are not self-hosted: Geist, Unbounded and VT323 stand in (see PLAN.md 19)
export const FACES = {
  geist: { css: '"Geist"', label: 'Geist', generic: 'sans-serif', weights: true },
  unbounded: { css: '"Unbounded"', label: 'Unbounded', generic: 'sans-serif', weights: true },
  vt323: { css: '"VT323"', label: 'VT323', generic: 'monospace', weights: false },
  'jetbrains-mono': { css: '"JetBrains Mono"', label: 'JetBrains Mono', generic: 'monospace', weights: true },
  'geist-mono': { css: '"Geist Mono"', label: 'Geist Mono', generic: 'monospace', weights: true },
};
const FONT_OPTIONS = Object.entries(FACES).map(([value, f]) => ({ value, label: f.label }));

const stackOf = (id) => {
  const f = FACES[id] || FACES.geist;
  return `${f.css}, "Geist Mono", "DejaVu Sans Mono", ${f.generic}`;
};

const COLOR_MODES = ['mono', 'original', 'gradient', 'palette'];
const MAX_PREVIEW_SIDE = 4096;
const MAX_LETTERS_PER_ROW = 3000;
const DEFAULT_TEXT = 'HORAIN ';

// ---- font loading and advance widths -----------------------------------------------------------------------------------
const pending = new Set();
function faceReady(id, weight, text) {
  if (!document.fonts?.check) return true;
  try { return document.fonts.check(`${weight} 16px ${FACES[id].css}`, text); } catch { return true; }
}
function requestFace(id, weight, text, onReady) {
  const key = `${id}|${weight}|${text}`;
  if (pending.has(key) || !document.fonts?.load) return;
  pending.add(key);
  document.fonts.load(`${weight} 16px ${FACES[id].css}`, text).catch(() => {}).finally(() => { pending.delete(key); onReady?.(); });
}

let measureCtx = null;
const widthCache = new Map();
/** Advance of `ch` at 100 px (cached per face, weight bucket and readiness). */
function advance100(id, weight, ch, ready) {
  const key = `${id}|${weight}|${ready ? 1 : 0}|${ch}`;
  let w = widthCache.get(key);
  if (w === undefined) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = `${weight} 100px ${stackOf(id)}`;
    w = measureCtx.measureText(ch).width;
    if (widthCache.size > 20000) widthCache.clear();
    widthCache.set(key, w);
  }
  return w;
}

const weightBucket = (t) => 100 * (1 + Math.round(t * 8)); // 100 .. 900

/**
 * Lay the text out over the cells of the picture.
 * @returns {{ rows: { top: number, baseline: number, letters: object[] }[], width: number, height: number }}
 */
export function layoutPortrait({ text, faceId, fontSize, letterSpacing, lineHeight, uppercase, modulate, cols, rows, t, ready }) {
  let src = String(text ?? '');
  if (!src.trim()) src = DEFAULT_TEXT;
  if (uppercase) src = src.toUpperCase();
  const seq = Array.from(src);
  const face = FACES[faceId] || FACES.geist;
  const cellW = Math.max(1, fontSize * 0.6 + letterSpacing);
  const lineH = Math.max(2, fontSize * lineHeight);
  const width = cols * cellW;
  const height = rows * lineH;
  const out = [];
  let k = 0;
  for (let r = 0; r < rows; r++) {
    const letters = [];
    const cy = Math.min(rows - 1, r);
    let x = 0;
    while (x < width && letters.length < MAX_LETTERS_PER_ROW) {
      const ch = seq[k++ % seq.length];
      // sample the picture at the middle of a nominal cell where this letter starts
      const cx = Math.min(cols - 1, Math.max(0, Math.floor((x + cellW / 2) / cellW)));
      const i = cy * cols + cx;
      const level = t[i];
      let size = fontSize;
      let weight = face.weights ? 500 : 400;
      let opacity = 1;
      if (modulate === 'size') size = Math.round(fontSize * (0.4 + 0.95 * level) * 2) / 2; // half pixels: far fewer distinct fonts
      else if (modulate === 'weight' && face.weights) weight = weightBucket(level);
      else if (modulate === 'opacity') opacity = 0.1 + 0.9 * level;
      const adv = Math.max(size * 0.2, (advance100(faceId, weight, ch, ready) * size) / 100);
      if (ch !== ' ' && ch !== '\t') letters.push({ ch, x, size, weight, opacity, cell: i });
      x += adv + letterSpacing;
    }
    out.push({ top: r * lineH, baseline: r * lineH + (lineH + 0.7 * fontSize) / 2, letters });
  }
  return { rows: out, width, height };
}

const fmt = (n) => (Math.round(n * 100) / 100).toString();
const hexAt = (colors, i, fallback) => (colors ? rgbToHex(colors[i * 4], colors[i * 4 + 1], colors[i * 4 + 2]) : fallback);

/** SVG document of a layout. Every piece of user text goes through escapeXml(). */
export function portraitToSVG(model) {
  const { layout, family, fontSize, modulate, ink, bg, colors, baseWeight } = model;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(layout.width)}" height="${fmt(layout.height)}" viewBox="0 0 ${fmt(layout.width)} ${fmt(layout.height)}">`);
  parts.push(`<title>${escapeXml(config.productName)} typographic portrait</title>`);
  if (bg) parts.push(`<rect width="${fmt(layout.width)}" height="${fmt(layout.height)}" fill="${bg}"/>`);
  parts.push(`<g font-family="${escapeXml(family)}" font-size="${fmt(fontSize)}" font-weight="${baseWeight}" fill="${ink}">`);
  for (const row of layout.rows) {
    if (!row.letters.length) continue;
    let line = `<text y="${fmt(row.baseline)}">`;
    for (const L of row.letters) {
      let attrs = `x="${fmt(L.x)}"`;
      const fill = colors ? hexAt(colors, L.cell, ink) : null;
      if (fill && fill !== ink) attrs += ` fill="${fill}"`;
      if (modulate === 'size') attrs += ` font-size="${fmt(L.size)}"`;
      if (modulate === 'weight' && L.weight !== baseWeight) attrs += ` font-weight="${L.weight}"`;
      if (modulate === 'opacity') attrs += ` fill-opacity="${fmt(L.opacity)}"`;
      line += `<tspan ${attrs}>${escapeXml(L.ch)}</tspan>`;
    }
    parts.push(`${line}</text>`);
  }
  parts.push('</g>', '</svg>');
  return parts.join('\n');
}

export default {
  id: 'typoportrait',
  category: 'text',
  name: { es: 'Retrato tipográfico', en: 'Typographic portrait' },
  blurb: { es: 'Tu texto repetido dibuja la imagen', en: 'Your text, repeated, draws the picture' },
  badges: ['SVG'],
  animated: false,
  uses: ['image', 'color'],
  colorModes: COLOR_MODES,
  exports: ['png', 'svg', 'html'],
  draftScale: 1,
  hide: ['dither', 'serpentine'],

  presets: [
    { id: 'name', name: { es: 'Tu nombre', en: 'Your name' }, mode: { text: 'HORAIN ', modulate: 'size', font: 'geist' } },
    { id: 'poster', name: { es: 'Cartel', en: 'Poster' }, mode: { modulate: 'weight', font: 'unbounded', fontSize: 14 } },
    { id: 'whisper', name: { es: 'Susurro', en: 'Whisper' }, mode: { modulate: 'opacity', font: 'jetbrains-mono', fontSize: 10 } },
  ],

  params: [
    {
      id: 'text', type: 'text', default: DEFAULT_TEXT, maxLength: 200,
      label: { es: 'Texto', en: 'Text' },
      help: { es: 'Se repite por las filas hasta llenar la imagen.', en: 'It repeats along the rows until the picture is full.' },
    },
    {
      id: 'font', type: 'select', default: 'geist', options: FONT_OPTIONS,
      label: { es: 'Fuente', en: 'Font' },
    },
    {
      id: 'fontSize', type: 'range', min: 6, max: 40, step: 1, default: 12, unit: 'px',
      label: { es: 'Tamaño de fuente', en: 'Font size' },
    },
    {
      id: 'modulate', type: 'select', default: 'size',
      options: [
        { value: 'color', label: { es: 'Color', en: 'Color' } },
        { value: 'size', label: { es: 'Tamaño', en: 'Size' } },
        { value: 'weight', label: { es: 'Peso', en: 'Weight' } },
        { value: 'opacity', label: { es: 'Opacidad', en: 'Opacity' } },
      ],
      label: { es: 'Modular con la luz', en: 'Modulate by light' },
      help: { es: 'Qué cambia en cada letra según la luminosidad: el color, el tamaño, el peso o la opacidad.', en: 'What changes in each letter with the brightness: color, size, weight or opacity.' },
    },
    {
      id: 'letterSpacing', type: 'range', min: -2, max: 8, step: 0.5, default: 0, unit: 'px',
      label: { es: 'Espaciado de letras', en: 'Letter spacing' },
    },
    {
      id: 'lineHeight', type: 'range', min: 0.8, max: 1.8, step: 0.05, default: 1,
      label: { es: 'Altura de línea', en: 'Line height' },
    },
    {
      id: 'uppercase', type: 'toggle', default: true,
      label: { es: 'Mayúsculas', en: 'Uppercase' },
    },
  ],

  resolution(params, srcW, srcH) {
    const p = params.mode;
    const cols = Math.max(1, Math.min(LIMITS.maxCols, Math.round(params.global.cols)));
    const cellW = Math.max(1, p.fontSize * 0.6 + p.letterSpacing);
    const lineH = Math.max(2, p.fontSize * p.lineHeight);
    return { width: cols, height: Math.max(1, Math.round((cols * cellW * (srcH / srcW)) / lineH)) };
  },

  preOptions(params, theme) {
    const cr = resolveColors(params.color, theme, COLOR_MODES);
    const dark = isDarkBackground(cr);
    return {
      matte: cr.bgTransparent ? (dark ? '#000000' : '#ffffff') : rgbToHex(...cr.bg),
      edgeBlend: dark ? 'light' : 'dark',
    };
  },

  init() {
    return { cache: {}, model: null };
  },

  render(ctx, state) {
    const p = ctx.params.mode;
    const cr = resolveColors(ctx.params.color, ctx.theme, COLOR_MODES);
    const dark = isDarkBackground(cr);
    const faceId = p.font in FACES ? p.font : 'geist';
    const { width: cols, height: rows } = ctx;
    const n = cols * rows;
    const text = `${p.text}${DEFAULT_TEXT}`;
    const weights = FACES[faceId].weights ? [100, 500, 900] : [400];
    let ready = true;
    for (const w of weights) {
      if (!faceReady(faceId, w, text)) { ready = false; requestFace(faceId, w, text, ctx.invalidate); }
    }

    // "more ink" where the picture is bright on a dark background (and the other way round on a light one)
    const luma = ctx.luma();
    const t = new Float32Array(n);
    for (let i = 0; i < n; i++) t[i] = dark ? luma[i] : 1 - luma[i];

    // colours: picture colours (original / gradient / palette), or the ink; "colour" modulation fades ink in from the paper
    const avgRGB = ctx.rgba;
    let colors = cellColors(cr, avgRGB, luma, state.cache, state.colors);
    if (colors) state.colors = colors;
    if (p.modulate === 'color' && !colors) {
      const bg = cr.bgTransparent ? (dark ? [0, 0, 0] : [255, 255, 255]) : cr.bg;
      colors = new Uint8ClampedArray(n * 4);
      for (let i = 0; i < n; i++) {
        const lv = t[i] ** 0.8;
        colors[i * 4] = bg[0] + (cr.ink[0] - bg[0]) * lv;
        colors[i * 4 + 1] = bg[1] + (cr.ink[1] - bg[1]) * lv;
        colors[i * 4 + 2] = bg[2] + (cr.ink[2] - bg[2]) * lv;
        colors[i * 4 + 3] = 255;
      }
    }

    const layout = layoutPortrait({
      text: p.text, faceId, fontSize: p.fontSize, letterSpacing: p.letterSpacing, lineHeight: p.lineHeight,
      uppercase: p.uppercase, modulate: p.modulate, cols, rows, t, ready,
    });

    // ---- draw (scale capped like the other text modes) ----
    const cap = ctx.isExport ? LIMITS.maxExportImageSide : MAX_PREVIEW_SIDE;
    const s = Math.max(0.05, Math.min(ctx.outScale, cap / layout.width, cap / layout.height));
    const W = Math.max(1, Math.round(layout.width * s));
    const H = Math.max(1, Math.round(layout.height * s));
    const canvas = ctx.out.canvas;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const g = ctx.out.ctx2d;
    g.clearRect(0, 0, W, H);
    if (!cr.bgTransparent) {
      g.fillStyle = rgbToHex(...cr.bg);
      g.fillRect(0, 0, W, H);
    }
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    const stack = stackOf(faceId);
    const baseWeight = FACES[faceId].weights ? 500 : 400;
    const inkHex = rgbToHex(...cr.ink);
    let lastFont = '';
    for (const row of layout.rows) {
      for (const L of row.letters) {
        const font = `${L.weight} ${Math.max(1, L.size * s)}px ${stack}`;
        if (font !== lastFont) { g.font = font; lastFont = font; }
        const fill = colors ? hexAt(colors, L.cell, inkHex) : inkHex;
        if (p.modulate === 'opacity') g.globalAlpha = L.opacity;
        g.fillStyle = fill;
        g.fillText(L.ch, L.x * s, row.baseline * s);
        if (p.modulate === 'opacity') g.globalAlpha = 1;
      }
    }

    state.model = {
      layout, family: stack, fontSize: p.fontSize, modulate: p.modulate, ink: inkHex,
      bg: cr.bgTransparent ? null : rgbToHex(...cr.bg), colors, baseWeight,
    };
    return { cols, rows, transparent: cr.bgTransparent, effectiveScale: s };
  },

  toSVG(state) {
    return state?.model ? portraitToSVG(state.model) : '';
  },

  /** format: 'html' -> a standalone page with the SVG inline */
  toText(state, format) {
    if (!state?.model) return '';
    const svg = portraitToSVG(state.model);
    const bg = state.model.bg;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${escapeXml(config.productName)} by Horain">
<title>${escapeXml(config.productName)} typographic portrait</title>
<style>html,body{margin:0;padding:0;${bg ? `background:${bg};` : ''}}body{padding:24px}svg{display:block;max-width:100%;height:auto;margin:0 auto}</style>
</head>
<body>
${svg}
</body>
</html>
`;
  },

  dispose(state) {
    if (state) state.model = null;
  },
};
