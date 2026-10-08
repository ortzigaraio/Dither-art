// Text exports for character-grid modes (PLAN.md 9.1): TXT, coloured HTML (escaped) and ANSI.
// A "grid" is { cols, rows, chars: string[], rgba?: Uint8ClampedArray, mono?: [r,g,b], bg?: [r,g,b]|null, css }
// where `chars` has one (possibly multi-unit) code point per cell and `rgba` holds 4 bytes per cell.

import { rgbToHex } from '../engine/color.js';

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

/** Standalone HTML page with a <pre>; contiguous cells of the same colour share one <span>. */
export function gridToHTML(grid, { title = 'HORAIN' } = {}) {
  const css = grid.css || {};
  const lines = [];
  for (let y = 0; y < grid.rows; y++) {
    if (!grid.rgba) {
      lines.push(escapeXml(rowString(grid, y)));
      continue;
    }
    let line = '';
    let pending = ''; // spaces seen since the last glyph: invisible, so they never split a run
    let runText = '';
    let runColor = null;
    for (let x = 0; x < grid.cols; x++) {
      const i = y * grid.cols + x;
      const ch = grid.chars[i];
      if (ch === ' ') { pending += ch; continue; }
      const [r, g, b] = cellRGB(grid, i);
      const hex = rgbToHex(r, g, b);
      if (hex === runColor) {
        runText += pending + ch;
      } else {
        if (runText) line += `<span style="color:${runColor}">${escapeXml(runText)}</span>`;
        line += escapeXml(pending);
        runColor = hex;
        runText = ch;
      }
      pending = '';
    }
    if (runText) line += `<span style="color:${runColor}">${escapeXml(runText)}</span>`;
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
<meta name="generator" content="HORAIN">
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
    let current = null;
    for (let x = 0; x < grid.cols; x++) {
      const i = y * grid.cols + x;
      const ch = grid.chars[i];
      if (ch !== ' ') {
        const [r, g, b] = cellRGB(grid, i);
        const code = sgr('fg', r, g, b, d);
        if (code !== current) { line += code; current = code; }
      }
      line += ch;
    }
    out += `${line}\x1b[0m\n`;
  }
  return out;
}

/** format: 'txt' | 'html' | 'ansi' */
export function gridToText(grid, format, opts = {}) {
  if (format === 'html') return gridToHTML(grid, opts);
  if (format === 'ansi') return gridToANSI(grid, opts);
  return gridToTXT(grid);
}
