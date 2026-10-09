// Text exports for character-grid modes (PLAN.md 9.1): TXT, coloured HTML (escaped) and ANSI.
// A "grid" is { cols, rows, chars: string[], rgba?: Uint8ClampedArray, mono?: [r,g,b], bg?: [r,g,b]|null, css,
// bgRgba?: Uint8ClampedArray } where `chars` has one (possibly multi-unit) code point per cell, `rgba` holds the
// foreground colour of each cell (4 bytes per cell) and the optional `bgRgba` a background colour per cell
// (ANSI Art: half blocks and shades). Every piece of text that reaches HTML/SVG goes through escapeXml().

import { rgbToHex } from '../engine/color.js';
import { VGA16 } from '../engine/ansiart.js';

export { VGA16 };
import { config } from '../config.js';

const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape the five characters that matter in HTML/SVG text and attributes. */
export function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => XML_ESC[c]);
}

function rowString(grid, y) {
  let s = '';
  const base = y * grid.cols;
  for (let x = 0; x < grid.cols; x++) s += grid.chars[base + x];
  return s;
}

/** Plain text: `rows` lines of `cols` characters, each ending in a newline. */
export function gridToTXT(grid) {
  let out = '';
  for (let y = 0; y < grid.rows; y++) out += `${rowString(grid, y)}\n`;
  return out;
}

const cellRGB = (grid, i) => (grid.rgba ? [grid.rgba[i * 4], grid.rgba[i * 4 + 1], grid.rgba[i * 4 + 2]] : grid.mono);

const cellBG = (grid, i) => (grid.bgRgba ? [grid.bgRgba[i * 4], grid.bgRgba[i * 4 + 1], grid.bgRgba[i * 4 + 2]] : null);

/** Standalone HTML page with a <pre>; contiguous cells of the same colours share one <span>. */
export function gridToHTML(grid, { title = config.productName } = {}) {
  const css = grid.css || {};
  const lines = [];
  const style = (fg, bgc) => `color:${fg}${bgc ? `;background:${bgc}` : ''}`;
  for (let y = 0; y < grid.rows; y++) {
    if (!grid.rgba) {
      lines.push(escapeXml(rowString(grid, y)));
      continue;
    }
    let line = '';
    let pending = ''; // spaces seen since the last glyph: invisible, so they never split a run
    let runText = '';
    let runKey = null;
    let runStyle = '';
    for (let x = 0; x < grid.cols; x++) {
      const i = y * grid.cols + x;
      const ch = grid.chars[i];
      const bgc = grid.bgRgba ? rgbToHex(...cellBG(grid, i)) : null;
      if (ch === ' ' && !bgc) { pending += ch; continue; }
      const [r, g, b] = cellRGB(grid, i);
      const fg = rgbToHex(r, g, b);
      const key = `${fg}|${bgc}`;
      if (key === runKey) {
        runText += pending + ch;
      } else {
        if (runText) line += `<span style="${runStyle}">${escapeXml(runText)}</span>`;
        line += escapeXml(pending);
        runKey = key;
        runStyle = style(fg, bgc);
        runText = ch;
      }
      pending = '';
    }
    if (runText) line += `<span style="${runStyle}">${escapeXml(runText)}</span>`;
    line += escapeXml(pending);
    lines.push(line);
  }

  const ink = grid.mono ? rgbToHex(...grid.mono) : null;
  const bg = grid.bg ? rgbToHex(...grid.bg) : null;
  const family = css.family || '"Geist Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace';
  const preStyle = [
    'margin:0 auto',
    'width:max-content',
    `font-family:${family}`,
    `font-size:${css.size || 12}px`,
    `line-height:${css.lineHeight || 1}`,
    `letter-spacing:${css.letterSpacing || 0}px`,
    ink ? `color:${ink}` : null,
  ].filter(Boolean).join(';');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${escapeXml(config.productName)}">
<title>${escapeXml(title)}</title>
<style>html,body{margin:0;padding:0;${bg ? `background:${bg};` : ''}}body{padding:24px}</style>
</head>
<body>
<pre style="${escapeXml(preStyle)}">${lines.join('\n')}</pre>
</body>
</html>
`;
}

// ---- ANSI ------------------------------------------------------------------

const ANSI16 = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];

const CUBE = [0, 95, 135, 175, 215, 255];

function nearest16(r, g, b) {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < 16; i++) {
    const c = ANSI16[i];
    const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

function nearest256(r, g, b) {
  const q = (v) => {
    let best = 0;
    for (let i = 1; i < 6; i++) if (Math.abs(CUBE[i] - v) < Math.abs(CUBE[best] - v)) best = i;
    return best;
  };
  const qr = q(r), qg = q(g), qb = q(b);
  const cubeIdx = 16 + 36 * qr + 6 * qg + qb;
  const cubeD = (r - CUBE[qr]) ** 2 + (g - CUBE[qg]) ** 2 + (b - CUBE[qb]) ** 2;
  const avg = (r + g + b) / 3;
  const gi = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const gv = 8 + gi * 10;
  const grayD = (r - gv) ** 2 + (g - gv) ** 2 + (b - gv) ** 2;
  return grayD < cubeD ? 232 + gi : cubeIdx;
}

function sgr(kind, r, g, b, depth) {
  const base = kind === 'fg' ? 38 : 48;
  if (depth === 16) {
    const i = nearest16(r, g, b);
    const code = i < 8 ? (kind === 'fg' ? 30 : 40) + i : (kind === 'fg' ? 90 : 100) + (i - 8);
    return `\x1b[${code}m`;
  }
  if (depth === 256) return `\x1b[${base};5;${nearest256(r, g, b)}m`;
  return `\x1b[${base};2;${r};${g};${b}m`;
}

/**
 * ANSI escapes, one reset per line. depth: 24 (truecolor), 256 or 16.
 */
export function gridToANSI(grid, { depth = 24 } = {}) {
  const d = depth === 16 || depth === 256 ? depth : 24;
  let out = '';
  for (let y = 0; y < grid.rows; y++) {
    let line = grid.bg ? sgr('bg', grid.bg[0], grid.bg[1], grid.bg[2], d) : '';
    let curFg = null;
    let curBg = null;
    for (let x = 0; x < grid.cols; x++) {
      const i = y * grid.cols + x;
      const ch = grid.chars[i];
      const bgc = cellBG(grid, i);
      if (bgc) {
        const code = sgr('bg', bgc[0], bgc[1], bgc[2], d);
        if (code !== curBg) { line += code; curBg = code; }
      }
      if (ch !== ' ' || bgc) {
        const [r, g, b] = cellRGB(grid, i);
        const code = sgr('fg', r, g, b, d);
        if (code !== curFg) { line += code; curFg = code; }
      }
      line += ch;
    }
    out += `${line}\x1b[0m\n`;
  }
  return out;
}

// ---- .ans (CP437 bytes with ANSI.SYS-compatible SGR codes; VGA16 palette lives in engine/ansiart.js) -----------------

// Unicode -> CP437 for the characters the text modes produce (printable ASCII passes through)
const CP437 = new Map(Object.entries({
  '░': 0xb0, '▒': 0xb1, '▓': 0xb2, '█': 0xdb, '▀': 0xdf, '▄': 0xdc, '▌': 0xdd, '▐': 0xde, '■': 0xfe,
  '│': 0xb3, '┤': 0xb4, '╣': 0xb9, '║': 0xba, '╗': 0xbb, '╝': 0xbc, '┐': 0xbf, '└': 0xc0, '┴': 0xc1, '┬': 0xc2,
  '├': 0xc3, '─': 0xc4, '┼': 0xc5, '╚': 0xc8, '╔': 0xc9, '╩': 0xca, '╦': 0xcb, '╠': 0xcc, '═': 0xcd, '╬': 0xce,
  '┘': 0xd9, '┌': 0xda, '·': 0xfa, '•': 0x07, '°': 0xf8, '±': 0xf1, '≈': 0xf7, '√': 0xfb, '∞': 0xec, '♥': 0x03,
  '♦': 0x04, '♣': 0x05, '♠': 0x06, '○': 0x09, '◘': 0x08, '☺': 0x01, '☻': 0x02, '↑': 0x18, '↓': 0x19, '→': 0x1a,
  '←': 0x1b, '↔': 0x1d, '↕': 0x12,
}));
for (let c = 0x20; c < 0x7f; c++) CP437.set(String.fromCharCode(c), c);

/** CP437 byte of a character; anything without a CP437 equivalent becomes '?'. */
export function cp437Byte(ch) {
  return CP437.get(ch) ?? 0x3f;
}

function nearestVGA(r, g, b, count) {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < count; i++) {
    const c = VGA16[i];
    const dd = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
    if (dd < bd) { bd = dd; best = i; }
  }
  return best;
}

/** VGA attribute index -> ANSI colour digit (the red and blue bits are swapped). */
const ansiDigit = (v) => ((v & 1) << 2) | (v & 2) | ((v & 4) >> 2);

/**
 * Bytes of an ANSI.SYS-style .ans file: CP437 characters, one SGR per colour change, 16 foreground colours and 8
 * backgrounds (a bright background would blink on real hardware, so it is mapped to the nearest dark one).
 * Rows narrower than 80 columns end in CR LF; a row of 80 or more relies on the terminal wrapping.
 * @returns {Uint8Array}
 */
export function gridToANS(grid) {
  const bytes = [];
  const push = (str) => { for (let i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i)); };
  const baseBg = grid.bg || [0, 0, 0];
  for (let y = 0; y < grid.rows; y++) {
    let cur = -1;
    for (let x = 0; x < grid.cols; x++) {
      const i = y * grid.cols + x;
      const ch = grid.chars[i];
      const bgc = cellBG(grid, i) || baseBg;
      const [r, g, b] = cellRGB(grid, i) || [255, 255, 255];
      // a bright background would blink: use its dark counterpart (same hue)
      const bgIdx = nearestVGA(bgc[0], bgc[1], bgc[2], 16) & 7;
      const fgIdx = nearestVGA(r, g, b, 16);
      const attr = (fgIdx << 4) | bgIdx;
      if (attr !== cur) {
        cur = attr;
        push(`\x1b[0;${fgIdx > 7 ? '1;' : ''}${30 + ansiDigit(fgIdx & 7)};${40 + ansiDigit(bgIdx)}m`);
      }
      bytes.push(cp437Byte(ch));
    }
    push('\x1b[0m');
    if (grid.cols < 80) push('\r\n');
  }
  return Uint8Array.from(bytes);
}

/** format: 'txt' | 'html' | 'ansi' */
export function gridToText(grid, format, opts = {}) {
  if (format === 'html') return gridToHTML(grid, opts);
  if (format === 'ansi') return gridToANSI(grid, opts);
  return gridToTXT(grid);
}
