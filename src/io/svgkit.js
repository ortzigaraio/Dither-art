// Minimal SVG writer for the pixel modes (halftone, LED): one <g> per ink as an Inkscape layer, numbers trimmed,
// every piece of text escaped with escapeXml() (PLAN.md 18.3). Phase 4 builds the full exportSVG.js on top of ideas
// found here (layers, mm units); this file only needs what the raster-like modes use.

import { escapeXml } from './exportText.js';
import { config } from '../config.js';

/** Number with at most 2 decimals, no trailing zeros. */
export const num = (v) => {
  const s = (Math.round(v * 100) / 100).toString();
  return s === '-0' ? '0' : s;
};

const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#000000');

/**
 * @param {{ width:number, height:number, title?:string, desc?:string }} o  logical size in px
 * @param {string[]} layers  already built <g> strings (see layer())
 */
export function svgDocument({ width, height, title = config.productName, desc = '' }, layers) {
  const w = num(width);
  const h = num(height);
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" `
    + `width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n`
    + `<title>${escapeXml(title)}</title>\n${desc ? `<desc>${escapeXml(desc)}</desc>\n` : ''}`
    + `${layers.join('\n')}\n</svg>\n`;
}

/** An Inkscape layer: `fill` colour, optional CSS blend mode, `body` = shape elements. */
export function layer(label, fill, body, { blend = '', id = '' } = {}) {
  const lid = escapeXml(id || label.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  const style = blend ? ` style="mix-blend-mode:${escapeXml(blend)}"` : '';
  return `<g id="${lid}" inkscape:groupmode="layer" inkscape:label="${escapeXml(label)}" fill="${safeColor(fill)}"${style}>\n${body}\n</g>`;
}

export const rectEl = (x, y, w, h, fill) => `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}"${fill ? ` fill="${safeColor(fill)}"` : ''}/>`;
export const circleEl = (x, y, r) => `<circle cx="${num(x)}" cy="${num(y)}" r="${num(r)}"/>`;
export const ellipseEl = (x, y, rx, ry, deg) => `<ellipse cx="${num(x)}" cy="${num(y)}" rx="${num(rx)}" ry="${num(ry)}"${deg ? ` transform="rotate(${num(deg)} ${num(x)} ${num(y)})"` : ''}/>`;
export const polyEl = (pts) => `<path d="M${pts.map((p) => `${num(p[0])} ${num(p[1])}`).join('L')}Z"/>`;
