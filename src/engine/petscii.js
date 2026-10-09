// PETSCII-style glyph set (PLAN.md 7.4): ~96 original 8x8 bitmaps drawn by this project, inspired by the idea of
// a C64-like character screen (blocks, bars, lines, diagonals, rounded shapes). It is NOT the C64 character ROM and
// copies none of its bitmaps. Every glyph is 8 bytes, bit 7 = leftmost pixel. Glyphs are generated from small
// predicates at load time, so the data stays compact and auditable.

import { hexToRgb } from './color.js';
import { PALETTES } from './palettes.js';

/** Build 8 row bytes from a predicate fn(x, y) -> boolean, with x and y in 0..7. */
export function bitmap(fn) {
  const rows = new Uint8Array(8);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (fn(x, y)) rows[y] |= 0x80 >> x;
  return rows;
}

const fromRows = (...r) => Uint8Array.from(r);
const d2 = (x, y) => (x - 3.5) ** 2 + (y - 3.5) ** 2;

export const GLYPH_SETS = ['blocks', 'lines', 'diagonals', 'rounds'];

const DEFS = [];
const add = (set, id, bytes) => DEFS.push({ set, id, rows: bytes });
const def = (set, id, fn) => add(set, id, bitmap(fn));

// ---- blocks, bars and shades ---------------------------------------------------------------------------------------
def('blocks', 'empty', () => false);
def('blocks', 'full', () => true);
def('blocks', 'half-top', (x, y) => y < 4);
def('blocks', 'half-bottom', (x, y) => y >= 4);
def('blocks', 'half-left', (x) => x < 4);
def('blocks', 'half-right', (x) => x >= 4);
def('blocks', 'quad-tl', (x, y) => x < 4 && y < 4);
def('blocks', 'quad-tr', (x, y) => x >= 4 && y < 4);
def('blocks', 'quad-bl', (x, y) => x < 4 && y >= 4);
def('blocks', 'quad-br', (x, y) => x >= 4 && y >= 4);
def('blocks', 'three-no-tl', (x, y) => !(x < 4 && y < 4));
def('blocks', 'three-no-tr', (x, y) => !(x >= 4 && y < 4));
def('blocks', 'three-no-bl', (x, y) => !(x < 4 && y >= 4));
def('blocks', 'three-no-br', (x, y) => !(x >= 4 && y >= 4));
def('blocks', 'quad-diag-a', (x, y) => (x < 4) === (y < 4));
def('blocks', 'quad-diag-b', (x, y) => (x < 4) !== (y < 4));
for (const w of [1, 2, 3, 5, 6, 7]) def('blocks', `bar-left-${w}`, (x) => x < w);
for (const h of [1, 2, 3, 5, 6, 7]) def('blocks', `bar-bottom-${h}`, (x, y) => y >= 8 - h);
def('blocks', 'shade-checker', (x, y) => (x + y) % 2 === 0);
def('blocks', 'shade-checker2', (x, y) => ((x >> 1) + (y >> 1)) % 2 === 0);
def('blocks', 'shade-sparse', (x, y) => x % 2 === 0 && y % 2 === 0);
def('blocks', 'shade-dense', (x, y) => !(x % 2 === 1 && y % 2 === 1));
def('blocks', 'shade-rows', (x, y) => y % 2 === 0);
def('blocks', 'shade-cols', (x) => x % 2 === 0);

// ---- thin lines, corners, grids ------------------------------------------------------------------------------------
for (const y0 of [0, 2, 3, 4, 5, 7]) def('lines', `line-h-${y0}`, (x, y) => y === y0);
for (const x0 of [0, 2, 3, 4, 5, 7]) def('lines', `line-v-${x0}`, (x) => x === x0);
def('lines', 'cross', (x, y) => x === 3 || y === 3);
def('lines', 'corner-tl', (x, y) => (y === 3 && x >= 3) || (x === 3 && y >= 3));
def('lines', 'corner-tr', (x, y) => (y === 3 && x <= 3) || (x === 3 && y >= 3));
def('lines', 'corner-bl', (x, y) => (y === 3 && x >= 3) || (x === 3 && y <= 3));
def('lines', 'corner-br', (x, y) => (y === 3 && x <= 3) || (x === 3 && y <= 3));
def('lines', 'tee-right', (x, y) => x === 3 || (y === 3 && x >= 3));
def('lines', 'tee-left', (x, y) => x === 3 || (y === 3 && x <= 3));
def('lines', 'tee-down', (x, y) => y === 3 || (x === 3 && y >= 3));
def('lines', 'tee-up', (x, y) => y === 3 || (x === 3 && y <= 3));
def('lines', 'grid', (x, y) => x % 4 === 0 || y % 4 === 0);
def('lines', 'double-h', (x, y) => y === 2 || y === 5);
def('lines', 'double-v', (x) => x === 2 || x === 5);

// ---- diagonals and triangles ---------------------------------------------------------------------------------------
def('diagonals', 'slash', (x, y) => x + y === 7);
def('diagonals', 'backslash', (x, y) => x === y);
def('diagonals', 'slash-thick', (x, y) => x + y === 7 || x + y === 8);
def('diagonals', 'backslash-thick', (x, y) => x - y === 0 || x - y === 1);
def('diagonals', 'x', (x, y) => x + y === 7 || x === y);
def('diagonals', 'tri-bl', (x, y) => x <= y);
def('diagonals', 'tri-tr', (x, y) => x >= y);
def('diagonals', 'tri-br', (x, y) => x + y >= 7);
def('diagonals', 'tri-tl', (x, y) => x + y <= 7);
def('diagonals', 'tri-small-tl', (x, y) => x + y < 4);
def('diagonals', 'tri-small-tr', (x, y) => 7 - x + y < 4);
def('diagonals', 'tri-small-bl', (x, y) => x + 7 - y < 4);
def('diagonals', 'tri-small-br', (x, y) => 7 - x + 7 - y < 4);
def('diagonals', 'stripes-slash', (x, y) => (x + y) % 4 < 2);
def('diagonals', 'stripes-back', (x, y) => (x - y + 8) % 4 < 2);
def('diagonals', 'chevron-up', (x, y) => y === [5, 4, 3, 2, 2, 3, 4, 5][x]);
def('diagonals', 'chevron-down', (x, y) => y === [2, 3, 4, 5, 5, 4, 3, 2][x]);

// ---- rounded shapes ------------------------------------------------------------------------------------------------
def('rounds', 'disc', (x, y) => d2(x, y) <= 14.4);
def('rounds', 'ring', (x, y) => d2(x, y) <= 14.4 && d2(x, y) >= 6);
def('rounds', 'dot-small', (x, y) => Math.abs(x - 3.5) <= 0.5 && Math.abs(y - 3.5) <= 0.5);
def('rounds', 'dot-medium', (x, y) => d2(x, y) <= 5.5);
const corner = (cx, cy) => (x, y) => (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= 7.8 ** 2;
def('rounds', 'round-tl', corner(0, 0));
def('rounds', 'round-tr', corner(8, 0));
def('rounds', 'round-bl', corner(0, 8));
def('rounds', 'round-br', corner(8, 8));
def('rounds', 'hollow-tl', (x, y) => !corner(0, 0)(x, y));
def('rounds', 'hollow-tr', (x, y) => !corner(8, 0)(x, y));
def('rounds', 'hollow-bl', (x, y) => !corner(0, 8)(x, y));
def('rounds', 'hollow-br', (x, y) => !corner(8, 8)(x, y));
def('rounds', 'half-disc-top', (x, y) => (x - 3.5) ** 2 + (y + 0.5) ** 2 <= 17);
def('rounds', 'half-disc-bottom', (x, y) => (x - 3.5) ** 2 + (y - 8.5) ** 2 <= 17);
def('rounds', 'half-disc-left', (x, y) => (x + 0.5) ** 2 + (y - 3.5) ** 2 <= 17);
def('rounds', 'half-disc-right', (x, y) => (x - 8.5) ** 2 + (y - 3.5) ** 2 <= 17);
def('rounds', 'diamond', (x, y) => Math.abs(x - 3.5) + Math.abs(y - 3.5) <= 4);
def('rounds', 'diamond-outline', (x, y) => { const m = Math.abs(x - 3.5) + Math.abs(y - 3.5); return m <= 4 && m >= 2.5; });
add('rounds', 'heart', fromRows(0x66, 0xff, 0xff, 0xff, 0x7e, 0x3c, 0x18, 0x00));
add('rounds', 'spade', fromRows(0x18, 0x3c, 0x7e, 0xff, 0xff, 0x5a, 0x18, 0x3c));
add('rounds', 'club', fromRows(0x3c, 0x3c, 0xdb, 0xff, 0xff, 0x5a, 0x18, 0x3c));
add('rounds', 'sparkle', fromRows(0x18, 0x18, 0x3c, 0xff, 0xff, 0x3c, 0x18, 0x18));

export const GLYPHS = DEFS.map((d, i) => ({ index: i, id: d.id, set: d.set, rows: d.rows }));
export const GLYPH_COUNT = GLYPHS.length;
/** All bitmaps back to back: glyph g occupies bytes g*8 .. g*8+7. */
export const GLYPH_BYTES = (() => {
  const out = new Uint8Array(GLYPH_COUNT * 8);
  GLYPHS.forEach((g, i) => out.set(g.rows, i * 8));
  return out;
})();

/** 1 when glyph g belongs to one of the enabled sets; "empty" and "full" are always available. */
export function enabledMask(sets) {
  const on = new Set(sets);
  return Uint8Array.from(GLYPHS, (g) => (on.has(g.set) || g.id === 'empty' || g.id === 'full' ? 1 : 0));
}

/** Pixel (x, y) of glyph g is on? */
export const glyphPixel = (g, x, y) => (GLYPH_BYTES[g * 8 + y] & (0x80 >> x)) !== 0;

// ---------------------------------------------------------------------------
// Palettes (16 slots; PET is monochrome green)
// ---------------------------------------------------------------------------

export const PETSCII_PALETTES = {
  c64: { name: { es: 'C64 (Pepto)', en: 'C64 (Pepto)' }, colors: PALETTES.c64.colors },
  vic20: {
    name: { es: 'VIC-20', en: 'VIC-20' },
    colors: [
      '#000000', '#FFFFFF', '#782922', '#87D6DD', '#AA5FB6', '#55A049', '#40318D', '#BFCE72',
      '#AA7449', '#EAB489', '#B86962', '#C7FFFF', '#EA9FF6', '#94E089', '#8071CC', '#FFFFB2',
    ],
  },
  pet: { name: { es: 'PET (verde monocromo)', en: 'PET (green mono)' }, colors: ['#000000', '#33FF66'] },
};

export const PETSCII_PALETTE_IDS = Object.keys(PETSCII_PALETTES);

export function paletteRGB(id) {
  return (PETSCII_PALETTES[id] || PETSCII_PALETTES.c64).colors.map(hexToRgb);
}

// ---------------------------------------------------------------------------
// Unicode approximation for TXT export: nearest of ~110 block / line / geometric characters by 8x8 bitmap distance
// ---------------------------------------------------------------------------

const CANDIDATES = [];
const cand = (ch, fn) => CANDIDATES.push({ ch, rows: bitmap(fn) });
cand(' ', () => false);
cand('█', () => true);
cand('▀', (x, y) => y < 4);
cand('▄', (x, y) => y >= 4);
cand('▌', (x) => x < 4);
cand('▐', (x) => x >= 4);
cand('▘', (x, y) => x < 4 && y < 4);
cand('▝', (x, y) => x >= 4 && y < 4);
cand('▖', (x, y) => x < 4 && y >= 4);
cand('▗', (x, y) => x >= 4 && y >= 4);
cand('▚', (x, y) => (x < 4) === (y < 4));
cand('▞', (x, y) => (x < 4) !== (y < 4));
cand('▛', (x, y) => !(x >= 4 && y >= 4));
cand('▜', (x, y) => !(x < 4 && y >= 4));
cand('▙', (x, y) => !(x >= 4 && y < 4));
cand('▟', (x, y) => !(x < 4 && y < 4));
'▁▂▃▄▅▆▇'.split('').forEach((ch, i) => { if (i !== 3) cand(ch, (x, y) => y >= 8 - (i + 1)); });
[['▏', 1], ['▎', 2], ['▍', 3], ['▋', 5], ['▊', 6], ['▉', 7]].forEach(([ch, w]) => cand(ch, (x) => x < w));
cand('░', (x, y) => x % 2 === 0 && y % 2 === 0);
cand('▒', (x, y) => (x + y) % 2 === 0);
cand('▓', (x, y) => !(x % 2 === 1 && y % 2 === 1));
cand('─', (x, y) => y === 3);
cand('│', (x) => x === 3);
cand('┼', (x, y) => x === 3 || y === 3);
cand('┌', (x, y) => (y === 3 && x >= 3) || (x === 3 && y >= 3));
cand('┐', (x, y) => (y === 3 && x <= 3) || (x === 3 && y >= 3));
cand('└', (x, y) => (y === 3 && x >= 3) || (x === 3 && y <= 3));
cand('┘', (x, y) => (y === 3 && x <= 3) || (x === 3 && y <= 3));
cand('├', (x, y) => x === 3 || (y === 3 && x >= 3));
cand('┤', (x, y) => x === 3 || (y === 3 && x <= 3));
cand('┬', (x, y) => y === 3 || (x === 3 && y >= 3));
cand('┴', (x, y) => y === 3 || (x === 3 && y <= 3));
cand('╱', (x, y) => x + y === 7);
cand('╲', (x, y) => x === y);
cand('╳', (x, y) => x + y === 7 || x === y);
cand('◣', (x, y) => x <= y);
cand('◥', (x, y) => x >= y);
cand('◢', (x, y) => x + y >= 7);
cand('◤', (x, y) => x + y <= 7);
cand('●', (x, y) => d2(x, y) <= 14.4);
cand('○', (x, y) => d2(x, y) <= 14.4 && d2(x, y) >= 6);
cand('·', (x, y) => Math.abs(x - 3.5) <= 0.5 && Math.abs(y - 3.5) <= 0.5);
cand('◆', (x, y) => Math.abs(x - 3.5) + Math.abs(y - 3.5) <= 4);
cand('◇', (x, y) => { const m = Math.abs(x - 3.5) + Math.abs(y - 3.5); return m <= 4 && m >= 2.5; });
cand('♥', (x, y) => (GLYPHS.find((g) => g.id === 'heart').rows[y] & (0x80 >> x)) !== 0);
cand('♠', (x, y) => (GLYPHS.find((g) => g.id === 'spade').rows[y] & (0x80 >> x)) !== 0);
cand('♣', (x, y) => (GLYPHS.find((g) => g.id === 'club').rows[y] & (0x80 >> x)) !== 0);
// Symbols for Legacy Computing: sextants (2 x 3 cells over rows 0-2 / 3-4 / 5-7), U+1FB00..U+1FB3B
for (let p = 1; p < 63; p++) {
  if (p === 21 || p === 42) continue; // left / right half: already in Block Elements
  const code = 0x1fb00 + (p - 1) - (p > 21 ? 1 : 0) - (p > 42 ? 1 : 0);
  cand(String.fromCodePoint(code), (x, y) => {
    const band = y < 3 ? 0 : y < 5 ? 1 : 2;
    return (p & (1 << (band * 2 + (x < 4 ? 0 : 1)))) !== 0;
  });
}

const popcount8 = (v) => { let n = 0; for (let i = v; i; i &= i - 1) n++; return n; };
const unicodeCache = new Map();

/** Unicode character that looks most like glyph `g` (ties keep the earlier, simpler candidate). */
export function glyphToUnicode(g) {
  const hit = unicodeCache.get(g);
  if (hit !== undefined) return hit;
  let best = ' ';
  let bd = Infinity;
  for (const c of CANDIDATES) {
    let d = 0;
    for (let y = 0; y < 8; y++) d += popcount8(GLYPH_BYTES[g * 8 + y] ^ c.rows[y]);
    if (d < bd) { bd = d; best = c.ch; if (d === 0) break; }
  }
  unicodeCache.set(g, best);
  return best;
}
