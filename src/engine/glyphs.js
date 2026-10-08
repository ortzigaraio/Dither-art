// Glyphs for text modes: character sets, font loading and metrics, ink-density measurement
// (so that auto-sorting works for any set) and the glyph atlas used to draw cells quickly.

export const GRADIENTS = {
  standard: ' .:-=+*#%@',
  detailed: ' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$',
  blocks: ' ░▒▓█',
  math: ' ·∙∘∗+±×÷=≠≈∼∝∞∫∑∏√∂∆∇≡≤≥∩∪∧∨¬∀∃∈',
  arrows: ' ←↑→↓↔↕↖↗↘↙⇐⇑⇒⇓',
  binary: ' 01',
  katakana: ' ｦｧｨｩｪｫｬｭｮｯｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄ',
  box: ' ─│┌┐└┘├┤┬┴┼═║╬',
  dots: ' ·•●',
  custom: null,
};

export const GRADIENT_OPTIONS = [
  { value: 'standard', label: { es: 'Estándar', en: 'Standard' } },
  { value: 'detailed', label: { es: 'Detallado', en: 'Detailed' } },
  { value: 'blocks', label: { es: 'Bloques', en: 'Blocks' } },
  { value: 'math', label: { es: 'Símbolos matemáticos', en: 'Math Symbols' } },
  { value: 'arrows', label: { es: 'Flechas', en: 'Arrows' } },
  { value: 'binary', label: { es: 'Binario', en: 'Binary' } },
  { value: 'katakana', label: { es: 'Katakana', en: 'Katakana' } },
  { value: 'box', label: { es: 'Cajas', en: 'Box drawing' } },
  { value: 'dots', label: { es: 'Puntos', en: 'Dots' } },
  { value: 'custom', label: { es: 'Personalizado', en: 'Custom' } },
];

export const EDGE_CHARS = ['-', '\\', '|', '/'];

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

export const FONTS = {
  'geist-mono': { name: 'Geist Mono', css: '"Geist Mono"', weight: 400 },
  'jetbrains-mono': { name: 'JetBrains Mono', css: '"JetBrains Mono"', weight: 400 },
  'ibm-plex-mono': { name: 'IBM Plex Mono', css: '"IBM Plex Mono"', weight: 400 },
  vt323: { name: 'VT323', css: '"VT323"', weight: 400 },
  'space-mono': { name: 'Space Mono', css: '"Space Mono"', weight: 400 },
  courier: { name: 'Courier', css: '"Courier New", Courier', weight: 400 },
};

export const FONT_OPTIONS = Object.entries(FONTS).map(([value, f]) => ({ value, label: f.name }));

export function fontStack(id) {
  const f = FONTS[id] || FONTS['geist-mono'];
  const fallback = f === FONTS['geist-mono'] ? '' : '"Geist Mono", ';
  return `${f.css}, ${fallback}"DejaVu Sans Mono", Menlo, Consolas, monospace`;
}

const familyOf = (id) => (FONTS[id] || FONTS['geist-mono']).css.split(',')[0];

const readyCache = new Set();

/** True when the faces needed to draw `text` with this font are already loaded (positive results are cached). */
export function fontsReady(fontId, text = '') {
  if (!document.fonts || !document.fonts.check) return true;
  const key = `${fontId}|${text}`;
  if (readyCache.has(key)) return true;
  let ok = true;
  try {
    ok = document.fonts.check(`16px ${familyOf(fontId)}`, text) && document.fonts.check('16px "Geist Mono"', text);
  } catch { ok = true; }
  if (ok) {
    if (readyCache.size > 500) readyCache.clear();
    readyCache.add(key);
  }
  return ok;
}

/** Load the faces needed for `text` (the chosen font plus the Geist Mono fallback). */
export async function ensureFonts(fontId, text = '') {
  if (!document.fonts || !document.fonts.load) return;
  try {
    await Promise.all([
      document.fonts.load(`16px ${familyOf(fontId)}`, text || 'M'),
      document.fonts.load('16px "Geist Mono"', text || 'M'),
    ]);
  } catch { /* the fallback stack still renders something */ }
}

const pendingLoads = new Map();
/** Start loading fonts in the background and call `onReady` once when done (deduplicated). */
export function requestFonts(fontId, text, onReady) {
  const key = `${fontId}|${text}`;
  if (pendingLoads.has(key)) return;
  const p = ensureFonts(fontId, text).then(() => {
    pendingLoads.delete(key);
    onReady?.();
  });
  pendingLoads.set(key, p);
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

const ratioCache = new Map();
/** Advance and cap height of a font as ratios of the font size, measured from the real font. */
export function fontRatios(fontId) {
  const hit = ratioCache.get(fontId);
  if (hit) return hit;
  const ready = fontsReady(fontId, 'MH');
  const c = makeCanvas(8, 8);
  const g = c.getContext('2d');
  const size = 200;
  g.font = `${(FONTS[fontId] || FONTS['geist-mono']).weight} ${size}px ${fontStack(fontId)}`;
  const adv = g.measureText('M').width / size;
  const cap = (g.measureText('H').actualBoundingBoxAscent || size * 0.7) / size;
  const r = { advance: adv > 0 ? adv : 0.6, cap: cap > 0 ? cap : 0.7 };
  if (ready) ratioCache.set(fontId, r);
  return r;
}

/** Unrounded cell aspect (width / height) used to derive the number of rows (PLAN.md 5.1). */
export function cellAspect(fontId, lineHeight, letterSpacingEm = 0) {
  const { advance } = fontRatios(fontId);
  return (advance + letterSpacingEm) / lineHeight;
}

/** Integer cell metrics in output pixels for a given font size. */
export function cellMetrics(fontId, fontPx, lineHeight, letterSpacingPx) {
  const { advance, cap } = fontRatios(fontId);
  const cellW = Math.max(1, Math.round(advance * fontPx + letterSpacingPx));
  const cellH = Math.max(1, Math.round(fontPx * lineHeight));
  const baseline = Math.round(cellH / 2 + (cap * fontPx) / 2);
  return { fontPx, cellW, cellH, baseline };
}

// ---------------------------------------------------------------------------
// Drawing one glyph into a tile
// ---------------------------------------------------------------------------

// Block elements are drawn procedurally so rows and columns join without gaps: [x, y, w, h, alpha]
const BLOCKS = {
  '█': [0, 0, 1, 1, 1],
  '▓': [0, 0, 1, 1, 0.75],
  '▒': [0, 0, 1, 1, 0.5],
  '░': [0, 0, 1, 1, 0.25],
  '▀': [0, 0, 1, 0.5, 1],
  '▄': [0, 0.5, 1, 0.5, 1],
  '▌': [0, 0, 0.5, 1, 1],
  '▐': [0.5, 0, 0.5, 1, 1],
};

/** Draw `ch` in white into the tile at (tx, ty). The context font must already be set. */
function drawGlyph(g, ch, tx, ty, cellW, cellH, baseline) {
  const b = BLOCKS[ch];
  if (b) {
    g.globalAlpha = b[4];
    g.fillRect(tx + b[0] * cellW, ty + b[1] * cellH, b[2] * cellW, b[3] * cellH);
    g.globalAlpha = 1;
    return;
  }
  if (ch === ' ') return;
  g.fillText(ch, tx + cellW / 2, ty + baseline);
}

function prepareContext(g, fontId, fontPx) {
  g.font = `${(FONTS[fontId] || FONTS['geist-mono']).weight} ${fontPx}px ${fontStack(fontId)}`;
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
}

// ---------------------------------------------------------------------------
// Density measurement
// ---------------------------------------------------------------------------

const densityCache = new Map();

/** Ink density 0..1 of each character (mean coverage of its tile), measured with the real font. */
export function measureDensities(chars, fontId) {
  const ready = fontsReady(fontId, chars.join(''));
  const dens = new Map();
  const missing = [];
  for (const ch of new Set(chars)) {
    if (ch === ' ') { dens.set(ch, 0); continue; }
    const hit = densityCache.get(`${fontId}|${ch}`);
    if (hit !== undefined) dens.set(ch, hit);
    else missing.push(ch);
  }
  if (missing.length) {
    const px = 32;
    const m = cellMetrics(fontId, px, 1.2, 0);
    const cols = 16;
    const rows = Math.ceil(missing.length / cols);
    const sheet = makeCanvas(cols * m.cellW, rows * m.cellH);
    const g = sheet.getContext('2d', { willReadFrequently: true });
    prepareContext(g, fontId, px);
    missing.forEach((ch, i) => drawGlyph(g, ch, (i % cols) * m.cellW, Math.floor(i / cols) * m.cellH, m.cellW, m.cellH, m.baseline));
    const data = g.getImageData(0, 0, sheet.width, sheet.height).data;
    const tile = m.cellW * m.cellH;
    missing.forEach((ch, i) => {
      const x0 = (i % cols) * m.cellW;
      const y0 = Math.floor(i / cols) * m.cellH;
      let sum = 0;
      for (let y = 0; y < m.cellH; y++) {
        let o = ((y0 + y) * sheet.width + x0) * 4 + 3;
        for (let x = 0; x < m.cellW; x++, o += 4) sum += data[o];
      }
      const d = sum / 255 / tile;
      dens.set(ch, d);
      if (ready) densityCache.set(`${fontId}|${ch}`, d);
    });
  }
  return Float32Array.from(chars, (c) => dens.get(c) ?? 0);
}

// ---------------------------------------------------------------------------
// Gradient (ordered list of characters, light -> dark)
// ---------------------------------------------------------------------------

const gradientCache = new Map();

/**
 * @returns {{ chars: string[], dens: Float32Array }} ordered from least to most ink.
 */
export function buildGradient({ gradient, custom, autoSort, invert, spaceDensity, fontId }) {
  const text = gradient === 'custom' ? String(custom ?? '') : (GRADIENTS[gradient] ?? GRADIENTS.standard);
  const ready = fontsReady(fontId, text);
  const key = [gradient, text, autoSort, invert, spaceDensity, fontId, ready].join('\u0001');
  const hit = gradientCache.get(key);
  if (hit) return hit;

  let chars = Array.from(text).filter((c) => c !== '\n' && c !== '\r' && c !== '\t');
  if (!chars.length) chars = Array.from(GRADIENTS.standard);
  let rest = chars.filter((c) => c !== ' ');
  if (!rest.length) rest = ['#'];
  if (autoSort) {
    const d = measureDensities(rest, fontId);
    const order = rest.map((_, i) => i).sort((a, b) => d[a] - d[b] || a - b);
    rest = order.map((i) => rest[i]);
  }
  const spaces = Math.max(0, Math.min(20, Math.round(spaceDensity)));
  chars = [...Array(spaces).fill(' '), ...rest];
  if (chars.length < 2) chars = [' ', ...chars];
  if (invert) chars.reverse();
  const res = { chars, dens: measureDensities(chars, fontId) };
  if (gradientCache.size >= 24) gradientCache.delete(gradientCache.keys().next().value);
  gradientCache.set(key, res);
  return res;
}

// ---------------------------------------------------------------------------
// Atlas: every character drawn once in white; cells are composited from its alpha channel
// ---------------------------------------------------------------------------

const atlasCache = new Map();

/**
 * @param {string[]} chars unique characters
 * @returns {{ canvas: HTMLCanvasElement, alpha: Uint8Array, width: number, index: Map<string, number>,
 *   cols: number, cellW: number, cellH: number, baseline: number }}
 */
export function getAtlas(chars, fontId, fontPx, lineHeight, letterSpacingPx) {
  const m = cellMetrics(fontId, fontPx, lineHeight, letterSpacingPx);
  const ready = fontsReady(fontId, chars.join(''));
  const key = [fontId, m.fontPx, m.cellW, m.cellH, m.baseline, chars.join(''), ready].join('\u0001');
  const hit = atlasCache.get(key);
  if (hit) {
    atlasCache.delete(key);
    atlasCache.set(key, hit);
    return hit;
  }

  const n = chars.length;
  const cols = Math.max(1, Math.min(n, Math.floor(8192 / m.cellW), Math.ceil(Math.sqrt(n * (m.cellH / m.cellW)))));
  const rows = Math.ceil(n / cols);
  const canvas = makeCanvas(cols * m.cellW, rows * m.cellH);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  prepareContext(g, fontId, m.fontPx);
  const index = new Map();
  chars.forEach((ch, i) => {
    index.set(ch, i);
    drawGlyph(g, ch, (i % cols) * m.cellW, Math.floor(i / cols) * m.cellH, m.cellW, m.cellH, m.baseline);
  });

  // Keep only the alpha channel: it is all the compositor needs
  const px = g.getImageData(0, 0, canvas.width, canvas.height).data;
  const alpha = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0, o = 3; i < alpha.length; i++, o += 4) alpha[i] = px[o];

  const atlas = { canvas, alpha, width: canvas.width, index, cols, cellW: m.cellW, cellH: m.cellH, baseline: m.baseline };
  if (atlasCache.size >= 6) atlasCache.delete(atlasCache.keys().next().value);
  atlasCache.set(key, atlas);
  return atlas;
}

export const NO_GLYPH = 0xffff;

const div255 = (t) => ((t + 128) * 257) >> 16;

/**
 * Composite a grid of glyphs into `out.canvas` (resized to cols*cellW x rows*cellH) from the atlas alpha.
 * Done on the CPU in horizontal bands: faster than thousands of drawImage calls and independent of the GPU.
 * (Typed-array packing below assumes little-endian, true of every browser platform.)
 *
 * @param {{ canvas: HTMLCanvasElement, ctx2d: CanvasRenderingContext2D }} out
 * @param {object} grid
 * @param {number} grid.cols
 * @param {number} grid.rows
 * @param {ReturnType<typeof getAtlas>} grid.atlas
 * @param {Uint16Array} grid.glyph    atlas tile index per cell, NO_GLYPH to skip
 * @param {Uint8ClampedArray|null} grid.rgba  RGBA per cell, or null for a single ink colour
 * @param {number[]} grid.ink          [r,g,b] used when rgba is null
 * @param {number[]|null} grid.bg      [r,g,b], or null for a transparent background
 * @param {object} scratch             reusable buffers owned by the caller
 */
export function drawGlyphGrid(out, grid, scratch) {
  const { cols, rows, atlas, glyph, rgba, ink, bg } = grid;
  const { cellW, cellH, alpha } = atlas;
  const aw = atlas.width;
  const acols = atlas.cols;
  const W = cols * cellW;
  const H = rows * cellH;
  const canvas = out.canvas;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }

  const bandRows = Math.max(1, Math.min(rows, Math.floor(1500000 / Math.max(1, W * cellH))));
  const bandH = bandRows * cellH;
  if (!scratch.img || scratch.img.width !== W || scratch.img.height !== bandH) {
    scratch.img = new ImageData(W, bandH);
    scratch.u32 = new Uint32Array(scratch.img.data.buffer);
  }
  const u32 = scratch.u32;
  const bg32 = bg ? (255 << 24) | (bg[2] << 16) | (bg[1] << 8) | bg[0] : 0;
  const bgR = bg ? bg[0] : 0;
  const bgG = bg ? bg[1] : 0;
  const bgB = bg ? bg[2] : 0;

  // Mono: one lookup table alpha -> packed pixel
  let lut = null;
  if (!rgba) {
    lut = new Uint32Array(256);
    for (let a = 1; a < 256; a++) {
      lut[a] = bg
        ? (255 << 24) | (div255(bgB * (255 - a) + ink[2] * a) << 16) | (div255(bgG * (255 - a) + ink[1] * a) << 8) | div255(bgR * (255 - a) + ink[0] * a)
        : (a << 24) | (ink[2] << 16) | (ink[1] << 8) | ink[0];
    }
  }

  for (let r0 = 0; r0 < rows; r0 += bandRows) {
    const r1 = Math.min(rows, r0 + bandRows);
    const hpx = (r1 - r0) * cellH;
    u32.fill(bg32, 0, W * hpx);
    for (let cy = r0; cy < r1; cy++) {
      const rowBase = cy * cols;
      const yOff = (cy - r0) * cellH;
      for (let cx = 0; cx < cols; cx++) {
        const gi = glyph[rowBase + cx];
        if (gi === NO_GLYPH) continue;
        const sx = (gi % acols) * cellW;
        const sy = Math.floor(gi / acols) * cellH;
        let cr = 0, cg = 0, cb = 0;
        if (rgba) {
          const o = (rowBase + cx) * 4;
          cr = rgba[o]; cg = rgba[o + 1]; cb = rgba[o + 2];
        }
        for (let ry = 0; ry < cellH; ry++) {
          let s = (sy + ry) * aw + sx;
          let d = (yOff + ry) * W + cx * cellW;
          if (lut) {
            for (let k = 0; k < cellW; k++, s++, d++) {
              const a = alpha[s];
              if (a !== 0) u32[d] = lut[a];
            }
          } else if (bg) {
            for (let k = 0; k < cellW; k++, s++, d++) {
              const a = alpha[s];
              if (a === 0) continue;
              if (a === 255) { u32[d] = (255 << 24) | (cb << 16) | (cg << 8) | cr; continue; }
              const ia = 255 - a;
              u32[d] = (255 << 24) | (div255(bgB * ia + cb * a) << 16) | (div255(bgG * ia + cg * a) << 8) | div255(bgR * ia + cr * a);
            }
          } else {
            for (let k = 0; k < cellW; k++, s++, d++) {
              const a = alpha[s];
              if (a !== 0) u32[d] = (a << 24) | (cb << 16) | (cg << 8) | cr;
            }
          }
        }
      }
    }
    out.ctx2d.putImageData(scratch.img, 0, r0 * cellH, 0, 0, W, hpx);
  }
}
